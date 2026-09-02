"""Turn EDDN messages into station and market records.

Pure functions, no I/O, so the rules below are testable against captured
messages rather than only observable in production.

The governing hazard here is that **field naming is not consistent across
schemas**. `commodity/3`, `outfitting/*` and `shipyard/2` use lowercase
(`marketId`, `stationName`), while `journal/1`, `approachsettlement/1` and
`dockinggranted/1` use Frontier's PascalCase (`MarketID`, `StationName`).
Reading only one convention loses data silently rather than raising -- see
docs/EDDN.md.
"""

from __future__ import annotations

import dataclasses
from typing import Any, Iterable, Sequence

# --------------------------------------------------------------------------
# Station type classification
#
# EDDN reports no orbital/planetary flag anywhere (measured; see docs/EDDN.md).
# The Logistics optimizer needs one, so it is DERIVED from stationType here.
#
# This mapping is ours, not Frontier's. It lives in one documented place rather
# than scattered through conditionals, and an unrecognised type resolves to
# None -- unknown -- rather than being guessed into a bucket.
# --------------------------------------------------------------------------

ORBITAL_STATION_TYPES = frozenset(
    {
        "coriolis",
        "orbis",
        "ocellus",
        "bernal",  # legacy name for Ocellus-class
        "dodec",  # observed in journals as a Bernal/Ocellus variant
        "asteroidbase",
        "outpost",
        "megaship",
        "spaceconstructiondepot",
        "fleetcarrier",
    }
)

PLANETARY_STATION_TYPES = frozenset(
    {
        "craterport",
        "crateroutpost",
        "onfootsettlement",
        "surfacestation",
        "planetaryconstructiondepot",
    }
)


def is_planetary(station_type: str | None) -> bool | None:
    """True/False when the type is recognised, None when it is not.

    None is a real answer. A station type we have never seen must not be
    silently classified as orbital just because most stations are.
    """
    if not station_type:
        return None
    key = station_type.strip().lower()
    if key in PLANETARY_STATION_TYPES:
        return True
    if key in ORBITAL_STATION_TYPES:
        return False
    return None


def is_fleet_carrier(station_type: str | None) -> bool:
    return bool(station_type) and station_type.strip().lower() == "fleetcarrier"


# --------------------------------------------------------------------------
# Field access across both naming conventions
# --------------------------------------------------------------------------


def pick(message: dict[str, Any], *names: str) -> Any:
    """First present field among `names`.

    Callers pass both spellings, e.g. pick(m, "MarketID", "marketId"). Being
    explicit at each call site is deliberate: a generic case-insensitive lookup
    would also match fields we did not mean.
    """
    for name in names:
        if name in message:
            return message[name]
    return None


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    return float(value) if isinstance(value, (int, float)) else None


# --------------------------------------------------------------------------
# Records
# --------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Provenance:
    """Where an observation came from (§27). Never overwritten."""

    software_name: str | None
    software_version: str | None
    game_version: str | None
    game_build: str | None
    uploader_id: str | None
    #: When the observer saw it.
    observed_at: str | None
    #: When the EDDN gateway received it. Differs from observed_at, and the
    #: difference matters for freshness scoring (§15), so both are kept.
    gateway_at: str | None
    schema_ref: str


@dataclasses.dataclass(frozen=True)
class StationRecord:
    market_id: int
    station_name: str | None
    station_type: str | None
    system_name: str | None
    system_address: int | None
    star_pos: tuple[float, float, float] | None
    #: Case-folded service ids. None means the message carried no service list,
    #: which is different from a station having no services.
    services: tuple[str, ...] | None
    #: Raw tokens exactly as sent, retained as evidence (§9, §27).
    services_raw: tuple[str, ...] | None
    economies: tuple[tuple[str, float | None], ...] | None
    dist_from_star_ls: float | None
    landing_pads: dict[str, int] | None
    is_planetary: bool | None
    is_fleet_carrier: bool
    provenance: Provenance


@dataclasses.dataclass(frozen=True)
class CommodityRecord:
    name: str
    mean_price: int | None
    buy_price: int | None
    sell_price: int | None
    stock: int | None
    demand: int | None
    stock_bracket: int | None
    demand_bracket: int | None


@dataclasses.dataclass(frozen=True)
class MarketRecord:
    market_id: int
    station_name: str | None
    system_name: str | None
    commodities: tuple[CommodityRecord, ...]
    provenance: Provenance


def provenance_of(envelope: dict[str, Any]) -> Provenance:
    header = envelope.get("header") or {}
    message = envelope.get("message") or {}
    return Provenance(
        software_name=_str(header.get("softwareName")),
        software_version=_str(header.get("softwareVersion")),
        game_version=_str(header.get("gameversion")),
        # Frontier's build string carries a trailing space; kept verbatim.
        game_build=_str(header.get("gamebuild")),
        uploader_id=_str(header.get("uploaderID")),
        observed_at=_str(message.get("timestamp")),
        gateway_at=_str(header.get("gatewayTimestamp")),
        schema_ref=str(envelope.get("$schemaRef", "")),
    )


def _star_pos(value: Any) -> tuple[float, float, float] | None:
    """Coordinates only when all three are numbers. Never partial."""
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return None
    parts = [_float(v) for v in value]
    if any(p is None for p in parts):
        return None
    return (parts[0], parts[1], parts[2])  # type: ignore[return-value]


def _services(value: Any) -> tuple[tuple[str, ...], tuple[str, ...]] | None:
    """(folded ids, raw tokens), or None when absent.

    Both are kept. Frontier's array mixes cases (`stationMenu`, `techBroker`),
    so comparison needs the folded id while any discrepancy report must quote
    the raw token as evidence (§9).
    """
    if not isinstance(value, list):
        return None
    raw = tuple(v for v in value if isinstance(v, str))
    return tuple(v.lower() for v in raw), raw


def _economies(value: Any) -> tuple[tuple[str, float | None], ...] | None:
    if not isinstance(value, list):
        return None
    out: list[tuple[str, float | None]] = []
    for entry in value:
        if not isinstance(entry, dict):
            continue
        name = _str(entry.get("Name") or entry.get("name"))
        if not name:
            continue
        # Proportion is NOT renormalised: observed sums exceed 1.0.
        out.append((name, _float(entry.get("Proportion") or entry.get("proportion"))))
    return tuple(out)


def _landing_pads(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    pads = {k: v for k, v in value.items() if isinstance(v, int) and not isinstance(v, bool)}
    return pads or None


#: journal/1 relays many event types; only these carry station attributes.
STATION_EVENTS = frozenset({"Docked", "Location", "CarrierJump", "ApproachSettlement"})


def station_from(envelope: dict[str, Any]) -> StationRecord | None:
    """Extract a station record, or None when the message carries none.

    Requires a MarketID: without stable identity there is nothing to merge the
    record onto, and §19 makes MarketID the preferred station key.
    """
    message = envelope.get("message")
    if not isinstance(message, dict):
        return None

    schema = str(envelope.get("$schemaRef", ""))
    event = _str(message.get("event"))

    # journal/1 carries everything from Scan to Docked; only some are stations.
    if schema.endswith("/journal/1") and event not in STATION_EVENTS:
        return None

    market_id = _int(pick(message, "MarketID", "marketId"))
    if market_id is None:
        return None

    services = _services(pick(message, "StationServices"))
    station_type = _str(pick(message, "StationType", "stationType"))

    # ApproachSettlement names the settlement in `Name`.
    name = _str(pick(message, "StationName", "stationName"))
    if name is None and event == "ApproachSettlement":
        name = _str(message.get("Name"))

    return StationRecord(
        market_id=market_id,
        station_name=name,
        station_type=station_type,
        system_name=_str(pick(message, "StarSystem", "systemName")),
        system_address=_int(pick(message, "SystemAddress", "systemAddress")),
        star_pos=_star_pos(message.get("StarPos")),
        services=services[0] if services else None,
        services_raw=services[1] if services else None,
        economies=_economies(pick(message, "StationEconomies", "economies")),
        dist_from_star_ls=_float(pick(message, "DistFromStarLS", "distFromStarLS")),
        landing_pads=_landing_pads(message.get("LandingPads")),
        is_planetary=is_planetary(station_type),
        is_fleet_carrier=is_fleet_carrier(station_type),
        provenance=provenance_of(envelope),
    )


def _commodities(value: Any) -> tuple[CommodityRecord, ...]:
    out: list[CommodityRecord] = []
    if not isinstance(value, list):
        return ()
    for entry in value:
        if not isinstance(entry, dict):
            continue
        name = _str(entry.get("name"))
        if not name:
            continue
        out.append(
            CommodityRecord(
                # Lower-cased for joining. EDDN already sends these lowercase,
                # but normalising defensively costs nothing and a future
                # uploader will eventually not.
                name=name.lower(),
                mean_price=_int(entry.get("meanPrice")),
                buy_price=_int(entry.get("buyPrice")),
                sell_price=_int(entry.get("sellPrice")),
                stock=_int(entry.get("stock")),
                demand=_int(entry.get("demand")),
                stock_bracket=_int(entry.get("stockBracket")),
                demand_bracket=_int(entry.get("demandBracket")),
            )
        )
    return tuple(out)


def market_from(envelope: dict[str, Any]) -> MarketRecord | None:
    """Extract a market record from a commodity/N message."""
    schema = str(envelope.get("$schemaRef", ""))
    if "/commodity/" not in schema:
        return None

    message = envelope.get("message")
    if not isinstance(message, dict):
        return None

    market_id = _int(message.get("marketId"))
    if market_id is None:
        return None

    return MarketRecord(
        market_id=market_id,
        station_name=_str(message.get("stationName")),
        system_name=_str(message.get("systemName")),
        commodities=_commodities(message.get("commodities")),
        provenance=provenance_of(envelope),
    )


def iter_records(envelope: dict[str, Any]) -> Iterable[StationRecord | MarketRecord]:
    """Every record derivable from one message.

    A commodity message yields both: the market itself, and the station identity
    it carries (marketId, stationName, stationType, systemName). That station
    half is thin -- no services, no pads, no arrival distance -- but it is real,
    and it is the widest source of stationType coverage we have, since journal/1
    only carries it on ~13% of its messages.

    `station_from` already reads commodity messages via its dual-naming lookup,
    so no special case is needed here; an earlier version added one and emitted
    every commodity station twice.
    """
    station = station_from(envelope)
    if station is not None:
        yield station

    market = market_from(envelope)
    if market is not None:
        yield market


def known_station_types(records: Sequence[StationRecord]) -> set[str]:
    """Station types seen but not classified. Feeds the unknown-type report."""
    return {
        r.station_type
        for r in records
        if r.station_type and is_planetary(r.station_type) is None
    }
