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


if __name__ == '__main__':
    unittest.main()
