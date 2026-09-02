/**
 * The reference data a station observation is compared against.
 *
 * Worth being precise about what this is, because the phase notes and
 * VERIFICATION.md say EDFM has no station dataset, and that is still true.
 *
 * This reference is the aggregated community observation set built by the EDDN
 * worker. Comparing against it answers "does this commander's game disagree
 * with what everyone else has reported?", which is a real and useful question,
 * and is what seeds a station dataset EDFM does not yet have. It is explicitly
 * NOT "EDFM says X" -- no code here may claim that, and the discrepancy wording
 * follows from `source` so a reviewer is never misled about what disagreed.
 */

import type { Db } from './db.js';

export type ReferenceSourceName = 'eddn-aggregate' | 'edfm-wiki';

export interface StationReference {
  readonly source: ReferenceSourceName;
  readonly marketId: string;
  readonly name: string | null;
  readonly stationType: string | null;
  readonly systemName: string | null;
  readonly systemAddress: string | null;
  readonly isFleetCarrier: boolean;
  readonly isPlanetary: boolean | null;
  /** Case-folded ids for matching. */
  readonly serviceIds: readonly string[] | null;
  /** Frontier's own casing, retained as evidence (§9). */
  readonly servicesRaw: readonly string[] | null;
  readonly observedAt: string | null;
}

interface Row {
  market_id: string;
  name: string | null;
  station_type: string | null;
  system_name: string | null;
  system_address: string | null;
  is_fleet_carrier: boolean;
  is_planetary: boolean | null;
  service_ids: string[] | null;
  services_raw: string[] | null;
  observed_at: Date | null;
}

const SELECT = `
  SELECT market_id::text, name, station_type, system_name, system_address::text,
         is_fleet_carrier, is_planetary, service_ids, services_raw, observed_at
    FROM stations`;

function toReference(row: Row): StationReference {
  return {
    source: 'eddn-aggregate',
    marketId: row.market_id,
    name: row.name,
    stationType: row.station_type,
    systemName: row.system_name,
    systemAddress: row.system_address,
    isFleetCarrier: row.is_fleet_carrier,
    isPlanetary: row.is_planetary,
    serviceIds: row.service_ids,
    servicesRaw: row.services_raw,
    observedAt: row.observed_at?.toISOString() ?? null,
  };
}

export async function getStation(db: Db, marketId: string): Promise<StationReference | null> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE market_id = $1`, [marketId]);
  const row = rows[0];
  return row ? toReference(row) : null;
}

export async function getStations(
  db: Db,
  marketIds: readonly string[],
): Promise<StationReference[]> {
  if (marketIds.length === 0) return [];
  const { rows } = await db.query<Row>(`${SELECT} WHERE market_id = ANY($1::bigint[])`, [
    marketIds,
  ]);
  return rows.map(toReference);
}
