/**
 * Every fixture here is shaped from a real event in the 224-journal corpus
 * profiled on 2026-09-03, and every assertion about counts or field presence
 * traces back to a number measured there.
 */

import { describe, expect, it } from 'vitest';
import type { CommanderState, NormalizedEvent } from '@edfm/elite-journal';
import { SessionTracker, isPlausible } from '../src/session.js';
import { SETTLEMENT_MATERIALS } from '../src/projects/settlement-materials.js';
import type { ObservedSession } from '../src/types.js';

let offset = 0;

function ev(event: string, raw: Record<string, unknown>, timestamp: string): NormalizedEvent {
  offset += 1;
  return {
    kind: 'other',
    known: false,
    data: null,
    source: {
      event,
      raw: { event, timestamp, ...raw },
      provenance: {
        eventId: `Journal.test.log:${offset}`,
        sourceFile: 'Journal.test.log',
        byteOffset: offset,
        timestamp,
        timestampMs: Date.parse(timestamp),
        gameVersion: '4.4.0.3',
        build: 'r330683/r0 ',
        odyssey: true,
        part: 1,
        commander: 'Hadfield',
        fid: 'F1234567',
      },
    },
  } as unknown as NormalizedEvent;
}

const state = {} as CommanderState;

/** Modelled on a real ApproachSettlement (n=441, all fields 100% except allegiance). */
const approach = (at: string, over: Record<string, unknown> = {}) =>
  ev(
    'ApproachSettlement',
    {
      Name: 'Webb Analysis Lab',
      MarketID: 4341407747,
      StationFaction: { Name: 'Workers of Hors Values Party', FactionState: 'War' },
      StationGovernment: '$government_Democracy;',
      StationGovernment_Localised: 'Democracy',
      StationAllegiance: 'Federation',
      StationEconomy: '$economy_HighTech;',
      StationEconomy_Localised: 'High Tech',
      SystemAddress: 40554691709800,
      BodyID: 2,
      BodyName: 'Owaha 2',
      ...over,
    },
    at,
  );

const disembark = (at: string, over: Record<string, unknown> = {}) =>
  ev(
    'Disembark',
    { SRV: false, Taxi: false, Multicrew: false, StarSystem: 'Owaha', SystemAddress: 40554691709800, Body: 'Owaha 2', BodyID: 2, OnStation: false, OnPlanet: true, ...over },
    at,
  );

const collect = (at: string, name: string, type = 'Component', count = 1) =>
  ev('CollectItems', { Name: name, Name_Localised: name.toUpperCase(), Type: type, OwnerID: 0, Count: count, Stolen: false }, at);

const backpackAdd = (at: string, name: string, type = 'Component', count = 1) =>
  ev('BackpackChange', { Added: [{ Name: name, Name_Localised: name.toUpperCase(), OwnerID: 0, Count: count, Type: type }] }, at);

function track(onClosed?: (s: ObservedSession) => void): SessionTracker {
  return new SessionTracker({
    project: SETTLEMENT_MATERIALS,
    companionVersion: '0.1.0',
    now: () => new Date('2026-09-03T00:00:00Z'),
    ...(onClosed ? { onSessionClosed: onClosed } : {}),
  });
}

describe('opening a session', () => {
  it('opens on disembarking onto the approached body', () => {
    const t = track();
    t.observe(approach('2026-06-14T05:14:53Z'), state);
    expect(t.openSession).toBeNull();
    t.observe(disembark('2026-06-14T05:16:00Z'), state);
    expect(t.openSession).not.toBeNull();
    expect(t.openSession!.context.settlementName).toBe('Webb Analysis Lab');
  });

  it('does not open for a disembark on a different body', () => {
    // Disembark names its station only 25.8% of the time (n=178), so the body
    // is the reliable link. Without this check an ordinary station walk would
    // be recorded as a settlement visit.
    const t = track();
    t.observe(approach('2026-06-14T05:14:53Z'), state);
    t.observe(disembark('2026-06-14T05:16:00Z', { BodyID: 99 }), state);
    expect(t.openSession).toBeNull();
  });

  it('does not open with no approach at all', () => {
    const t = track();
    t.observe(disembark('2026-06-14T05:16:00Z'), state);
    expect(t.openSession).toBeNull();
  });

  it('ignores an approach that has gone stale', () => {
    const t = track();
    t.observe(approach('2026-06-14T05:00:00Z'), state);
    // Well past the 30-minute window.
    t.observe(disembark('2026-06-14T07:00:00Z'), state);
    expect(t.openSession).toBeNull();
  });

  it('uses the most recent approach when several were made', () => {
    const t = track();
    t.observe(approach('2026-06-14T05:00:00Z', { Name: 'First Site', BodyID: 2 }), state);
    t.observe(approach('2026-06-14T05:05:00Z', { Name: 'Second Site', BodyID: 2 }), state);
    t.observe(disembark('2026-06-14T05:06:00Z'), state);
    expect(t.openSession!.context.settlementName).toBe('Second Site');
  });

  it('records absent allegiance as null rather than inventing one', () => {
    // Measured at 47.8% presence, so null is a real answer.
    const t = track();
    const a = approach('2026-06-14T05:14:53Z');
    delete (a.source.raw as Record<string, unknown>).StationAllegiance;
    t.observe(a, state);
    t.observe(disembark('2026-06-14T05:16:00Z'), state);
    expect(t.openSession!.context.allegiance).toBeNull();
    expect(t.openSession!.context.economy).toBe('High Tech');
  });
});

describe('collecting observations', () => {
  const open = () => {
    const t = track();
    t.observe(approach('2026-06-14T05:14:53Z'), state);
    t.observe(disembark('2026-06-14T05:16:00Z'), state);
    return t;
  };

  it('records collected items', () => {
    const t = open();
    t.observe(collect('2026-06-14T05:17:00Z', 'circuitboard'), state);
    t.observe(collect('2026-06-14T05:17:30Z', 'epoxyadhesive'), state);
    expect(t.openSession!.observations.map((o) => o.name)).toEqual(['circuitboard', 'epoxyadhesive']);
  });

  it('does not count one pickup twice when both events fire', () => {
    // The measurement that shaped the whole project: 258 of 281 collections
    // appear in both CollectItems and BackpackChange within a second. This
    // project reads only CollectItems, so the BackpackChange is ignored
    // outright rather than deduplicated after the fact.
    const t = open();
    t.observe(collect('2026-06-14T05:17:00Z', 'circuitboard'), state);
    t.observe(backpackAdd('2026-06-14T05:17:00Z', 'circuitboard'), state);
    expect(t.openSession!.observations).toHaveLength(1);
  });

  it('collapses a repeated CollectItems inside the dedupe window', () => {
    const t = open();
    t.observe(collect('2026-06-14T05:17:00Z', 'circuitboard'), state);
    t.observe(collect('2026-06-14T05:17:00Z', 'circuitboard'), state);
    expect(t.openSession!.observations).toHaveLength(1);
  });

  it('keeps a genuine second pickup of the same item later', () => {
    const t = open();
    t.observe(collect('2026-06-14T05:17:00Z', 'circuitboard'), state);
    t.observe(collect('2026-06-14T05:19:00Z', 'circuitboard'), state);
    expect(t.openSession!.observations).toHaveLength(2);
  });

  it('keeps Frontier’s label when given and null when not', () => {
    // Name_Localised is present on 84.3% of CollectItems (n=281).
    const t = open();
    const bare = collect('2026-06-14T05:17:00Z', 'circuitboard');
    delete (bare.source.raw as Record<string, unknown>).Name_Localised;
    t.observe(bare, state);
    expect(t.openSession!.observations[0]!.label).toBeNull();
    expect(t.openSession!.observations[0]!.category).toBe('Component');
  });

  it('ignores collections made outside a session', () => {
    const t = track();
    t.observe(collect('2026-06-14T05:17:00Z', 'circuitboard'), state);
    expect(t.sessions()).toHaveLength(0);
  });
});

describe('closing a session', () => {
  const open = () => {
    const t = track();
    t.observe(approach('2026-06-14T05:14:53Z'), state);
    t.observe(disembark('2026-06-14T05:16:00Z'), state);
    t.observe(collect('2026-06-14T05:17:00Z', 'circuitboard'), state);
    return t;
  };

  it('closes on embark and records the duration', () => {
    const t = open();
    t.observe(ev('Embark', {}, '2026-06-14T05:26:00Z'), state);
    const [s] = t.sessions();
    expect(s!.outcome).toBe('ended');
    expect(s!.endEvent).toBe('Embark');
    expect(s!.durationSeconds).toBe(600);
  });

  it('treats death as an abortive ending, not a completed visit', () => {
    // 2 of 30 real sessions ended this way; the spec's proposed boundary model
    // did not mention death at all.
    const t = open();
    t.observe(ev('Died', {}, '2026-06-14T05:20:00Z'), state);
    expect(t.sessions()[0]!.outcome).toBe('died');
  });

  it('closes on liftoff without an embark', () => {
    // Measured once in the corpus.
    const t = open();
    t.observe(ev('Liftoff', {}, '2026-06-14T05:20:00Z'), state);
    expect(t.sessions()[0]!.endEvent).toBe('Liftoff');
  });

  it('does not count the closing event as an observation', () => {
    const t = open();
    t.observe(ev('Embark', {}, '2026-06-14T05:26:00Z'), state);
    expect(t.sessions()[0]!.observations).toHaveLength(1);
  });

  it('marks a session interrupted when the journal simply stops', () => {
    // Different evidence from a clean ending, and §13 wants it counted.
    const t = open();
    t.finish();
    expect(t.sessions()[0]!.outcome).toBe('interrupted');
  });

  it('notifies on close', () => {
    const closed: ObservedSession[] = [];
    const t = new SessionTracker({
      project: SETTLEMENT_MATERIALS,
      companionVersion: '0.1.0',
      onSessionClosed: (s) => closed.push(s),
    });
    t.observe(approach('2026-06-14T05:14:53Z'), state);
    t.observe(disembark('2026-06-14T05:16:00Z'), state);
    t.observe(ev('Embark', {}, '2026-06-14T05:26:00Z'), state);
    expect(closed).toHaveLength(1);
  });

  it('can run a second session after the first closes', () => {
    const t = open();
    t.observe(ev('Embark', {}, '2026-06-14T05:26:00Z'), state);
    t.observe(approach('2026-06-14T06:00:00Z', { Name: 'Other Site', BodyID: 3 }), state);
    t.observe(disembark('2026-06-14T06:02:00Z', { BodyID: 3 }), state);
    t.observe(ev('Embark', {}, '2026-06-14T06:12:00Z'), state);
    expect(t.sessions()).toHaveLength(2);
    expect(t.sessions()[1]!.context.settlementName).toBe('Other Site');
  });
});

describe('completeness', () => {
  it('defaults to unknown and is never inferred', () => {
    // §12: the app cannot know whether every container was searched, whether
    // someone looted first, or whether the player skipped areas.
    const t = track();
    t.observe(approach('2026-06-14T05:14:53Z'), state);
    t.observe(disembark('2026-06-14T05:16:00Z'), state);
    t.observe(ev('Embark', {}, '2026-06-14T05:26:00Z'), state);
    expect(t.sessions()[0]!.completeness).toBe('unknown');
  });

  it('can be marked by the commander afterwards', () => {
    const t = track();
    t.observe(approach('2026-06-14T05:14:53Z'), state);
    t.observe(disembark('2026-06-14T05:16:00Z'), state);
    t.observe(ev('Embark', {}, '2026-06-14T05:26:00Z'), state);
    const id = t.sessions()[0]!.id;
    expect(t.markCompleteness(id, 'complete')).toBe(true);
    expect(t.sessions()[0]!.completeness).toBe('complete');
  });
});

describe('plausibility', () => {
  const base = (over: Partial<ObservedSession>): ObservedSession =>
    ({
      id: 'x', projectId: SETTLEMENT_MATERIALS.id, projectVersion: 1,
      startedAt: '2026-06-14T05:16:00Z', endedAt: '2026-06-14T05:26:00Z',
      durationSeconds: 600, context: {}, observations: [], outcome: 'ended',
      endEvent: 'Embark', completeness: 'unknown', commander: null, commanderFid: null,
      gameVersion: null, gameBuild: null, companionVersion: '0.1.0', sessionKey: 'j',
      ...over,
    }) as ObservedSession;

  it('rejects a visit shorter than a minute', () => {
    // 4 of 30 real sessions: approach and leave, not a visit.
    expect(isPlausible(base({ durationSeconds: 20 }), SETTLEMENT_MATERIALS)).toBe(false);
  });

  it('rejects a session that clearly missed its ending', () => {
    // Precautionary: no session in the corpus reaches this, but a missed end
    // event would otherwise span hours of unrelated play.
    expect(isPlausible(base({ durationSeconds: 5000 }), SETTLEMENT_MATERIALS)).toBe(false);
  });

  it('rejects an interrupted session', () => {
    expect(isPlausible(base({ outcome: 'interrupted' }), SETTLEMENT_MATERIALS)).toBe(false);
  });

  it('accepts an ordinary visit', () => {
    expect(isPlausible(base({}), SETTLEMENT_MATERIALS)).toBe(true);
  });
});

describe('the project definition itself', () => {
  it('names the fields the game does not expose', () => {
    // §12 asked for these three; none appears in any journal event. Recorded
    // in the definition so the gap reads as a finding, not an oversight.
    expect(SETTLEMENT_MATERIALS.unavailableFields).toEqual([
      'security',
      'powered/unpowered state',
      'abandoned/active state',
    ]);
  });

  it('does not read BackpackChange', () => {
    const events = SETTLEMENT_MATERIALS.observe.flatMap((r) =>
      typeof r.on === 'string' ? [r.on] : [...r.on],
    );
    expect(events).toEqual(['CollectItems']);
  });
});

describe('Guardian sites are not settlements', () => {
  /**
   * `ApproachSettlement` fires for Guardian ruins too. Measured on 2026-09-27:
   * 5 of 462 events, carrying only a name, body and coordinates.
   */
  const guardian = (at: string) =>
    ev(
      'ApproachSettlement',
      {
        Name: '$Ancient_Small_005:#index=1;',
        Name_Localised: 'Guardian Structure',
        SystemAddress: 1184840454858,
        BodyID: 18,
        BodyName: 'Synuefe NL-N c23-4 B 3',
        Latitude: 51.209953,
        Longitude: 89.097206,
      },
      at,
    );

  it('does not open a session for Guardian ruins', () => {
    // Without the MarketID guard this recorded a settlement visit with a null
    // economy, which is not a thin observation but a different subject.
    const t = track();
    t.observe(guardian('2026-09-10T16:56:00Z'), state);
    t.observe(disembark('2026-09-10T16:58:00Z', { BodyID: 18 }), state);
    expect(t.openSession).toBeNull();
  });

  it('does not let a Guardian approach mask a real settlement', () => {
    // Both are on the same body. The real approach must still win, rather than
    // the Guardian one displacing it as the most recent context.
    const t = track();
    t.observe(approach('2026-09-10T16:50:00Z', { BodyID: 18 }), state);
    t.observe(guardian('2026-09-10T16:56:00Z'), state);
    t.observe(disembark('2026-09-10T16:58:00Z', { BodyID: 18 }), state);
    expect(t.openSession).not.toBeNull();
    expect(t.openSession!.context.settlementName).toBe('Webb Analysis Lab');
  });
});
