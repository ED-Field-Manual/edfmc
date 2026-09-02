/**
 * Verification engine: deduplication, independence, conflict and notification.
 *
 * Covers the non-spoiler cases §16 requires: station mismatch, extra service,
 * dynamic mismatch, repeated observations from one session, independent
 * confirmation, conflicting observations, and an unrecognised game token.
 */

import { describe, expect, it } from 'vitest';
import {
  JournalSessionContext,
  normalize,
  parseLine,
  type NormalizedEvent,
} from '@edfm/elite-journal';

import {
  VerificationEngine,
  applyObservation,
  areIndependentObservations,
  baselineConfidence,
  canRaiseDiscrepancy,
  countIndependent,
  createStationProvider,
  discrepancyKey,
  discrepancyPhrasing,
  EMPTY_REFERENCE,
  mapReference,
  PUBLIC,
  shouldNotify,
  type NotifyEvent,
  type StationReference,
  type VerificationObservation,
} from '../src/index.js';

const COMPANION_VERSION = '0.1.0';

function ev(line: string, file: string, ctx: JournalSessionContext, offset: number): NormalizedEvent {
  const r = parseLine(line, file, offset, ctx);
  if (!r?.ok) throw new Error('fixture failed to parse');
  return normalize(r.event);
}

const HEADER =
  '{ "timestamp":"2026-09-01T13:26:17Z", "event":"Fileheader", "part":1, "language":"English/UK", "Odyssey":true, "gameversion":"4.4.0.3", "build":"r330683/r0 " }';

const DOCKED =
  '{ "timestamp":"2026-09-01T13:34:55Z", "event":"Docked", "StationName":"Elder Hub", "StationType":"Coriolis", "Taxi":false, "Multicrew":false, "StarSystem":"Mundii", "SystemAddress":99, "MarketID":128, "StationFaction":{ "Name":"F" }, "StationGovernment":"$government_Corporate;", "StationServices":[ "dock", "commodities", "techBroker" ], "StationEconomy":"$economy_Industrial;", "StationEconomies":[], "DistFromStarLS":10.0, "LandingPads":{ "Small":1, "Medium":1, "Large":1 } }';

const DOCKED_CARRIER =
  '{ "timestamp":"2026-09-01T17:07:40Z", "event":"Docked", "StationName":"HBN-TXN", "StationType":"FleetCarrier", "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe", "SystemAddress":750, "MarketID":370, "StationFaction":{ "Name":"FleetCarrier" }, "StationGovernment":"$government_Carrier;", "StationServices":[ "dock", "engineer" ], "StationEconomy":"$economy_Carrier;", "StationEconomies":[], "DistFromStarLS":1.0, "LandingPads":{ "Small":4, "Medium":4, "Large":8 } }';

/** EDFM believes Elder Hub also has a shipyard, and does not know about techBroker. */
const REFERENCE = mapReference({
  'station:128': {
    marketId: 128,
    stationName: 'Elder Hub',
    serviceIds: ['dock', 'commodities', 'shipyard'],
    source: 'test',
    updatedAt: null,
  } satisfies StationReference,
});

function session(file: string, commander: string, fid: string) {
  const ctx = new JournalSessionContext();
  let offset = 0;
  ev(HEADER, file, ctx, (offset += 100));
  ev(
    `{ "timestamp":"2026-09-01T13:27:33Z", "event":"Commander", "FID":"${fid}", "Name":"${commander}" }`,
    file,
    ctx,
    (offset += 100),
  );
  return {
    dock: (line = DOCKED) => ev(line, file, ctx, (offset += 100)),
  };
}

function engine(onNotify?: (e: NotifyEvent) => void) {
  const e = new VerificationEngine(onNotify ? { onNotify } : {});
  e.register(createStationProvider({ companionVersion: COMPANION_VERSION, reportExtras: true }));
  return e;
}

describe('detecting both directions', () => {
  it('reports a service EDFM has that the game does not', () => {
    const e = engine();
    const changed = e.observe(session('A.log', 'Sythan', 'F1').dock(), REFERENCE);

    const missing = changed.find((d) => d.field === 'service:shipyard');
    expect(missing?.kind).toBe('missing_in_game');
    expect(missing?.expectedValue).toBe('present');
    expect(missing?.observedValue).toBe('absent');
  });

  it('reports a service the game has that EDFM does not, with the raw token', () => {
    const e = engine();
    const changed = e.observe(session('A.log', 'Sythan', 'F1').dock(), REFERENCE);

    const extra = changed.find((d) => d.field === 'service:techbroker');
    expect(extra?.kind).toBe('missing_in_edfm');
    // §9: the evidence is Frontier's own casing, not our folded id.
    expect(extra?.observations[0]?.rawToken).toBe('techBroker');
  });

  it('reports a station EDFM has never heard of, without calling it wrong', () => {
    const e = engine();
    const changed = e.observe(session('A.log', 'Sythan', 'F1').dock(), EMPTY_REFERENCE);

    expect(changed).toHaveLength(1);
    expect(changed[0]!.kind).toBe('unknown_edfm_entity');
    expect(changed[0]!.expectedValue).toBeNull();
  });

  it('never verifies a fleet carrier', () => {
    const e = engine();
    expect(e.observe(session('A.log', 'Sythan', 'F1').dock(DOCKED_CARRIER), REFERENCE)).toEqual([]);
  });
});

describe('deduplication and independence', () => {
  it('does not count a repeat from the same session as confirmation', () => {
    // §10: thirty users hitting one wrong service is one finding, and the same
    // commander docking twice is not two.
    const e = engine();
    const s = session('A.log', 'Sythan', 'F1');
    e.observe(s.dock(), REFERENCE);
    e.observe(s.dock(), REFERENCE);

    const d = e.all().find((x) => x.field === 'service:shipyard')!;
    expect(d.observations).toHaveLength(2);
    expect(d.independentConfirmations).toBe(1);
  });

  it('ignores a replay of the exact same journal line', () => {
    const e = engine();
    const ctx = new JournalSessionContext();
    ev(HEADER, 'A.log', ctx, 100);
    const event = ev(DOCKED, 'A.log', ctx, 500);

    e.observe(event, REFERENCE);
    const second = e.observe(event, REFERENCE);

    expect(second).toEqual([]);
    expect(e.all()[0]!.observations).toHaveLength(1);
  });

  it('counts a different commander in a different session as independent', () => {
    const e = engine();
    e.observe(session('A.log', 'Sythan', 'F1').dock(), REFERENCE);
    e.observe(session('B.log', 'Other', 'F2').dock(), REFERENCE);

    const d = e.all().find((x) => x.field === 'service:shipyard')!;
    expect(d.independentConfirmations).toBe(2);
  });
});

describe('notification moments', () => {
  it('notifies on creation and on first independent confirmation only', () => {
    // §10: exactly two moments deserve a Discord message.
    const events: NotifyEvent[] = [];
    const e = engine((n) => events.push(n));

    e.observe(session('A.log', 'Sythan', 'F1').dock(), REFERENCE);
    e.observe(session('B.log', 'Other', 'F2').dock(), REFERENCE);
    e.observe(session('C.log', 'Third', 'F3').dock(), REFERENCE);

    const forShipyard = events.filter((n) => n.discrepancy.field === 'service:shipyard');
    expect(forShipyard.map((n) => n.reason)).toEqual(['created', 'confirmed']);
  });

  it('notifies when observations start conflicting', () => {
    const before = applyObservation(undefined, obs({ observedValue: 'absent' }), 'missing_in_game');
    const after = applyObservation(
      before,
      obs({ observedValue: 'present', sourceEventId: 'B.log:1', sessionKey: 'B.log', commanderFid: 'F2', commander: 'Other' }),
      'missing_in_game',
    );

    expect(after.status).toBe('conflicting');
    expect(shouldNotify(before, after)).toBe('conflicting');
    // §10: neither observation is discarded.
    expect(after.observations).toHaveLength(2);
  });

  it('says nothing for a third matching observation', () => {
    const a = applyObservation(undefined, obs(), 'missing_in_game');
    const b = applyObservation(a, obs({ sourceEventId: 'B.log:1', sessionKey: 'B.log', commanderFid: 'F2', commander: 'B' }), 'missing_in_game');
    const c = applyObservation(b, obs({ sourceEventId: 'C.log:1', sessionKey: 'C.log', commanderFid: 'F3', commander: 'C' }), 'missing_in_game');

    expect(shouldNotify(b, c)).toBeNull();
  });
});

describe('evidence and volatility', () => {
  it('refuses to let inference correct EDFM', () => {
    expect(canRaiseDiscrepancy('direct')).toBe(true);
    expect(canRaiseDiscrepancy('derived')).toBe(true);
    // §2: inference must never be presented as game truth.
    expect(canRaiseDiscrepancy('inferred')).toBe(false);
  });

  it('never rates a dynamic field highly, however directly observed', () => {
    // The observation being accurate says nothing about EDFM having been wrong
    // when it was recorded.
    expect(baselineConfidence('direct', 'static')).toBe('high');
    expect(baselineConfidence('direct', 'dynamic')).toBe('low');
  });

  it('words a dynamic mismatch as staleness, not error', () => {
    expect(discrepancyPhrasing('static')).toContain('incorrect');
    expect(discrepancyPhrasing('dynamic')).toContain('outdated');
  });
});

describe('discrepancy identity', () => {
  it('collapses the same finding across commanders onto one key', () => {
    const a = discrepancyKey(obs());
    const b = discrepancyKey(obs({ commander: 'Other', commanderFid: 'F2', sourceEventId: 'B.log:1' }));
    expect(a).toBe(b);
  });

  it('separates the same field across game versions', () => {
    // A field changing across an update is a different finding, not the same
    // one recurring.
    const a = discrepancyKey(obs());
    const b = discrepancyKey(obs({ gameVersion: '4.5.0.0' }));
    expect(a).not.toBe(b);
  });
});

describe('engine statistics', () => {
  it('counts checks and matches for the Contributions screen', () => {
    const e = engine();
    // Matching reference: nothing to report.
    const clean = mapReference({
      'station:128': {
        marketId: 128,
        stationName: 'Elder Hub',
        serviceIds: ['dock', 'commodities', 'techbroker'],
        source: 'test',
        updatedAt: null,
      } satisfies StationReference,
    });

    e.observe(session('A.log', 'Sythan', 'F1').dock(), clean);
    const stats = e.stats();

    expect(stats.checked).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.discrepancies).toBe(0);
  });
});

function obs(overrides: Partial<VerificationObservation> = {}): VerificationObservation {
  return {
    entityType: 'station',
    entityId: '128',
    field: 'service:shipyard',
    expectedValue: 'present',
    observedValue: 'absent',
    rawToken: null,
    evidence: 'direct',
    confidence: 'high',
    volatility: 'semi-static',
    visibility: PUBLIC,
    observedAt: '2026-09-01T13:34:55Z',
    commander: 'Sythan',
    commanderFid: 'F1',
    gameVersion: '4.4.0.3',
    gameBuild: 'r330683/r0 ',
    companionVersion: COMPANION_VERSION,
    sourceEventId: 'A.log:1',
    sourceEvent: 'Docked',
    sessionKey: 'A.log',
    ...overrides,
  };
}

describe('independence helpers', () => {
  it('treats same commander, same FID or same session as one observation', () => {
    expect(areIndependentObservations(obs(), obs({ sourceEventId: 'A.log:2' }))).toBe(false);
    expect(
      areIndependentObservations(obs(), obs({ commanderFid: 'F2', commander: 'Other' })),
    ).toBe(false); // same sessionKey
    expect(
      areIndependentObservations(
        obs(),
        obs({ commanderFid: 'F2', commander: 'Other', sessionKey: 'B.log' }),
      ),
    ).toBe(true);
  });

  it('counts mutually independent observations only', () => {
    const list = [
      obs(),
      obs({ sourceEventId: 'A.log:2' }),
      obs({ commander: 'B', commanderFid: 'F2', sessionKey: 'B.log', sourceEventId: 'B.log:1' }),
    ];
    expect(countIndependent(list)).toBe(2);
  });
});
