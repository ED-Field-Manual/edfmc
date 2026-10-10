/**
 * Combat in the Activity Journal: fights, deaths, interdictions and cashing in.
 *
 * Lines are the shape of real ones in the corpus, with names made up. The corpus
 * block replays the real journals where they exist.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JournalSessionContext, listJournalFiles, normalize, parseLine, replayFile } from '@edfm/elite-journal';
import '@edfm/elite-journal/node';

import { ActivityEngine, combatTotals, type ActivityEntry } from '../src/index.js';

const ctx = new JournalSessionContext();
let offset = 0;
function ev(line: string) {
  const parsed = parseLine(line, 'Journal.2026-10-10T150000.01.log', (offset += 100), ctx);
  if (!parsed?.ok) throw new Error('fixture failed to parse');
  return normalize(parsed.event);
}

const JUMP = (sys: string, at = '2026-10-10T15:00:00Z') =>
  `{ "timestamp":"${at}", "event":"FSDJump", "Taxi":false, "Multicrew":false, "StarSystem":"${sys}", "SystemAddress":${sys.length}, "StarPos":[1,2,3], "JumpDist":8.5, "FuelUsed":0.6, "FuelLevel":31.2 }`;
const BOUNTY_SHIP = (ship: string, reward: number) =>
  `{ "timestamp":"2026-10-10T15:10:00Z", "event":"Bounty", "Rewards":[ { "Faction":"Test Alliance", "Reward":${reward} } ], "PilotName":"$npc_name_decorate:#name=Jo Example;", "PilotName_Localised":"Jo Example", "Target":"${ship}", "TotalReward":${reward}, "VictimFaction":"Test Pirates" }`;
const BOUNTY_SKIMMER =
  '{ "timestamp":"2026-10-10T15:11:00Z", "event":"Bounty", "Rewards":[ { "Faction":"Test Alliance", "Reward":1000 } ], "Target":"skimmerdrone", "Target_Localised":"Sentry Skimmer", "TotalReward":1000, "VictimFaction":"Test Alliance" }';
const BOND = (reward: number) =>
  `{ "timestamp":"2026-10-10T15:12:00Z", "event":"FactionKillBond", "Reward":${reward}, "AwardingFaction":"Test Alliance", "VictimFaction":"Test Pirates" }`;
const SC_ENTRY = '{ "timestamp":"2026-10-10T15:30:00Z", "event":"SupercruiseEntry", "Taxi":false, "Multicrew":false, "StarSystem":"Test System", "SystemAddress":11 }';

function feed(engine: ActivityEngine, lines: string[]): ActivityEntry[] {
  return lines.flatMap((l) => [...engine.observe(ev(l))]);
}

describe('a fight', () => {
  it('is one entry when the commander leaves, with kills, earnings and what was destroyed', () => {
    const e = new ActivityEngine({ commanderFid: 'F0000001' });
    const out = feed(e, [JUMP('Test System'), BOUNTY_SHIP('python', 45000), BOUNTY_SHIP('python', 30000), BOUNTY_SKIMMER, BOND(3189)]);
    expect(out).toEqual([]);
    const [fight] = feed(e, [SC_ENTRY]);
    expect(fight).toMatchObject({
      category: 'combat',
      subtype: 'fight',
      title: '4 kills',
      detail: 'Bounties 76,000 Cr · Combat bonds 3,189 Cr · Python ×2, Sentry Skimmer',
      systemName: 'Test System',
    });
    expect(fight!.data).toMatchObject({ kills: 4, bounties: 76000, bonds: 3189 });
    expect(fight!.sources).toHaveLength(4);
  });

  it('ended by a jump belongs to the system it was fought in', () => {
    const e = new ActivityEngine({ commanderFid: 'F0000001' });
    const [fight] = feed(e, [JUMP('Test System'), BOND(1000), JUMP('Somewhere Else', '2026-10-10T16:00:00Z')]);
    expect(fight!.systemName).toBe('Test System');
    expect(fight!.title).toBe('1 kill');
  });

  it('ended by dying gives the fight and then the death', () => {
    const e = new ActivityEngine({ commanderFid: 'F0000001' });
    const out = feed(e, [
      JUMP('Test System'),
      BOND(1000),
      '{ "timestamp":"2026-10-10T15:20:00Z", "event":"Died", "KillerName":"$ShipName_PowersSecurity;", "KillerName_Localised":"Power Security Force", "KillerShip":"anaconda", "KillerRank":"Expert" }',
    ]);
    expect(out.map((x) => x.subtype)).toEqual(['fight', 'died']);
    expect(out[1]).toMatchObject({ title: 'Killed by Power Security Force', detail: 'Anaconda · Expert' });
  });
});

describe('single moments', () => {
  const one = (line: string) => feed(new ActivityEngine({ commanderFid: 'F0000001' }), [JUMP('Test System'), line]);

  it('a death with no killer named, and one on foot', () => {
    expect(one('{ "timestamp":"2026-10-10T15:20:00Z", "event":"Died" }')[0]).toMatchObject({ title: 'Died', detail: null });
    expect(
      one('{ "timestamp":"2026-10-10T15:20:00Z", "event":"Died", "KillerName":"Sam Example", "KillerShip":"assaultsuitai_class2", "KillerRank":"Harmless" }')[0],
    ).toMatchObject({ title: 'Killed by Sam Example', detail: 'On foot · Harmless' });
  });

  it('interdictions, either way round', () => {
    expect(
      one('{ "timestamp":"2026-10-10T15:20:00Z", "event":"Interdicted", "Submitted":false, "Interdictor":"Jo Example", "IsPlayer":false, "Faction":"Test Pirates" }')[0],
    ).toMatchObject({ subtype: 'interdicted', title: 'Interdicted by Jo Example', detail: 'Test Pirates' });
    expect(
      one('{ "timestamp":"2026-10-10T15:20:00Z", "event":"Interdicted", "Submitted":true, "Interdictor":"CMDR Someone", "IsPlayer":true }')[0],
    ).toMatchObject({ title: 'Submitted to an interdiction by CMDR Someone (player)', detail: null });
    expect(one('{ "timestamp":"2026-10-10T15:20:00Z", "event":"EscapeInterdiction", "Interdictor":"Jo Example", "IsPlayer":false }')[0]).toMatchObject({
      subtype: 'interdiction-escaped',
      title: 'Escaped an interdiction by Jo Example',
    });
    expect(one('{ "timestamp":"2026-10-10T15:20:00Z", "event":"Interdiction", "Success":true, "IsPlayer":false, "Faction":"Test Pirates" }')[0]).toMatchObject({
      subtype: 'interdiction',
      title: 'Interdicted a ship',
    });
    expect(
      one('{ "timestamp":"2026-10-10T15:20:00Z", "event":"Interdiction", "Success":false, "IsPlayer":false, "Interdicted":"Jo Example", "Faction":"Test Pirates" }')[0],
    ).toMatchObject({ title: 'Failed to interdict Jo Example' });
  });

  it('cashing in bonds and bounties, but not other vouchers', () => {
    expect(one('{ "timestamp":"2026-10-10T15:20:00Z", "event":"RedeemVoucher", "Type":"CombatBond", "Amount":403685, "Faction":"Test Alliance" }')[0]).toMatchObject({
      subtype: 'bonds-redeemed',
      title: 'Cashed in 403,685 Cr of combat bonds',
      detail: 'Test Alliance',
    });
    expect(
      one('{ "timestamp":"2026-10-10T15:20:00Z", "event":"RedeemVoucher", "Type":"bounty", "Amount":12750, "Factions":[ { "Faction":"", "Amount":9000 }, { "Faction":"Test Alliance", "Amount":3750 } ], "BrokerPercentage":25.000000 }')[0],
    ).toMatchObject({ subtype: 'bounties-redeemed', detail: 'Test Alliance · via a broker (25%)' });
    expect(one('{ "timestamp":"2026-10-10T15:20:00Z", "event":"RedeemVoucher", "Type":"codex", "Amount":5000 }')).toEqual([]);
  });
});

describe('the Combat total', () => {
  it('adds up kills, earnings, cash-ins and deaths', () => {
    const e = new ActivityEngine({ commanderFid: 'F0000001' });
    const entries = feed(e, [
      JUMP('Test System'),
      BOUNTY_SHIP('eagle', 20000),
      BOND(5000),
      SC_ENTRY,
      '{ "timestamp":"2026-10-10T15:40:00Z", "event":"RedeemVoucher", "Type":"bounty", "Amount":20000, "Factions":[ { "Faction":"Test Alliance", "Amount":20000 } ] }',
      '{ "timestamp":"2026-10-10T15:50:00Z", "event":"Died" }',
    ]);
    expect(combatTotals(entries)).toEqual({ kills: 2, bounties: 20000, bonds: 5000, cashedIn: 20000, deaths: 1 });
  });
});

const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
const DIR = process.env['EDFM_JOURNAL_DIR'] ?? join(home, 'Saved Games', 'Frontier Developments', 'Elite Dangerous');
(home !== '' && existsSync(DIR) ? describe : describe.skip)('combat in the real journals', () => {
  it('every kill lands in exactly one fight, and no name is a raw token', async () => {
    const files = (await listJournalFiles(DIR)).filter((f) => f.sizeBytes > 0);
    const engine = new ActivityEngine({ commanderFid: 'F-TEST' });
    let kills = 0;
    const combat: ActivityEntry[] = [];
    for (const file of files) {
      for (const event of (await replayFile(file.fullPath)).events) {
        if (event.source.event === 'Bounty' || event.source.event === 'FactionKillBond') kills += 1;
        combat.push(...engine.observe(event).filter((e) => e.category === 'combat'));
      }
    }
    const fights = combat.filter((e) => e.subtype === 'fight');
    const recorded = fights.reduce((n, f) => n + (f.data['kills'] as number), 0);
    // A fight still open at the end of the newest journal is not recorded yet.
    expect(recorded).toBeLessThanOrEqual(kills);
    expect(kills - recorded).toBeLessThan(200);
    expect(new Set(combat.map((e) => e.id)).size).toBe(combat.length);
    for (const e of combat) expect(`${e.title} ${e.detail ?? ''}`).not.toMatch(/\$\w+;/);
  }, 120_000);
});
