/**
 * When a context starts, how long it lasts, and whose it is.
 *
 * Every journal line below is copied from the shape of a real one in the
 * corpus; names of places are the game's own. Frontier IDs and commander names
 * are invented (F0000001 / F0000002), because fixtures are public.
 *
 * The resolver's clock is injected, and set relative to the lines' own
 * timestamps, so each test states exactly how long after the event it is read.
 */

import { describe, expect, it } from 'vitest';
import {
  JournalSessionContext,
  applyEvent,
  initialState,
  normalize,
  parseLine,
  type CommanderState,
  type NormalizedEvent,
} from '@edfm/elite-journal';

import {
  BUNDLED_RULES,
  ContextResolver,
  contextTiming,
  resourceUrl,
  safeExternalUrl,
  sanitise,
  type ContextRuleSet,
} from '../src/index.js';

/* ------------------------------------------------------------- harness */

const MIN = 60_000;
const T = (iso: string) => Date.parse(iso);

/** A commander's game: one state, one resolver, lines fed in journal order. */
function game(now: { ms: number }, ruleSet: ContextRuleSet = BUNDLED_RULES, maxActive = 10) {
  const state: CommanderState = initialState();
  const resolver = new ContextResolver(ruleSet, { now: () => now.ms, maxActive });
  let ctx = new JournalSessionContext();
  let offset = 0;
  let file = 'Journal.2026-10-09T180000.01.log';
  return {
    state,
    resolver,
    /** A new journal file, as a fresh game launch writes. */
    newFile(name: string) {
      file = name;
      ctx = new JournalSessionContext();
      offset = 0;
    },
    feed(line: string): boolean {
      const r = parseLine(line, file, (offset += 200), ctx);
      if (!r?.ok) throw new Error(`fixture failed to parse: ${line.slice(0, 60)}`);
      const event: NormalizedEvent = normalize(r.event);
      applyEvent(state, event);
      return resolver.observe(event, state);
    },
    ids(): string[] {
      return resolver.current().map((c) => c.rule.id);
    },
    get(id: string) {
      return resolver.all().find((c) => c.rule.id === id);
    },
  };
}

/* ------------------------------------------------------------ fixtures */

const HEADER = (at: string) =>
  `{ "timestamp":"${at}", "event":"Fileheader", "part":1, "language":"English/UK", "Odyssey":true, "gameversion":"4.4.1.1", "build":"r332841/r0 " }`;
const COMMANDER = (at: string, fid: string, name: string) =>
  `{ "timestamp":"${at}", "event":"Commander", "FID":"${fid}", "Name":"${name}" }`;
const LOAD_GAME = (at: string, fid: string, name: string) =>
  `{ "timestamp":"${at}", "event":"LoadGame", "FID":"${fid}", "Commander":"${name}", "Horizons":true, "Odyssey":true, "Ship":"PantherMkII", "ShipID":21, "ShipName":"", "ShipIdent":"", "FuelLevel":32.0, "FuelCapacity":32.0, "GameMode":"Solo", "Credits":1000, "Loan":0, "language":"English/UK", "gameversion":"4.4.1.1", "build":"r332841/r0 " }`;
const SHUTDOWN = (at: string) => `{ "timestamp":"${at}", "event":"Shutdown" }`;
const MUSIC = (at: string) => `{ "timestamp":"${at}", "event":"Music", "MusicTrack":"NoTrack" }`;

const PROSPECTED = (at: string) =>
  `{ "timestamp":"${at}", "event":"ProspectedAsteroid", "Materials":[ { "Name":"Platinum", "Proportion":58.822453 } ], "Content":"$AsteroidMaterialContent_High;", "Content_Localised":"Material Content: High", "Remaining":100.0 }`;
const REFINED = (at: string) =>
  `{ "timestamp":"${at}", "event":"MiningRefined", "Type":"$platinum_name;", "Type_Localised":"Platinum" }`;

const DOCKED_FC = (at: string) =>
  `{ "timestamp":"${at}", "event":"Docked", "StationName":"HBN-TXN", "StationType":"FleetCarrier", "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe KO-G c24-7", "SystemAddress":2008870359762, "MarketID":3703420416, "StationFaction":{ "Name":"FleetCarrier" }, "StationGovernment":"$government_Carrier;", "StationServices":[ "dock", "autodock", "commodities", "contacts", "crewlounge", "rearm", "refuel", "repair", "engineer", "flightcontroller", "stationoperations", "stationMenu", "carriermanagement", "carrierfuel", "socialspace", "exploration", "vistagenomics" ], "StationEconomy":"$economy_Carrier;", "StationEconomies":[], "DistFromStarLS":1000.0 }`;
const UNDOCKED = (at: string) =>
  `{ "timestamp":"${at}", "event":"Undocked", "StationName":"HBN-TXN", "StationType":"FleetCarrier", "MarketID":3703420416, "Taxi":false, "Multicrew":false }`;
const SUPERCRUISE_ENTRY = (at: string) =>
  `{ "timestamp":"${at}", "event":"SupercruiseEntry", "Taxi":false, "Multicrew":false, "StarSystem":"Gladyangar", "SystemAddress":3657265287914 }`;

/** Verbatim shape: an approach carries the settlement's whole service list. */
const APPROACH_SETTLEMENT = (at: string) =>
  `{ "timestamp":"${at}", "event":"ApproachSettlement", "Name":"Boodt Base", "MarketID":3521428480, "StationFaction":{ "Name":"The Dark Armada" }, "StationGovernment":"$government_Patronage;", "StationServices":[ "dock", "autodock", "commodities", "contacts", "exploration", "missions", "refuel", "repair", "stationMenu", "vistagenomics", "pioneersupplies", "materialtrader" ], "StationEconomy":"$economy_Refinery;", "StationEconomies":[], "SystemAddress":3657265287914, "BodyID":13, "BodyName":"Gladyangar 2", "Latitude":-0.857149, "Longitude":73.282791 }`;
/** Docking at that same settlement seven minutes later, as the corpus shows. */
const DOCKED_SETTLEMENT = (at: string) =>
  `{ "timestamp":"${at}", "event":"Docked", "StationName":"Boodt Base", "StationType":"CraterPort", "Taxi":false, "Multicrew":false, "StarSystem":"Gladyangar", "SystemAddress":3657265287914, "MarketID":3521428480, "StationFaction":{ "Name":"The Dark Armada" }, "StationGovernment":"$government_Patronage;", "StationServices":[ "dock", "autodock", "commodities", "contacts", "exploration", "missions", "refuel", "repair", "stationMenu", "vistagenomics", "pioneersupplies", "materialtrader" ], "StationEconomy":"$economy_Refinery;", "StationEconomies":[], "DistFromStarLS":12.0 }`;

const FSS_BIO = (at: string) =>
  `{ "timestamp":"${at}", "event":"FSSBodySignals", "BodyName":"LHS 475 2 e", "BodyID":25, "SystemAddress":5069269378481, "Signals":[ { "Type":"$SAA_SignalType_Biological;", "Type_Localised":"Biological", "Count":2 } ] }`;
const FSS_GEO = (at: string) =>
  `{ "timestamp":"${at}", "event":"FSSBodySignals", "BodyName":"LHS 475 4 a", "BodyID":51, "SystemAddress":5069269378481, "Signals":[ { "Type":"$SAA_SignalType_Geological;", "Type_Localised":"Geological", "Count":2 } ] }`;
const FSS_MINING = (at: string) =>
  `{ "timestamp":"${at}", "event":"FSSBodySignals", "BodyName":"LP 844-28 AB 2", "BodyID":24, "SystemAddress":671491368353, "Signals":[ { "Type":"$PlanetaryMiningLocation_Name;", "Type_Localised":"Planetary Mining Location", "Count":5 } ] }`;
const SAA_MINING = (at: string) =>
  `{ "timestamp":"${at}", "event":"SAASignalsFound", "BodyName":"LP 844-28 AB 2", "SystemAddress":671491368353, "BodyID":24, "Signals":[ { "Type":"$PlanetaryMiningLocation_Name;", "Type_Localised":"Planetary Mining Location", "Count":5 }, { "Type":"$SAA_SignalType_Human;", "Type_Localised":"Human", "Count":2 } ], "Genuses":[  ] }`;
/** A scan with no BodyName: never seen in the corpus, so the rule must still read sensibly. */
const SAA_MINING_NO_NAME = (at: string) =>
  `{ "timestamp":"${at}", "event":"SAASignalsFound", "SystemAddress":671491368353, "BodyID":24, "Signals":[ { "Type":"$PlanetaryMiningLocation_Name;", "Count":5 } ], "Genuses":[] }`;
const MERITS = (at: string) =>
  `{ "timestamp":"${at}", "event":"PowerplayMerits", "Power":"Felicia Winters", "MeritsGained":54, "TotalMerits":54 }`;
const ENGINEER_CRAFT = (at: string) =>
  `{ "timestamp":"${at}", "event":"EngineerCraft", "Slot":"FrameShiftDrive", "Module":"int_hyperdrive_size6_class4", "Ingredients":[ { "Name":"disruptedwakeechoes", "Count":1 } ], "Engineer":"Felicity Farseer", "EngineerID":300100, "BlueprintID":128673690, "BlueprintName":"FSD_LongRange", "Level":1, "Quality":0.2 }`;
const FSD_JUMP = (at: string) =>
  `{ "timestamp":"${at}", "event":"FSDJump", "Taxi":false, "Multicrew":false, "StarSystem":"Diaguandri", "SystemAddress":670417429889, "StarPos":[-41.06,-62.15,-103.25], "JumpDist":8.523, "FuelUsed":0.62, "FuelLevel":31.2 }`;

/* --------------------------------------------- time: the journal's clock */

describe('event timestamps and TTL', () => {
  it('a context runs from the line’s own time, not from when it was read', () => {
    const now = { ms: T('2026-10-09T18:05:00Z') };
    const g = game(now);
    g.feed(PROSPECTED('2026-10-09T18:00:00Z'));

    const ctx = g.get('mining-prospecting')!;
    expect(ctx.matchedAt).toBe(T('2026-10-09T18:00:00Z'));
    // 600 s TTL from the line, not from the read five minutes later.
    expect(ctx.expiresAt).toBe(T('2026-10-09T18:10:00Z'));

    now.ms = T('2026-10-09T18:10:01Z');
    expect(g.ids()).not.toContain('mining-prospecting');
  });

  it('a line older than its TTL never starts a context (historical replay)', () => {
    // The app re-reads a session at startup. A prospect from three hours ago is history.
    const now = { ms: T('2026-10-09T21:00:00Z') };
    const g = game(now);
    expect(g.feed(PROSPECTED('2026-10-09T18:00:00Z'))).toBe(false);
    expect(g.resolver.all()).toEqual([]);
  });

  it('the last minutes of a session still being played come back as they were', () => {
    // Restarting the app mid-mining is not a reason to lose the mining guides.
    const now = { ms: T('2026-10-09T18:04:00Z') };
    const g = game(now);
    g.feed(PROSPECTED('2026-10-09T17:20:00Z')); // expired by now
    g.feed(PROSPECTED('2026-10-09T18:02:00Z')); // still within its 10 minutes
    expect(g.get('mining-prospecting')?.matchedAt).toBe(T('2026-10-09T18:02:00Z'));
  });

  it('a line stamped in the future is treated as now, not trusted to outlive its TTL', () => {
    const now = { ms: T('2026-10-09T18:00:00Z') };
    const g = game(now);
    g.feed(PROSPECTED('2026-10-09T19:00:00Z'));
    expect(g.get('mining-prospecting')?.expiresAt).toBe(now.ms + 600_000);
  });

  it('an unreadable timestamp is treated as now', () => {
    const now = { ms: T('2026-10-09T18:00:00Z') };
    const g = game(now);
    g.feed(PROSPECTED('not a time'));
    expect(g.get('mining-prospecting')?.matchedAt).toBe(now.ms);
  });

  it('prune() ends a context at its own time with no further journal line', () => {
    const now = { ms: T('2026-10-09T18:00:30Z') };
    const g = game(now);
    g.feed(REFINED('2026-10-09T18:00:00Z'));
    expect(g.resolver.prune()).toBe(false);
    now.ms = T('2026-10-09T18:10:00Z');
    expect(g.resolver.prune()).toBe(true);
    expect(g.resolver.all()).toEqual([]);
  });

  it('decay is measured from the line’s time, so an old activity ranks below a fresh one', () => {
    // Interdicted (95, 3 min) read 2.5 minutes late is worth less than fresh prospecting (70).
    const now = { ms: T('2026-10-09T18:02:30Z') };
    const g = game(now);
    g.feed(
      '{ "timestamp":"2026-10-09T18:00:00Z", "event":"Interdicted", "Submitted":true, "Interdictor":"Pirate", "IsPlayer":false }',
    );
    g.feed(PROSPECTED('2026-10-09T18:02:29Z'));
    expect(g.ids()[0]).toBe('mining-prospecting');
  });
});

/* ----------------------------------------------- commanders and sessions */

describe('commander isolation', () => {
  it('another commander never sees the previous commander’s guides', () => {
    const now = { ms: T('2026-10-09T18:30:00Z') };
    const g = game(now);
    g.feed(HEADER('2026-10-09T18:00:00Z'));
    g.feed(COMMANDER('2026-10-09T18:00:01Z', 'F0000001', 'Alpha'));
    g.feed(DOCKED_FC('2026-10-09T18:25:00Z'));
    g.feed(MERITS('2026-10-09T18:26:00Z'));
    expect(g.ids()).toEqual(expect.arrayContaining(['powerplay-activity', 'fleet-carrier']));

    // Back to the menu and in as someone else, in the same journal.
    g.feed(COMMANDER('2026-10-09T18:27:00Z', 'F0000002', 'Bravo'));
    expect(g.resolver.all()).toEqual([]);
  });

  it('follows the commander through A, B and back to A without carrying anything across', () => {
    const now = { ms: T('2026-10-09T18:30:00Z') };
    const g = game(now);
    g.feed(COMMANDER('2026-10-09T18:00:00Z', 'F0000001', 'Alpha'));
    g.feed(REFINED('2026-10-09T18:20:00Z'));

    g.feed(COMMANDER('2026-10-09T18:21:00Z', 'F0000002', 'Bravo'));
    g.feed(PROSPECTED('2026-10-09T18:22:00Z'));
    expect(g.ids()).toEqual(['mining-prospecting']);

    g.feed(COMMANDER('2026-10-09T18:23:00Z', 'F0000001', 'Alpha'));
    // Alpha's refining is not resurrected, and Bravo's prospecting is gone.
    expect(g.ids()).toEqual([]);
  });
});

describe('shutdown, crashes and logins', () => {
  it('Shutdown ends activity; where the commander was stays, as last session', () => {
    const now = { ms: T('2026-10-09T18:30:00Z') };
    const g = game(now);
    g.feed(COMMANDER('2026-10-09T18:00:00Z', 'F0000001', 'Alpha'));
    g.feed(DOCKED_FC('2026-10-09T18:20:00Z'));
    g.feed(REFINED('2026-10-09T18:21:00Z'));
    g.feed(SHUTDOWN('2026-10-09T18:22:00Z'));

    expect(g.ids()).toEqual(['fleet-carrier']);
    const carrier = g.get('fleet-carrier')!;
    // The app decides it is no longer current: the game has closed.
    expect(contextTiming(carrier, false)).toBe('last-session');
    expect(contextTiming(carrier, true)).toBe('current');
  });

  it('a crash writes no Shutdown; the next launch’s Fileheader ends the old activity', () => {
    const now = { ms: T('2026-10-09T18:30:00Z') };
    const g = game(now);
    g.feed(PROSPECTED('2026-10-09T18:24:00Z'));
    g.newFile('Journal.2026-10-09T182800.01.log');
    g.feed(HEADER('2026-10-09T18:28:00Z'));
    expect(g.ids()).not.toContain('mining-prospecting');
  });

  it('LoadGame ends the previous session’s activity too', () => {
    const now = { ms: T('2026-10-09T18:30:00Z') };
    const g = game(now);
    g.feed(PROSPECTED('2026-10-09T18:24:00Z'));
    g.feed(LOAD_GAME('2026-10-09T18:29:00Z', 'F0000001', 'Alpha'));
    expect(g.ids()).not.toContain('mining-prospecting');
  });
});

/* ------------------------------------------------- state-scoped rules */

describe('fleet carrier', () => {
  it('says why in words, and keeps the line that started it rather than the latest one', () => {
    const now = { ms: T('2026-10-09T18:40:00Z') };
    const g = game(now);
    g.feed(DOCKED_FC('2026-10-09T18:20:00Z'));
    g.feed(MUSIC('2026-10-09T18:25:00Z'));
    g.feed(SHUTDOWN('2026-10-09T18:30:00Z'));

    const c = g.get('fleet-carrier')!;
    expect(c.subtitle).toBe('Docked at a Fleet Carrier');
    // Version 1 reported "Triggered by Shutdown".
    expect(c.triggerEvent).toBe('Docked');
    expect(c.matchedAt).toBe(T('2026-10-09T18:20:00Z'));
    expect(c.scope).toBe('state');
  });

  it('an unrelated line is not a change, so it does not re-render', () => {
    const now = { ms: T('2026-10-09T18:40:00Z') };
    const g = game(now);
    expect(g.feed(DOCKED_FC('2026-10-09T18:20:00Z'))).toBe(true);
    expect(g.feed(MUSIC('2026-10-09T18:25:00Z'))).toBe(false);
  });

  it('ends on undocking, and supercruise entry leaves nothing behind', () => {
    const now = { ms: T('2026-10-09T18:40:00Z') };
    const g = game(now);
    g.feed(DOCKED_FC('2026-10-09T18:20:00Z'));
    g.feed(UNDOCKED('2026-10-09T18:21:00Z'));
    expect(g.ids()).not.toContain('fleet-carrier');
    g.feed(SUPERCRUISE_ENTRY('2026-10-09T18:22:00Z'));
    expect(g.ids()).toEqual([]);
  });
});

describe('approaching a settlement is not docking', () => {
  it('advertised services are not offered until the commander docks', () => {
    const now = { ms: T('2026-06-16T22:20:00Z') };
    const g = game(now);
    g.feed(APPROACH_SETTLEMENT('2026-06-16T22:11:24Z'));
    // The approach line lists Pioneer Supplies, Vista Genomics and a Material Trader.
    expect(g.ids()).toEqual([]);

    g.feed(DOCKED_SETTLEMENT('2026-06-16T22:18:08Z'));
    expect(g.ids()).toEqual(
      expect.arrayContaining(['station-pioneer-supplies', 'station-material-trader']),
    );
    // Vista Genomics also needs data to sell; none has been analysed in this test.
    expect(g.ids()).not.toContain('station-vista-genomics');
  });

  it('Vista Genomics appears docked with unsold data, and not on approach with the same data', () => {
    const now = { ms: T('2026-06-16T22:20:00Z') };
    const g = game(now);
    g.state.exobiologyToSell = 2;
    g.feed(APPROACH_SETTLEMENT('2026-06-16T22:11:24Z'));
    expect(g.ids()).not.toContain('station-vista-genomics');
    g.feed(DOCKED_SETTLEMENT('2026-06-16T22:18:08Z'));
    expect(g.ids()).toContain('station-vista-genomics');
  });
});

/* ------------------------------------------------------------ signals */

describe('planetary mining locations', () => {
  it('FSS and surface scan of one body are one context, with accurate words and links', () => {
    const now = { ms: T('2026-09-07T18:10:00Z') };
    const g = game(now);
    g.feed(FSS_MINING('2026-09-07T18:00:49Z'));
    g.feed(SAA_MINING('2026-09-07T18:05:00Z'));

    const all = g.resolver.all().filter((c) => c.rule.id === 'planet-surface-mining');
    expect(all).toHaveLength(1);
    const c = all[0]!;
    expect(c.title).toBe('Planetary mining locations');
    expect(c.subtitle).toBe('Planetary mining locations detected on LP 844-28 AB 2');
    expect(c.triggerEvent).toBe('SAASignalsFound');
    const pages = c.rule.resources.map((r) => r.page);
    expect(pages).toContain('Surface Mining');
    expect(pages).not.toContain('Sub-surface Mining');
  });

  it('a scan without a body name still reads as a sentence', () => {
    const now = { ms: T('2026-09-07T18:10:00Z') };
    const g = game(now);
    g.feed(SAA_MINING_NO_NAME('2026-09-07T18:05:00Z'));
    expect(g.get('planet-surface-mining')?.subtitle).toBe(
      'Planetary mining locations have been detected on this body',
    );
  });

  it('leaving the system ends it', () => {
    const now = { ms: T('2026-09-07T18:10:00Z') };
    const g = game(now);
    g.feed(FSS_MINING('2026-09-07T18:00:49Z'));
    g.feed(FSD_JUMP('2026-09-07T18:06:00Z'));
    expect(g.ids()).toEqual([]);
  });
});

describe('biological signals from the FSS', () => {
  it('reports signals on the body, without a count it was not given and without a species', () => {
    const now = { ms: T('2026-06-14T04:25:00Z') };
    const g = game(now);
    g.feed(FSS_BIO('2026-06-14T04:19:51Z'));
    const c = g.get('planet-biological-signals')!;
    expect(c.subtitle).toBe('Biological signals detected on LHS 475 2 e');
  });

  it('a geological-only body is not a biology guide', () => {
    const now = { ms: T('2026-06-14T04:25:00Z') };
    const g = game(now);
    g.feed(FSS_GEO('2026-06-14T04:15:20Z'));
    expect(g.ids()).toEqual([]);
  });
});

/* ------------------------------------------------ ranking and limits */

describe('ranking and the maximum shown', () => {
  it('shows only the top three, a present station above a fading activity', () => {
    const now = { ms: T('2026-10-09T18:05:30Z') };
    const g = game(now);
    const r = new ContextResolver(BUNDLED_RULES, { now: () => now.ms, maxActive: 3 });
    const feed = (line: string) => {
      const ctx = new JournalSessionContext();
      const p = parseLine(line, 'J.log', 1, ctx);
      if (!p?.ok) throw new Error('bad');
      const e = normalize(p.event);
      applyEvent(g.state, e);
      r.observe(e, g.state);
    };
    feed(DOCKED_FC('2026-10-09T18:00:00Z')); // 60, state: no decay
    feed(ENGINEER_CRAFT('2026-10-09T18:01:00Z')); // 75, but 270 of its 300 s gone
    feed(MERITS('2026-10-09T18:05:29Z')); // 40, fresh
    feed(FSS_BIO('2026-10-09T18:05:29Z')); // 65, fresh
    expect(r.all()).toHaveLength(4);
    const ids = r.current().map((c) => c.rule.id);
    expect(ids).toEqual(['planet-biological-signals', 'fleet-carrier', 'powerplay-activity']);
  });
});

/* -------------------------------------------- rule-set replacement */

describe('replacing the rule set', () => {
  const plugin: ContextRuleSet = {
    ...BUNDLED_RULES,
    rules: [
      ...BUNDLED_RULES.rules,
      {
        id: 'example/at-carrier',
        title: 'Carrier tips',
        when: { kind: 'state', path: 'stationType', op: 'eq', value: 'FleetCarrier' },
        priority: 10,
        ttlSeconds: 300,
        resources: [{ label: 'Fleet Carriers', page: 'Fleet Carriers' }],
      },
    ],
  };

  it('keeps what is still true and re-checks state, instead of blanking the page', () => {
    const now = { ms: T('2026-10-09T18:22:00Z') };
    const g = game(now);
    g.feed(DOCKED_FC('2026-10-09T18:20:00Z'));
    g.feed(PROSPECTED('2026-10-09T18:21:00Z'));

    g.resolver.setRuleSet(plugin);
    const ids = g.resolver.all().map((c) => c.rule.id);
    // Both survivors kept, with their original times; the new state rule found
    // from current state, with no journal line invented to find it.
    expect(ids).toEqual(
      expect.arrayContaining(['fleet-carrier', 'mining-prospecting', 'example/at-carrier']),
    );
    expect(g.get('mining-prospecting')?.matchedAt).toBe(T('2026-10-09T18:21:00Z'));
    expect(g.get('example/at-carrier')?.triggerEvent).toBeNull();
  });

  it('drops a context whose rule was removed', () => {
    const now = { ms: T('2026-10-09T18:22:00Z') };
    const g = game(now, plugin);
    g.feed(DOCKED_FC('2026-10-09T18:20:00Z'));
    expect(g.ids()).toContain('example/at-carrier');
    g.resolver.setRuleSet(BUNDLED_RULES);
    expect(g.ids()).not.toContain('example/at-carrier');
    expect(g.ids()).toContain('fleet-carrier');
  });
});

/* ------------------------------------------------- links and rule safety */

describe('external links', () => {
  it('only https, parsed, without credentials', () => {
    expect(safeExternalUrl('https://edfieldmanual.com/wiki/Mining')).toBe(
      'https://edfieldmanual.com/wiki/Mining',
    );
    expect(safeExternalUrl('http://edfieldmanual.com/wiki/Mining')).toBeNull();
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('file:///C:/Windows/system32/calc.exe')).toBeNull();
    expect(safeExternalUrl('edfmc://open')).toBeNull();
    expect(safeExternalUrl('https://edfieldmanual.com@evil.example/')).toBeNull();
    expect(safeExternalUrl('https://')).toBeNull();
    expect(safeExternalUrl('not a url')).toBeNull();
    expect(safeExternalUrl(42)).toBeNull();
  });

  it('every bundled link is an EDFM wiki page over https', () => {
    for (const rule of BUNDLED_RULES.rules) {
      for (const res of rule.resources) {
        const url = resourceUrl(res);
        expect(url, `${rule.id}: ${res.label}`).toMatch(/^https:\/\/edfieldmanual\.com\/wiki\//);
      }
    }
  });

  it('a rule set cannot smuggle in a link the app would refuse, or an unreadable gate', () => {
    const clean = sanitise({
      version: 1,
      updatedAt: '2026-10-09T00:00:00Z',
      source: 'bundled',
      rules: [
        {
          id: 'x',
          title: 'X',
          when: { kind: 'event', name: 'Music' },
          priority: 1,
          ttlSeconds: 60,
          resources: [
            { label: 'Fine', page: 'Mining' },
            { label: 'Plain http', url: 'http://example.com/' },
            { label: 'Script', url: 'javascript:alert(1)' },
            { label: '', page: 'Mining' },
            { label: 'Nowhere' },
            { label: 'Gated oddly', page: 'Exobiology', requires: { kind: 'telepathy' } as never },
            { label: 'Gated', page: 'Exobiology', requires: { kind: 'body-scanned' } },
            { label: 'Elsewhere', url: 'https://example.com/guide' },
            'not even an object' as never,
          ],
        },
      ],
    });
    expect(clean.rules[0]!.resources.map((r) => r.label)).toEqual(['Fine', 'Gated', 'Elsewhere']);
  });

  it('a malformed condition never throws on the ingest path', () => {
    const now = { ms: T('2026-10-09T18:00:00Z') };
    const g = game(now, {
      ...BUNDLED_RULES,
      rules: [
        {
          id: 'broken',
          title: 'Broken',
          when: { kind: 'service', id: 42 as never },
          priority: 1,
          ttlSeconds: 60,
          resources: [],
        },
      ],
    });
    expect(() => g.feed(DOCKED_FC('2026-10-09T17:59:00Z'))).not.toThrow();
  });
});
