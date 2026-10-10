/**
 * Turning combat into activity.
 *
 * ## What the journal says
 *
 * Measured on the corpus (325 journal files):
 *
 * - `Bounty` 677: `Target`, `TotalReward`, `VictimFaction` and `Rewards` on
 *   every one. `Target_Localised` on 461: it is absent exactly when `Target` is
 *   a plain ship symbol (`python`, `vulture`, `anaconda`), so the name comes
 *   from the ship table then. `SharedWithOthers` on 10.
 * - `FactionKillBond` 575: `Reward`, `AwardingFaction` and `VictimFaction` on
 *   every one. No target.
 * - `Died` 19: `KillerName` and `KillerShip` on 16, `KillerRank` on 14; three
 *   carry nothing but the timestamp. `KillerShip` is a suit symbol
 *   (`assaultsuitai_class2`) when the killer was on foot.
 * - `Interdicted` 107 (`Submitted`, `Interdictor`, `IsPlayer` on every one,
 *   `Faction` on 106), `EscapeInterdiction` 16, and `Interdiction` 54, the
 *   commander's own (`Success`, `IsPlayer`, `Faction`; `Interdicted` on one).
 * - `RedeemVoucher` 137, of which `CombatBond` 31 and `bounty` 74 are combat
 *   (the rest are trade, settlement, codex and scannable). `Amount` on every one.
 *
 * `CapShipBond` and `PVPKill` do not occur in the corpus, so they are not read.
 *
 * ## A fight, not a kill
 *
 * One entry per kill would bury everything else (1,252 kills in the corpus
 * against 268 fights), so kills are added up into a **fight**, the way mining runs
 * are: it starts at the first `Bounty` or `FactionKillBond` and ends when the
 * commander moves on -- `SupercruiseEntry`, `FSDJump`, `Docked`, `Died`, or the
 * session ending. Measured: 268 fights, ended by SupercruiseEntry 224 times,
 * FSDJump 34, Died 5, LoadGame 3, Shutdown 2.
 *
 * Deaths, interdictions and cashing in are one entry each: they are single
 * moments, and there are few of them.
 *
 * Local only: none of this is part of what EDFM Commander Journal syncs.
 */

import { shipDisplayName, vehicleKind, type NormalizedEvent } from '@edfm/elite-journal';

import type { ActivityContext, ActivityEntry } from './types.js';

const ENDS_A_FIGHT = new Set(['SupercruiseEntry', 'FSDJump', 'Docked', 'Died', 'Shutdown', 'LoadGame', 'Fileheader']);
/** Provenance kept per entry; more is a list nobody reads. */
const MAX_SOURCES = 400;

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function num(o: Record<string, unknown>, k: string): number | null {
  return typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : null;
}

/** `12,345 Cr`. */
const credits = (n: number) => `${n.toLocaleString('en-GB')} Cr`;

/** A name the journal gave, unless it is a `$TOKEN;` placeholder. */
function readable(localised: string | null, plain: string | null): string | null {
  for (const v of [localised, plain]) if (v !== null && !/^\$.*;$/.test(v)) return v;
  return null;
}

interface Fight {
  readonly firstEventId: string;
  readonly startedAt: string;
  endedAt: string;
  readonly systemName: string | null;
  readonly systemAddress: number | null;
  kills: number;
  bounties: number;
  bonds: number;
  readonly targets: Map<string, number>;
  readonly sources: string[];
}

export class CombatFights {
  private fight: Fight | null = null;

  reset(): void {
    this.fight = null;
  }

  /** Feed one event; returns the finished fight's entry when this event ends one. */
  observe(event: NormalizedEvent, ctx: ActivityContext): readonly ActivityEntry[] {
    const raw = event.source.raw as Record<string, unknown>;
    const name = event.source.event;

    if (name === 'Bounty' || name === 'FactionKillBond') {
      const p = event.source.provenance;
      this.fight ??= {
        firstEventId: p.eventId,
        startedAt: p.timestamp,
        endedAt: p.timestamp,
        // Kept from the start: the jump that ends a fight has already moved on.
        systemName: ctx.systemName,
        systemAddress: ctx.systemAddress,
        kills: 0,
        bounties: 0,
        bonds: 0,
        targets: new Map(),
        sources: [],
      };
      const fight = this.fight;
      fight.endedAt = p.timestamp;
      fight.kills += 1;
      if (name === 'Bounty') {
        fight.bounties += num(raw, 'TotalReward') ?? 0;
        const target = str(raw, 'Target');
        if (target !== null) {
          const label = shipDisplayName(target, str(raw, 'Target_Localised')).name;
          fight.targets.set(label, (fight.targets.get(label) ?? 0) + 1);
        }
      } else {
        fight.bonds += num(raw, 'Reward') ?? 0;
      }
      if (fight.sources.length < MAX_SOURCES) fight.sources.push(p.eventId);
      return [];
    }

    if (ENDS_A_FIGHT.has(name) && this.fight !== null) {
      const done = this.entry(this.fight, ctx);
      this.fight = null;
      return [done];
    }
    return [];
  }

  private entry(f: Fight, ctx: ActivityContext): ActivityEntry {
    const targets = [...f.targets.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const parts: string[] = [];
    if (f.bounties > 0) parts.push(`Bounties ${credits(f.bounties)}`);
    if (f.bonds > 0) parts.push(`Combat bonds ${credits(f.bonds)}`);
    if (targets.length > 0) {
      parts.push(targets.map((t) => (t.count > 1 ? `${t.label} ×${t.count}` : t.label)).join(', '));
    }
    return {
      id: f.firstEventId,
      commanderFid: ctx.commanderFid,
      occurredAt: f.endedAt,
      category: 'combat',
      subtype: 'fight',
      systemName: f.systemName,
      systemAddress: f.systemAddress,
      bodyName: null,
      bodyId: null,
      locationName: null,
      title: `${f.kills} ${f.kills === 1 ? 'kill' : 'kills'}`,
      detail: parts.length > 0 ? parts.join(' · ') : null,
      data: {
        kills: f.kills,
        bounties: f.bounties,
        bonds: f.bonds,
        targets: targets.slice(0, 20),
        startedAt: f.startedAt,
        endedAt: f.endedAt,
      },
      sources: f.sources,
    };
  }
}

/** Deaths, interdictions and cashing in: one entry per event. */
export function combatEntries(event: NormalizedEvent, ctx: ActivityContext): readonly ActivityEntry[] {
  const raw = event.source.raw as Record<string, unknown>;
  const p = event.source.provenance;
  const base = {
    id: p.eventId,
    commanderFid: ctx.commanderFid,
    occurredAt: p.timestamp,
    category: 'combat' as const,
    systemName: ctx.systemName,
    systemAddress: ctx.systemAddress,
    bodyName: null,
    bodyId: null,
    locationName: null,
    sources: [p.eventId],
  };

  switch (event.source.event) {
    case 'Died': {
      const killer = readable(str(raw, 'KillerName_Localised'), str(raw, 'KillerName'));
      const ship = str(raw, 'KillerShip');
      const rank = str(raw, 'KillerRank');
      const vehicle = ship === null ? null : vehicleKind(ship) === 'suit' ? 'On foot' : shipDisplayName(ship).name;
      const detail = [vehicle, rank].filter((v) => v !== null).join(' · ');
      return [
        {
          ...base,
          subtype: 'died',
          title: killer === null ? 'Died' : `Killed by ${killer}`,
          detail: detail === '' ? null : detail,
          data: { killer, killerShip: ship, killerRank: rank },
        },
      ];
    }
    case 'Interdicted':
    case 'EscapeInterdiction': {
      const by = readable(str(raw, 'Interdictor_Localised'), str(raw, 'Interdictor'));
      const isPlayer = raw['IsPlayer'] === true;
      const who = by === null ? '' : ` by ${by}${isPlayer ? ' (player)' : ''}`;
      const escaped = event.source.event === 'EscapeInterdiction';
      const submitted = raw['Submitted'] === true;
      return [
        {
          ...base,
          subtype: escaped ? 'interdiction-escaped' : 'interdicted',
          title: escaped ? `Escaped an interdiction${who}` : submitted ? `Submitted to an interdiction${who}` : `Interdicted${who}`,
          detail: str(raw, 'Faction'),
          data: { interdictor: by, isPlayer, ...(escaped ? {} : { submitted }) },
        },
      ];
    }
    case 'Interdiction': {
      const target = readable(str(raw, 'Interdicted_Localised'), str(raw, 'Interdicted'));
      const success = raw['Success'] === true;
      return [
        {
          ...base,
          subtype: 'interdiction',
          title: success ? `Interdicted ${target ?? 'a ship'}` : `Failed to interdict ${target ?? 'a ship'}`,
          detail: str(raw, 'Faction'),
          data: { target, success, isPlayer: raw['IsPlayer'] === true },
        },
      ];
    }
    case 'RedeemVoucher': {
      const type = str(raw, 'Type');
      const amount = num(raw, 'Amount');
      if ((type !== 'CombatBond' && type !== 'bounty') || amount === null) return [];
      // `Faction` on some, a `Factions` list on others, where a name may be "".
      const factions = new Set<string>();
      const one = str(raw, 'Faction');
      if (one !== null) factions.add(one);
      if (Array.isArray(raw['Factions'])) {
        for (const f of raw['Factions']) {
          if (f !== null && typeof f === 'object') {
            const n = str(f as Record<string, unknown>, 'Faction');
            if (n !== null) factions.add(n);
          }
        }
      }
      const broker = num(raw, 'BrokerPercentage');
      const detail = [...factions].join(', ') + (broker !== null ? `${factions.size > 0 ? ' · ' : ''}via a broker (${broker}%)` : '');
      return [
        {
          ...base,
          subtype: type === 'CombatBond' ? 'bonds-redeemed' : 'bounties-redeemed',
          title: `Cashed in ${credits(amount)} of ${type === 'CombatBond' ? 'combat bonds' : 'bounties'}`,
          detail: detail === '' ? null : detail,
          data: { amount, kind: type, factions: [...factions], brokerPercentage: broker },
        },
      ];
    }
    default:
      return [];
  }
}

/** What the Combat filter adds up across the entries listed. */
export function combatTotals(entries: readonly ActivityEntry[]): {
  kills: number;
  bounties: number;
  bonds: number;
  cashedIn: number;
  deaths: number;
} {
  const t = { kills: 0, bounties: 0, bonds: 0, cashedIn: 0, deaths: 0 };
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  for (const e of entries) {
    if (e.subtype === 'fight') {
      t.kills += n(e.data['kills']);
      t.bounties += n(e.data['bounties']);
      t.bonds += n(e.data['bonds']);
    } else if (e.subtype === 'bonds-redeemed' || e.subtype === 'bounties-redeemed') {
      t.cashedIn += n(e.data['amount']);
    } else if (e.subtype === 'died') {
      t.deaths += 1;
    }
  }
  return t;
}
