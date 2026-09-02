import { describe, expect, it } from 'vitest';
import {
  JournalSessionContext,
  UNKNOWN,
  normalize,
  parseLine,
  type NormalizedEvent,
} from '@edfm/elite-journal';

import {
  MissionStore,
  explainMission,
  missionCaveat,
  missionCategory,
  missionTypeKey,
} from '../src/index.js';

let offset = 0;
const ctx = new JournalSessionContext();

function ev(line: string): NormalizedEvent {
  const r = parseLine(line, 'J.log', (offset += 100), ctx);
  if (!r?.ok) throw new Error('fixture failed to parse');
  return normalize(r.event);
}

/* ---- All fixtures below are verbatim from the validation corpus ---- */

const MASSACRE =
  '{ "timestamp":"2026-08-08T03:00:35Z", "event":"MissionAccepted", "Faction":"Sirius Special Forces", "Name":"Mission_Massacre_Legal_Military", "LocalisedName":"Engage and destroy Black Heart Gang Pirates", "TargetType":"$MissionUtil_FactionTag_Pirate;", "TargetType_Localised":"Pirates", "TargetFaction":"Black Heart Gang", "KillCount":15, "DestinationSystem":"Wregoe AB-F d11-17", "DestinationStation":"Volta Installation", "Expiry":"2026-08-09T14:23:40Z", "Wing":false, "Influence":"++", "Reputation":"++", "Reward":11624394, "MissionID":1062787030 }';

const DONATION_NO_DESTINATION =
  '{ "timestamp":"2026-08-31T02:20:49Z", "event":"MissionAccepted", "Faction":"Sirius Special Forces", "Name":"Mission_AltruismCredits", "LocalisedName":"Donate 750,000 Cr to the cause", "Donation":"750000", "Expiry":"2026-08-31T05:22:50Z", "Wing":false, "Influence":"++", "Reputation":"++", "MissionID":1064798745 }';

/** Mission_Altruism: a *commodity* donation — needs 32t of hold, unlike AltruismCredits. */
const COMMODITY_DONATION =
  '{ "timestamp":"2026-07-25T04:44:38Z", "event":"MissionAccepted", "Faction":"Sirius Special Forces", "Name":"Mission_Altruism", "LocalisedName":"Donate 32 units of Micro Controllers", "Commodity":"$MicroControllers_Name;", "Commodity_Localised":"Micro Controllers", "Count":32, "DestinationSystem":"Wregoe WP-G d10-70", "DestinationStation":"Sythan Folly", "Expiry":"2026-07-26T16:47:04Z", "Wing":false, "Influence":"+", "Reputation":"+", "MissionID":1061622760 }';

const COURIER =
  '{ "timestamp":"2026-07-25T05:00:00Z", "event":"MissionAccepted", "Faction":"Sirius Special Forces", "Name":"Mission_Courier", "LocalisedName":"Deliver data", "Count":4, "Commodity":"$Data_Name;", "DestinationSystem":"Wregoe AB-F d11-17", "DestinationStation":"Volta Installation", "Expiry":"2026-07-26T00:00:00Z", "Wing":false, "Influence":"+", "Reputation":"+", "MissionID":1061622848 }';

const REDIRECTED =
  '{ "timestamp":"2026-08-09T03:49:18Z", "event":"MissionRedirected", "MissionID":1062787030, "Name":"Mission_Massacre_Legal_Military", "LocalisedName":"x", "NewDestinationStation":"Chamberlain Rest", "NewDestinationSystem":"HIP 97950", "OldDestinationStation":"Volta Installation", "OldDestinationSystem":"Wregoe AB-F d11-17" }';

const COMPLETED =
  '{ "timestamp":"2026-08-31T02:21:05Z", "event":"MissionCompleted", "Faction":"Sirius Special Forces", "Name":"Mission_AltruismCredits_name", "LocalisedName":"Donate 750,000 Cr", "MissionID":1064798745, "Donation":"750000", "Donated":750000, "FactionEffects":[] }';

/** Snapshot Name is `Mission_Altruism_name`, not `Mission_Altruism`. */
const SNAPSHOT_ACTIVE =
  '{ "timestamp":"2026-07-25T17:01:41Z", "event":"Missions", "Active":[ { "MissionID":1061622760, "Name":"Mission_Altruism_name", "PassengerMission":false, "Expires":85523 } ], "Failed":[  ], "Complete":[  ] }';

const SNAPSHOT_EMPTY =
  '{ "timestamp":"2026-07-25T18:00:00Z", "event":"Missions", "Active":[  ], "Failed":[  ], "Complete":[  ] }';

/** The colonisation pseudo-mission: MissionID is 2^64-1. */
const SNAPSHOT_COLONISATION =
  '{ "timestamp":"2026-08-23T19:45:20Z", "event":"Missions", "Active":[ { "MissionID":18446744073709551615, "Name":"$Mission_Colonisation_Initial_Name;", "Name_Localised":"Construct primary port", "PassengerMission":false, "Expires":1789699599 } ], "Failed":[  ], "Complete":[  ] }';

describe('mission type keys', () => {
  it('folds Frontier inconsistent casing', () => {
    // Both forms occur in the corpus.
    expect(missionTypeKey('Mission_Courier')).toBe('mission_courier');
    expect(missionTypeKey('MISSION_Salvage_Illegal')).toBe('mission_salvage_illegal');
  });

  it('folds the snapshot _name suffix and $...; wrapping to the same key', () => {
    // The same mission appears in all three forms across events; joining by name
    // would fail without this.
    expect(missionTypeKey('Mission_Altruism_name')).toBe('mission_altruism');
    expect(missionTypeKey('$Mission_Colonisation_Initial_Name;')).toBe('mission_colonisation_initial');
  });

  it('categorises the real mission names observed', () => {
    expect(missionCategory(missionTypeKey('Mission_Massacre_Legal_Military'))).toBe('massacre');
    expect(missionCategory(missionTypeKey('Mission_Assassinate_Planetary'))).toBe('assassination');
    expect(missionCategory(missionTypeKey('Mission_AltruismCredits'))).toBe('donation');
    expect(missionCategory(missionTypeKey('MISSION_Salvage_Illegal'))).toBe('salvage');
    expect(missionCategory(missionTypeKey('Mission_Collect_Industrial'))).toBe('collect');
    expect(missionCategory(missionTypeKey('Mission_Mining'))).toBe('mining');
    expect(missionCategory(missionTypeKey('Mission_Courier_RankFed'))).toBe('courier');
    expect(missionCategory(missionTypeKey('MISSION_genericPermit1'))).toBe('permit');
    expect(missionCategory(missionTypeKey('Something_Unknown'))).toBe('other');
  });
});

describe('accepting missions', () => {
  it('captures a massacre mission in full', () => {
    const s = new MissionStore();
    expect(s.observe(ev(MASSACRE))).toBe(true);

    const m = s.get(1062787030)!;
    expect(m.category).toBe('massacre');
    expect(m.killCount).toBe(15);
    expect(m.targetFaction).toBe('Black Heart Gang');
    expect(m.destinationSystem).toBe('Wregoe AB-F d11-17');
    expect(m.reward).toBe(11624394);
    expect(m.status).toBe('active');
  });

  it('records a missing destination as UNKNOWN rather than inventing one', () => {
    // DestinationSystem is present on only 54.8% of accepted missions.
    const s = new MissionStore();
    s.observe(ev(DONATION_NO_DESTINATION));

    const m = s.get(1064798745)!;
    expect(m.destinationSystem).toBe(UNKNOWN);
    expect(m.destinationStation).toBe(UNKNOWN);
    expect(m.category).toBe('donation');
  });

  it('reads Donation even though it is a string on MissionAccepted', () => {
    const s = new MissionStore();
    s.observe(ev(DONATION_NO_DESTINATION));
    expect(s.get(1064798745)!.donation).toBe(750000);
  });

  it('leaves passenger fields UNKNOWN, since none were observed', () => {
    const s = new MissionStore();
    s.observe(ev(MASSACRE));
    const m = s.get(1062787030)!;
    expect(m.passengerCount).toBe(UNKNOWN);
    expect(m.passengerVips).toBe(UNKNOWN);
  });

  it('ignores events that are not missions', () => {
    const s = new MissionStore();
    expect(s.observe(ev('{ "timestamp":"2026-09-01T00:00:00Z", "event":"Music", "MusicTrack":"NoTrack" }'))).toBe(false);
  });
});

describe('mission lifecycle', () => {
  it('marks a mission completed', () => {
    const s = new MissionStore();
    s.observe(ev(DONATION_NO_DESTINATION));
    expect(s.observe(ev(COMPLETED))).toBe(true);
    expect(s.get(1064798745)!.status).toBe('completed');
    expect(s.active()).toHaveLength(0);
  });

  it('handles failure and abandonment', () => {
    const s = new MissionStore();
    s.observe(ev(MASSACRE));
    s.observe(ev('{ "timestamp":"2026-08-09T00:00:00Z", "event":"MissionFailed", "Name":"x", "MissionID":1062787030 }'));
    expect(s.get(1062787030)!.status).toBe('failed');

    const s2 = new MissionStore();
    s2.observe(ev(MASSACRE));
    s2.observe(ev('{ "timestamp":"2026-08-09T00:00:00Z", "event":"MissionAbandoned", "Name":"x", "MissionID":1062787030 }'));
    expect(s2.get(1062787030)!.status).toBe('abandoned');
  });

  it('applies a redirect to the destination', () => {
    const s = new MissionStore();
    s.observe(ev(MASSACRE));
    expect(s.observe(ev(REDIRECTED))).toBe(true);

    const m = s.get(1062787030)!;
    expect(m.destinationSystem).toBe('HIP 97950');
    expect(m.destinationStation).toBe('Chamberlain Rest');
    expect(m.redirected).toBe(true);
  });

  it('ignores a redirect for a mission it never saw accepted', () => {
    const s = new MissionStore();
    expect(s.observe(ev(REDIRECTED))).toBe(false);
  });

  it('is idempotent when the same completion is replayed', () => {
    // Replaying a journal must not double-apply.
    const s = new MissionStore();
    s.observe(ev(DONATION_NO_DESTINATION));
    expect(s.observe(ev(COMPLETED))).toBe(true);
    expect(s.observe(ev(COMPLETED))).toBe(false);
  });

  it('records a completion for a mission accepted before we were watching', () => {
    const s = new MissionStore();
    expect(s.observe(ev(COMPLETED))).toBe(true);
    const m = s.get(1064798745)!;
    expect(m.status).toBe('completed');
    expect(m.destinationSystem).toBe(UNKNOWN); // we genuinely never learned it
  });
});

describe('reconciliation against the Missions snapshot', () => {
  it('keeps a mission the game still lists as active', () => {
    const s = new MissionStore();
    s.observe(ev(COMMODITY_DONATION));
    s.observe(ev(SNAPSHOT_ACTIVE));
    expect(s.get(1061622760)!.status).toBe('active');
  });

  it('joins on MissionID, not on Name', () => {
    // The snapshot says `Mission_Altruism_name`; MissionAccepted said
    // `Mission_Altruism`. Name-based joining would silently fail here.
    const s = new MissionStore();
    s.observe(ev(COMMODITY_DONATION));
    s.observe(ev(SNAPSHOT_ACTIVE));
    expect(s.active()).toHaveLength(1);
  });

  it('marks a vanished mission ended-unknown rather than completed', () => {
    // The game stopped listing it, but never said why. Claiming "completed"
    // would invent an outcome and inflate the commander's record.
    const s = new MissionStore();
    s.observe(ev(COMMODITY_DONATION));
    expect(s.observe(ev(SNAPSHOT_EMPTY))).toBe(true);
    expect(s.get(1061622760)!.status).toBe('ended-unknown');
  });

  it('honours Complete and Failed lists in the snapshot', () => {
    const s = new MissionStore();
    s.observe(ev(COMMODITY_DONATION));
    s.observe(
      ev(
        '{ "timestamp":"2026-07-25T18:00:00Z", "event":"Missions", "Active":[ ], "Failed":[ ], "Complete":[ { "MissionID":1061622760, "Name":"Mission_Altruism_name", "PassengerMission":false, "Expires":0 } ] }',
      ),
    );
    expect(s.get(1061622760)!.status).toBe('completed');
  });

  it('ignores the colonisation pseudo-mission whose id exceeds safe integers', () => {
    // MissionID 2^64-1 loses precision on JSON parse; treating it as a real id
    // risks colliding with, or silently overwriting, a genuine mission.
    const s = new MissionStore();
    s.observe(ev(COMMODITY_DONATION));
    s.observe(ev(SNAPSHOT_COLONISATION));

    expect(s.all().some((m) => !m.idIsReliable)).toBe(false);
    // The genuine mission is absent from that snapshot, so it ended unknown —
    // but the sentinel must not have been recorded as a mission.
    expect(s.all()).toHaveLength(1);
    expect(s.get(1061622760)!.status).toBe('ended-unknown');
  });

  it('does nothing for a snapshot with no arrays at all', () => {
    const s = new MissionStore();
    expect(s.observe(ev('{ "timestamp":"2026-07-25T18:00:00Z", "event":"Missions" }'))).toBe(false);
  });
});

describe('explanations', () => {
  function missionFrom(line: string) {
    const s = new MissionStore();
    s.observe(ev(line));
    return s.all()[0]!;
  }

  it('explains what "source and return" actually asks of the player', () => {
    // The journal cannot distinguish this from a provided-cargo delivery: both
    // carry Commodity and Count and nothing else. It is editorial knowledge.
    const m = missionFrom(
      '{ "timestamp":"2026-07-25T05:00:00Z", "event":"MissionAccepted", "Faction":"F", "Name":"Mission_Collect_Industrial", "LocalisedName":"Source and return 1386 units of Bertrandite", "Commodity":"$Bertrandite_Name;", "Count":1386, "DestinationSystem":"Sol", "Expiry":"2026-07-26T00:00:00Z", "Wing":false, "Influence":"+", "Reputation":"+", "MissionID":901 }',
    );
    const text = explainMission(m)!;
    expect(text).toContain('acquire the commodity yourself');
    expect(text).toContain('Nothing is provided');
  });

  it('distinguishes a commodity donation from a credit donation', () => {
    // Both are category 'donation', but only one costs you cargo and money for
    // goods. Splitting on the data rather than the category is what makes this
    // possible.
    const commodity = missionFrom(COMMODITY_DONATION);
    const credits = missionFrom(DONATION_NO_DESTINATION);

    expect(explainMission(commodity)).toContain('source it yourself');
    expect(explainMission(credits)).toContain('credits');
    expect(explainMission(commodity)).not.toBe(explainMission(credits));
  });

  it('warns that kill progress is not journalled', () => {
    const m = missionFrom(MASSACRE);
    expect(missionCaveat(m)).toContain('does not record kill progress');
  });

  it('returns null rather than filler when it has nothing useful to say', () => {
    // A vague line under every mission trains the eye to skip the useful ones.
    const m = missionFrom(
      '{ "timestamp":"2026-07-25T05:00:00Z", "event":"MissionAccepted", "Faction":"F", "Name":"Mission_SomethingNew", "LocalisedName":"x", "Expiry":"2026-07-26T00:00:00Z", "Wing":false, "Influence":"+", "Reputation":"+", "MissionID":902 }',
    );
    expect(m.category).toBe('other');
    expect(explainMission(m)).toBeNull();
    expect(missionCaveat(m)).toBeNull();
  });
});

describe('grouping', () => {
  function loaded() {
    const s = new MissionStore({ now: () => Date.parse('2026-07-25T06:00:00Z') });
    s.observe(ev(COMMODITY_DONATION));
    s.observe(ev(COURIER));
    s.observe(ev(MASSACRE));
    s.observe(ev(DONATION_NO_DESTINATION));
    return s;
  }

  it('separates missions with no destination instead of bucketing them', () => {
    const { groups, withoutDestination } = loaded().byDestination();
    expect(withoutDestination.map((m) => m.missionId)).toEqual([1064798745]);
    expect(groups.every((g) => g.system.length > 0)).toBe(true);
  });

  it('aggregates a destination', () => {
    const { groups } = loaded().byDestination();
    const volta = groups.find((g) => g.station === 'Volta Installation')!;

    expect(volta.missionCount).toBe(2); // courier + massacre
    expect(volta.cargoRequired).toBe(4); // only the courier carries cargo
    expect(volta.killsRequired).toBe(15);
    expect(volta.targetFactions).toEqual(['Black Heart Gang']);
    expect(volta.earliestExpiry).toBe('2026-07-26T00:00:00Z');
  });

  it('flags a group whose cargo figure is incomplete', () => {
    // A carrying mission that reported no Count must not silently contribute 0.
    const s = new MissionStore();
    s.observe(
      ev(
        '{ "timestamp":"2026-07-25T05:00:00Z", "event":"MissionAccepted", "Faction":"F", "Name":"Mission_Delivery_Boom", "LocalisedName":"x", "DestinationSystem":"Sol", "DestinationStation":"Abraham Lincoln", "Expiry":"2026-07-26T00:00:00Z", "Wing":false, "Influence":"+", "Reputation":"+", "MissionID":555 }',
      ),
    );
    const group = s.byDestination().groups[0]!;
    expect(group.cargoRequired).toBe(0);
    expect(group.cargoIncomplete).toBe(true);
  });

  it('orders by expiry, putting missions with no expiry last', () => {
    const s = new MissionStore();
    s.observe(ev(COURIER)); // expires 2026-07-26T00:00:00Z
    s.observe(
      ev(
        '{ "timestamp":"2026-07-25T05:00:00Z", "event":"MissionAccepted", "Faction":"F", "Name":"Mission_Courier", "LocalisedName":"no expiry", "DestinationSystem":"Sol", "Wing":false, "Influence":"+", "Reputation":"+", "MissionID":777 }',
      ),
    );
    expect(s.byExpiry().map((m) => m.missionId)).toEqual([1061622848, 777]);
  });

  it('summarises without guessing', () => {
    const summary = loaded().summary();
    expect(summary.active).toBe(4);
    expect(summary.withoutDestination).toBe(1);
    // 32 from the commodity donation + 4 from the courier. The commodity
    // donation counts despite being categorised 'donation', because cargo is
    // decided by the presence of Commodity+Count, not by category.
    expect(summary.totalCargo).toBe(36);
    expect(summary.categories['massacre']).toBe(1);
    // Both Mission_Altruism and Mission_AltruismCredits are donations; only the
    // first needs cargo. That difference is exactly why category cannot be used
    // to work out cargo.
    expect(summary.categories['donation']).toBe(2);
  });
});
