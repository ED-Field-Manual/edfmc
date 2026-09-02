/**
 * Commander / session state (§4).
 *
 * Governing rule: never guess. Every field starts UNKNOWN and only becomes known
 * when an event actually said so. A field the game did not report stays UNKNOWN
 * rather than defaulting to false/zero/empty, because downstream features
 * (verification especially) must be able to distinguish "absent" from "reported as
 * none".
 */

import type { NormalizedEvent, Known } from './types.js';
import { UNKNOWN, isKnown } from './types.js';
import type {
  ApproachSettlementData,
  DockedData,
  FsdJumpData,
  LocationData,
  StationService,
} from './normalizer.js';

export type DockingState = 'docked' | 'undocked' | 'unknown';
export type VehicleState = 'ship' | 'srv' | 'on-foot' | 'taxi' | 'unknown';

export interface CommanderState {
  commander: Known<string>;
  fid: Known<string>;
  gameVersion: Known<string>;
  build: Known<string>;
  odyssey: Known<boolean>;
  gameMode: Known<string>;

  starSystem: Known<string>;
  systemAddress: Known<number>;
  starPos: Known<readonly [number, number, number]>;

  body: Known<string>;
  /**
   * "Planet", "Star", or "Station".
   *
   * "Station" means Body and StationName are the same thing: the journal reports
   * Body='Elder Hub' alongside StationName='Elder Hub' (89 of 169 docked Location
   * events). Anything else means Body is a real celestial body the station sits on
   * or orbits — a fleet carrier is always Planet or Star — and the two are
   * genuinely different places worth showing separately.
   */
  bodyType: Known<string>;
  bodyId: Known<number>;
  latitude: Known<number>;
  longitude: Known<number>;

  /** Exactly what the journal reported. For a carrier this is the callsign. */
  stationName: Known<string>;
  stationType: Known<string>;
  marketId: Known<number>;
  stationServices: Known<readonly StationService[]>;
  docking: DockingState;

  /**
   * Human-readable name of the carrier currently docked at, when known.
   *
   * Only resolvable for the commander's own carrier: `Docked` carries just the
   * callsign, and the name has to be joined from CarrierStats by CarrierID. At
   * someone else's carrier this stays UNKNOWN, because the journal genuinely does
   * not say — it is not a lookup failure to paper over.
   */
  carrierName: Known<string>;
  /** CarrierID -> name, accumulated from CarrierStats / CarrierNameChange. */
  knownCarriers: Record<number, string>;

  vehicle: VehicleState;
  ship: Known<string>;
  shipName: Known<string>;
  shipIdent: Known<string>;
  cargoCount: Known<number>;

  /** Most recent settlement approached, for context assistance (Phase 3). */
  lastSettlement: Known<string>;

  /** Provenance of the newest event folded in, for the dashboard and diagnostics. */
  lastEventId: string | null;
  lastEventName: string | null;
  lastEventAt: string | null;
  /** Set when a Shutdown event was seen; the game is known to have exited. */
  shutdown: boolean;
}

export function initialState(): CommanderState {
  return {
    commander: UNKNOWN,
    fid: UNKNOWN,
    gameVersion: UNKNOWN,
    build: UNKNOWN,
    odyssey: UNKNOWN,
    gameMode: UNKNOWN,
    starSystem: UNKNOWN,
    systemAddress: UNKNOWN,
    starPos: UNKNOWN,
    body: UNKNOWN,
    bodyType: UNKNOWN,
    bodyId: UNKNOWN,
    latitude: UNKNOWN,
    longitude: UNKNOWN,
    stationName: UNKNOWN,
    stationType: UNKNOWN,
    marketId: UNKNOWN,
    stationServices: UNKNOWN,
    carrierName: UNKNOWN,
    knownCarriers: {},
    docking: 'unknown',
    vehicle: 'unknown',
    ship: UNKNOWN,
    shipName: UNKNOWN,
    shipIdent: UNKNOWN,
    cargoCount: UNKNOWN,
    lastSettlement: UNKNOWN,
    lastEventId: null,
    lastEventName: null,
    lastEventAt: null,
    shutdown: false,
  };
}

/** Assign only when the incoming value is actually known — never overwrite with UNKNOWN. */
function set<T>(current: Known<T>, incoming: Known<T>): Known<T> {
  return isKnown(incoming) ? incoming : current;
}

/**
 * Join the docked station to a known carrier name.
 *
 * The link is `Docked.MarketID === CarrierStats.CarrierID`; both were observed as
 * 3703420416 for the same carrier. Leaves `carrierName` UNKNOWN when no identity
 * has been seen, which is the honest answer for another commander's carrier.
 */
function resolveCarrierName(s: CommanderState): void {
  if (!isKnown(s.stationType) || s.stationType !== 'FleetCarrier') return;
  if (!isKnown(s.marketId)) return;
  const name = s.knownCarriers[s.marketId];
  if (name) s.carrierName = name;
}

/**
 * Record a carrier identity and re-resolve the current station if it matches.
 *
 * Separate from `applyEvent` so identities can be loaded from storage or learned
 * from historical journals without those old events overwriting `lastEvent*` and
 * making the dashboard report stale activity.
 */
export function learnCarrier(state: CommanderState, carrierId: number, name: string): void {
  if (!Number.isFinite(carrierId) || name.length === 0) return;
  state.knownCarriers[carrierId] = name;
  if (isKnown(state.marketId) && state.marketId === carrierId) state.carrierName = name;
}

function clearLocation(s: CommanderState): void {
  s.stationName = UNKNOWN;
  s.stationType = UNKNOWN;
  s.marketId = UNKNOWN;
  s.stationServices = UNKNOWN;
  s.carrierName = UNKNOWN;
}

/**
 * Fold one normalized event into state.
 *
 * Pure with respect to its input event; mutates and returns `state` so a long
 * session does not allocate a new object per event (§30).
 */
export function applyEvent(state: CommanderState, event: NormalizedEvent): CommanderState {
  const p = event.source.provenance;

  state.lastEventId = p.eventId;
  state.lastEventName = event.source.event;
  state.lastEventAt = p.timestamp || null;

  if (p.commander !== null) state.commander = p.commander;
  if (p.fid !== null) state.fid = p.fid;
  if (p.gameVersion !== null) state.gameVersion = p.gameVersion;
  if (p.build !== null) state.build = p.build;
  if (p.odyssey !== null) state.odyssey = p.odyssey;

  switch (event.kind) {
    case 'load-game': {
      const d = event.data as {
        ship: Known<string>;
        shipName: Known<string>;
        shipIdent: Known<string>;
        gameMode: Known<string>;
      };
      state.ship = set(state.ship, d.ship);
      state.shipName = set(state.shipName, d.shipName);
      state.shipIdent = set(state.shipIdent, d.shipIdent);
      state.gameMode = set(state.gameMode, d.gameMode);
      state.shutdown = false;
      break;
    }

    case 'location': {
      const d = event.data as LocationData;
      applyLocationLike(state, d);
      break;
    }

    case 'carrier-jump': {
      applyLocationLike(state, event.data as LocationData);
      break;
    }

    case 'fsd-jump': {
      const d = event.data as FsdJumpData;
      state.starSystem = set(state.starSystem, d.starSystem);
      state.systemAddress = set(state.systemAddress, d.systemAddress);
      state.starPos = set(state.starPos, d.starPos);
      state.body = set(state.body, d.body);
      state.bodyType = set(state.bodyType, d.bodyType);
      state.bodyId = set(state.bodyId, d.bodyId);
      // Jumping always leaves any station and any planetary surface behind.
      state.docking = 'undocked';
      state.latitude = UNKNOWN;
      state.longitude = UNKNOWN;
      state.lastSettlement = UNKNOWN;
      clearLocation(state);
      break;
    }

    case 'carrier-identity': {
      const d = event.data as {
        carrierId: Known<number>;
        name: Known<string>;
      };
      // Also re-resolves, so a rename while docked takes effect immediately.
      if (isKnown(d.carrierId) && isKnown(d.name)) learnCarrier(state, d.carrierId, d.name);
      break;
    }

    case 'docked': {
      const d = event.data as DockedData;
      state.docking = 'docked';
      state.stationName = set(state.stationName, d.stationName);
      state.stationType = set(state.stationType, d.stationType);
      state.marketId = set(state.marketId, d.marketId);
      state.starSystem = set(state.starSystem, d.starSystem);
      state.systemAddress = set(state.systemAddress, d.systemAddress);
      if (d.services !== UNKNOWN) state.stationServices = d.services;
      resolveCarrierName(state);
      break;
    }

    case 'undocked': {
      state.docking = 'undocked';
      clearLocation(state);
      break;
    }

    case 'approach-settlement': {
      const d = event.data as ApproachSettlementData;
      state.lastSettlement = set(state.lastSettlement, d.name);
      state.systemAddress = set(state.systemAddress, d.systemAddress);
      state.bodyId = set(state.bodyId, d.bodyId);
      state.body = set(state.body, d.bodyName);
      state.marketId = set(state.marketId, d.marketId);
      if (d.services !== UNKNOWN) state.stationServices = d.services;
      break;
    }

    case 'touchdown': {
      const d = event.data as { latitude: Known<number>; longitude: Known<number> };
      state.latitude = set(state.latitude, d.latitude);
      state.longitude = set(state.longitude, d.longitude);
      break;
    }

    case 'liftoff': {
      state.latitude = UNKNOWN;
      state.longitude = UNKNOWN;
      break;
    }

    case 'disembark': {
      const d = event.data as { srv: Known<boolean> };
      // Disembark means leaving a vehicle. SRV:true is disembarking *from* an SRV,
      // which still puts the commander on foot.
      state.vehicle = 'on-foot';
      void d;
      break;
    }

    case 'embark': {
      const d = event.data as { srv: Known<boolean>; taxi: Known<boolean> };
      state.vehicle = isKnown(d.srv) && d.srv ? 'srv' : isKnown(d.taxi) && d.taxi ? 'taxi' : 'ship';
      break;
    }

    case 'supercruise-entry': {
      state.docking = 'undocked';
      state.latitude = UNKNOWN;
      state.longitude = UNKNOWN;
      break;
    }

    case 'supercruise-exit': {
      const d = event.data as { body: Known<string>; bodyType: Known<string> };
      state.body = set(state.body, d.body);
      state.bodyType = set(state.bodyType, d.bodyType);
      break;
    }

    case 'cargo': {
      const d = event.data as { vessel: Known<string>; count: Known<number> };
      // Only ship cargo belongs on the dashboard's cargo figure.
      if (!isKnown(d.vessel) || d.vessel === 'Ship') state.cargoCount = set(state.cargoCount, d.count);
      break;
    }

    case 'shutdown': {
      state.shutdown = true;
      break;
    }

    default:
      break; // unknown events still updated provenance above
  }

  return state;
}

function applyLocationLike(state: CommanderState, d: LocationData): void {
  state.starSystem = set(state.starSystem, d.starSystem);
  state.systemAddress = set(state.systemAddress, d.systemAddress);
  state.starPos = set(state.starPos, d.starPos);
  state.body = set(state.body, d.body);
  state.bodyType = set(state.bodyType, d.bodyType);
  state.bodyId = set(state.bodyId, d.bodyId);
  state.latitude = set(state.latitude, d.latitude);
  state.longitude = set(state.longitude, d.longitude);

  if (isKnown(d.docked)) {
    state.docking = d.docked ? 'docked' : 'undocked';
    if (d.docked) {
      state.stationName = set(state.stationName, d.stationName);
      state.stationType = set(state.stationType, d.stationType);
      state.marketId = set(state.marketId, d.marketId);
      if (d.services !== UNKNOWN) state.stationServices = d.services as readonly StationService[];
      // Covers starting the session already docked, and CarrierJump.
      resolveCarrierName(state);
    } else {
      clearLocation(state);
    }
  }

  // OnFoot/InSRV appear only when true; absence here means "not reported".
  if (isKnown(d.onFoot) && d.onFoot) state.vehicle = 'on-foot';
  else if (isKnown(d.inSrv) && d.inSrv) state.vehicle = 'srv';
}
