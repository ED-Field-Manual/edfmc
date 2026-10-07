"""
Tests for the Python plugin host.

Run with `python -m unittest discover -s tests` from `plugin-host`. Journal
lines are verbatim from a real commander's journal (2026-10-05).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

_TMP = tempfile.mkdtemp(prefix='edfmc-host-test-')
os.environ['EDFMC_DATA_DIR'] = os.path.join(_TMP, 'data')
os.environ['EDFMC_PLUGIN_DIR'] = os.path.join(_TMP, 'plugins')
os.environ['EDFMC_JOURNAL_DIR'] = os.path.join(_TMP, 'journal')
sys.path.insert(0, os.path.join(ROOT, 'compat'))
sys.path.insert(0, ROOT)

import host  # noqa: E402
from config import config  # noqa: E402
from monitor import monitor  # noqa: E402

LOADGAME = '{ "timestamp":"2026-10-05T23:06:39Z", "event":"LoadGame", "FID":"F8240321", "Commander":"Sythan", "Horizons":true, "Odyssey":true, "Ship":"Corsair", "ShipID":18, "ShipName":"Void Revenant", "ShipIdent":"BS-VR1", "FuelLevel":32.000000, "FuelCapacity":32.000000, "GameMode":"Solo", "Credits":2275663689, "Loan":0, "language":"English/UK", "gameversion":"4.4.1.1", "build":"r332841/r0 " }'
CARGO = '{ "timestamp":"2026-10-05T23:07:49Z", "event":"Cargo", "Vessel":"Ship", "Count":5, "Inventory":[ { "Name":"foodcartridges", "Name_Localised":"Food Cartridges", "Count":1, "Stolen":0 }, { "Name":"occupiedcryopod", "Name_Localised":"Occupied Escape Pod", "Count":1, "Stolen":0 }, { "Name":"drones", "Name_Localised":"Limpet", "Count":3, "Stolen":0 } ] }'
DOCKED = '{ "timestamp":"2026-10-05T23:20:18Z", "event":"Docked", "StationName":"Ribeiro Landing", "StationType":"CraterOutpost", "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe VN-L b49-6", "SystemAddress":13871536743849, "MarketID":4319377155, "StationFaction":{ "Name":"Wolf 406 Transport & Co" } }'


class MonitorTest(unittest.TestCase):
    def setUp(self) -> None:
        monitor.fold({'event': 'Fileheader', 'gameversion': '4.4.1.1', 'build': 'r332841/r0 '})

    def test_loadgame_sets_commander_and_ship(self) -> None:
        monitor.fold(json.loads(LOADGAME))
        self.assertEqual(monitor.cmdr, 'Sythan')
        self.assertEqual(monitor.state['FID'], 'F8240321')
        self.assertEqual(monitor.state['ShipType'], 'corsair')
        self.assertTrue(monitor.state['Odyssey'])
        self.assertEqual(monitor.state['GameVersion'], '4.4.1.1')
        self.assertFalse(monitor.is_beta)

    def test_cargo_counts_by_lowercase_name(self) -> None:
        monitor.fold(json.loads(CARGO))
        self.assertEqual(monitor.state['Cargo'], {'foodcartridges': 1, 'occupiedcryopod': 1, 'drones': 3})

    def test_docked_then_undocked(self) -> None:
        monitor.fold(json.loads(DOCKED))
        self.assertEqual(monitor.station, 'Ribeiro Landing')
        self.assertEqual(monitor.state['MarketID'], 4319377155)
        self.assertTrue(monitor.state['IsDocked'])
        monitor.fold({'event': 'Undocked', 'StationName': 'Ribeiro Landing'})
        self.assertIsNone(monitor.station)
        self.assertFalse(monitor.state['IsDocked'])

    def test_snapshot_cannot_change_the_real_state(self) -> None:
        monitor.fold(json.loads(CARGO))
        snap = monitor.snapshot()
        snap['Cargo']['drones'] = 99
        self.assertEqual(monitor.state['Cargo']['drones'], 3)


class ConfigTest(unittest.TestCase):
    def test_round_trip_and_types(self) -> None:
        config.set('test_str', 'hello')
        config.set('test_int', 5)
        config.set('test_list', ['a', 'b'])
        reread = type(config)()
        self.assertEqual(reread.get_str('test_str'), 'hello')
        self.assertEqual(reread.get_int('test_int'), 5)
        self.assertEqual(reread.get_list('test_list'), ['a', 'b'])
        self.assertEqual(reread.get_int('missing', default=7), 7)
        self.assertIsNone(reread.get_str('missing'))

    def test_delete(self) -> None:
        config.set('gone', 1)
        config.delete('gone')
        self.assertEqual(config.get_int('gone', default=-1), -1)
        config.delete('gone', suppress=True)


class LoadingTest(unittest.TestCase):
    def _plugin(self, folder: str, files: dict[str, str]) -> host.Plugin:
        path = os.path.join(config.plugin_dir_path, folder)
        os.makedirs(path, exist_ok=True)
        for rel, text in files.items():
            full = os.path.join(path, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, 'w', encoding='utf-8') as f:
                f.write(textwrap.dedent(text))
        return host.Plugin(folder, path)

    def test_package_inside_a_same_named_folder(self) -> None:
        # SpanshRouter's layout: plugins/SpanshRouter/SpanshRouter/__init__.py,
        # whose __init__ imports a sibling module by the package name.
        plugin = self._plugin('Nested', {
            'load.py': '''
                from Nested.Inner import NAME
                def plugin_start3(plugin_dir):
                    return NAME
            ''',
            'Nested/__init__.py': 'from Nested.helper import VALUE\n',
            'Nested/helper.py': 'VALUE = 1\n',
            'Nested/Inner.py': 'NAME = "Nested plugin"\n',
        })
        if config.plugin_dir_path not in sys.path:
            sys.path.append(config.plugin_dir_path)
        host.load(plugin)
        self.assertIsNone(plugin.error)
        self.assertEqual(plugin.name, 'Nested plugin')

    def test_old_interface_is_refused_with_a_reason(self) -> None:
        plugin = self._plugin('Old', {'load.py': 'def plugin_start(plugin_dir):\n    return "Old"\n'})
        host.load(plugin)
        self.assertIsNone(plugin.module)
        self.assertIn('plugin_start3', plugin.error)

    def test_a_failing_hook_is_contained(self) -> None:
        plugin = self._plugin('Broken', {
            'load.py': '''
                def plugin_start3(plugin_dir):
                    return "Broken"
                def journal_entry(cmdr, is_beta, system, station, entry, state):
                    raise RuntimeError("boom")
            ''',
        })
        host.load(plugin)
        self.assertIsNone(plugin.call('journal_entry', 'c', False, None, None, {}, {}))

    def test_describe_reports_what_the_plugin_states(self) -> None:
        # ConstructionTracker states `plugin_version`; SpanshRouter keeps a
        # bare version string in version.json. Both are real layouts.
        stated = self._plugin('Stated', {
            'load.py': 'plugin_version = "1.4.0"\ndef plugin_start3(d):\n    return "Stated"\ndef plugin_prefs(p, c, b):\n    return None\n',
            'README.md': '# Stated\nHow to use it.\n',
        })
        host.load(stated)
        info = stated.describe()
        self.assertEqual(info['version'], '1.4.0')
        self.assertTrue(info['hasSettings'])
        self.assertFalse(info['hasPanel'])
        self.assertIn('How to use it.', info['readme'])

        in_file = self._plugin('InFile', {'load.py': 'def plugin_start3(d):\n    return "InFile"\n', 'version.json': '3.1.0'})
        host.load(in_file)
        self.assertEqual(in_file.describe()['version'], '3.1.0')

        silent = self._plugin('Silent', {'load.py': 'def plugin_start3(d):\n    return "Silent"\n'})
        host.load(silent)
        self.assertIsNone(silent.describe()['version'])
        self.assertIsNone(silent.describe()['readme'])

    def test_discovery_skips_disabled_and_hidden(self) -> None:
        self._plugin('Skip.disabled', {'load.py': ''})
        self._plugin('.hidden', {'load.py': ''})
        self._plugin('NoLoad', {'readme.txt': ''})
        folders = [p.folder for p in host.discover(config.plugin_dir_path)]
        self.assertNotIn('Skip.disabled', folders)
        self.assertNotIn('.hidden', folders)
        self.assertNotIn('NoLoad', folders)


class ResponsiveTest(unittest.TestCase):
    """SpanshRouter's Plot Route sleeps on the main thread while Spansh works."""

    def test_sleep_keeps_the_window_responding_and_still_waits(self) -> None:
        import time
        import tkinter as tk

        root = tk.Tk()
        root.withdraw()
        real_sleep = time.sleep
        try:
            host.Responsive(root).install()
            fired = []
            root.after(20, lambda: fired.append(True))
            start = time.monotonic()
            time.sleep(0.3)
            self.assertGreaterEqual(time.monotonic() - start, 0.29)
            self.assertEqual(fired, [True])  # an event ran during the wait
        finally:
            time.sleep = real_sleep
            root.destroy()


class EdfmcModuleTest(unittest.TestCase):
    """What a plugin gets from `import edfmc` (Router uses it for the overlay)."""

    def test_publish_reaches_the_app_as_plain_json(self) -> None:
        import edfmc
        import host_bridge
        sent = []
        host_bridge.set_publish_handler(lambda topic, data: sent.append((topic, data)))
        edfmc.publish('route', {'next': 'Achenar', 'jumpsLeft': 4})
        self.assertEqual(sent, [('route', {'next': 'Achenar', 'jumpsLeft': 4})])
        with self.assertRaises(TypeError):
            edfmc.publish('route', {'not json': object()})


class NativePageTest(unittest.TestCase):
    """A plugin can have its tab drawn by the app instead of by tkinter."""

    def test_register_page_marks_the_plugin_native_and_routes_actions(self) -> None:
        import host_bridge
        path = os.path.join(config.plugin_dir_path, 'Native')
        os.makedirs(path, exist_ok=True)
        with open(os.path.join(path, 'load.py'), 'w', encoding='utf-8') as f:
            f.write(textwrap.dedent('''
                import edfmc
                seen = []
                def plugin_start3(plugin_dir):
                    global page
                    page = edfmc.register_page(lambda name, args: seen.append((name, args)))
                    return 'Native'
                def plugin_app(parent):
                    raise AssertionError('a native plugin gets no tkinter panel')
            '''))
        plugin = host.Plugin('Native', path)
        host.load(plugin)
        self.assertTrue(plugin.native)
        self.assertTrue(plugin.describe()['native'])

        updates = []
        host_bridge.set_page_handler(lambda folder, state: updates.append((folder, state)))
        plugin.module.page.update({'kind': 'test', 'n': 1})
        self.assertEqual(updates, [('Native', {'kind': 'test', 'n': 1})])

        host_bridge.pages['Native']('plot', {'to': 'Colonia'})
        self.assertEqual(plugin.module.seen, [('plot', {'to': 'Colonia'})])

    def test_register_page_outside_start_is_refused(self) -> None:
        import edfmc
        with self.assertRaises(RuntimeError):
            edfmc.register_page(lambda n, a: None)


class TailTest(unittest.TestCase):
    def test_primes_without_delivering_then_delivers_new_lines(self) -> None:
        jdir = os.path.join(_TMP, 'tail')
        os.makedirs(jdir, exist_ok=True)
        path = os.path.join(jdir, 'Journal.2026-10-05T180552.01.log')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(LOADGAME + '\n')
        tail = host.JournalTail(jdir)
        tail.prime()
        self.assertEqual(monitor.cmdr, 'Sythan')
        self.assertEqual(tail.poll(), [])

        with open(path, 'a', encoding='utf-8') as f:
            f.write(CARGO + '\n' + DOCKED[:40])  # a line still being written
        self.assertEqual([e['event'] for e in tail.poll()], ['Cargo'])

        with open(path, 'a', encoding='utf-8') as f:
            f.write(DOCKED[40:] + '\n')
        self.assertEqual([e['event'] for e in tail.poll()], ['Docked'])

    def test_switches_to_a_newer_journal(self) -> None:
        jdir = os.path.join(_TMP, 'rotate')
        os.makedirs(jdir, exist_ok=True)
        with open(os.path.join(jdir, 'Journal.2026-10-05T131650.01.log'), 'w', encoding='utf-8') as f:
            f.write(LOADGAME + '\n')
        tail = host.JournalTail(jdir)
        tail.prime()
        with open(os.path.join(jdir, 'Journal.2026-10-05T180552.01.log'), 'w', encoding='utf-8') as f:
            f.write(CARGO + '\n')
        self.assertEqual([e['event'] for e in tail.poll()], ['Cargo'])


if __name__ == '__main__':
    unittest.main()
