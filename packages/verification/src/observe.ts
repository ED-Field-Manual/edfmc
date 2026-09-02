/**
 * Turning journal events into station observations.
 *
 * Passive by design (§9). Nothing here prompts the commander, and nothing is
 * submitted anywhere — it captures what the game reported while they went about
 * their session.
 */

import {
  UNKNOWN,
  isKnown,
  normalizeStationServices,
  type Known,
  type NormalizedEvent,
  type StationService,
} from '@edfm/elite-journal';

import type { ObservationChannel, StationEconomyObservation, StationObservation } from './types.js';

function str(o: Readonly<Record<string, unknown>>, k: string): Known<string> {
  const v = o[k];
  return typeof v === 'string' ? v : UNKNOWN;
}
function num(o: Readonly<Record<string, unknown>>, k: string): Known<number> {
  const v = o[k];
  return typeof v === 'number' ? v : UNKNOWN;
}

function economies(value: unknown): StationEconomyObservation[] {
  if (!Array.isArray(value)) return [];
  const out: StationEconomyObservation[] = [];
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

function landingPads(value: unknown): Known<Record<string, number>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return UNKNOWN;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : UNKNOWN;
}

function factionName(value: unknown): Known<string> {
  if (value === null || typeof value !== 'object') return UNKNOWN;
  const name = (value as Record<string, unknown>)['Name'];
  return typeof name === 'string' ? name : UNKNOWN;
}

const CHANNELS: Record<string, ObservationChannel> = {
  Docked: 'docked',
  ApproachSettlement: 'approach',
  Location: 'location',
  CarrierJump: 'location',
};

/**
 * Extract a station observation, or null when the event carries none.
 *
 * Requires a MarketID and a services array. Without the former there is no stable
 * identity to attach evidence to; without the latter there is nothing to verify,
 * and recording an empty service list would assert the station has none.
 */
export function observeStation(event: NormalizedEvent): StationObservation | null {
  const channel = CHANNELS[event.source.event];
  if (!channel) return null;

  const raw = event.source.raw;
  const marketId = raw['MarketID'];
  if (typeof marketId !== 'number' || !Number.isSafeInteger(marketId)) return null;

  const services = normalizeStationServices(raw['StationServices']);
  if (services === UNKNOWN) return null;

  // ApproachSettlement names the settlement in `Name`; the others use StationName.
  const nameField = event.source.event === 'ApproachSettlement' ? 'Name' : 'StationName';
  const stationName = raw[nameField];
  if (typeof stationName !== 'string' || stationName.length === 0) return null;

  const p = event.source.provenance;

  return {
    marketId,
    stationName,
    stationType: str(raw, 'StationType'),
    starSystem: str(raw, 'StarSystem'),
    systemAddress: num(raw, 'SystemAddress'),
    services: services as readonly StationService[],
    economies: economies(raw['StationEconomies']),
    stationFaction: factionName(raw['StationFaction']),
    stationGovernment: str(raw, 'StationGovernment'),
    allegiance: str(raw, 'StationAllegiance'),
    distFromStarLs: num(raw, 'DistFromStarLS'),
    landingPads: landingPads(raw['LandingPads']),
    channel,
    observedAt: p.timestamp,
    commander: p.commander,
    commanderFid: p.fid,
    gameVersion: p.gameVersion,
    gameBuild: p.build,
    sourceEventId: p.eventId,
    sourceEvent: event.source.event,
  };
}

/**
 * Whether two observations of the same station say the same thing.
 *
 * Used to avoid storing a new record every time the commander re-docks somewhere
 * unchanged. Compares the facts, not the provenance — a second sighting of an
 * identical station is not new evidence about the station, though it *is* evidence
 * about consistency, which is why the caller still updates a "last seen" time.
 */
export function sameObservation(a: StationObservation, b: StationObservation): boolean {
  if (a.marketId !== b.marketId) return false;
  if (a.stationName !== b.stationName) return false;
  if (a.services.length !== b.services.length) return false;

  const aIds = [...a.services.map((s) => s.id)].sort();
  const bIds = [...b.services.map((s) => s.id)].sort();
  for (let i = 0; i < aIds.length; i += 1) {
    if (aIds[i] !== bIds[i]) return false;
  }

  // Deliberately not compared: allegiance, which is absent 68% of the time and
  // would make otherwise-identical observations look like changes.
  return true;
}

/** Whether the observation names a fleet carrier, whose services owners change freely. */
export function isCarrier(o: StationObservation): boolean {
  return isKnown(o.stationType) && o.stationType === 'FleetCarrier';
}
