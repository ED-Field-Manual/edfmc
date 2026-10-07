/**
 * Journal → Inara translation.
 *
 * Inara's events are deliberately not a mirror of the journal ("Inara API and
 * its events are not intended to be one-to-one copy of the journals"), so this
 * keeps a small normalised state of its own -- which ship is being flown, where
 * the commander is, whether they are in a taxi, the ranks just reported -- and
 * turns journal lines into the documented Inara events. See docs/INARA.md for
 * the full matrix and the corpus evidence behind each field.
 *
 * Pure: no clock, no I/O, no network. Every mapping is a function of the lines
 * fed in, which is what lets each one be tested on its own.
 *
 * Nothing here reads the commander's key, and nothing produced here contains
 * it. The header is built in Rust.
 */

/** What a commander can switch off, as the settings screen names it. */
export type InaraCategory =
  | 'travel'
  | 'ranks'
  | 'ships'
  | 'suits'
  | 'inventory'
  | 'statistics'
  | 'credits';

export const INARA_CATEGORIES: readonly InaraCategory[] = [
  'travel',
  'ranks',
  'ships',
  'suits',
  'inventory',
  'statistics',
  'credits',
];

/**
 * Per-category defaults.
 *
 * Credits are off: Inara's own documentation warns against sending them unless
 * certain, and a commander's balance is the most personal figure here. The
 * value sent is the game's own, so it is accurate when switched on.
 */
export const INARA_CATEGORY_DEFAULTS: Readonly<Record<InaraCategory, boolean>> = {
  travel: true,
  ranks: true,
  ships: true,
  suits: true,
  inventory: true,
  statistics: true,
  credits: false,
};

/** One event ready for the queue. */
export interface InaraOutgoing {
  readonly eventName: string;
  /** The journal's own timestamp, verbatim. Inara asks for the real event time. */
  readonly eventTimestamp: string;
  readonly eventData: unknown;
  readonly category: InaraCategory;
  /**
   * Set on snapshots: a newer event with the same key makes an older, unsent
   * one pointless, and an identical one to what Inara already holds is noise.
   */
  readonly coalesceKey: string | null;
}

/** When the queue should be drained, following Inara's guidance. */
export type InaraFlushHint = 'session-start' | 'now' | null;

export type InaraBlock = 'legacy' | 'beta' | 'unknown-version' | 'too-old' | 'no-commander';

export interface InaraTranslation {
  readonly events: readonly InaraOutgoing[];
  readonly flush: InaraFlushHint;
  /** Set when the line was refused before translation. */
  readonly blocked: InaraBlock | null;
}

/** The provenance fields this needs; a subset of `EventProvenance`. */
export interface InaraProvenance {
  readonly timestamp: string;
  readonly timestampMs: number | null;
  readonly gameVersion: string | null;
  readonly build: string | null;
  readonly fid: string | null;
}

/** Inara: "The date/time provided shouldn't be older than 30 days." */
export const INARA_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------- the gate */

/**
 * Whether a line comes from the live game.
 *
 * Inara: "Send data only from the Live game version (Odyssey, Horizons 4.0 and
 * future game updates)", "Do NOT send data from the Legacy game version
 * (Horizons 3.8)", "Do NOT send data from the game beta versions".
 *
 * An unknown version is refused rather than assumed live: every live session
 * writes `gameversion` in its `Fileheader`, so its absence means this cannot
 * say where the line came from.
 */
export function inaraLiveGate(p: {
  readonly gameVersion: string | null;
  readonly build: string | null;
}): 'live' | 'legacy' | 'beta' | 'unknown-version' {
  const version = p.gameVersion?.trim() ?? '';
  if (version.length === 0) return 'unknown-version';
  if (/beta/i.test(version) || /beta/i.test(p.build ?? '')) return 'beta';
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major)) return 'unknown-version';
  if (major < 4) return 'legacy';
  return 'live';
}

/* ------------------------------------------------------------- helpers */

type Raw = Readonly<Record<string, unknown>>;

const str = (r: Raw, k: string): string | null => {
  const v = r[k];
  return typeof v === 'string' && v.length > 0 ? v : null;
};
const num = (r: Raw, k: string): number | null => {
  const v = r[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
const int = (r: Raw, k: string): number | null => {
  const v = num(r, k);
  return v !== null && Number.isInteger(v) ? v : null;
};
const bool = (r: Raw, k: string): boolean | null => {
  const v = r[k];
  return typeof v === 'boolean' ? v : null;
};
const rec = (v: unknown): Raw | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;
const list = (r: Raw, k: string): readonly unknown[] | null => {
  const v = r[k];
  return Array.isArray(v) ? v : null;
};
const coords = (r: Raw, k: string): [number, number, number] | null => {
  const v = r[k];
  if (!Array.isArray(v) || v.length !== 3) return null;
  return v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? [v[0] as number, v[1] as number, v[2] as number]
    : null;
};
/** Journal reputation is −100..100; Inara wants −1..1. */
const rep = (v: number): number => Math.max(-1, Math.min(1, v / 100));

/** Journal rank names to Inara's, which are the same words in lower case. */
const PILOT_RANKS = [
  'Combat',
  'Trade',
  'Explore',
  'Soldier',
  'Exobiologist',
  'Empire',
  'Federation',
  'CQC',
] as const;

/** The four stages Inara accepts. The journal also writes `Known`, which is not one. */
const ENGINEER_STAGES = new Set(['Invited', 'Acquainted', 'Unlocked', 'Barred']);

interface Ship {
  readonly type: string;
  readonly id: number;
}

interface Place {
  readonly system: string | null;
  readonly coords: [number, number, number] | null;
  readonly station: string | null;
  readonly marketId: number | null;
}

/* ---------------------------------------------------------- translator */

/**
 * Stateful translator, one per commander.
 *
 * Construct a new one -- or let `observe` reset this one -- when the commander
 * changes: a ship or a location must never carry from one commander to the next.
 */
export class InaraTranslator {
  private fid: string | null = null;
  private ship: Ship | null = null;
  private place: Place = { system: null, coords: null, station: null, marketId: null };
  /** Set by BookTaxi / BookDropship; used when a later event says `Taxi: true`. */
  private taxi: 'shuttle' | 'dropship' | null = null;
  private ranks: Partial<Record<(typeof PILOT_RANKS)[number], number>> = {};
  private ranksSinceLogin = false;
  private powerRanks = new Map<string, number>();
  /** Minor faction reputation last emitted, so a revisit only sends changes. */
  private minorRep = new Map<string, number>();

  /** The commander this translator is currently attributing to. */
  get commander(): string | null {
    return this.fid;
  }

  private reset(fid: string | null): void {
    this.fid = fid;
    this.ship = null;
    this.place = { system: null, coords: null, station: null, marketId: null };
    this.taxi = null;
    this.ranks = {};
    this.ranksSinceLogin = false;
    this.powerRanks = new Map();
    this.minorRep = new Map();
  }

  /**
   * Translate one journal line.
   *
   * Refuses -- before anything is produced -- lines from Legacy or beta, lines
   * whose commander is unknown, and lines older than Inara accepts. State is
   * still updated from a too-old line, because a current ship or location
   * learned from it is still true; only the events are withheld.
   */
  observe(raw: Raw, provenance: InaraProvenance, nowMs: number): InaraTranslation {
    const gate = inaraLiveGate(provenance);
    if (gate !== 'live') return { events: [], flush: null, blocked: gate };

    const fid = provenance.fid ?? (typeof raw['FID'] === 'string' ? (raw['FID'] as string) : null);
    if (fid === null) return { events: [], flush: null, blocked: 'no-commander' };
    if (fid !== this.fid) this.reset(fid);

    const out: InaraOutgoing[] = [];
    const flush = this.translate(raw, provenance.timestamp, out);

    const t = provenance.timestampMs;
    if (t === null || nowMs - t > INARA_MAX_AGE_MS) {
      return { events: [], flush: null, blocked: 'too-old' };
    }
    return { events: out, flush, blocked: null };
  }

  private translate(r: Raw, at: string, out: InaraOutgoing[]): InaraFlushHint {
    const push = (
      eventName: string,
      eventData: unknown,
      category: InaraCategory,
      coalesceKey: string | null = null,
    ) => out.push({ eventName, eventTimestamp: at, eventData, category, coalesceKey });

    switch (r['event']) {
      /* ------------------------------------------------------ session */
      case 'LoadGame': {
        const type = str(r, 'Ship');
        const id = int(r, 'ShipID');
        // On foot or in a taxi at login there is no ShipID (1 of 400 in the corpus).
        this.ship = type !== null && id !== null ? { type, id } : null;
        this.ranksSinceLogin = false;
        const credits = int(r, 'Credits');
        if (credits !== null) {
          const loan = int(r, 'Loan');
          push(
            'setCommanderCredits',
            { commanderCredits: credits, ...(loan !== null ? { commanderLoan: loan } : {}) },
            'credits',
            'credits',
          );
        }
        return 'session-start';
      }
      case 'Shutdown':
        return 'now';

      /* ------------------------------------------------------- travel */
      case 'Location': {
        const docked = bool(r, 'Docked') === true;
        this.place = {
          system: str(r, 'StarSystem'),
          coords: coords(r, 'StarPos'),
          station: docked ? str(r, 'StationName') : null,
          marketId: docked ? int(r, 'MarketID') : null,
        };
        if (this.place.system !== null) {
          const d: Record<string, unknown> = { starsystemName: this.place.system };
          if (this.place.coords) d['starsystemCoords'] = this.place.coords;
          if (this.place.station) d['stationName'] = this.place.station;
          if (this.place.marketId !== null) d['marketID'] = this.place.marketId;
          const body = str(r, 'Body');
          // A station's Body is the station itself; only a real body is named.
          if (body !== null && str(r, 'BodyType') !== 'Station') d['starsystemBodyName'] = body;
          // Never `starsystemBodyCoords`: a surface position is never shared.
          push('setCommanderTravelLocation', d, 'travel', 'location');
        }
        this.minorFactions(r, push);
        return null;
      }
      case 'FSDJump': {
        this.place = {
          system: str(r, 'StarSystem'),
          coords: coords(r, 'StarPos'),
          station: null,
          marketId: null,
        };
        if (this.place.system !== null) {
          const d: Record<string, unknown> = { starsystemName: this.place.system };
          if (this.place.coords) d['starsystemCoords'] = this.place.coords;
          const dist = num(r, 'JumpDist');
          if (dist !== null) d['jumpDistance'] = dist;
          this.vehicle(r, d);
          push('addCommanderTravelFSDJump', d, 'travel');
        }
        this.minorFactions(r, push);
        return 'now';
      }
      case 'CarrierJump': {
        const docked = bool(r, 'Docked') === true;
        this.place = {
          system: str(r, 'StarSystem'),
          coords: coords(r, 'StarPos'),
          station: docked ? str(r, 'StationName') : null,
          marketId: docked ? int(r, 'MarketID') : null,
        };
        // Only aboard: a carrier jump the commander was not on is not their travel.
        if (docked && this.place.system !== null) {
          const d: Record<string, unknown> = { starsystemName: this.place.system };
          if (this.place.coords) d['starsystemCoords'] = this.place.coords;
          if (this.place.station) d['stationName'] = this.place.station;
          if (this.place.marketId !== null) d['marketID'] = this.place.marketId;
          // `jumpDistance` deliberately absent: Inara says not to set it.
          if (this.ship) {
            d['shipType'] = this.ship.type;
            d['shipGameID'] = this.ship.id;
          }
          push('addCommanderTravelCarrierJump', d, 'travel');
        }
        this.minorFactions(r, push);
        return 'now';
      }
      case 'Docked': {
        const system = str(r, 'StarSystem') ?? this.place.system;
        this.place = {
          system,
          coords: system === this.place.system ? this.place.coords : null,
          station: str(r, 'StationName'),
          marketId: int(r, 'MarketID'),
        };
        if (system !== null && this.place.station !== null) {
          const d: Record<string, unknown> = {
            starsystemName: system,
            stationName: this.place.station,
          };
          if (this.place.coords) d['starsystemCoords'] = this.place.coords;
          if (this.place.marketId !== null) d['marketID'] = this.place.marketId;
          this.vehicle(r, d);
          push('addCommanderTravelDock', d, 'travel');
        }
        return 'now';
      }
      case 'Undocked':
        this.place = { ...this.place, station: null, marketId: null };
        return null;
      case 'Touchdown': {
        // Only a landing the commander made, on a planet. An autopilot or a
        // touchdown on a station pad is not a landing in Inara's sense.
        if (bool(r, 'PlayerControlled') !== true || bool(r, 'OnPlanet') !== true) return null;
        const system = str(r, 'StarSystem') ?? this.place.system;
        const body = str(r, 'Body');
        if (system === null || body === null) return null;
        const d: Record<string, unknown> = { starsystemName: system, starsystemBodyName: body };
        if (this.place.coords && system === this.place.system) {
          d['starsystemCoords'] = this.place.coords;
        }
        // Never `starsystemBodyCoords` (latitude/longitude): see the privacy manifest.
        this.vehicle(r, d);
        push('addCommanderTravelLand', d, 'travel');
        return null;
      }
      case 'BookTaxi':
        this.taxi = 'shuttle';
        return null;
      case 'BookDropship':
        this.taxi = 'dropship';
        return null;
      case 'CancelTaxi':
      case 'CancelDropship':
        this.taxi = null;
        return null;

      /* ------------------------------------------------------- ranks */
      case 'Rank': {
        for (const name of PILOT_RANKS) {
          const v = int(r, name);
          if (v !== null) this.ranks[name] = v;
        }
        this.ranksSinceLogin = true;
        return null;
      }
      case 'Progress': {
        // Paired with the Rank written beside it at login; alone, progress
        // without its rank is not sent.
        if (!this.ranksSinceLogin) return null;
        const items = PILOT_RANKS.flatMap((name) => {
          const value = this.ranks[name];
          const progress = num(r, name);
          if (value === undefined && progress === null) return [];
          return [
            {
              rankName: name.toLowerCase(),
              ...(value !== undefined ? { rankValue: value } : {}),
              ...(progress !== null ? { rankProgress: Math.max(0, Math.min(1, progress / 100)) } : {}),
            },
          ];
        });
        if (items.length > 0) push('setCommanderRankPilot', items, 'ranks', 'rank-pilot');
        return null;
      }
      case 'Promotion': {
        const items = PILOT_RANKS.flatMap((name) => {
          const v = int(r, name);
          if (v === null) return [];
          this.ranks[name] = v;
          return [{ rankName: name.toLowerCase(), rankValue: v }];
        });
        if (items.length > 0) push('setCommanderRankPilot', items, 'ranks');
        return null;
      }
      case 'EngineerProgress': {
        const rows = list(r, 'Engineers') ?? [r];
        const items = rows.flatMap((x) => {
          const e = rec(x);
          if (!e) return [];
          const engineerName = str(e, 'Engineer');
          if (engineerName === null) return [];
          const stage = str(e, 'Progress');
          const value = int(e, 'Rank');
          const item: Record<string, unknown> = { engineerName };
          if (stage !== null && ENGINEER_STAGES.has(stage)) item['rankStage'] = stage;
          if (value !== null && value >= 1 && value <= 5) item['rankValue'] = value;
          // At least one of the two, as Inara requires. `Known` alone gives neither.
          return Object.keys(item).length > 1 ? [item] : [];
        });
        if (items.length > 0) {
          push(
            'setCommanderRankEngineer',
            items,
            'ranks',
            list(r, 'Engineers') ? 'rank-engineer' : null,
          );
        }
        return null;
      }
      case 'Powerplay':
      case 'PowerplayRank': {
        const power = str(r, 'Power');
        const rank = int(r, 'Rank');
        if (power === null || rank === null) return null;
        this.powerRanks.set(power, rank);
        const merits = r['event'] === 'Powerplay' ? int(r, 'Merits') : null;
        push(
          'setCommanderRankPower',
          { powerName: power, rankValue: rank, ...(merits !== null ? { meritsValue: merits } : {}) },
          'ranks',
          `rank-power:${power}`,
        );
        return null;
      }
      case 'PowerplayMerits': {
        const power = str(r, 'Power');
        const total = int(r, 'TotalMerits');
        const rank = power !== null ? this.powerRanks.get(power) : undefined;
        // `rankValue` is the event's point; merits without a known rank are not sent.
        if (power === null || total === null || rank === undefined) return null;
        push(
          'setCommanderRankPower',
          { powerName: power, rankValue: rank, meritsValue: total },
          'ranks',
          `rank-power:${power}`,
        );
        return null;
      }
      case 'PowerplayLeave': {
        const power = str(r, 'Power');
        if (power === null) return null;
        this.powerRanks.delete(power);
        // Inara: "When player is leaving a power, just set a rankValue [-1]".
        push('setCommanderRankPower', { powerName: power, rankValue: -1 }, 'ranks', `rank-power:${power}`);
        return null;
      }
      case 'Reputation': {
        const items = ['Empire', 'Federation', 'Independent', 'Alliance'].flatMap((name) => {
          const v = num(r, name);
          return v === null
            ? []
            : [{ majorfactionName: name.toLowerCase(), majorfactionReputation: rep(v) }];
        });
        if (items.length > 0) {
          push('setCommanderReputationMajorFaction', items, 'ranks', 'reputation-major');
        }
        return null;
      }
      case 'Statistics': {
        // The whole object, because Inara replaces the stored set: anything left
        // out would be erased.
        const stats = Object.fromEntries(
          Object.entries(r).filter(([k]) => k !== 'timestamp' && k !== 'event'),
        );
        if (Object.keys(stats).length > 0) {
          push('setCommanderGameStatistics', stats, 'statistics', 'statistics');
        }
        return null;
      }

      /* -------------------------------------------------------- ships */
      case 'Loadout':
        this.loadout(r, push);
        return null;
      case 'SetUserShipName': {
        const type = str(r, 'Ship');
        const id = int(r, 'ShipID');
        if (type === null || id === null) return null;
        const d: Record<string, unknown> = { shipType: type, shipGameID: id };
        const name = str(r, 'UserShipName');
        const ident = str(r, 'UserShipId');
        if (name !== null) d['shipName'] = name;
        if (ident !== null) d['shipIdent'] = ident;
        push('setCommanderShip', d, 'ships');
        return null;
      }
      case 'ShipyardSwap': {
        this.oldShip(r, 'StoreOldShip', 'StoreShipID', 'SellOldShip', 'SellShipID', push, 'transfer');
        const type = str(r, 'ShipType');
        const id = int(r, 'ShipID');
        if (type !== null && id !== null) {
          this.ship = { type, id };
          push('setCommanderShip', { shipType: type, shipGameID: id, isCurrentShip: true }, 'ships');
        }
        return null;
      }
      case 'ShipyardBuy':
        // Inara's own example stores the old ship with `setCommanderShip`.
        this.oldShip(r, 'StoreOldShip', 'StoreShipID', 'SellOldShip', 'SellShipID', push, 'ship');
        return null;
      case 'ShipyardNew': {
        const type = str(r, 'ShipType');
        // The journal writes `NewShipID`; Inara's example shows `ShipID`.
        const id = int(r, 'NewShipID');
        if (type === null || id === null) return null;
        this.ship = { type, id };
        push('addCommanderShip', { shipType: type, shipGameID: id }, 'ships');
        return null;
      }
      case 'ShipyardSell':
      case 'SellShipOnRebuy': {
        const type = str(r, 'ShipType');
        const id = int(r, 'SellShipID');
        if (type === null || id === null) return null;
        push('delCommanderShip', { shipType: type, shipGameID: id }, 'ships');
        return null;
      }
      case 'ShipyardTransfer': {
        const type = str(r, 'ShipType');
        const id = int(r, 'ShipID');
        // The destination is where the commander is now; the journal's `System`
        // is where the ship came from. Inara requires both system and station.
        if (type === null || id === null || this.place.system === null) return null;
        if (this.place.station === null) return null;
        const d: Record<string, unknown> = {
          shipType: type,
          shipGameID: id,
          starsystemName: this.place.system,
        };
        if (this.place.station) d['stationName'] = this.place.station;
        if (this.place.marketId !== null) d['marketID'] = this.place.marketId;
        const time = int(r, 'TransferTime');
        if (time !== null) d['transferTime'] = time;
        push('setCommanderShipTransfer', d, 'ships');
        return null;
      }

      /* -------------------------------------------------------- suits */
      case 'SuitLoadout':
      case 'CreateSuitLoadout': {
        const d = suitLoadout(r);
        if (d) push('setCommanderSuitLoadout', d, 'suits', `suit:${d['loadoutGameID']}`);
        return null;
      }
      case 'DeleteSuitLoadout': {
        const id = int(r, 'LoadoutID');
        if (id !== null) push('delCommanderSuitLoadout', { loadoutGameID: id }, 'suits', `suit:${id}`);
        return null;
      }
      case 'RenameSuitLoadout': {
        const id = int(r, 'LoadoutID');
        const name = str(r, 'LoadoutName');
        if (id !== null && name !== null) {
          push('updateCommanderSuitLoadout', { loadoutGameID: id, loadoutName: name }, 'suits');
        }
        return null;
      }

      /* ---------------------------------------------------- inventory */
      case 'Materials': {
        const items = ['Raw', 'Manufactured', 'Encoded'].flatMap((k) => countedItems(list(r, k)));
        if (items === null) return null;
        // Inara documents `set…` as replacing only when it has at least one item,
        // so an empty snapshot is sent as a reset instead.
        if (items.length === 0) {
          push('resetCommanderInventory', [{ itemType: 'Material' }], 'inventory', 'materials');
        } else {
          push('setCommanderInventoryMaterials', items, 'inventory', 'materials');
        }
        return null;
      }
      case 'Cargo': {
        // Only the ship's hold, and only when the event carries the full list.
        if (str(r, 'Vessel') !== 'Ship') return null;
        const inv = list(r, 'Inventory');
        if (inv === null) return null;
        const items = inv.flatMap((x) => {
          const e = rec(x);
          if (!e) return [];
          const itemName = str(e, 'Name');
          const itemCount = int(e, 'Count');
          if (itemName === null || itemCount === null || itemCount <= 0) return [];
          const item: Record<string, unknown> = { itemName, itemCount };
          const stolen = num(e, 'Stolen');
          if (stolen !== null) item['isStolen'] = stolen > 0;
          const mission = int(e, 'MissionID');
          if (mission !== null) item['missionGameID'] = mission;
          return [item];
        });
        if (items.length === 0) {
          push('resetCommanderInventory', [{ itemType: 'Commodity' }], 'inventory', 'cargo');
        } else {
          push('setCommanderInventoryCargo', items, 'inventory', 'cargo');
        }
        return null;
      }
      case 'ShipLocker': {
        const kinds = [
          ['Items', 'Item'],
          ['Components', 'Component'],
          ['Consumables', 'Consumable'],
          ['Data', 'Data'],
        ] as const;
        // Only a complete snapshot: the short form of this event carries no lists.
        if (kinds.some(([k]) => list(r, k) === null)) return null;
        const set: Record<string, unknown>[] = [];
        const reset: Record<string, unknown>[] = [];
        for (const [k, itemType] of kinds) {
          const items = list(r, k)!.flatMap((x) => {
            const e = rec(x);
            if (!e) return [];
            const itemName = str(e, 'Name');
            const itemCount = int(e, 'Count');
            if (itemName === null || itemCount === null || itemCount <= 0) return [];
            const item: Record<string, unknown> = {
              itemName,
              itemCount,
              itemType,
              itemLocation: 'ShipLocker',
            };
            const mission = int(e, 'MissionID');
            if (mission !== null) item['missionGameID'] = mission;
            return [item];
          });
          if (items.length === 0) reset.push({ itemType, itemLocation: 'ShipLocker' });
          else set.push(...items);
        }
        // Reset first, in the same batch, so the order is preserved.
        if (reset.length > 0) push('resetCommanderInventory', reset, 'inventory', 'locker-reset');
        if (set.length > 0) push('setCommanderInventory', set, 'inventory', 'locker');
        return null;
      }
      default:
        return null;
    }
  }

  /** Ship fields, or taxi flags instead when the commander is not in their own ship. */
  private vehicle(r: Raw, d: Record<string, unknown>): void {
    if (bool(r, 'Taxi') === true) {
      if (this.taxi === 'shuttle') d['isTaxiShuttle'] = true;
      if (this.taxi === 'dropship') d['isTaxiDropship'] = true;
      return;
    }
    if (this.ship) {
      d['shipType'] = this.ship.type;
      d['shipGameID'] = this.ship.id;
    }
  }

  private minorFactions(r: Raw, push: (n: string, d: unknown, c: InaraCategory) => void): void {
    const factions = list(r, 'Factions');
    if (!factions) return;
    const items = factions.flatMap((x) => {
      const f = rec(x);
      if (!f) return [];
      const name = str(f, 'Name');
      const value = num(f, 'MyReputation');
      if (name === null || value === null) return [];
      const v = rep(value);
      if (this.minorRep.get(name) === v) return [];
      this.minorRep.set(name, v);
      return [{ minorfactionName: name, minorfactionReputation: v }];
    });
    if (items.length > 0) push('setCommanderReputationMinorFaction', items, 'ranks');
  }

  private oldShip(
    r: Raw,
    storeTypeKey: string,
    storeIdKey: string,
    sellTypeKey: string,
    sellIdKey: string,
    push: (n: string, d: unknown, c: InaraCategory) => void,
    as: 'transfer' | 'ship',
  ): void {
    const sellId = int(r, sellIdKey);
    const sellType = str(r, sellTypeKey);
    if (sellId !== null && sellType !== null) {
      push('delCommanderShip', { shipType: sellType, shipGameID: sellId }, 'ships');
      return;
    }
    const storeId = int(r, storeIdKey);
    const storeType = str(r, storeTypeKey);
    if (storeId === null || storeType === null || this.place.system === null) return;
    // `setCommanderShipTransfer` requires the station; without one, nothing is sent.
    if (as === 'transfer' && this.place.station === null) return;
    const d: Record<string, unknown> = {
      shipType: storeType,
      shipGameID: storeId,
      starsystemName: this.place.system,
    };
    if (this.place.station) d['stationName'] = this.place.station;
    if (this.place.marketId !== null) d['marketID'] = this.place.marketId;
    push(as === 'transfer' ? 'setCommanderShipTransfer' : 'setCommanderShip', d, 'ships');
  }

  private loadout(
    r: Raw,
    push: (n: string, d: unknown, c: InaraCategory, k?: string | null) => void,
  ): void {
    const type = str(r, 'Ship');
    const id = int(r, 'ShipID');
    if (type === null || id === null) return;
    this.ship = { type, id };

    const ship: Record<string, unknown> = { shipType: type, shipGameID: id, isCurrentShip: true };
    const name = str(r, 'ShipName');
    const ident = str(r, 'ShipIdent');
    if (name !== null) ship['shipName'] = name;
    if (ident !== null) ship['shipIdent'] = ident;
    if (bool(r, 'Hot') === true) ship['isHot'] = true;
    const fields: Array<[string, string]> = [
      ['HullValue', 'shipHullValue'],
      ['ModulesValue', 'shipModulesValue'],
      ['Rebuy', 'shipRebuyCost'],
      ['CargoCapacity', 'shipCargoCapacity'],
    ];
    for (const [from, to] of fields) {
      const v = int(r, from);
      if (v !== null) ship[to] = v;
    }
    const jump = num(r, 'MaxJumpRange');
    if (jump !== null) ship['shipMaxJumpRange'] = jump;
    // `isMainShip` is never sent: it is the commander's own pick on Inara, and
    // has nothing to do with which ship they happen to be flying.
    push('setCommanderShip', ship, 'ships', `ship:${id}`);

    const modules = list(r, 'Modules');
    if (modules) {
      push(
        'setCommanderShipLoadout',
        { shipType: type, shipGameID: id, shipLoadout: modules.flatMap(loadoutModule) },
        'ships',
        `loadout:${id}`,
      );
    }
  }
}

function countedItems(rows: readonly unknown[] | null): Array<{ itemName: string; itemCount: number }> {
  if (!rows) return [];
  return rows.flatMap((x) => {
    const e = rec(x);
    if (!e) return [];
    const itemName = str(e, 'Name');
    const itemCount = int(e, 'Count');
    return itemName !== null && itemCount !== null && itemCount > 0 ? [{ itemName, itemCount }] : [];
  });
}

/** One `Loadout.Modules` entry in Inara's shape. Field names per the docs example. */
export function loadoutModule(x: unknown): Array<Record<string, unknown>> {
  const m = rec(x);
  if (!m) return [];
  const slotName = str(m, 'Slot');
  const itemName = str(m, 'Item');
  if (slotName === null || itemName === null) return [];
  const out: Record<string, unknown> = { slotName, itemName };
  const value = int(m, 'Value');
  if (value !== null) out['itemValue'] = value;
  const health = num(m, 'Health');
  if (health !== null) out['itemHealth'] = health;
  const on = bool(m, 'On');
  if (on !== null) out['isOn'] = on;
  const priority = int(m, 'Priority');
  if (priority !== null) out['itemPriority'] = priority;
  const clip = int(m, 'AmmoInClip');
  if (clip !== null) out['itemAmmoClip'] = clip;
  const hopper = int(m, 'AmmoInHopper');
  if (hopper !== null) out['itemAmmoHopper'] = hopper;

  const eng = rec(m['Engineering']);
  if (eng) {
    const e: Record<string, unknown> = {};
    const bp = str(eng, 'BlueprintName');
    if (bp !== null) e['blueprintName'] = bp;
    const level = int(eng, 'Level');
    if (level !== null) e['blueprintLevel'] = level;
    const quality = num(eng, 'Quality');
    if (quality !== null) e['blueprintQuality'] = quality;
    const fx = str(eng, 'ExperimentalEffect');
    if (fx !== null) e['experimentalEffect'] = fx;
    const mods = list(eng, 'Modifiers');
    if (mods) {
      e['modifiers'] = mods.flatMap((y) => {
        const mod = rec(y);
        if (!mod) return [];
        const name = str(mod, 'Label');
        if (name === null) return [];
        const v = num(mod, 'Value');
        const vs = str(mod, 'ValueStr');
        if (v === null && vs === null) return [];
        const o: Record<string, unknown> = { name, value: v ?? vs };
        const orig = num(mod, 'OriginalValue');
        if (orig !== null) o['originalValue'] = orig;
        const less = num(mod, 'LessIsGood');
        if (less !== null) o['lessIsGood'] = less === 1;
        return [o];
      });
    }
    if (Object.keys(e).length > 0) out['engineering'] = e;
  }
  return [out];
}

function suitLoadout(r: Raw): Record<string, unknown> | null {
  const loadoutGameID = int(r, 'LoadoutID');
  const suitGameID = int(r, 'SuitID');
  const suitType = str(r, 'SuitName');
  if (loadoutGameID === null || suitGameID === null || suitType === null) return null;
  const modules = list(r, 'Modules');
  const mods = list(r, 'SuitMods');
  // Complete loadouts only, as Inara asks ("journal event with the entire
  // loadout known"): both lists must be present, even if empty.
  if (modules === null || mods === null) return null;
  const d: Record<string, unknown> = {
    loadoutGameID,
    suitGameID,
    suitType,
    suitMods: mods.filter((m): m is string => typeof m === 'string'),
    suitLoadout: modules.flatMap((x) => {
      const m = rec(x);
      if (!m) return [];
      const slotName = str(m, 'SlotName');
      const itemName = str(m, 'ModuleName');
      if (slotName === null || itemName === null) return [];
      const o: Record<string, unknown> = { slotName, itemName };
      const cls = int(m, 'Class');
      if (cls !== null) o['itemClass'] = cls;
      const gid = int(m, 'SuitModuleID');
      if (gid !== null) o['itemGameID'] = gid;
      const wm = list(m, 'WeaponMods');
      if (wm && wm.length > 0) {
        o['engineering'] = wm
          .filter((b): b is string => typeof b === 'string')
          .map((blueprintName) => ({ blueprintName }));
      }
      return [o];
    }),
  };
  const name = str(r, 'LoadoutName');
  if (name !== null) d['loadoutName'] = name;
  return d;
}
