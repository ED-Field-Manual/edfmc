"""Persistence for station and market records.

The SQL here carries one rule that matters more than the rest: **an older
observation must never overwrite a newer one** in the `*_latest` tables (§35).

That is enforced in the `ON CONFLICT ... WHERE` clause rather than by reading the
current row first and deciding in Python. Two reasons:

  1. It is atomic. Several worker processes can write concurrently without a
     read-modify-write race silently losing the newer reading.
  2. Out-of-order delivery is the normal case, not an edge case. Two commanders
     dock minutes apart and their uploaders relay at different speeds, so the
     stream routinely carries an older observation after a newer one.

`market_observations` keeps every reading regardless of order -- history is
append-only, and §14 wants it for confidence scoring.
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Sequence

from .normalize import MarketRecord, StationRecord, is_planetary

# --------------------------------------------------------------------------
# Statements
# --------------------------------------------------------------------------

UPSERT_SYSTEM = """
INSERT INTO systems (system_address, name, x, y, z)
VALUES (%(system_address)s, %(name)s, %(x)s, %(y)s, %(z)s)
ON CONFLICT (system_address) DO UPDATE SET
    name = COALESCE(EXCLUDED.name, systems.name),
    -- Coordinates never change, so only fill them in; never blank an existing
    -- value with a message that happened not to carry one.
    x = COALESCE(EXCLUDED.x, systems.x),
    y = COALESCE(EXCLUDED.y, systems.y),
    z = COALESCE(EXCLUDED.z, systems.z),
    updated_at = now()
"""

# COALESCE on every optional column is the point: a commodity message carries
# stationType but no services, and must not erase services a journal message
# recorded earlier. Only newer observations may overwrite, and even then only
# fields they actually carry.
UPSERT_STATION = """
INSERT INTO stations (
    market_id, name, station_type, system_address, system_name,
    is_planetary, is_fleet_carrier, dist_from_star_ls, landing_pads,
    service_ids, services_raw, economies,
    observed_at, gateway_at, software_name, software_version,
    game_version, game_build, schema_ref
) VALUES (
    %(market_id)s, %(name)s, %(station_type)s, %(system_address)s, %(system_name)s,
    %(is_planetary)s, %(is_fleet_carrier)s, %(dist_from_star_ls)s, %(landing_pads)s,
    %(service_ids)s, %(services_raw)s, %(economies)s,
    %(observed_at)s, %(gateway_at)s, %(software_name)s, %(software_version)s,
    %(game_version)s, %(game_build)s, %(schema_ref)s
)
ON CONFLICT (market_id) DO UPDATE SET
    name              = COALESCE(EXCLUDED.name, stations.name),
    station_type      = COALESCE(EXCLUDED.station_type, stations.station_type),
    system_address    = COALESCE(EXCLUDED.system_address, stations.system_address),
    system_name       = COALESCE(EXCLUDED.system_name, stations.system_name),
    is_planetary      = COALESCE(EXCLUDED.is_planetary, stations.is_planetary),
    is_fleet_carrier  = EXCLUDED.is_fleet_carrier OR stations.is_fleet_carrier,
    dist_from_star_ls = COALESCE(EXCLUDED.dist_from_star_ls, stations.dist_from_star_ls),
    landing_pads      = COALESCE(EXCLUDED.landing_pads, stations.landing_pads),
    service_ids       = COALESCE(EXCLUDED.service_ids, stations.service_ids),
    services_raw      = COALESCE(EXCLUDED.services_raw, stations.services_raw),
    economies         = COALESCE(EXCLUDED.economies, stations.economies),
    observed_at       = GREATEST(EXCLUDED.observed_at, stations.observed_at),
    gateway_at        = COALESCE(EXCLUDED.gateway_at, stations.gateway_at),
    software_name     = COALESCE(EXCLUDED.software_name, stations.software_name),
    software_version  = COALESCE(EXCLUDED.software_version, stations.software_version),
    game_version      = COALESCE(EXCLUDED.game_version, stations.game_version),
    game_build        = COALESCE(EXCLUDED.game_build, stations.game_build),
    schema_ref        = EXCLUDED.schema_ref,
    updated_at        = now()
WHERE
    -- Only a strictly newer observation may change a station row. Equal
    -- timestamps are refused too: re-applying the same reading is pure write
    -- amplification, and EDDN relays duplicates.
    stations.observed_at IS NULL
    OR EXCLUDED.observed_at > stations.observed_at
"""

INSERT_OBSERVATION = """
INSERT INTO market_observations (
    market_id, commodity, buy_price, sell_price, mean_price,
    stock, demand, stock_bracket, demand_bracket,
    observed_at, gateway_at, software_name, software_version, game_version
) VALUES (
    %(market_id)s, %(commodity)s, %(buy_price)s, %(sell_price)s, %(mean_price)s,
    %(stock)s, %(demand)s, %(stock_bracket)s, %(demand_bracket)s,
    %(observed_at)s, %(gateway_at)s, %(software_name)s, %(software_version)s,
    %(game_version)s
)
"""

UPSERT_MARKET_LATEST = """
INSERT INTO market_latest (
    market_id, commodity, buy_price, sell_price, mean_price,
    stock, demand, stock_bracket, demand_bracket,
    observed_at, gateway_at, software_name, software_version, game_version
) VALUES (
    %(market_id)s, %(commodity)s, %(buy_price)s, %(sell_price)s, %(mean_price)s,
    %(stock)s, %(demand)s, %(stock_bracket)s, %(demand_bracket)s,
    %(observed_at)s, %(gateway_at)s, %(software_name)s, %(software_version)s,
    %(game_version)s
)
ON CONFLICT (market_id, commodity) DO UPDATE SET
    buy_price        = EXCLUDED.buy_price,
    sell_price       = EXCLUDED.sell_price,
    mean_price       = EXCLUDED.mean_price,
    stock            = EXCLUDED.stock,
    demand           = EXCLUDED.demand,
    stock_bracket    = EXCLUDED.stock_bracket,
    demand_bracket   = EXCLUDED.demand_bracket,
    observed_at      = EXCLUDED.observed_at,
    gateway_at       = EXCLUDED.gateway_at,
    software_name    = EXCLUDED.software_name,
    software_version = EXCLUDED.software_version,
    game_version     = EXCLUDED.game_version,
    updated_at       = now()
WHERE
    -- THE rule (§35). Prices and stock are replaced wholesale rather than
    -- COALESCEd, because a market genuinely stops selling things: a NULL or
    -- absent commodity is information, and carrying the old value forward would
    -- report stock that is no longer there.
    EXCLUDED.observed_at > market_latest.observed_at
"""

UPSERT_COMMODITY = """
INSERT INTO commodities (symbol) VALUES (%(symbol)s)
ON CONFLICT (symbol) DO NOTHING
"""

RECORD_UNKNOWN_STATION_TYPE = """
INSERT INTO unknown_station_types (station_type) VALUES (%(station_type)s)
ON CONFLICT (station_type) DO UPDATE SET
    seen_count = unknown_station_types.seen_count + 1,
    last_seen_at = now()
"""

QUARANTINE = """
INSERT INTO quarantine (schema_ref, reason, detail, payload)
VALUES (%(schema_ref)s, %(reason)s, %(detail)s, %(payload)s)
"""

BUMP_STATS = """
UPDATE ingest_stats SET
    messages_total = messages_total + %(total)s,
    messages_accepted = messages_accepted + %(accepted)s,
    messages_quarantined = messages_quarantined + %(quarantined)s,
    reconnects = reconnects + %(reconnects)s,
    last_message_at = COALESCE(%(last_message_at)s, last_message_at),
    updated_at = now()
WHERE id = 1
"""


# --------------------------------------------------------------------------
# Parameter building (pure, so it is testable without a database)
# --------------------------------------------------------------------------


def station_params(record: StationRecord) -> dict[str, Any]:
    return {
        "market_id": record.market_id,
        "name": record.station_name,
        "station_type": record.station_type,
        "system_address": record.system_address,
        "system_name": record.system_name,
        "is_planetary": record.is_planetary,
        "is_fleet_carrier": record.is_fleet_carrier,
        "dist_from_star_ls": record.dist_from_star_ls,
        "landing_pads": json.dumps(record.landing_pads) if record.landing_pads else None,
        # Postgres arrays; None stays None so COALESCE keeps any existing value.
        "service_ids": list(record.services) if record.services is not None else None,
        "services_raw": list(record.services_raw) if record.services_raw is not None else None,
        "economies": json.dumps(
            [{"name": n, "proportion": p} for n, p in record.economies]
        )
        if record.economies is not None
        else None,
        "observed_at": record.provenance.observed_at,
        "gateway_at": record.provenance.gateway_at,
        "software_name": record.provenance.software_name,
        "software_version": record.provenance.software_version,
        "game_version": record.provenance.game_version,
        "game_build": record.provenance.game_build,
        "schema_ref": record.provenance.schema_ref,
    }


def system_params(record: StationRecord) -> dict[str, Any] | None:
    """System row, or None when the record cannot identify one."""
    if record.system_address is None or not record.system_name:
        return None
    pos = record.star_pos
    return {
        "system_address": record.system_address,
        "name": record.system_name,
        "x": pos[0] if pos else None,
        "y": pos[1] if pos else None,
        "z": pos[2] if pos else None,
    }


def market_params(record: MarketRecord) -> Iterable[dict[str, Any]]:
    p = record.provenance
    for c in record.commodities:
        yield {
            "market_id": record.market_id,
            "commodity": c.name,
            "buy_price": c.buy_price,
            "sell_price": c.sell_price,
            "mean_price": c.mean_price,
            "stock": c.stock,
            "demand": c.demand,
            "stock_bracket": c.stock_bracket,
            "demand_bracket": c.demand_bracket,
            "observed_at": p.observed_at,
            "gateway_at": p.gateway_at,
            "software_name": p.software_name,
            "software_version": p.software_version,
            "game_version": p.game_version,
        }


# --------------------------------------------------------------------------
# Store
# --------------------------------------------------------------------------


class Store:
    """Thin wrapper over a psycopg connection.

    Deliberately not an ORM. The upsert semantics above are the whole point of
    this module, and hiding them behind a mapping layer would make the ordering
    rule invisible at exactly the place it must stay obvious.
    """

    def __init__(self, conn: Any) -> None:
        self.conn = conn

    def write_station(self, record: StationRecord) -> None:
        with self.conn.cursor() as cur:
            system = system_params(record)
            if system is not None:
                cur.execute(UPSERT_SYSTEM, system)
            cur.execute(UPSERT_STATION, station_params(record))

            # A station type we cannot classify is a signal to update the
            # mapping, not something to swallow.
            if record.station_type and is_planetary(record.station_type) is None:
                cur.execute(
                    RECORD_UNKNOWN_STATION_TYPE, {"station_type": record.station_type}
                )

    def write_market(self, record: MarketRecord) -> None:
        rows = list(market_params(record))
        if not rows:
            return
        with self.conn.cursor() as cur:
            symbols = sorted({r["commodity"] for r in rows})
            cur.executemany(UPSERT_COMMODITY, [{"symbol": s} for s in symbols])
            # History first: it is append-only and must record the reading even
            # when the latest-state upsert rejects it as older.
            cur.executemany(INSERT_OBSERVATION, rows)
            cur.executemany(UPSERT_MARKET_LATEST, rows)

    def quarantine(
        self, schema_ref: str | None, reason: str, detail: str, payload: Any
    ) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                QUARANTINE,
                {
                    "schema_ref": schema_ref,
                    "reason": reason,
                    # Bounded: a pathological payload must not fill the table.
                    "detail": (detail or "")[:2000],
                    "payload": json.dumps(payload)[:200_000] if payload is not None else None,
                },
            )

    def bump_stats(
        self,
        *,
        total: int = 0,
        accepted: int = 0,
        quarantined: int = 0,
        reconnects: int = 0,
        last_message_at: str | None = None,
    ) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                BUMP_STATS,
                {
                    "total": total,
                    "accepted": accepted,
                    "quarantined": quarantined,
                    "reconnects": reconnects,
                    "last_message_at": last_message_at,
                },
            )

    def commit(self) -> None:
        self.conn.commit()
