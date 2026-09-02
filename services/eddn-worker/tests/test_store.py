"""Store parameter-building and the ordering rule.

The ordering rule itself lives in SQL, so these tests assert on the statement
text as well as on the parameters. That is unusual, but the alternative is
asserting nothing about the single most important line in the service until a
real Postgres is available -- and §35 lists it explicitly as a required case.
"""

from __future__ import annotations

import json

from edfm_eddn.normalize import market_from, station_from
from edfm_eddn.store import (
    UPSERT_MARKET_LATEST,
    UPSERT_STATION,
    market_params,
    station_params,
    system_params,
)

from test_normalize import COMMODITY, JOURNAL_DOCKED


class TestOrderingRule:
    """§35: an older observation must not overwrite a newer latest-state row."""

    def test_market_latest_refuses_older_observations(self):
        # Enforced in SQL rather than by read-then-decide in Python, so it holds
        # atomically across concurrent workers.
        normalised = " ".join(UPSERT_MARKET_LATEST.split())
        assert "EXCLUDED.observed_at > market_latest.observed_at" in normalised

    def test_station_refuses_older_and_equal_observations(self):
        normalised = " ".join(UPSERT_STATION.split())
        assert "EXCLUDED.observed_at > stations.observed_at" in normalised
        # Equal timestamps are refused too: EDDN relays duplicates, and
        # re-applying an identical reading is pure write amplification.
        assert ">=" not in normalised.split("WHERE")[-1]

    def test_history_is_written_before_latest_state(self):
        # market_observations is append-only and must record a reading even when
        # the latest-state upsert rejects it as older, so the observation insert
        # cannot be conditional on that comparison.
        from edfm_eddn.store import INSERT_OBSERVATION

        assert "ON CONFLICT" not in INSERT_OBSERVATION
        assert "WHERE" not in INSERT_OBSERVATION


class TestStationParams:
    def test_maps_a_docked_station(self):
        record = station_from(JOURNAL_DOCKED)
        params = station_params(record)  # type: ignore[arg-type]

        assert params["market_id"] == 128
        assert params["station_type"] == "Coriolis"
        assert params["is_planetary"] is False
        assert params["is_fleet_carrier"] is False
        assert params["dist_from_star_ls"] == 92.137178
        assert json.loads(params["landing_pads"]) == {"Small": 2, "Medium": 2, "Large": 3}

    def test_sends_both_folded_and_raw_service_arrays(self):
        params = station_params(station_from(JOURNAL_DOCKED))  # type: ignore[arg-type]
        assert params["service_ids"] == ["dock", "commodities", "stationmenu", "techbroker"]
        assert params["services_raw"] == ["dock", "commodities", "stationMenu", "techBroker"]

    def test_absent_services_send_NULL_so_COALESCE_keeps_the_old_value(self):
        # A commodity message carries stationType but no services. If it sent an
        # empty array instead of NULL it would erase services a journal message
        # recorded earlier -- the exact bug COALESCE exists to prevent.
        params = station_params(station_from(COMMODITY))  # type: ignore[arg-type]
        assert params["service_ids"] is None
        assert params["services_raw"] is None
        assert params["station_type"] == "Orbis"

    def test_upsert_coalesces_rather_than_overwriting_with_nulls(self):
        normalised = " ".join(UPSERT_STATION.split())
        for column in ("service_ids", "services_raw", "dist_from_star_ls", "landing_pads"):
            assert f"{column} = COALESCE(EXCLUDED.{column}, stations.{column})" in normalised

    def test_carrier_flag_is_sticky(self):
        # A later message that omits stationType must not un-flag a carrier.
        normalised = " ".join(UPSERT_STATION.split())
        assert "is_fleet_carrier = EXCLUDED.is_fleet_carrier OR stations.is_fleet_carrier" in normalised


class TestSystemParams:
    def test_maps_a_system_with_coordinates(self):
        params = system_params(station_from(JOURNAL_DOCKED))  # type: ignore[arg-type]
        assert params is not None
        assert params["system_address"] == 99
        assert (params["x"], params["y"], params["z"]) == (1.5, -2.0, 3.25)

    def test_returns_None_when_the_system_cannot_be_identified(self):
        # commodity/3 names the system but carries no SystemAddress.
        assert system_params(station_from(COMMODITY)) is None  # type: ignore[arg-type]

    def test_coordinates_are_only_ever_filled_in_never_blanked(self):
        normalised = " ".join(UPSERT_SYSTEM_TEXT.split())
        for axis in ("x", "y", "z"):
            assert f"{axis} = COALESCE(EXCLUDED.{axis}, systems.{axis})" in normalised


class TestMarketParams:
    def test_maps_each_commodity_with_provenance(self):
        rows = list(market_params(market_from(COMMODITY)))  # type: ignore[arg-type]
        assert len(rows) == 1

        row = rows[0]
        assert row["market_id"] == 128035328
        assert row["commodity"] == "advancedcatalysers"
        assert row["sell_price"] == 3681
        assert row["demand"] == 42096
        # Both timestamps travel with every row: freshness scoring needs the
        # observation time, and gateway time catches a lagging uploader.
        assert row["observed_at"] == "2026-09-02T05:43:38Z"
        assert row["gateway_at"] == "2026-09-02T05:43:40.032604Z"
        assert row["software_name"] == "E:D Market Connector [Windows]"

    def test_zero_stock_is_preserved_rather_than_treated_as_missing(self):
        # buyPrice 0 with stock 0 is a real "not sold here" state.
        row = next(iter(market_params(market_from(COMMODITY))))  # type: ignore[arg-type]
        assert row["buy_price"] == 0
        assert row["stock"] == 0

    def test_latest_state_replaces_prices_rather_than_coalescing(self):
        # A market genuinely stops selling things. Carrying an old stock figure
        # forward would report goods that are no longer there.
        normalised = " ".join(UPSERT_MARKET_LATEST.split())
        assert "stock = EXCLUDED.stock" in normalised
        assert "COALESCE(EXCLUDED.stock" not in normalised


# Imported late so the module-level statement text is available to the test above.
from edfm_eddn.store import UPSERT_SYSTEM as UPSERT_SYSTEM_TEXT  # noqa: E402
