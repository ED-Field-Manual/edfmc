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
  CarrierBuy: {
    kind: 'carrier-identity',
    fn: (r) => ({
      carrierId: num(r, 'CarrierID'),
      callsign: str(r, 'Callsign'),
      // A newly bought carrier has no name yet.
      name: UNKNOWN as Known<string>,
    }),
  },

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
