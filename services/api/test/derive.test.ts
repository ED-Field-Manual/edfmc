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

describe('bulk service differences', () => {
  // A station with a large service list, as real ones have.
  const large = reference({
    serviceIds: [
      'dock', 'autodock', 'blackmarket', 'commodities', 'contacts', 'exploration',
      'missions', 'outfitting', 'crewlounge', 'rearm', 'refuel', 'repair',
      'shipyard', 'tuning', 'engineer', 'facilitator', 'stationmenu', 'shop',
      'livery', 'socialspace',
    ],
  });

  it('reports one aggregate finding rather than one per missing service', () => {
    // The case that prompted this: a real submission against Jaques Station
    // produced 32 findings, which would have been 32 Discord alerts.
    const result = deriveStationFindings(
      observation({ servicesRaw: ['Dock', 'Commodities', 'Refuel'] }),
      large,
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('normalization_conflict');
    expect(result.skipped).toBe('bulk-service-difference');
  });

  it('rates the aggregate low, because the likeliest cause is a partial reading', () => {
    const result = deriveStationFindings(
      observation({ servicesRaw: ['Dock', 'Commodities', 'Refuel'] }),
      large,
    );
    // Not a confident claim that the station changed. A direct semi-static
    // observation would otherwise be medium, which would let a probable
    // misreading reach a reviewer weighted like a finding we believe.
    expect(result.findings[0]!.observation.confidence).toBe('low');
    expect(result.findings[0]!.observation.field).toBe('services');
    expect(result.findings[0]!.observation.expectedValue).toContain('shipyard');
  });

  it('still reports a small number of differences individually', () => {
    // Four missing out of twenty is a finding, not a partial reading.
    const result = deriveStationFindings(
      observation({
        servicesRaw: [
          'Dock', 'autodock', 'blackmarket', 'Commodities', 'contacts', 'exploration',
          'missions', 'outfitting', 'crewlounge', 'rearm', 'refuel', 'repair',
          'shipyard', 'tuning', 'engineer', 'facilitator',
        ],
      }),
      large,
    );
    expect(result.findings).toHaveLength(4);
    expect(result.findings.every((f) => f.kind === 'missing_in_game')).toBe(true);
  });

  it('treats a majority difference at a small station as partial too', () => {
    // Five of six missing is plainly a partial reading, even though five is a
    // small number in absolute terms.
    const small = reference({ serviceIds: ['dock', 'refuel', 'repair', 'rearm', 'shipyard', 'outfitting'] });
    const result = deriveStationFindings(observation({ servicesRaw: ['Dock'] }), small);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('normalization_conflict');
  });

  it('aggregates a bulk difference in the other direction as well', () => {
    // A station gaining twelve services at once is equally implausible.
    const result = deriveStationFindings(
      observation({
        servicesRaw: [
          'dock', 'autodock', 'blackmarket', 'commodities', 'contacts', 'exploration',
          'missions', 'outfitting', 'crewlounge', 'rearm', 'refuel', 'repair',
          'shipyard', 'tuning', 'engineer', 'facilitator', 'stationmenu', 'shop',
          'livery', 'socialspace', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8',
          'x9', 'x10', 'x11', 'x12',
        ],
      }),
      large,
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('normalization_conflict');
  });
});
