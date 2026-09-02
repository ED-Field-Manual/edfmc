"""Integration tests against a real PostgreSQL.

These exist because the most important rule in the service is written in SQL,
not Python: an older observation must never overwrite a newer `market_latest`
row (§35). Asserting on the statement text proves it was written; only a real
database proves it works.

Skipped automatically when no database is configured, so CI and other machines
stay green:

    set EDFM_TEST_DSN=postgresql://postgres:edfmdev@localhost/edfm_test
    python -m pytest tests/test_integration.py
"""

from __future__ import annotations

import copy
import os
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

import pytest

from edfm_eddn.normalize import market_from, station_from
from edfm_eddn.store import Store

from test_normalize import COMMODITY, JOURNAL_DOCKED

DSN = os.environ.get("EDFM_TEST_DSN")

pytestmark = pytest.mark.skipif(not DSN, reason="EDFM_TEST_DSN not set")

psycopg = pytest.importorskip("psycopg")


def _assert_disposable(dsn: str) -> None:
    """Refuse to run against a database that is not obviously disposable.

    The fixture below opens with TRUNCATE. This is not hypothetical: pointed
    at the development database while the EDDN worker was ingesting into it,
    this suite wiped the stations table mid-run. Only a database named for
    testing is accepted.
    """
    name = urlsplit(dsn).path.lstrip("/").split("?")[0]
    if not re.search(r"(^|[_-])test($|[_-])", name):
        raise RuntimeError(
            f"EDFM_TEST_DSN points at database {name!r}, which is not named as a "
            "test database. This suite TRUNCATEs tables; refusing to run. "
            "Use a database dedicated to tests (edfm_test), not the one the EDDN "
            "worker ingests into -- truncating that mid-ingest destroys real data."
        )


if DSN:
    _assert_disposable(DSN)


@pytest.fixture()
def store():
    conn = psycopg.connect(DSN, autocommit=False)
    with conn.cursor() as cur:
        # Isolated per test: these tables are shared, and a leftover row from a
        # previous run would make an ordering assertion pass for the wrong reason.
        cur.execute(
            "TRUNCATE market_latest, market_observations, stations, systems,"
            " commodities, unknown_station_types"
        )
    conn.commit()
    yield Store(conn)
    conn.rollback()
    conn.close()


def envelope_at(base: dict, timestamp: str, **message_overrides) -> dict:
    """A copy of `base` at a different timestamp.

    Deep-copied deliberately. A shallow copy shares the nested `commodities`
    list with the module-level fixture, so a test that edits one price silently
    corrupts every other test using that fixture — which is exactly what
    happened the first time this was written.
    """
    envelope = copy.deepcopy(base)
    envelope["message"]["timestamp"] = timestamp
    envelope["message"].update(message_overrides)
    return envelope


class TestOrderingRule:
    """§35, against a real database rather than a regex."""

    def test_older_observation_does_not_overwrite_newer(self, store):
        newer = market_from(envelope_at(COMMODITY, "2026-09-02T12:00:00Z"))
        store.write_market(newer)
        store.commit()

        # Same market, same commodity, observed EARLIER but delivered later.
        # EDDN does this routinely: two commanders dock minutes apart and their
        # uploaders relay at different speeds.
        older_env = envelope_at(COMMODITY, "2026-09-02T09:00:00Z")
        older_env["message"]["commodities"][0] = {
            **older_env["message"]["commodities"][0],
            "sellPrice": 1,
            "demand": 1,
        }
        store.write_market(market_from(older_env))
        store.commit()

        with store.conn.cursor() as cur:
            cur.execute(
                "SELECT sell_price, demand, observed_at FROM market_latest "
                "WHERE market_id = %s AND commodity = %s",
                (128035328, "advancedcatalysers"),
            )
            row = cur.fetchone()

        # The newer reading survived.
        assert row[0] == 3681
        assert row[1] == 42096
        # TIMESTAMPTZ comes back in the session timezone, so compare instants
        # rather than strings -- 12:00Z and 07:00-05:00 are the same moment.
        assert row[2] == datetime(2026, 9, 2, 12, 0, tzinfo=timezone.utc)

    def test_newer_observation_does_overwrite_older(self, store):
        store.write_market(market_from(envelope_at(COMMODITY, "2026-09-02T09:00:00Z")))
        store.commit()

        newer = envelope_at(COMMODITY, "2026-09-02T12:00:00Z")
        newer["message"]["commodities"][0] = {
            **newer["message"]["commodities"][0],
            "sellPrice": 9999,
        }
        store.write_market(market_from(newer))
        store.commit()

        with store.conn.cursor() as cur:
            cur.execute(
                "SELECT sell_price FROM market_latest WHERE market_id = %s AND commodity = %s",
                (128035328, "advancedcatalysers"),
            )
            assert cur.fetchone()[0] == 9999

    def test_history_records_both_readings_regardless_of_order(self, store):
        # market_observations is append-only: a reading must be recorded even
        # when latest-state rejects it as older, or confidence scoring loses the
        # very data it needs.
        store.write_market(market_from(envelope_at(COMMODITY, "2026-09-02T12:00:00Z")))
        store.write_market(market_from(envelope_at(COMMODITY, "2026-09-02T09:00:00Z")))
        store.commit()

        with store.conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM market_observations WHERE market_id = %s", (128035328,)
            )
            assert cur.fetchone()[0] == 2

    def test_identical_timestamp_does_not_rewrite(self, store):
        # Equal is refused as well as older: EDDN relays duplicates, and
        # re-applying the same reading is pure write amplification.
        store.write_market(market_from(envelope_at(COMMODITY, "2026-09-02T12:00:00Z")))
        store.commit()

        with store.conn.cursor() as cur:
            cur.execute("SELECT updated_at FROM market_latest WHERE market_id = %s", (128035328,))
            first = cur.fetchone()[0]

        store.write_market(market_from(envelope_at(COMMODITY, "2026-09-02T12:00:00Z")))
        store.commit()

        with store.conn.cursor() as cur:
            cur.execute("SELECT updated_at FROM market_latest WHERE market_id = %s", (128035328,))
            assert cur.fetchone()[0] == first


class TestStationMerging:
    def test_a_commodity_message_does_not_erase_services(self, store):
        # The bug COALESCE exists to prevent: commodity/3 carries stationType but
        # no services, and must not blank services a journal message recorded.
        store.write_station(station_from(envelope_at(JOURNAL_DOCKED, "2026-09-02T09:00:00Z")))
        store.commit()

        thin = envelope_at(COMMODITY, "2026-09-02T12:00:00Z")
        thin["message"]["marketId"] = 128  # same station as the journal fixture
        store.write_station(station_from(thin))
        store.commit()

        with store.conn.cursor() as cur:
            cur.execute("SELECT service_ids, services_raw, station_type FROM stations WHERE market_id = 128")
            services, raw, station_type = cur.fetchone()

        assert services == ["dock", "commodities", "stationmenu", "techbroker"]
        # Frontier's own casing survives as evidence (§9).
        assert raw == ["dock", "commodities", "stationMenu", "techBroker"]
        # And the newer message's stationType was still applied.
        assert station_type == "Orbis"

    def test_an_older_station_message_is_rejected_entirely(self, store):
        store.write_station(station_from(envelope_at(JOURNAL_DOCKED, "2026-09-02T12:00:00Z")))
        store.commit()

        stale = envelope_at(JOURNAL_DOCKED, "2026-09-02T09:00:00Z", StationName="Old Name")
        store.write_station(station_from(stale))
        store.commit()

        with store.conn.cursor() as cur:
            cur.execute("SELECT name FROM stations WHERE market_id = 128")
            assert cur.fetchone()[0] == "Elder Hub"

    def test_records_the_system_with_coordinates(self, store):
        store.write_station(station_from(JOURNAL_DOCKED))
        store.commit()

        with store.conn.cursor() as cur:
            cur.execute("SELECT name, x, y, z FROM systems WHERE system_address = 99")
            assert cur.fetchone() == ("Mundii", 1.5, -2.0, 3.25)

    def test_flags_an_unclassified_station_type_for_review(self, store):
        odd = envelope_at(JOURNAL_DOCKED, "2026-09-02T12:00:00Z", StationType="SomeNewKind")
        store.write_station(station_from(odd))
        store.commit()

        with store.conn.cursor() as cur:
            cur.execute("SELECT seen_count FROM unknown_station_types WHERE station_type = %s", ("SomeNewKind",))
            assert cur.fetchone()[0] == 1
