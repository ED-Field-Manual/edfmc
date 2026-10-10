/**
 * RawJournalEvent -> NormalizedEvent.
 *
 * Additive only. `source.raw` always survives, so a normalization mistake made today
 * can be corrected later without having lost the observation (§6, §27).
 *
 * Phase 1 covers the events required for commander/session state. Every other event
 * still flows through as `known: false` with full provenance — unknown events are
 * delivered, never dropped and never fatal (§28).
 */

import type { NormalizedEvent, RawJournalEvent, Known } from './types.js';
import { parseInventory } from './cargo.js';
import { UNKNOWN, optional } from './types.js';

/* ------------------------------------------------------------------ helpers */

function str(o: Readonly<Record<string, unknown>>, k: string): Known<string> {
  const v = optional<unknown>(o, k);
  return typeof v === 'string' ? v : UNKNOWN;
}
function num(o: Readonly<Record<string, unknown>>, k: string): Known<number> {
  const v = optional<unknown>(o, k);
  return typeof v === 'number' ? v : UNKNOWN;
}
function bool(o: Readonly<Record<string, unknown>>, k: string): Known<boolean> {
  const v = optional<unknown>(o, k);
  return typeof v === 'boolean' ? v : UNKNOWN;
}
function obj(o: Readonly<Record<string, unknown>>, k: string): Record<string, unknown> | null {
  const v = o[k];
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** `[x, y, z]` only when all three are numbers; otherwise UNKNOWN. Never partial. */
function starPos(o: Readonly<Record<string, unknown>>): Known<readonly [number, number, number]> {
  const v = o['StarPos'];
  if (!Array.isArray(v) || v.length !== 3) return UNKNOWN;
  const [x, y, z] = v;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return UNKNOWN;
  return [x, y, z] as const;
}

/* -------------------------------------------------------- station services */

export interface StationService {
  /** Frontier's token, byte-for-byte. This is the evidence a §9 report carries. */
  readonly raw: string;
  /** Case-folded identifier used for comparison. */
  readonly id: string;
}

/**
 * Normalize the `StationServices` array.
 *
 * Casing in this array is genuinely inconsistent: one real sample contains
 * `"stationMenu"` alongside `"dock"`, `"searchrescue"` and
 * `"registeringcolonisation"`. Comparing raw tokens would produce phantom
 * discrepancies, so comparison happens on `id` while `raw` is retained verbatim.
 */
export function normalizeStationServices(value: unknown): readonly StationService[] | typeof UNKNOWN {
  if (!Array.isArray(value)) return UNKNOWN;
  const out: StationService[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    out.push({ raw: entry, id: entry.toLowerCase() });
  }
  return out;
}

export interface StationEconomy {
  readonly name: string;
  readonly localised: string | null;
  /**
   * Frontier's value, NOT renormalised. Observed proportions summing to 1.10
   * (0.90 + 0.10 + 0.05 + 0.05), so treating these as a probability distribution
   * would be wrong.
   */
  readonly proportion: number | null;
}

function economies(value: unknown): readonly StationEconomy[] | typeof UNKNOWN {
  if (!Array.isArray(value)) return UNKNOWN;
  const out: StationEconomy[] = [];
  for (const e of value) {
    if (e === null || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r['Name'] !== 'string') continue;
    out.push({
      name: r['Name'],
      localised: typeof r['Name_Localised'] === 'string' ? r['Name_Localised'] : null,
      proportion: typeof r['Proportion'] === 'number' ? r['Proportion'] : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------ typed shapes */

export interface DockedData {
  readonly stationName: Known<string>;
  readonly stationType: Known<string>;
  readonly marketId: Known<number>;
  readonly starSystem: Known<string>;
  readonly systemAddress: Known<number>;
  readonly stationFaction: Known<string>;
  readonly services: ReturnType<typeof normalizeStationServices>;
  readonly economies: ReturnType<typeof economies>;
  readonly distFromStarLs: Known<number>;
  /** Present on only 32.0% of Docked events. UNKNOWN is not "independent". */
  readonly allegiance: Known<string>;
  readonly landingPads: Known<Record<string, unknown>>;
}

export interface LocationData {
  readonly starSystem: Known<string>;
  readonly systemAddress: Known<number>;
  readonly starPos: Known<readonly [number, number, number]>;
  readonly body: Known<string>;
  readonly bodyId: Known<number>;
  readonly bodyType: Known<string>;
  readonly docked: Known<boolean>;
  readonly stationName: Known<string>;
  readonly stationType: Known<string>;
  readonly marketId: Known<number>;
  readonly services: ReturnType<typeof normalizeStationServices> | typeof UNKNOWN;
  /** Appears only when true; absence means "not reported", handled by state. */
  readonly onFoot: Known<boolean>;
  readonly inSrv: Known<boolean>;
  readonly latitude: Known<number>;
  readonly longitude: Known<number>;
}

export interface FsdJumpData {
  readonly starSystem: Known<string>;
  readonly systemAddress: Known<number>;
  /** 100% present across n=3837 — the basis for any distance calculation. */
  readonly starPos: Known<readonly [number, number, number]>;
  readonly jumpDist: Known<number>;
  readonly fuelLevel: Known<number>;
  readonly body: Known<string>;
  readonly bodyId: Known<number>;
  /** 100% present on FSDJump (n=3837). */
  readonly bodyType: Known<string>;
}

export interface ApproachSettlementData {
  readonly name: Known<string>;
  readonly marketId: Known<number>;
  readonly systemAddress: Known<number>;
  readonly bodyId: Known<number>;
  readonly bodyName: Known<string>;
  readonly latitude: Known<number>;
  readonly longitude: Known<number>;
  readonly services: ReturnType<typeof normalizeStationServices>;
  readonly economies: ReturnType<typeof economies>;
  readonly allegiance: Known<string>;
  readonly stationFaction: Known<string>;
}

export interface ColonisationDepotResource {
  /** `$aluminium_name;` form — differs from Market/EDDN naming. Kept raw. */
  readonly name: string;
  readonly localised: string | null;
  readonly required: number;
  readonly provided: number;
  readonly payment: number | null;
}

export interface ColonisationDepotData {
  readonly marketId: Known<number>;
  readonly progress: Known<number>;
  readonly complete: Known<boolean>;
  readonly failed: Known<boolean>;
  /** A complete snapshot every emission — no delta inference is required. */
  readonly resources: readonly ColonisationDepotResource[];
}

/* -------------------------------------------------------------- registry */

type Normalizer = (raw: Readonly<Record<string, unknown>>) => unknown;

const REGISTRY: Record<string, { kind: string; fn: Normalizer }> = {
  Docked: {
    kind: 'docked',
    fn: (r): DockedData => ({
      stationName: str(r, 'StationName'),
      stationType: str(r, 'StationType'),
      marketId: num(r, 'MarketID'),
      starSystem: str(r, 'StarSystem'),
      systemAddress: num(r, 'SystemAddress'),
      stationFaction: (() => {
        const f = obj(r, 'StationFaction');
        return f && typeof f['Name'] === 'string' ? f['Name'] : UNKNOWN;
      })(),
      services: normalizeStationServices(r['StationServices']),
      economies: economies(r['StationEconomies']),
      distFromStarLs: num(r, 'DistFromStarLS'),
      allegiance: str(r, 'StationAllegiance'),
      landingPads: (obj(r, 'LandingPads') ?? UNKNOWN) as Known<Record<string, unknown>>,
    }),
  },
  Undocked: {
    kind: 'undocked',
    fn: (r) => ({
      stationName: str(r, 'StationName'),
      stationType: str(r, 'StationType'),
      marketId: num(r, 'MarketID'),
    }),
  },
  Location: { kind: 'location', fn: (r): LocationData => locationLike(r) },
  FSDJump: {
    kind: 'fsd-jump',
    fn: (r): FsdJumpData => ({
      starSystem: str(r, 'StarSystem'),
      systemAddress: num(r, 'SystemAddress'),
      starPos: starPos(r),
      jumpDist: num(r, 'JumpDist'),
      fuelLevel: num(r, 'FuelLevel'),
      body: str(r, 'Body'),
      bodyId: num(r, 'BodyID'),
      bodyType: str(r, 'BodyType'),
    }),
  },
  CarrierJump: { kind: 'carrier-jump', fn: (r): LocationData => locationLike(r) },
  ApproachSettlement: {
    kind: 'approach-settlement',
    fn: (r): ApproachSettlementData => ({
      name: str(r, 'Name'),
      marketId: num(r, 'MarketID'),
      systemAddress: num(r, 'SystemAddress'),
      bodyId: num(r, 'BodyID'),
      bodyName: str(r, 'BodyName'),
      latitude: num(r, 'Latitude'),
      longitude: num(r, 'Longitude'),
      services: normalizeStationServices(r['StationServices']),
      economies: economies(r['StationEconomies']),
      allegiance: str(r, 'StationAllegiance'),
      stationFaction: (() => {
        const f = obj(r, 'StationFaction');
        return f && typeof f['Name'] === 'string' ? f['Name'] : UNKNOWN;
      })(),
    }),
  },
  ColonisationConstructionDepot: {
    kind: 'colonisation-depot',
    fn: (r): ColonisationDepotData => {
      const list = Array.isArray(r['ResourcesRequired']) ? r['ResourcesRequired'] : [];
      const resources: ColonisationDepotResource[] = [];
      for (const e of list) {
        if (e === null || typeof e !== 'object') continue;
        const x = e as Record<string, unknown>;
        if (typeof x['Name'] !== 'string') continue;
        if (typeof x['RequiredAmount'] !== 'number' || typeof x['ProvidedAmount'] !== 'number') continue;
        resources.push({
          name: x['Name'],
          localised: typeof x['Name_Localised'] === 'string' ? x['Name_Localised'] : null,
          required: x['RequiredAmount'],
          provided: x['ProvidedAmount'],
          payment: typeof x['Payment'] === 'number' ? x['Payment'] : null,
        });
      }
      return {
        marketId: num(r, 'MarketID'),
        progress: num(r, 'ConstructionProgress'),
        complete: bool(r, 'ConstructionComplete'),
        failed: bool(r, 'ConstructionFailed'),
        resources,
      };
    },
  },
  LoadGame: {
    kind: 'load-game',
    fn: (r) => ({
      commander: str(r, 'Commander'),
      fid: str(r, 'FID'),
      ship: str(r, 'Ship'),
      shipLocalised: str(r, 'Ship_Localised'),
      shipName: str(r, 'ShipName'),
      shipIdent: str(r, 'ShipIdent'),
      shipId: num(r, 'ShipID'),
      credits: num(r, 'Credits'),
      gameMode: str(r, 'GameMode'),
      group: str(r, 'Group'),
      startLanded: bool(r, 'StartLanded'),
      fuelLevel: num(r, 'FuelLevel'),
      fuelCapacity: num(r, 'FuelCapacity'),
    }),
  },
  Commander: { kind: 'commander', fn: (r) => ({ name: str(r, 'Name'), fid: str(r, 'FID') }) },
  /*
   * The ship being flown, written after login, outfitting and shipyard swaps.
   * Ship, ShipID, ShipName, ShipIdent and CargoCapacity are present on all 843
   * in the corpus.
   */
  Loadout: {
    kind: 'loadout',
    fn: (r) => ({
      ship: str(r, 'Ship'),
      shipId: num(r, 'ShipID'),
      shipName: str(r, 'ShipName'),
      shipIdent: str(r, 'ShipIdent'),
      cargoCapacity: num(r, 'CargoCapacity'),
    }),
  },
  Fileheader: {
    kind: 'file-header',
    fn: (r) => ({
      gameVersion: str(r, 'gameversion'),
      build: str(r, 'build'),
      odyssey: bool(r, 'Odyssey'),
      part: num(r, 'part'),
      language: str(r, 'language'),
    }),
  },
  Cargo: {
    kind: 'cargo',
    fn: (r) => ({
      vessel: str(r, 'Vessel'),
      count: num(r, 'Count'),
      /** Absent when the game wrote the detail to Cargo.json instead. */
      hasInventory: Array.isArray(r['Inventory']),
      inventory: parseInventory(r['Inventory']),
    }),
  },
  /*
   * Fleet carrier identity.
   *
   * `Docked` at a carrier reports only the callsign (e.g. `HBN-TXN`) as
   * StationName; the human-readable name appears nowhere in that event. It comes
   * from `CarrierStats` / `CarrierNameChange`, which carry `CarrierID` — and that
   * id equals the `MarketID` on the corresponding Docked event, which is what
   * lets the two be joined.
   *
   * This therefore only resolves the *commander's own* carrier. Docking at
   * someone else's produces no CarrierStats, so their name is genuinely not in
   * the journal and the callsign is all we can honestly show.
   *
   * Note: real CarrierNameChange payloads contain a malformed empty-string key
   * (`"":"FleetCarrier"`). It is ignored, and parsing is unaffected.
   */
  CarrierStats: {
    kind: 'carrier-identity',
    fn: (r) => ({
      carrierId: num(r, 'CarrierID'),
      callsign: str(r, 'Callsign'),
      name: str(r, 'Name'),
    }),
  },
  CarrierNameChange: {
    kind: 'carrier-identity',
    fn: (r) => ({
      carrierId: num(r, 'CarrierID'),
      callsign: str(r, 'Callsign'),
      name: str(r, 'Name'),
    }),
  },
  /**
   * Fleet carrier jump scheduling.
   *
   * `DepartureTime` is present on 100% of 136 requests and is accurate: the
   * observed `CarrierJump` follows it by a median of 58 seconds (range -60s to
   * +63s, the spread being when the *commander* loaded into the new system rather
   * than when the carrier left). So a countdown is reported, not inferred.
   *
   * These are management events and follow the commander, not the carrier: only
   * 47.8% of requests were made while aboard, the rest from open space or a station
   * in another system. A pending jump is therefore knowable from anywhere.
   *
   * `CarrierJumpRequest` only ever fires for a carrier the commander commands --
   * all 136 belong to the three carriers seen in CarrierStats, and none of the 45
   * other carriers docked at produced one. Someone else's carrier tells us nothing.
   */
  CarrierJumpRequest: {
    kind: 'carrier-jump-request',
    fn: (r) => ({
      carrierId: num(r, 'CarrierID'),
      system: str(r, 'SystemName'),
      systemAddress: num(r, 'SystemAddress'),
      // 97.1% present: a jump to a system with no body selected omits it.
      body: str(r, 'Body'),
      bodyId: num(r, 'BodyID'),
      departureTime: str(r, 'DepartureTime'),
    }),
  },

  CarrierJumpCancelled: {
    kind: 'carrier-jump-cancelled',
    fn: (r) => ({ carrierId: num(r, 'CarrierID') }),
  },

  /**
   * Where the carrier is, independent of whether the commander saw it move.
   *
   * This is what makes a pending jump resolvable at all. `CarrierJump` is only
   * written when the commander is aboard -- 53 of them while docked at an owned
   * carrier, and none otherwise -- so with 136 requests against 72 jumps, roughly
   * half of all jumps are never witnessed. Keying completion on `CarrierJump` alone
   * would leave a countdown stuck pending forever on those.
   */
  CarrierLocation: {
    kind: 'carrier-location',
    fn: (r) => ({
      carrierId: num(r, 'CarrierID'),
      starSystem: str(r, 'StarSystem'),
      systemAddress: num(r, 'SystemAddress'),
      bodyId: num(r, 'BodyID'),
    }),
  },

  CarrierBuy: {
    kind: 'carrier-identity',
    fn: (r) => ({
      carrierId: num(r, 'CarrierID'),
      callsign: str(r, 'Callsign'),
      // A newly bought carrier has no name yet.
      name: UNKNOWN as Known<string>,
    }),
  },

  /**
   * Material Trader identity.
   *
   * `StationServices` says only `materialtrader` -- never which of the three
   * kinds it is. Measured across the corpus: 141 docks at trader stations, and no
   * field in any event names the type. `MaterialTrade` does name it
   * (`TraderType`: encoded / raw / manufactured), but only once the commander has
   * actually traded there.
   *
   * So the type is learned per station and remembered, exactly like a carrier
   * name. Two measurements justify that:
   *
   *  - It is stable. Across 29 stations where trades were observed, not one ever
   *    reported a second TraderType.
   *  - It cannot be inferred instead. The usual economy -> type mapping is wrong
   *    often enough to matter: High Tech gave `encoded` 7 times but `raw` once,
   *    Industrial gave `manufactured` 10 times but `raw` twice, and Extraction
   *    produced all three. Presenting an inference as fact is precisely what §2
   *    forbids, so an untraded station's type stays UNKNOWN.
   */
  MaterialTrade: {
    kind: 'trader-identity',
    fn: (r) => ({
      marketId: num(r, 'MarketID'),
      traderType: str(r, 'TraderType'),
    }),
  },

  /**
   * FSD target and route progress.
   *
   * `RemainingJumpsInRoute` is present on 94.5% of these (n=4157). Its absence
   * means no multi-jump route is plotted — not zero jumps remaining.
   */
  FSDTarget: {
    kind: 'fsd-target',
    fn: (r) => ({
      system: str(r, 'Name'),
      systemAddress: num(r, 'SystemAddress'),
      starClass: str(r, 'StarClass'),
      remainingJumps: num(r, 'RemainingJumpsInRoute'),
    }),
  },
  /**
   * Jump charging.
   *
   * `JumpType` is "Hyperspace" (n=3842) or "Supercruise" (n=1644). Only the
   * hyperspace form carries StarSystem/SystemAddress/StarClass, and it does so at
   * 100% presence — that is where the destination shown during witch space comes
   * from.
   */
  StartJump: {
    kind: 'start-jump',
    fn: (r) => ({
      jumpType: str(r, 'JumpType'),
      system: str(r, 'StarSystem'),
      starClass: str(r, 'StarClass'),
    }),
  },
  NavRouteClear: { kind: 'nav-route-clear', fn: () => ({}) },

  Shutdown: { kind: 'shutdown', fn: () => ({}) },
  Embark: { kind: 'embark', fn: (r) => onFootTransition(r) },
  Disembark: { kind: 'disembark', fn: (r) => onFootTransition(r) },
  SupercruiseEntry: { kind: 'supercruise-entry', fn: (r) => ({ starSystem: str(r, 'StarSystem') }) },
  SupercruiseExit: {
    kind: 'supercruise-exit',
    fn: (r) => ({ starSystem: str(r, 'StarSystem'), body: str(r, 'Body'), bodyType: str(r, 'BodyType') }),
  },
  Touchdown: {
    kind: 'touchdown',
    fn: (r) => ({
      body: str(r, 'Body'),
      latitude: num(r, 'Latitude'),
      longitude: num(r, 'Longitude'),
      nearestDestination: str(r, 'NearestDestination'),
    }),
  },
  Liftoff: { kind: 'liftoff', fn: (r) => ({ body: str(r, 'Body') }) },

  /**
   * Exobiology sampling.
   *
   * ScanType is one of Log / Sample / Analyse (measured 63 / 120 / 60 across 243
   * events, all fields 100% present). Only `Analyse` completes a specimen and
   * produces data that can be sold -- the first two are progress toward it.
   */
  ScanOrganic: {
    kind: 'organic-scan',
    fn: (r) => ({
      scanType: str(r, 'ScanType'),
      genus: str(r, 'Genus_Localised'),
      species: str(r, 'Species_Localised'),
      variant: str(r, 'Variant_Localised'),
      systemAddress: num(r, 'SystemAddress'),
      bodyId: num(r, 'Body'),
    }),
  },

  /**
   * Selling exobiology data at Vista Genomics.
   *
   * `BioData` is an array of what was sold, one entry per species -- 100% present
   * across 5 sales, of lengths 1, 1, 7, 8 and 28. Its length is the only statement
   * the journal makes about quantity.
   */
  SellOrganicData: {
    kind: 'organic-sold',
    fn: (r) => {
      const bio = r['BioData'];
      return {
        marketId: num(r, 'MarketID'),
        sold: Array.isArray(bio) ? bio.length : (UNKNOWN as Known<number>),
      };
    },
  },

  /**
   * Commander death.
   *
   * Normalized only so held exobiology data can be treated as no longer
   * confirmed. Whether death actually destroys unsold data could not be
   * established from the corpus -- see `exobiologyToSell`.
   */
  Died: { kind: 'died', fn: () => ({}) },
};

function onFootTransition(r: Readonly<Record<string, unknown>>) {
  return {
    srv: bool(r, 'SRV'),
    taxi: bool(r, 'Taxi'),
    multicrew: bool(r, 'Multicrew'),
    starSystem: str(r, 'StarSystem'),
    systemAddress: num(r, 'SystemAddress'),
    body: str(r, 'Body'),
    bodyId: num(r, 'BodyID'),
    onStation: bool(r, 'OnStation'),
    onPlanet: bool(r, 'OnPlanet'),
  };
}

function locationLike(r: Readonly<Record<string, unknown>>): LocationData {
  return {
    starSystem: str(r, 'StarSystem'),
    systemAddress: num(r, 'SystemAddress'),
    starPos: starPos(r),
    body: str(r, 'Body'),
    bodyId: num(r, 'BodyID'),
    bodyType: str(r, 'BodyType'),
    docked: bool(r, 'Docked'),
    stationName: str(r, 'StationName'),
    stationType: str(r, 'StationType'),
    marketId: num(r, 'MarketID'),
    services: 'StationServices' in r ? normalizeStationServices(r['StationServices']) : UNKNOWN,
    onFoot: bool(r, 'OnFoot'),
    inSrv: bool(r, 'InSRV'),
    latitude: num(r, 'Latitude'),
    longitude: num(r, 'Longitude'),
  };
}

/** True when a typed shape exists. Used by diagnostics, not by control flow. */
export function isKnownEvent(eventName: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, eventName);
}

/**
 * Normalize one event. Never throws: a normalizer that fails degrades the event to
 * `known: false` rather than taking down the pipeline, because a Frontier field type
 * change must not stop the application from working (§28).
 */
export function normalize(source: RawJournalEvent): NormalizedEvent {
  const entry = REGISTRY[source.event];
  if (!entry) return { kind: 'unknown', known: false, data: null, source };
  try {
    return { kind: entry.kind, known: true, data: entry.fn(source.raw), source };
  } catch {
    return { kind: 'unknown', known: false, data: null, source };
  }
}
