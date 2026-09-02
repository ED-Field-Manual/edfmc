/**
 * Mission persistence mapping.
 *
 * Explicit columns rather than a JSON blob (§26): missions are a first-class
 * entity that later phases will query and group by. The mapping lives here, next
 * to the type, so a new field cannot be added without a visible decision about
 * whether it is stored.
 *
 * UNKNOWN maps to SQL NULL and back. That round-trip is what keeps "the game did
 * not say" distinct from "zero" or "empty string" across a restart — collapsing
 * them on the way to disk would quietly destroy the distinction the whole design
 * rests on.
 */

import { UNKNOWN, isKnown, type Known } from '@edfm/elite-journal';

import { missionCategory, missionTypeKey } from './store.js';
import type { Mission, MissionStatus } from './types.js';

export interface MissionRow {
  mission_id: number;
  id_reliable: number;
  name: string;
  type_key: string;
  category: string;
  localised_name: string | null;
  faction: string | null;
  influence: string | null;
  reputation: string | null;
  wing: number | null;
  destination_system: string | null;
  destination_station: string | null;
  destination_settlement: string | null;
  target_faction: string | null;
  target: string | null;
  target_type: string | null;
  commodity: string | null;
  commodity_localised: string | null;
  count: number | null;
  kill_count: number | null;
  delivered: number | null;
  total_to_deliver: number | null;
  collected: number | null;
  passenger_count: number | null;
  passenger_type: string | null;
  passenger_vips: number | null;
  passenger_wanted: number | null;
  reward: number | null;
  donation: number | null;
  expiry: string | null;
  status: string;
  redirected: number;
  accepted_at: string;
  source_event_id: string;
  game_version: string | null;
  ended_at: string | null;
}

const s = (v: Known<string>): string | null => (isKnown(v) ? v : null);
const n = (v: Known<number>): number | null => (isKnown(v) ? v : null);
const b = (v: Known<boolean>): number | null => (isKnown(v) ? (v ? 1 : 0) : null);

const rs = (v: string | null): Known<string> => (v === null ? UNKNOWN : v);
const rn = (v: number | null): Known<number> => (v === null ? UNKNOWN : v);
const rb = (v: number | null): Known<boolean> => (v === null ? UNKNOWN : v !== 0);

export function toRow(m: Mission): MissionRow {
  return {
    mission_id: m.missionId,
    id_reliable: m.idIsReliable ? 1 : 0,
    name: m.name,
    type_key: m.typeKey,
    category: m.category,
    localised_name: s(m.localisedName),
    faction: s(m.faction),
    influence: s(m.influence),
    reputation: s(m.reputation),
    wing: b(m.wing),
    destination_system: s(m.destinationSystem),
    destination_station: s(m.destinationStation),
    destination_settlement: s(m.destinationSettlement),
    target_faction: s(m.targetFaction),
    target: s(m.target),
    target_type: s(m.targetType),
    commodity: s(m.commodity),
    commodity_localised: s(m.commodityLocalised),
    count: n(m.count),
    kill_count: n(m.killCount),
    delivered: n(m.delivered),
    total_to_deliver: n(m.totalToDeliver),
    collected: n(m.collected),
    passenger_count: n(m.passengerCount),
    passenger_type: s(m.passengerType),
    passenger_vips: b(m.passengerVips),
    passenger_wanted: b(m.passengerWanted),
    reward: n(m.reward),
    donation: n(m.donation),
    expiry: s(m.expiry),
    status: m.status,
    redirected: m.redirected ? 1 : 0,
    accepted_at: m.acceptedAt,
    source_event_id: m.sourceEventId,
    game_version: m.gameVersion,
    ended_at: m.endedAt,
  };
}

export function fromRow(row: MissionRow): Mission {
  const typeKey = row.type_key || missionTypeKey(row.name);
  return {
    missionId: row.mission_id,
    idIsReliable: row.id_reliable !== 0,
    name: row.name,
    typeKey,
    // Recomputed rather than trusted from disk, so an improved categoriser
    // applies to missions stored by an older build.
    category: missionCategory(typeKey),
    localisedName: rs(row.localised_name),
    faction: rs(row.faction),
    influence: rs(row.influence),
    reputation: rs(row.reputation),
    wing: rb(row.wing),
    destinationSystem: rs(row.destination_system),
    destinationStation: rs(row.destination_station),
    destinationSettlement: rs(row.destination_settlement),
    targetFaction: rs(row.target_faction),
    target: rs(row.target),
    targetType: rs(row.target_type),
    commodity: rs(row.commodity),
    commodityLocalised: rs(row.commodity_localised),
    count: rn(row.count),
    killCount: rn(row.kill_count),
    delivered: rn(row.delivered),
    totalToDeliver: rn(row.total_to_deliver),
    collected: rn(row.collected),
    passengerCount: rn(row.passenger_count),
    passengerType: rs(row.passenger_type),
    passengerVips: rb(row.passenger_vips),
    passengerWanted: rb(row.passenger_wanted),
    reward: rn(row.reward),
    donation: rn(row.donation),
    expiry: rs(row.expiry),
    status: row.status as MissionStatus,
    redirected: row.redirected !== 0,
    acceptedAt: row.accepted_at,
    sourceEventId: row.source_event_id,
    gameVersion: row.game_version,
    endedAt: row.ended_at,
  };
}

/** Column order used by the INSERT, kept beside the mapping so they cannot drift. */
export const MISSION_COLUMNS: readonly (keyof MissionRow)[] = [
  'mission_id', 'id_reliable', 'name', 'type_key', 'category', 'localised_name',
  'faction', 'influence', 'reputation', 'wing', 'destination_system',
  'destination_station', 'destination_settlement', 'target_faction', 'target',
  'target_type', 'commodity', 'commodity_localised', 'count', 'kill_count', 'delivered', 'total_to_deliver', 'collected',
  'passenger_count', 'passenger_type', 'passenger_vips', 'passenger_wanted',
  'reward', 'donation', 'expiry', 'status', 'redirected', 'accepted_at',
  'source_event_id', 'game_version', 'ended_at',
];
