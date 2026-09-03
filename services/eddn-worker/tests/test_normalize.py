"""Normalization tests.

Every fixture below is a real message captured from the live EDDN stream on
2026-09-02, trimmed only for length.
"""

from __future__ import annotations

import copy

from edfm_eddn.normalize import (
    is_fleet_carrier,
    is_planetary,
    iter_records,
    known_station_types,
    market_from,
    station_from,
    MarketRecord,
    StationRecord,
)

HEADER = {
    "softwareName": "E:D Market Connector [Windows]",
    "softwareVersion": "6.1.2",
    "uploaderID": "9412b0bc",
    "gameversion": "4.4.0.3",
    "gamebuild": "r330683/r0 ",
    "gatewayTimestamp": "2026-09-02T05:43:40.032604Z",
}

# Real commodity/3: note the LOWERCASE field names.
COMMODITY = {
    "$schemaRef": "https://eddn.edcd.io/schemas/commodity/3",
    "header": HEADER,
    "message": {
        "marketId": 128035328,
        "stationName": "Towarnicki",
        "stationType": "Orbis",
        "systemName": "Minerva",
        "horizons": True,
        "odyssey": True,
        "timestamp": "2026-09-02T05:43:38Z",
        "commodities": [
            {
                "name": "advancedcatalysers",
                "meanPrice": 2863,
                "buyPrice": 0,
                "stock": 0,
                "stockBracket": 0,
                "sellPrice": 3681,
                "demand": 42096,
                "demandBracket": 3,
            }
        ],
    },
}

# Real journal/1 Docked: PascalCase, and the only source of pads and distance.
JOURNAL_DOCKED = {
    "$schemaRef": "https://eddn.edcd.io/schemas/journal/1",
    "header": HEADER,
    "message": {
        "event": "Docked",
        "timestamp": "2026-09-02T05:43:36Z",
        "StationName": "Elder Hub",
        "StationType": "Coriolis",
        "MarketID": 128,
        "StarSystem": "Mundii",
        "SystemAddress": 99,
        "StarPos": [1.5, -2.0, 3.25],
        "StationServices": ["dock", "commodities", "stationMenu", "techBroker"],
        "StationEconomies": [
            {"Name": "$economy_Industrial;", "Proportion": 0.9},
            {"Name": "$economy_HighTech;", "Proportion": 0.1},
        ],
        "DistFromStarLS": 92.137178,
        "LandingPads": {"Small": 2, "Medium": 2, "Large": 3},
    },
}

# Real journal/1 Scan: carries no station at all.
JOURNAL_SCAN = {
    "$schemaRef": "https://eddn.edcd.io/schemas/journal/1",
    "header": HEADER,
    "message": {
        "event": "Scan",
        "timestamp": "2026-09-02T05:43:36Z",
        "BodyName": "Sollaro C 3",
        "StarSystem": "Sollaro",
        "SystemAddress": 11538024121505,
        "StarPos": [-9528.625, 1.0, 2.0],
        "DistanceFromArrivalLS": 23581.106909,
    },
}

APPROACH_SETTLEMENT = {
    "$schemaRef": "https://eddn.edcd.io/schemas/approachsettlement/1",
    "header": HEADER,
    "message": {
        "event": "ApproachSettlement",
        "timestamp": "2026-09-02T05:43:38Z",
        "Name": "The Watchtower",
        "MarketID": 128677767,
        "BodyName": "Tir A 2",
        "StarSystem": "Tir",
        "SystemAddress": 48996147307082,
        "StarPos": [-9532.9375, 1.0, 2.0],
        "StationServices": ["dock", "contacts"],
        "StationEconomies": [{"Name": "$economy_Colony;", "Proportion": 1}],
        "StationGovernment": "$government_Engineer;",
        "StationFaction": {"Name": "Some Faction"},
    },
}


class TestStationTypeClassification:
    def test_recognises_orbital_and_planetary(self):
        assert is_planetary("Coriolis") is False
        assert is_planetary("Orbis") is False
        assert is_planetary("CraterOutpost") is True
        assert is_planetary("OnFootSettlement") is True

    def test_is_case_insensitive(self):
        assert is_planetary("coriolis") is False
        assert is_planetary("CRATERPORT") is True

    def test_unknown_type_is_None_not_a_guess(self):
        # EDDN reports no orbital/planetary flag, so this mapping is ours. A type
        # we have never seen must not be bucketed as orbital just because most
        # stations are.
        assert is_planetary("SomeNewStationKind") is None
        assert is_planetary(None) is None
        assert is_planetary("") is None

    def test_identifies_fleet_carriers(self):
        assert is_fleet_carrier("FleetCarrier") is True
        assert is_fleet_carrier("Coriolis") is False


class TestLowercaseSchemas:
    """commodity/3 uses lowercase naming; reading only PascalCase loses it all."""

    def test_reads_a_commodity_market(self):
        market = market_from(COMMODITY)
        assert isinstance(market, MarketRecord)
        assert market.market_id == 128035328
        assert market.station_name == "Towarnicki"
        assert market.system_name == "Minerva"
        assert len(market.commodities) == 1

        c = market.commodities[0]
        assert c.name == "advancedcatalysers"
        assert c.sell_price == 3681
        assert c.demand == 42096
        # buyPrice 0 with stock 0 is a real "not sold here" state, not missing.
        assert c.buy_price == 0
        assert c.stock == 0

    def test_reads_station_identity_from_a_commodity_message(self):
        # The station half is thin, but it is the widest source of stationType
        # coverage there is -- journal/1 only carries it on ~13% of messages.
        records = list(iter_records(COMMODITY))
        stations = [r for r in records if isinstance(r, StationRecord)]
        markets = [r for r in records if isinstance(r, MarketRecord)]

        # Exactly one of each. An earlier version special-cased commodity
        # stations in iter_records on top of station_from's dual-naming lookup,
        # and emitted every one of them twice.
        assert len(stations) == 1
        assert len(markets) == 1
        assert stations[0].station_type == "Orbis"
        assert stations[0].is_planetary is False
        assert stations[0].services is None  # commodity messages carry none


class TestPascalCaseSchemas:
    def test_reads_a_docked_station_in_full(self):
        s = station_from(JOURNAL_DOCKED)
        assert s is not None
        assert s.market_id == 128
        assert s.station_name == "Elder Hub"
        assert s.station_type == "Coriolis"
        assert s.dist_from_star_ls == 92.137178
        assert s.landing_pads == {"Small": 2, "Medium": 2, "Large": 3}
        assert s.star_pos == (1.5, -2.0, 3.25)

    def test_keeps_raw_service_tokens_alongside_folded_ids(self):
        s = station_from(JOURNAL_DOCKED)
        assert s is not None
        assert s.services == ("dock", "commodities", "stationmenu", "techbroker")
        # Raw tokens are the evidence a discrepancy report must quote (§9).
        assert s.services_raw == ("dock", "commodities", "stationMenu", "techBroker")

    def test_does_not_renormalise_economy_proportions(self):
        s = station_from(JOURNAL_DOCKED)
        assert s is not None
        assert s.economies == (("$economy_Industrial;", 0.9), ("$economy_HighTech;", 0.1))

    def test_ignores_journal_events_that_are_not_stations(self):
        # journal/1 relays everything from Scan to Docked; 46.7% of the stream.
        assert station_from(JOURNAL_SCAN) is None

    def test_names_a_settlement_from_Name(self):
        s = station_from(APPROACH_SETTLEMENT)
        assert s is not None
        assert s.station_name == "The Watchtower"
        assert s.services == ("dock", "contacts")


class TestProvenance:
    def test_records_both_timestamps(self):
        s = station_from(JOURNAL_DOCKED)
        assert s is not None
        p = s.provenance
        # They differ, and the difference is what freshness scoring uses (§15).
        assert p.observed_at == "2026-09-02T05:43:36Z"
        assert p.gateway_at == "2026-09-02T05:43:40.032604Z"

    def test_records_software_and_game_version(self):
        p = station_from(JOURNAL_DOCKED).provenance  # type: ignore[union-attr]
        assert p.software_name == "E:D Market Connector [Windows]"
        assert p.software_version == "6.1.2"
        assert p.game_version == "4.4.0.3"
        # Frontier's trailing space is preserved verbatim.
        assert p.game_build == "r330683/r0 "
        assert p.schema_ref.endswith("/journal/1")


class TestRefusals:
    def test_no_market_id_no_record(self):
        message = dict(JOURNAL_DOCKED["message"])
        del message["MarketID"]
        assert station_from({**JOURNAL_DOCKED, "message": message}) is None

    def test_absent_services_are_None_not_an_empty_tuple(self):
        # An empty tuple would assert the station has no services, which is a
        # much stronger claim than "this message did not carry them".
        message = dict(JOURNAL_DOCKED["message"])
        del message["StationServices"]
        s = station_from({**JOURNAL_DOCKED, "message": message})
        assert s is not None and s.services is None

    def test_partial_coordinates_are_rejected(self):
        message = {**JOURNAL_DOCKED["message"], "StarPos": [1.0, None, 3.0]}
        s = station_from({**JOURNAL_DOCKED, "message": message})
        assert s is not None and s.star_pos is None

    def test_non_dict_message_is_ignored(self):
        assert station_from({"$schemaRef": "x", "header": {}, "message": []}) is None
        assert market_from({"$schemaRef": "x", "header": {}, "message": None}) is None


class TestUnknownTypeReporting:
    def test_surfaces_station_types_we_cannot_classify(self):
        message = {**JOURNAL_DOCKED["message"], "StationType": "SomeNewKind"}
        s = station_from({**JOURNAL_DOCKED, "message": message})
        assert known_station_types([s]) == {"SomeNewKind"}  # type: ignore[list-item]

    def test_reports_nothing_for_known_types(self):
        s = station_from(JOURNAL_DOCKED)
        assert known_station_types([s]) == set()  # type: ignore[list-item]


class TestEmptyServices:
    """An empty StationServices is silence, not a claim of having none."""

    def test_empty_list_is_treated_as_not_reported(self):
        # Found in production: a station was stored with service_ids = [],
        # which asserts it offers nothing. Every dockable station has at least
        # a pad, and as a reference that makes every observed service look
        # like a discrepancy.
        envelope = copy.deepcopy(JOURNAL_DOCKED)
        envelope["message"]["StationServices"] = []
        record = station_from(envelope)
        assert record.services is None
        assert record.services_raw is None

    def test_a_real_list_still_survives(self):
        record = station_from(JOURNAL_DOCKED)
        assert record.services == ("dock", "commodities", "stationmenu", "techbroker")

    def test_absent_key_is_also_none(self):
        envelope = copy.deepcopy(JOURNAL_DOCKED)
        del envelope["message"]["StationServices"]
        assert station_from(envelope).services is None
