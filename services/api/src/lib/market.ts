/**
 * Market search for the logistics planner.
 *
 * Returns candidate stations with their offers for the requested commodities.
 * The server does not build the plan: the client does, from this data, so the
 * reasoning stays where the commander can see it and a planning change does not
 * need a deployment.
 *
 * What the server does own is the filtering that only it can do efficiently —
 * distance in three dimensions, freshness, and stock — because doing that in
 * the client would mean shipping the whole market table to every commander.
 */

import type { Db } from './db.js';

export interface MarketSearchRequest {
  readonly commodities: readonly string[];
  /** Origin for distance. Absent when the client has no coordinates. */
  readonly origin?: { readonly x: number; readonly y: number; readonly z: number } | undefined;
  readonly radiusLy?: number | undefined;
  readonly maxAgeSeconds?: number | undefined;
  readonly minStock?: number | undefined;
  readonly includeFleetCarriers?: boolean | undefined;
  readonly includePlanetary?: boolean | undefined;
  readonly limit?: number | undefined;
}

export interface MarketOfferRow {
  readonly commodity: string;
  readonly stock: number;
  readonly buyPrice: number | null;
  readonly observedAt: string;
}

export interface MarketCandidate {
  readonly marketId: string;
  readonly stationName: string | null;
  readonly systemName: string | null;
  readonly systemAddress: string | null;
  readonly distanceLy: number | null;
  readonly arrivalDistanceLs: number | null;
  readonly isPlanetary: boolean | null;
  readonly isFleetCarrier: boolean;
  readonly offers: readonly MarketOfferRow[];
}

interface Row {
  market_id: string;
  station_name: string | null;
  system_name: string | null;
  system_address: string | null;
  distance_ly: number | null;
  dist_from_star_ls: number | null;
  is_planetary: boolean | null;
  is_fleet_carrier: boolean;
  commodity: string;
  stock: number;
  buy_price: number | null;
  observed_at: Date;
}

const MAX_LIMIT = 200;

export async function searchMarkets(
  db: Db,
  request: MarketSearchRequest,
): Promise<MarketCandidate[]> {
  if (request.commodities.length === 0) return [];

  const limit = Math.min(request.limit ?? 60, MAX_LIMIT);
  const minStock = request.minStock ?? 1;
  const origin = request.origin;

  // Distance is computed in SQL because the alternative is transferring every
  // system's coordinates to the client to sort locally.
  const distance = origin
    ? `sqrt(power(sy.x - $4, 2) + power(sy.y - $5, 2) + power(sy.z - $6, 2))`
    : 'NULL::double precision';

  const params: unknown[] = [request.commodities, minStock, request.maxAgeSeconds ?? null];
  if (origin) params.push(origin.x, origin.y, origin.z);

  const radiusClause =
    origin && request.radiusLy !== undefined
      ? `AND ${distance} <= ${Number(request.radiusLy)}`
      : '';

  const carrierClause = request.includeFleetCarriers === true ? '' : 'AND NOT s.is_fleet_carrier';
  // NULL is not excluded: an unclassified station type is unknown, not
  // planetary, and dropping it would silently hide stations from the plan.
  const planetaryClause = request.includePlanetary === false ? "AND s.is_planetary IS DISTINCT FROM true" : '';

  const { rows } = await db.query<Row>(
    `WITH candidate AS (
       SELECT m.market_id, m.commodity, m.stock, m.buy_price, m.observed_at,
              s.name AS station_name, s.system_name, s.system_address::text,
              s.dist_from_star_ls, s.is_planetary, s.is_fleet_carrier,
              ${distance} AS distance_ly
         FROM market_latest m
         JOIN stations s ON s.market_id = m.market_id
         LEFT JOIN systems sy ON sy.system_address = s.system_address
        WHERE m.commodity = ANY($1::text[])
          AND m.stock >= $2
          AND ($3::int IS NULL OR m.observed_at >= now() - ($3::int * interval '1 second'))
          ${carrierClause}
          ${planetaryClause}
          ${radiusClause}
     ),
     ranked AS (
       -- Rank stations by how many of the requested commodities they carry, so
       -- the client receives the ones that can actually reduce its stop count
       -- rather than an arbitrary slice of whatever matched.
       SELECT market_id, count(*) AS covered, min(distance_ly) AS distance_ly
         FROM candidate GROUP BY market_id
        ORDER BY covered DESC, distance_ly ASC NULLS LAST
        LIMIT ${limit}
     )
     SELECT c.market_id::text, c.station_name, c.system_name, c.system_address,
            c.distance_ly, c.dist_from_star_ls, c.is_planetary, c.is_fleet_carrier,
            c.commodity, c.stock, c.buy_price, c.observed_at
       FROM candidate c JOIN ranked r ON r.market_id = c.market_id
      ORDER BY r.covered DESC, c.distance_ly ASC NULLS LAST, c.market_id, c.commodity`,
    params,
  );

  const byStation = new Map<string, MarketCandidate & { offers: MarketOfferRow[] }>();
  for (const row of rows) {
    let station = byStation.get(row.market_id);
    if (station === undefined) {
      station = {
        marketId: row.market_id,
        stationName: row.station_name,
        systemName: row.system_name,
        systemAddress: row.system_address,
        distanceLy: row.distance_ly === null ? null : Number(row.distance_ly),
        arrivalDistanceLs:
          row.dist_from_star_ls === null ? null : Number(row.dist_from_star_ls),
        isPlanetary: row.is_planetary,
        isFleetCarrier: row.is_fleet_carrier,
        offers: [],
      };
      byStation.set(row.market_id, station);
    }
    station.offers.push({
      commodity: row.commodity,
      stock: row.stock,
      buyPrice: row.buy_price,
      observedAt: row.observed_at.toISOString(),
    });
  }

  return [...byStation.values()];
}
