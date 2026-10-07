"""
Router tests. Run from the plugin folder:  python tests/test_router.py

`fixtures/spansh_sol_achenar.json` is a real Spansh results response
(2026-10-06). Journal lines are verbatim from a real journal.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from router_core import bridge, spansh  # noqa: E402
from router_core.route import Route, Waypoint  # noqa: E402

with open(os.path.join(ROOT, 'tests', 'fixtures', 'spansh_sol_achenar.json'), encoding='utf-8') as f:
    SOL_ACHENAR = json.load(f)

FSDJUMP_ACHENAR = {'event': 'FSDJump', 'StarSystem': 'Achenar', 'SystemAddress': 164098653}


def three_stops() -> Route:
    return Route(waypoints=[
        Waypoint('Sol', 0, 10477373803),
        Waypoint('Middle', 3, 111),
        Waypoint('End', 5, 222),
    ])


class RouteTest(unittest.TestCase):
    def test_reads_a_real_spansh_result(self) -> None:
        route = Route.from_spansh(SOL_ACHENAR['result'])
        self.assertEqual([w.system for w in route.waypoints], ['Sol', 'Achenar'])
        self.assertEqual(route.waypoints[1].address, 164098653)
        self.assertEqual(route.total_jumps(), 4)

    def test_plotting_from_where_you_are_skips_the_start(self) -> None:
        route = Route.from_spansh(SOL_ACHENAR['result'])
        route.start_from('Sol', 10477373803)
        self.assertEqual(route.next.system, 'Achenar')
        self.assertEqual(route.jumps_left(), 4)

    def test_arriving_matches_on_address_then_name(self) -> None:
        route = three_stops()
        route.start_from('Sol', 10477373803)
        self.assertFalse(route.arrived('Somewhere else', 999))
        self.assertTrue(route.arrived('MIDDLE', 111))
        self.assertEqual(route.next.system, 'End')
        imported = Route.from_csv('System Name,Jumps\nSol,0\nMiddle,3\nEnd,5\n')
        self.assertTrue(imported.arrived('middle', 111))  # no addresses: name, any case

    def test_skipping_a_waypoint_still_counts(self) -> None:
        route = three_stops()
        route.start_from('Sol', 10477373803)
        self.assertTrue(route.arrived('End', 222))
        self.assertTrue(route.finished)
        self.assertIsNone(route.next)

    def test_stepping_stays_inside_the_route(self) -> None:
        route = three_stops()
        route.step(-5)
        self.assertEqual(route.next_index, 0)
        route.step(10)
        self.assertTrue(route.finished)

    def test_csv_import(self) -> None:
        route = Route.from_csv('﻿"System Name","Distance To Arrival","Distance Remaining","Neutron Star","Jumps"\n'
                               '"Sol","0","139.4","No","0"\n"Achenar","139.4","0","Yes","4"\n')
        self.assertEqual(route.waypoints[1].jumps, 4)
        self.assertTrue(route.waypoints[1].neutron)
        with self.assertRaises(ValueError):
            Route.from_csv('Name\nSol\n')

    def test_saves_and_loads(self) -> None:
        route = three_stops()
        route.step(2)
        path = os.path.join(tempfile.mkdtemp(), 'route.json')
        route.save(path)
        again = Route.load(path)
        self.assertEqual(again.next.system, 'End')
        self.assertEqual(again.waypoints[1].address, 111)
        self.assertTrue(Route.load(path + '.missing').empty)


class SpanshTest(unittest.TestCase):
    def test_submits_then_polls_until_ready(self) -> None:
        asked: list[tuple[str, str]] = []
        replies = [(202, {'job': 'ABC', 'status': 'queued'}),
                   (202, {'job': 'ABC', 'status': 'queued'}),
                   (200, SOL_ACHENAR)]

        def request(url: str, method: str):
            asked.append((method, url))
            return replies.pop(0)

        route = spansh.plot('Sol', 'Achenar', 50, 60, request=request, sleep=lambda s: None)
        self.assertEqual(route.destination.system, 'Achenar')
        self.assertEqual(asked[0][0], 'POST')
        self.assertIn('from=Sol', asked[0][1])
        self.assertIn('range=50.00', asked[0][1])
        self.assertTrue(asked[1][1].endswith('/results/ABC'))

    def test_via_systems_and_supercharge_reach_spansh(self) -> None:
        asked = []
        replies = [(202, {'job': 'J'}), (200, SOL_ACHENAR)]

        def request(url, method):
            asked.append(url)
            return replies.pop(0)

        spansh.plot('Sol', 'Achenar', 50, 60, request=request, sleep=lambda s: None,
                    via=['Alioth', ' '], supercharge=6)
        self.assertIn('via=Alioth', asked[0])
        self.assertEqual(asked[0].count('via='), 1)  # blank via entries are dropped
        self.assertIn('supercharge_multiplier=6', asked[0])

    def test_an_unknown_supercharge_falls_back_to_normal(self) -> None:
        asked = []
        replies = [(202, {'job': 'J'}), (200, SOL_ACHENAR)]
        spansh.plot('Sol', 'Achenar', 50, request=lambda u, m: (asked.append(u), replies.pop(0))[1],
                    sleep=lambda s: None, supercharge=9)
        self.assertIn('supercharge_multiplier=4', asked[0])

    def test_spansh_explains_a_bad_system(self) -> None:
        # Verbatim from Spansh for an unknown destination.
        def request(url: str, method: str):
            return 400, {'error': 'Could not find finishing system'}
        with self.assertRaisesRegex(spansh.PlotError, 'Could not find finishing system'):
            spansh.plot('Sol', 'NoSuchSystemXYZ', 50, request=request, sleep=lambda s: None)


class SuggestTest(unittest.TestCase):
    def test_names_that_start_with_the_text_come_first(self) -> None:
        # fixtures/spansh_names_sol.json is Spansh's real answer for "sol".
        with open(os.path.join(ROOT, 'tests', 'fixtures', 'spansh_names_sol.json'), encoding='utf-8') as f:
            body = json.load(f)
        names = spansh.suggest('sol', request=lambda url, method: (200, body))
        self.assertEqual(names[0], 'Sol')
        self.assertEqual(set(names), {'Sol', 'Solitude', 'Solibamba', 'Sollaro', 'Solati'})

    def test_a_fully_typed_system_is_offered_first(self) -> None:
        # Spansh's real answer for "Wregoe FH-D D12-45", typed with a capital D.
        # The exact system used to be left out of the list, which read as
        # Router not knowing it.
        with open(os.path.join(ROOT, 'tests', 'fixtures', 'spansh_names_wregoe_fh_d_d12_45.json'), encoding='utf-8') as f:
            body = json.load(f)
        names = spansh.suggest('Wregoe FH-D D12-45', request=lambda url, method: (200, body))
        self.assertEqual(names[0], 'Wregoe FH-D d12-45')

    def test_nothing_for_too_little_text_or_a_failed_request(self) -> None:
        self.assertEqual(spansh.suggest('s', request=lambda u, m: self.fail('should not ask')), [])
        self.assertEqual(spansh.suggest('sol', request=lambda u, m: (500, None)), [])


# A real Loadout line from 2026-10-05, with its Modules list removed for size.
LOADOUT = ('{"timestamp": "2026-10-05T23:07:46Z", "event": "Loadout", "Ship": "corsair", "ShipID": 18, '
           '"ShipName": "Void Revenant", "ShipIdent": "BS-VR1", "HullValue": 79304746, "ModulesValue": 215780835, '
           '"HullHealth": 1.0, "UnladenMass": 785.099976, "CargoCapacity": 64, "MaxJumpRange": 27.648792, '
           '"FuelCapacity": {"Main": 32.0, "Reserve": 0.41}, "Rebuy": 14754281}')


class WhereAmITest(unittest.TestCase):
    def test_reads_the_system_and_jump_range_the_host_already_knows(self) -> None:
        import load

        journal = os.path.join(tempfile.mkdtemp(), 'Journal.2026-10-05T180552.01.log')
        with open(journal, 'w', encoding='utf-8') as f:
            f.write(LOADOUT + '\n')

        class FakeMonitor:
            state = {'SystemName': 'Wregoe EH-D d12-54', 'SystemAddress': 1866003925355}
            logfile = journal

        stored: dict[str, object] = {}

        class FakeConfig:
            def get_str(self, key, default=None):
                return stored.get(key, default)

            def get_int(self, key, default=0):
                return stored.get(key, default)

            def set(self, key, value):
                stored[key] = value

        load.monitor, load.config = FakeMonitor(), FakeConfig()
        try:
            load._state['system'] = None
            load._where_am_i()
            self.assertEqual(load._state['system'], 'Wregoe EH-D d12-54')
            self.assertEqual(load._state['address'], 1866003925355)
            self.assertEqual(stored['router_range'], '27.65')
        finally:
            load.monitor, load.config = None, None


class NativePageTest(unittest.TestCase):
    """Inside EDFM Companion, Router publishes state for the app to draw."""

    def make(self, route):
        from router_core.native import NativePage
        published = []

        class Page:
            def update(self, state):
                json.dumps(state)  # must be plain JSON, as edfmc requires
                published.append(state)

        handlers = []

        def register(on_action):
            handlers.append(on_action)
            return Page()

        page = NativePage(register, route, current_system=lambda: 'Sol', current_address=lambda: 10477373803,
                          jump_range=lambda: 27.65, efficiency=lambda: 60, set_efficiency=lambda v: None,
                          auto_copy=lambda: False, changed=lambda: None)
        return page, handlers[0], published

    def test_publishes_the_form_state_with_no_route(self) -> None:
        _, _, published = self.make(Route())
        self.assertEqual(published[-1]['kind'], 'router-v1')
        self.assertEqual(published[-1]['currentSystem'], 'Sol')
        self.assertEqual(published[-1]['jumpRange'], 27.65)
        self.assertIsNone(published[-1]['route'])

    def test_actions_move_along_the_route_and_clear_it(self) -> None:
        route = three_stops()
        route.start_from('Sol', 10477373803)
        page, act, published = self.make(route)
        self.assertEqual(published[-1]['route']['next'], 'Middle')
        act('step', {'delta': 1})
        self.assertEqual(published[-1]['route']['next'], 'End')
        self.assertEqual(published[-1]['route']['waypoint'], 3)
        act('clear', {})
        self.assertIsNone(published[-1]['route'])

    def test_every_waypoint_is_published_with_where_it_stands(self) -> None:
        route = three_stops()
        route.start_from('Sol', 10477373803)
        _, act, published = self.make(route)
        cards = published[-1]['route']['waypoints_list']
        self.assertEqual([c['state'] for c in cards], ['done', 'next', 'upcoming'])
        act('goto', {'index': 2})
        self.assertEqual([c['state'] for c in published[-1]['route']['waypoints_list']], ['done', 'done', 'next'])

    def test_a_plot_with_missing_fields_says_why(self) -> None:
        _, act, published = self.make(Route())
        act('plot', {'source': 'Sol', 'destination': '', 'range': '50'})
        self.assertTrue(published[-1]['status']['error'])
        self.assertFalse(published[-1]['plotting'])


def fixture(name):
    with open(os.path.join(ROOT, 'tests', 'fixtures', name), encoding='utf-8') as f:
        return json.loads(f.read())


class ShipTest(unittest.TestCase):
    """Figures for the exact plotter, checked against the range the game states."""

    def test_an_engineered_drive_matches_the_game(self) -> None:
        from router_core import ship
        # The commander's Corsair: an engineered SCO drive (FSDOptimalMass 1894.1).
        f = ship.from_loadout(fixture('loadout_corsair.json'))
        self.assertAlmostEqual(f.optimal_mass, 1894.099976, places=3)
        self.assertEqual(f.max_fuel_per_jump, 5.2)
        self.assertEqual((f.tank_size, f.internal_tank_size), (32.0, 0.41))
        self.assertAlmostEqual(f.calculated_range, 27.648792, places=3)
        self.assertTrue(f.agrees)
        self.assertEqual(f.supercharge_multiplier, 4)

    def test_the_caspian_drive_supercharges_six_times(self) -> None:
        from router_core import ship
        f = ship.from_loadout(fixture('loadout_caspian.json'))
        self.assertTrue(f.agrees)
        self.assertEqual(f.supercharge_multiplier, 6)

    def test_figures_that_disagree_with_the_game_are_flagged(self) -> None:
        from router_core import ship
        loadout = fixture('loadout_corsair.json')
        loadout['MaxJumpRange'] = 30.0
        self.assertFalse(ship.from_loadout(loadout).agrees)

    def test_an_unknown_drive_says_so(self) -> None:
        from router_core import ship
        loadout = fixture('loadout_corsair.json')
        for m in loadout['Modules']:
            if m['Slot'] == 'FrameShiftDrive':
                m['Item'] = 'int_hyperdrive_newthing'
        with self.assertRaisesRegex(ship.ShipError, 'does not know the drive'):
            ship.from_loadout(loadout)


class ExactTest(unittest.TestCase):
    def test_reads_a_real_exact_plotter_result(self) -> None:
        # Spansh's real answer for Sol to Achenar in the commander's Corsair.
        route = Route.from_exact(fixture('spansh_exact_sol_achenar.json')['result'])
        self.assertEqual(route.waypoints[0].system, 'Sol')
        self.assertEqual(route.waypoints[-1].system, 'Achenar')
        self.assertEqual(route.total_jumps(), len(route.waypoints) - 1)
        self.assertTrue(route.waypoints[1].refuel)
        self.assertTrue(route.waypoints[1].scoopable)
        self.assertAlmostEqual(route.waypoints[1].distance, 26.56, places=2)

    def test_sends_the_ship_and_options(self) -> None:
        from router_core import ship
        sent = {}
        replies = [(202, {'job': 'J'}), (200, fixture('spansh_exact_sol_achenar.json'))]

        def request(url, method, form=None):
            if form is not None:
                sent.update(form)
            return replies.pop(0)

        f = ship.from_loadout(fixture('loadout_corsair.json'))
        route = spansh.plot_exact('Sol', 'Achenar', f, {'algorithm': 'fuel', 'exclude_secondary': True,
                                                         'max_time': 999}, request=request, sleep=lambda s: None)
        self.assertEqual(route.destination.system, 'Achenar')
        self.assertEqual(sent['algorithm'], 'fuel')
        self.assertEqual(sent['exclude_secondary'], 1)
        self.assertEqual(sent['use_supercharge'], 0)  # normal jumps unless asked
        self.assertEqual(sent['max_time'], 120)  # Spansh's limit
        self.assertAlmostEqual(sent['optimal_mass'], 1894.099976, places=3)


class FleetTest(unittest.TestCase):
    """Every owned ship, from the journals, without being in it."""

    # From a real StoredShips (2026-10-04), trimmed to two ships.
    STORED = {'timestamp': '2026-10-04T03:50:50Z', 'event': 'StoredShips', 'ShipsHere': [
        {'ShipID': 28, 'ShipType': 'explorer_nx', 'ShipType_Localised': 'Caspian Explorer', 'Value': 1, 'Hot': False},
        {'ShipID': 10, 'ShipType': 'dolphin', 'Name': 'FGS SOFIE', 'Value': 1, 'Hot': False}],
        'ShipsRemote': []}

    def build(self):
        from router_core.fleet import Fleet
        f = Fleet()
        caspian = fixture('loadout_caspian.json')
        caspian['ShipID'] = 28
        corsair = fixture('loadout_corsair.json')
        f.fold(caspian)
        f.fold(corsair)  # now flying the Corsair
        f.fold(self.STORED)
        return f

    def test_lists_owned_ships_with_their_last_figures(self) -> None:
        ships = {s['id']: s for s in self.build().ships()}
        self.assertTrue(ships[18]['current'])
        self.assertEqual(ships[28]['model'], 'Caspian Explorer')
        self.assertTrue(ships[28]['ready'])
        self.assertEqual(ships[28]['supercharge'], 6)
        self.assertAlmostEqual(ships[28]['maxJump'], 36.029522, places=4)

    def test_a_ship_never_flown_is_listed_with_why_it_cannot_plot(self) -> None:
        dolphin = {s['id']: s for s in self.build().ships()}[10]
        self.assertEqual(dolphin['name'], 'FGS SOFIE')
        self.assertEqual(dolphin['model'], 'Dolphin')
        self.assertFalse(dolphin['ready'])

    def test_a_ship_no_longer_listed_or_sold_drops_out(self) -> None:
        f = self.build()
        f.fold({'event': 'StoredShips', 'ShipsHere': [], 'ShipsRemote': []})
        self.assertEqual([s['id'] for s in f.ships()], [18])  # only the one being flown
        f.fold({'event': 'ShipyardSell', 'SellShipID': 18})
        self.assertEqual(f.ships(), [])


class BridgeTest(unittest.TestCase):
    def test_summary_for_the_overlay(self) -> None:
        route = three_stops()
        route.start_from('Sol', 10477373803)
        s = bridge.summary(route)
        self.assertEqual(s['next'], 'Middle')
        self.assertEqual(s['jumpsLeft'], 8)
        self.assertEqual((s['waypoint'], s['waypoints']), (2, 3))
        self.assertIsNone(bridge.summary(Route()))

    def test_publishing_is_silent_without_edfmc(self) -> None:
        self.assertFalse(bridge.available())  # no host module in tests
        bridge.publish(three_stops())  # must not raise


with open(os.path.join(ROOT, 'tests', 'fixtures', 'spansh_carrier_sol_alioth_achenar.json'), encoding='utf-8') as f:
    CARRIER_RESULT = json.load(f)


class CarrierTest(unittest.TestCase):
    """The fleet carrier planner. The fixture is a real Spansh job (2026-10-07)."""

    def test_reads_a_real_carrier_result_one_waypoint_per_place(self) -> None:
        route = Route.from_carrier(CARRIER_RESULT['result'])
        # Spansh lists the Alioth stop twice (arrive, then a 0 ly "jump" on);
        # the commander sees it once.
        self.assertEqual([w.system for w in route.waypoints], ['Sol', 'Alioth', 'Achenar'])
        self.assertTrue(route.is_carrier)
        self.assertEqual(route.total_jumps(), 2)
        sol, alioth, achenar = route.waypoints
        self.assertEqual(sol.restock, 50)  # load 50 t before leaving
        self.assertIsNone(sol.tritium_used)
        self.assertEqual((alioth.tritium_used, alioth.tritium_left), (16, 34))
        self.assertTrue(alioth.stop and achenar.stop)
        self.assertEqual(achenar.tritium_left, 0)
        self.assertAlmostEqual(achenar.distance, 221.68, places=1)

    def test_a_saved_carrier_route_reloads_and_an_older_save_still_loads(self) -> None:
        route = Route.from_carrier(CARRIER_RESULT['result'])
        again = Route.from_json(route.to_json())
        self.assertEqual(again.waypoints, route.waypoints)
        self.assertTrue(again.is_carrier)
        old = json.loads(three_stops().to_json())
        for w in old['waypoints']:
            for k in ('tritium_used', 'tritium_left', 'restock', 'icy_ring', 'pristine', 'stop'):
                w.pop(k)
        self.assertEqual(len(Route.from_json(json.dumps(old)).waypoints), 3)
        newer = json.loads(three_stops().to_json())
        newer['waypoints'][0]['from_the_future'] = 1
        self.assertEqual(len(Route.from_json(json.dumps(newer)).waypoints), 3)

    def _fake(self, sent: list) -> object:
        ids = {'Sol': 10477373803, 'Alioth': 1109989017963, 'Achenar': 164098653}

        def request(url: str, method: str = 'GET', form: dict | None = None):
            sent.append((url, method, form))
            if '/search/systems' in url:
                q = url.split('q=')[1].replace('%20', ' ')
                return 200, {'results': [{'name': n, 'id64': i} for n, i in ids.items() if n.lower().startswith(q.lower())]
                             + [{'name': q + ' Extra', 'id64': 1}]}
            if url.endswith('/fleetcarrier/route'):
                return 202, {'job': 'J', 'status': 'queued'}
            return 200, CARRIER_RESULT
        return request

    def test_sends_spanshs_own_field_names(self) -> None:
        sent: list = []
        route = spansh.plot_carrier('Sol', ['Alioth', 'Achenar'], 'fleet', 1200, refuel_at=['alioth'],
                                    request=self._fake(sent), sleep=lambda s: None)
        self.assertEqual(len(route.waypoints), 3)
        form = next(f for u, m, f in sent if u.endswith('/fleetcarrier/route'))
        self.assertEqual(form, {
            'source': 10477373803,
            'destinations': [1109989017963, 164098653],
            'capacity': 25000,
            'mass': 25000,
            'capacity_used': 1200,
            'calculate_starting_fuel': 1,
            'refuel_destinations': [1109989017963],
        })

    def test_planning_with_the_tritium_on_board(self) -> None:
        sent: list = []
        spansh.plot_carrier('Sol', ['Achenar'], 'squadron', 99999, fuel=5000, tritium_market=300,
                            request=self._fake(sent), sleep=lambda s: None)
        form = next(f for u, m, f in sent if u.endswith('/fleetcarrier/route'))
        self.assertEqual((form['capacity'], form['mass']), (60000, 15000))
        self.assertEqual(form['capacity_used'], 60000)  # clamped to the carrier
        self.assertEqual(form['calculate_starting_fuel'], 0)
        self.assertEqual(form['fuel_loaded'], 1000)  # the tank holds 1,000 t
        self.assertEqual(form['tritium_stored'], 300)

    def test_a_near_miss_name_is_refused_not_guessed(self) -> None:
        with self.assertRaises(spansh.PlotError) as e:
            spansh.plot_carrier('Sol', ['Alio'], request=self._fake([]), sleep=lambda s: None)
        self.assertIn('Alio', str(e.exception))

    def test_reads_the_carriers_from_journal_lines(self) -> None:
        from router_core.carrier import Carriers
        c = Carriers()
        # Shapes as in the journal corpus; names and numbers changed.
        c.fold({'timestamp': '2026-10-07T00:22:39Z', 'event': 'CarrierStats', 'CarrierID': 1, 'CarrierType': 'SquadronCarrier',
                'Callsign': 'ABCD', 'Name': 'TEST SQUADRON', 'FuelLevel': 839,
                'SpaceUsage': {'TotalCapacity': 60000, 'Crew': 4520, 'Cargo': 1236, 'FreeSpace': 54244}})
        c.fold({'timestamp': '2026-10-07T04:42:42Z', 'event': 'CarrierLocation', 'CarrierType': 'SquadronCarrier',
                'CarrierID': 1, 'StarSystem': 'Wregoe KO-G c24-7', 'SystemAddress': 2008870359762, 'BodyID': 13})
        c.fold({'timestamp': '2026-10-03T01:32:07Z', 'event': 'CarrierLocation', 'CarrierType': 'FleetCarrier',
                'CarrierID': 2, 'StarSystem': 'Sol', 'SystemAddress': 10477373803, 'BodyID': 0})
        sq = c.by_kind['squadron']
        self.assertEqual((sq.name, sq.fuel, sq.used_capacity, sq.capacity), ('TEST SQUADRON', 839, 5756, 60000))
        self.assertEqual(sq.system, 'Wregoe KO-G c24-7')
        self.assertEqual(c.by_kind['fleet'].system, 'Sol')
        self.assertFalse(c.fold({'event': 'CarrierStats', 'CarrierType': 'Something'}))


class EntryPointTest(unittest.TestCase):
    def test_follows_jumps_without_a_window(self) -> None:
        import load
        d = tempfile.mkdtemp()
        self.assertEqual(load.plugin_start3(d), 'Router')
        route = Route.from_spansh(SOL_ACHENAR['result'])
        route.start_from('Sol', 10477373803)
        load._state['route'] = route
        load.journal_entry('Cmdr', False, 'Sol', None, FSDJUMP_ACHENAR, {})
        self.assertTrue(load._state['route'].finished)
        self.assertTrue(os.path.exists(os.path.join(d, 'route.json')))


    def _two_routes(self):
        import load
        d = tempfile.mkdtemp()
        load.plugin_start3(d)
        ship = Route(waypoints=[Waypoint('Sol', 0, 10477373803), Waypoint('Alioth', 4, 1109989017963),
                                Waypoint('Shinrarta Dezhra', 6, 3932277478106)])
        ship.next_index = 1
        carrier = Route.from_carrier(CARRIER_RESULT['result'])
        carrier.next_index = 1
        load._state['route'] = ship
        load._state['carrier_route'] = carrier
        load._settings_set({'carrierType': 'fleet'})
        return load, d

    def test_both_routes_are_followed_at_the_same_time(self) -> None:
        load, d = self._two_routes()
        # The commander flies to Alioth in their own ship: their route moves on,
        # the carrier's does not, though its next stop is Alioth too.
        load.journal_entry('Cmdr', False, 'Alioth', None,
                           {'event': 'FSDJump', 'StarSystem': 'Alioth', 'SystemAddress': 1109989017963}, {})
        self.assertEqual(load._state['route'].next_index, 2)
        self.assertEqual(load._state['carrier_route'].next_index, 1)
        # A squadron carrier arriving there is not the carrier being routed.
        load.journal_entry('Cmdr', False, 'Alioth', None,
                           {'event': 'CarrierLocation', 'CarrierType': 'SquadronCarrier', 'CarrierID': 9,
                            'StarSystem': 'Alioth', 'SystemAddress': 1109989017963}, {})
        self.assertEqual(load._state['carrier_route'].next_index, 1)
        # The commander's own carrier arriving there is; their ship route is untouched.
        load.journal_entry('Cmdr', False, 'Alioth', None,
                           {'event': 'CarrierLocation', 'CarrierType': 'FleetCarrier', 'CarrierID': 2,
                            'StarSystem': 'Alioth', 'SystemAddress': 1109989017963}, {})
        self.assertEqual(load._state['carrier_route'].next_index, 2)
        self.assertEqual(load._state['route'].next_index, 2)
        # Each is saved to its own file.
        self.assertTrue(os.path.exists(os.path.join(d, 'route.json')))
        self.assertTrue(os.path.exists(os.path.join(d, 'carrier_route.json')))
        self.assertEqual(Route.load(os.path.join(d, 'carrier_route.json')).next_index, 2)

    def test_a_jump_aboard_the_carrier_moves_both(self) -> None:
        load, _ = self._two_routes()
        load._state['route'].next_index = 0
        load._state['route'].waypoints.insert(1, Waypoint('Achenar', 1, 164098653))
        load._state['carrier_route'].next_index = 2
        load.journal_entry('Cmdr', False, 'Achenar', None,
                           {'event': 'CarrierJump', 'Docked': True, 'StarSystem': 'Achenar', 'SystemAddress': 164098653}, {})
        self.assertTrue(load._state['carrier_route'].finished)
        self.assertEqual(load._state['route'].next_index, 2)

    def test_a_carrier_route_saved_by_0_7_0_moves_to_its_own_slot(self) -> None:
        import load
        d = tempfile.mkdtemp()
        Route.from_carrier(CARRIER_RESULT['result']).save(os.path.join(d, 'route.json'))
        load.plugin_start3(d)
        self.assertTrue(load._state['route'].empty)
        self.assertTrue(load._state['carrier_route'].is_carrier)
        self.assertEqual(len(load._state['carrier_route'].waypoints), 3)

    def test_the_overlay_gets_both_routes(self) -> None:
        carrier = Route.from_carrier(CARRIER_RESULT['result'])
        carrier.next_index = 1
        both = bridge.overlay(three_stops(), carrier)
        self.assertEqual(both['next'], 'Sol')
        self.assertEqual(both['carrier'], {'next': 'Alioth', 'destination': 'Achenar', 'jumpsLeft': 2, 'finished': False})
        only_carrier = bridge.overlay(Route(), carrier)
        self.assertIsNone(only_carrier['next'])
        self.assertTrue(only_carrier['noShipRoute'])
        self.assertIsNone(bridge.overlay(Route(), Route()))
        self.assertNotIn('carrier', bridge.overlay(three_stops(), Route()))


class NativeSlotsTest(unittest.TestCase):
    """The page's actions name a route; without one they mean the ship route, as before."""

    def _page(self):
        from router_core.native import NativePage

        class Page:
            def update(self, state):
                self.state = state
        page = Page()
        changed = {'ship': 0, 'carrier': 0}
        carrier = Route.from_carrier(CARRIER_RESULT['result'])
        carrier.next_index = 1
        p = NativePage(lambda on_action: page, three_stops(), current_system=lambda: 'Sol',
                       current_address=lambda: 10477373803, jump_range=lambda: 30.0, efficiency=lambda: 60,
                       set_efficiency=lambda v: None, auto_copy=lambda: False,
                       changed=lambda: changed.__setitem__('ship', changed['ship'] + 1),
                       carrier_route=carrier,
                       carrier_changed=lambda: changed.__setitem__('carrier', changed['carrier'] + 1))
        return p, page, changed

    def test_each_route_steps_and_clears_on_its_own(self) -> None:
        p, page, changed = self._page()
        p.on_action('step', {'delta': 1})
        self.assertEqual((p.route.next_index, p.carrier_route.next_index), (1, 1))
        p.on_action('step', {'delta': 1, 'slot': 'carrier'})
        self.assertEqual((p.route.next_index, p.carrier_route.next_index), (1, 2))
        p.on_action('clear', {'slot': 'carrier'})
        self.assertTrue(p.carrier_route.empty)
        self.assertFalse(p.route.empty)
        self.assertEqual(changed, {'ship': 1, 'carrier': 2})
        self.assertIsNone(page.state['carrierRoute'])
        self.assertEqual(page.state['route']['type'], 'neutron')

    def test_publishes_both_routes(self) -> None:
        p, page, _ = self._page()
        p.push()
        self.assertEqual(page.state['carrierRoute']['type'], 'carrier')
        self.assertEqual(page.state['carrierRoute']['next'], 'Alioth')
        self.assertEqual(page.state['route']['next'], 'Sol')
        self.assertFalse(page.state['plotting'])
        self.assertFalse(page.state['carrierPlotting'])


if __name__ == '__main__':
    unittest.main()
