import { describe, expect, it } from 'vitest';
import { deriveStationFindings, type StationObservationInput } from '../src/lib/derive.js';
import type { StationReference } from '../src/lib/reference.js';

const observation = (over: Partial<StationObservationInput> = {}): StationObservationInput => ({
  marketId: '128',
  stationName: 'Elder Hub',
  stationType: 'Orbis',
  systemName: 'Mundii',
  systemAddress: '99',
  servicesRaw: ['Dock', 'Commodities', 'techBroker'],
  observedAt: '2026-09-02T12:00:00Z',
  sourceEvent: 'Docked',
  sourceEventId: 'Journal.log:1024',
  gameVersion: '4.1.2',
  gameBuild: 'r300000',
  companionVersion: '0.1.0',
  commander: null,
  commanderFid: null,
  sessionKey: 'Journal.log',
  ...over,
});

const reference = (over: Partial<StationReference> = {}): StationReference => ({
  source: 'eddn-aggregate',
  marketId: '128',
  name: 'Elder Hub',
  stationType: 'Orbis',
  systemName: 'Mundii',
  systemAddress: '99',
  isFleetCarrier: false,
  isPlanetary: false,
  serviceIds: ['dock', 'commodities', 'techbroker'],
  servicesRaw: ['Dock', 'Commodities', 'techBroker'],
  observedAt: '2026-09-01T00:00:00Z',
  ...over,
});

describe('deriveStationFindings', () => {
  it('reports nothing when the observation agrees', () => {
    const result = deriveStationFindings(observation(), reference());
    expect(result.findings).toEqual([]);
    expect(result.skipped).toBe('agrees');
  });

  it('matches services case-insensitively but keeps the raw token as evidence', () => {
    // Frontier's array mixes cases (stationMenu, techBroker). Folding only for
    // comparison keeps the evidence quotable per §9.
    const result = deriveStationFindings(
      observation({ servicesRaw: ['DOCK', 'commodities', 'TechBroker'] }),
      reference(),
    );
    expect(result.findings).toEqual([]);
  });

  it('never compares a fleet carrier', () => {
    // A carrier's services are the owner's current configuration, not a fact
    // about the galaxy.
    const result = deriveStationFindings(
      observation({ servicesRaw: ['Dock'] }),
      reference({ isFleetCarrier: true }),
    );
    expect(result.findings).toEqual([]);
    expect(result.skipped).toBe('fleet-carrier');
  });

  it('treats an unknown station as absent data, not a discrepancy', () => {
    // Reporting every unseen station would produce exactly the flood of
    // confident, useless findings the phase notes warn about.
    const result = deriveStationFindings(observation(), null);
    expect(result.findings).toEqual([]);
    expect(result.skipped).toBe('no-reference');
  });

  it('does not compare services when the game did not report any', () => {
    // Absent is not empty. An empty list would assert the station HAS none.
    const result = deriveStationFindings(observation({ servicesRaw: null }), reference());
    expect(result.findings).toEqual([]);
  });

  it('detects a service the game reports and the reference lacks', () => {
    const result = deriveStationFindings(
      observation({ servicesRaw: ['Dock', 'Commodities', 'techBroker', 'Refuel'] }),
      reference(),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: 'missing_in_edfm',
      observation: { field: 'service:refuel', expectedValue: null, observedValue: 'refuel', rawToken: 'Refuel' },
    });
  });

  it('detects a service the reference has and the game does not report', () => {
    const result = deriveStationFindings(observation({ servicesRaw: ['Dock', 'Commodities'] }), reference());
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: 'missing_in_game',
      observation: { field: 'service:techbroker', expectedValue: 'techbroker', observedValue: null },
    });
  });

  it('rates a station type mismatch static and high, a service mismatch semi-static and medium', () => {
    const type = deriveStationFindings(observation({ stationType: 'Coriolis' }), reference());
    expect(type.findings[0]!.observation).toMatchObject({
      field: 'stationType',
      volatility: 'static',
      confidence: 'high',
    });
    const service = deriveStationFindings(observation({ servicesRaw: ['Dock', 'Commodities'] }), reference());
    expect(service.findings[0]!.observation).toMatchObject({
      volatility: 'semi-static',
      confidence: 'medium',
    });
  });

  it('does not compare a field the game did not report', () => {
    expect(deriveStationFindings(observation({ stationType: null }), reference()).findings).toEqual([]);
    expect(deriveStationFindings(observation(), reference({ stationType: null })).findings).toEqual([]);
  });
});
