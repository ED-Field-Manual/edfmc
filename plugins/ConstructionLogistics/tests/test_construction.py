"""
Construction Logistics, driven the way the host drives it.

Journal lines are the shape of real ones from the corpus (MarketIDs and names of
places are the game's; Frontier IDs and commander names are invented, because
fixtures are public). Run from the plugin folder:

    python -m unittest discover -s tests
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from logistics_core import hauling, store, tracker, views  # noqa: E402
from logistics_core.app import Controller  # noqa: E402
from logistics_core.market import request_body  # noqa: E402

SITE = 4387351555
OTHER = 3962061570
CARRIER = 3703420416


def depot(at, market=SITE, provided=3708, steel=(5000, 1000), complete=False, progress=0.58997):
    return {'timestamp': at, 'event': 'ColonisationConstructionDepot', 'MarketID': market,
            'ConstructionProgress': progress, 'ConstructionComplete': complete, 'ConstructionFailed': False,
            'ResourcesRequired': [
                {'Name': '$aluminium_name;', 'Name_Localised': 'Aluminium', 'RequiredAmount': 7047,
                 'ProvidedAmount': provided, 'Payment': 3239},
                {'Name': '$Steel_name;', 'Name_Localised': 'Steel', 'RequiredAmount': steel[0],
                 'ProvidedAmount': steel[1], 'Payment': 5057},
                {'Name': '$buildingfabricators_name;', 'Name_Localised': 'Building Fabricators',
                 'RequiredAmount': 407, 'ProvidedAmount': 407, 'Payment': 3800},
            ]}


def docked(at, market=SITE, name='Planetary Construction Site: Scholz Landing', kind='PlanetaryConstructionDepot'):
    return {'timestamp': at, 'event': 'Docked', 'StationName': name, 'StationType': kind,
            'StarSystem': 'Wregoe KO-G c24-7', 'MarketID': market}


def contribution(at, amount=264, market=SITE, name='$aluminium_name;'):
    return {'timestamp': at, 'event': 'ColonisationContribution', 'MarketID': market,
            'Contributions': [{'Name': name, 'Name_Localised': 'Aluminium', 'Amount': amount}]}


def transfer(at, count, direction, kind='steel'):
    return {'timestamp': at, 'event': 'CargoTransfer', 'Transfers': [{'Type': kind, 'Count': count, 'Direction': direction}]}


def cargo(at, items):
    return {'timestamp': at, 'event': 'Cargo', 'Vessel': 'Ship', 'Count': sum(items.values()),
            'Inventory': [{'Name': k, 'Count': v, 'Stolen': 0} for k, v in items.items()]}


GAME_A = {'FID': 'F0000001', 'Commander': 'Alpha', 'StarPos': (1.0, 2.0, 3.0)}
GAME_B = {'FID': 'F0000002', 'Commander': 'Bravo'}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = os.path.join(self.tmp.name, 'plugin-data', 'ConstructionLogistics')
        self.plugins = os.path.join(self.tmp.name, 'plugins')
        self.journal = os.path.join(self.tmp.name, 'journal')
        for d in (self.data, self.plugins, self.journal):
            os.makedirs(d)
        self.pages, self.overlays, self.later = [], [], []
        # Never read this machine's real EDMC plugins folder.
        self._local = os.environ.get('LOCALAPPDATA')
        os.environ['LOCALAPPDATA'] = self.tmp.name

    def tearDown(self):
        if self._local is None:
            os.environ.pop('LOCALAPPDATA', None)
        else:
            os.environ['LOCALAPPDATA'] = self._local
        self.tmp.cleanup()

    def controller(self, fetcher=None, edfmc_db=None):
        c = Controller(data_dir=self.data, plugin_dir=self.plugins, journal_dir=self.journal, edfmc_db=edfmc_db,
                       user_agent='test', show_page=self.pages.append, show_overlay=self.overlays.append,
                       schedule=lambda ms, fn: self.later.append(fn),
                       fetcher=fetcher or (lambda body, agent: []), threaded=False)
        return c

    def feed(self, c, *entries, game=GAME_A):
        for e in entries:
            c.journal_entry(e, game)


class Tracking(Base):
    def test_site_from_a_depot_report_named_by_the_dock(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, docked('2026-10-09T18:00:00Z'), depot('2026-10-09T18:00:05Z'))
        site = c.state['sites'][str(SITE)]
        self.assertEqual(site['name'], {'value': 'Scholz Landing', 'source': 'journal'})
        self.assertEqual(site['siteType']['value'], 'Planetary Construction Site')
        self.assertEqual(site['system']['value'], 'Wregoe KO-G c24-7')
        self.assertEqual([r['commodity'] for r in site['resources']], ['aluminium', 'steel', 'buildingfabricators'])
        rows = {r['commodity']: r for r in hauling.material_rows(c.state, site)}
        self.assertEqual(rows['aluminium']['remaining'], 7047 - 3708)
        self.assertEqual(rows['buildingfabricators']['status'], 'done')

    def test_colonisation_ship_and_finished_station_names(self):
        self.assertEqual(tracker.parse_station('$EXT_PANEL_ColonisationShip; Egerton Enterprise', 'SurfaceStation'),
                         ('Egerton Enterprise', 'Colonisation ship'))
        self.assertEqual(tracker.parse_station('Orbital Construction Site: Salk Relay', 'SpaceConstructionDepot'),
                         ('Salk Relay', 'Orbital Construction Site'))
        self.assertEqual(tracker.parse_station('Altieri Collection', 'CraterOutpost'),
                         ('Altieri Collection', 'Crater outpost'))

    def test_a_name_the_commander_typed_survives_docking(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, depot('2026-10-09T18:00:05Z'))
        c.on_action('renameSite', {'value': 'Home base'})
        self.feed(c, docked('2026-10-09T19:00:00Z'), depot('2026-10-09T19:00:05Z'))
        self.assertEqual(c.state['sites'][str(SITE)]['name'], {'value': 'Home base', 'source': 'user'})

    def test_an_older_snapshot_never_replaces_a_newer_one(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, depot('2026-10-09T19:00:00Z', provided=5000), depot('2026-10-09T18:00:00Z', provided=1000))
        self.assertEqual(c.state['sites'][str(SITE)]['resources'][0]['provided'], 5000)

    def test_a_contribution_counts_once_and_the_next_snapshot_settles_it(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, depot('2026-10-09T18:00:00Z', provided=3708))
        line = contribution('2026-10-09T18:05:00Z', 264)
        self.feed(c, line, line)  # replayed or delivered twice
        self.assertEqual(c.state['sites'][str(SITE)]['resources'][0]['provided'], 3708 + 264)
        # The game's own total afterwards wins, whatever it says.
        self.feed(c, depot('2026-10-09T18:05:01Z', provided=3972))
        self.assertEqual(c.state['sites'][str(SITE)]['resources'][0]['provided'], 3972)

    def test_a_contribution_older_than_the_snapshot_is_already_in_it(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, depot('2026-10-09T18:06:00Z', provided=3972), contribution('2026-10-09T18:05:00Z', 264))
        self.assertEqual(c.state['sites'][str(SITE)]['resources'][0]['provided'], 3972)

    def test_buying_is_not_delivering(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, depot('2026-10-09T18:00:00Z'),
                  {'timestamp': '2026-10-09T18:10:00Z', 'event': 'MarketBuy', 'Type': 'steel', 'Count': 700},
                  cargo('2026-10-09T18:10:00Z', {'steel': 700}))
        site = c.state['sites'][str(SITE)]
        self.assertEqual(site['resources'][1]['provided'], 1000)
        steel = next(r for r in hauling.material_rows(c.state, site) if r['commodity'] == 'steel')
        self.assertEqual((steel['ship'], steel['remaining'], steel['toSource']), (700, 4000, 3300))

    def test_unrecognised_and_missing_data_is_skipped_not_guessed(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, {'timestamp': '2026-10-09T18:00:00Z', 'event': 'ColonisationConstructionDepot'})
        self.assertEqual(c.state['sites'], {})
        odd = depot('2026-10-09T18:00:00Z')
        odd['ResourcesRequired'].append({'Name': 'Not A Symbol!', 'RequiredAmount': 5, 'ProvidedAmount': 0})
        self.feed(c, odd)
        self.assertEqual(len(c.state['sites'][str(SITE)]['resources']), 3)


class Carrier(Base):
    def test_transfers_move_the_estimate_once_each_and_never_below_zero(self):
        c = self.controller()
        c.start(GAME_A)
        line = transfer('2026-10-03T03:12:29Z', 358, 'tocarrier')
        self.feed(c, line, line, transfer('2026-10-03T03:13:00Z', 1000, 'toship'))
        # Never below zero, and with no count given it stays a lower bound, not a count.
        self.assertEqual(c.state['carrier']['cargo']['steel'], {'amount': 0, 'source': 'estimated', 'known': False,
                                                                'updatedAt': '2026-10-03T03:13:00Z'})

    def test_an_unknown_carrier_is_never_shown_as_empty(self):
        # The case reported: 4,944 t of titanium on the carrier's transfer screen,
        # 0 in the plugin, which then said to buy titanium.
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, depot('2026-10-09T18:00:00Z'))
        site = c.state['sites'][str(SITE)]
        steel = next(r for r in hauling.material_rows(c.state, site) if r['commodity'] == 'steel')
        self.assertEqual((steel['carrierKnown'], steel['carrierText']), (False, '?'))
        self.assertIn("isn't known", json.dumps(self.pages[-1]))
        # Moving some there proves at least that much.
        self.feed(c, transfer('2026-10-09T18:01:00Z', 358, 'tocarrier'))
        steel = next(r for r in hauling.material_rows(c.state, site) if r['commodity'] == 'steel')
        self.assertEqual(steel['carrierText'], '≥ 358')
        # A count given once is kept current by transfers, and is a count from then on.
        c.on_action('setCarrier', {'row': 'steel', 'value': 4944})
        self.feed(c, transfer('2026-10-09T18:02:00Z', 1000, 'toship'))
        steel = next(r for r in hauling.material_rows(c.state, site) if r['commodity'] == 'steel')
        self.assertEqual((steel['carrierKnown'], steel['carrierText'], steel['carrier']), (True, '3,944', 3944))
        self.assertNotIn("isn't known for 2", json.dumps(self.pages[-1]))

    def test_carrier_stats_are_journal_confirmed(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, {'timestamp': '2026-10-09T18:00:00Z', 'event': 'CarrierStats', 'CarrierID': CARRIER,
                      'Callsign': 'HBN-TXN', 'Name': 'PFC ATLAS UNBOUND',
                      'SpaceUsage': {'TotalCapacity': 25000, 'Cargo': 18096, 'FreeSpace': 5634}})
        carrier = c.state['carrier']
        self.assertEqual((carrier['capacity'], carrier['freeSpace'], carrier['callsign']), (25000, 5634, 'HBN-TXN'))

    def test_a_typed_count_replaces_the_estimate(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, depot('2026-10-09T18:00:00Z'), transfer('2026-10-09T18:01:00Z', 100, 'tocarrier'))
        c.on_action('setCarrier', {'row': 'steel', 'value': 2500})
        self.assertEqual(c.state['carrier']['cargo']['steel']['source'], 'user')
        steel = next(r for r in hauling.material_rows(c.state, c.state['sites'][str(SITE)]) if r['commodity'] == 'steel')
        self.assertEqual((steel['carrier'], steel['toSource']), (2500, 1500))


class Commanders(Base):
    def test_each_commander_has_their_own_file_and_nothing_crosses(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, depot('2026-10-09T18:00:00Z'), game=GAME_A)
        self.feed(c, {'timestamp': '2026-10-09T19:00:00Z', 'event': 'Commander', 'FID': 'F0000002', 'Name': 'Bravo'},
                  game=GAME_B)
        self.assertEqual(c.state['sites'], {})
        self.feed(c, depot('2026-10-09T19:05:00Z', market=OTHER), game=GAME_B)
        self.feed(c, {'timestamp': '2026-10-09T20:00:00Z', 'event': 'Music'}, game=GAME_A)
        self.assertEqual(list(c.state['sites']), [str(SITE)])
        files = sorted(os.listdir(self.data))
        self.assertEqual(files, ['cmdr-F0000001.json', 'cmdr-F0000002.json'])

    def test_a_restart_restores_state_and_does_not_reapply_deltas(self):
        c = self.controller()
        c.start(GAME_A)
        line = transfer('2026-10-09T18:01:00Z', 100, 'tocarrier')
        self.feed(c, depot('2026-10-09T18:00:00Z'), line)
        c.stop()
        again = self.controller()
        again.start(GAME_A)
        self.feed(again, line)
        self.assertEqual(again.state['carrier']['cargo']['steel']['amount'], 100)
        self.assertIn(str(SITE), again.state['sites'])

    def test_a_corrupt_file_is_kept_aside_not_overwritten(self):
        with open(store.file_for(self.data, 'F0000001'), 'w') as f:
            f.write('{not json')
        c = self.controller()
        c.start(GAME_A)
        self.assertEqual(c.state['sites'], {})
        self.assertTrue(os.path.exists(store.file_for(self.data, 'F0000001') + '.corrupt'))


class Planning(Base):
    def setUp(self):
        super().setUp()
        self.c = self.controller()
        self.c.start(GAME_A)
        self.feed(self.c, {'timestamp': '2026-10-09T17:00:00Z', 'event': 'Loadout', 'CargoCapacity': 784},
                  depot('2026-10-09T18:00:00Z'), cargo('2026-10-09T18:01:00Z', {'steel': 300, 'drones': 16}),
                  transfer('2026-10-09T18:02:00Z', 1000, 'tocarrier', 'aluminium'))

    def test_load_plan_takes_from_the_carrier_first_and_fits_the_hold(self):
        plan = hauling.load_plan(self.c.state)
        self.assertEqual(plan['capacity'], 784)
        self.assertEqual(plan['aboard'], 316)
        self.assertEqual(plan['freeBefore'], 468)
        self.assertEqual(plan['planned'], 468)
        first = plan['lines'][0]
        # Aluminium (3,339 left) outranks steel (3,700 left after the 300 aboard)? No: largest first at equal priority.
        self.assertEqual(first['commodity'], 'steel')
        self.c.on_action('setPriority', {'row': 'aluminium', 'value': 1})
        plan = hauling.load_plan(self.c.state)
        self.assertEqual(plan['lines'][0], {'commodity': 'aluminium', 'label': 'Aluminium', 'fromCarrier': 468,
                                            'buy': 0, 'total': 468, 'priority': 1, 'carrierKnown': False})

    def test_after_delivery_is_a_projection_not_a_change(self):
        site = self.c.state['sites'][str(SITE)]
        rows = {r['commodity']: r for r in hauling.after_delivery(self.c.state, site)}
        self.assertEqual(rows['steel']['after'], 4000 - 300)
        self.assertEqual(site['resources'][1]['provided'], 1000)

    def test_stock_is_shared_by_priority_not_counted_twice(self):
        self.feed(self.c, depot('2026-10-09T18:03:00Z', market=OTHER, steel=(500, 0)))
        self.c.state['sites'][str(OTHER)]['priority'] = 2
        alloc = hauling.allocations(self.c.state)['steel']
        self.assertEqual(alloc[str(SITE)]['ship'], 300)
        self.assertNotIn(str(OTHER), alloc)

    def test_sourcing_asks_only_for_what_is_still_to_source(self):
        seen = {}

        def fetch(body, agent):
            seen.update(body)
            return [{'marketId': '1', 'stationName': 'Ray Gateway', 'systemName': 'Diaguandri', 'systemAddress': '1',
                     'distanceLy': 12.5, 'arrivalDistanceLs': 20, 'isPlanetary': False, 'isFleetCarrier': False,
                     'offers': [{'commodity': 'steel', 'stock': 90000, 'buyPrice': 300,
                                 'observedAt': '2999-01-01T00:00:00Z'}]}]

        self.c.fetcher = fetch
        self.c.on_action('source', {})
        self.assertEqual(sorted(seen['commodities']), ['aluminium', 'steel'])
        self.assertEqual(seen['origin'], {'x': 1.0, 'y': 2.0, 'z': 3.0})
        result = self.c.state['sourcing']['result']
        self.assertEqual(result['stops'][0]['station']['stationName'], 'Ray Gateway')
        # Steel: 4,000 left, 300 aboard -> 3,700 bought. Aluminium: nobody sells it here.
        self.assertEqual(result['stops'][0]['purchases'][0]['amount'], 3700)
        self.assertEqual([u['commodity'] for u in result['unfulfilled']], ['aluminium'])

        # Limited to the hold, one stop buys no more than fits.
        self.c.on_action('setLimitToHold', {'value': True})
        self.c.on_action('source', {})
        self.assertEqual(self.c.state['sourcing']['result']['stops'][0]['purchases'][0]['amount'], 784)

    def test_offline_sourcing_says_so_and_nothing_else_breaks(self):
        def fetch(body, agent):
            raise RuntimeError('The market service could not be reached.')
        self.c.fetcher = fetch
        self.c.on_action('source', {})
        self.assertIn('could not be reached', self.c.state['sourcing']['error'])
        self.assertFalse(self.c.ui['searching'])
        self.assertEqual(self.pages[-1]['kind'], 'ui-v1')

    def test_orbital_only_asks_the_service_to_leave_out_planetary(self):
        body = request_body([{'commodity': 'steel', 'amount': 1}], {'stationPreference': 'orbital-only',
                                                                     'maxAgeHours': 12}, None)
        self.assertIs(body['includePlanetary'], False)
        self.assertNotIn('origin', body)


class Overlay(Base):
    def test_modes_follow_where_the_commander_is(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, depot('2026-10-09T18:00:00Z'), cargo('2026-10-09T18:01:00Z', {'steel': 300}))
        self.assertEqual(views.overlay_mode(c.state), 'hauling')
        self.assertIn('Hauling for', self.overlays[-1]['blocks'][0]['text'])
        self.feed(c, docked('2026-10-09T18:10:00Z'))
        self.assertEqual(views.overlay_mode(c.state), 'delivery')
        delivery = self.overlays[-1]
        self.assertIn('Delivering to', delivery['blocks'][0]['text'])
        self.feed(c, contribution('2026-10-09T18:11:00Z', 300, name='$steel_name;'))
        self.assertIn('Confirmed: 300 t', json.dumps(self.overlays[-1]))
        self.feed(c, {'timestamp': '2026-10-09T18:20:00Z', 'event': 'Undocked'},
                  docked('2026-10-09T18:40:00Z', market=999, name='Ray Gateway', kind='Coriolis'))
        self.assertEqual(views.overlay_mode(c.state), 'shopping')
        c.on_action('setOverlayMode', {'value': 'hauling'})
        self.assertEqual(views.overlay_mode(c.state), 'hauling')

    def _table(self, panel):
        table = next(b for b in panel['blocks'] if b['type'] == 'table')
        return {r['id']: r['cells'] for r in table['rows']}, [col['key'] for col in table['columns']]

    def test_every_view_shows_how_much_more_is_needed_as_it_changes(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, depot('2026-10-09T18:00:00Z'), docked('2026-10-09T18:01:00Z', market=999, name='Ray Gateway',
                                                          kind='Coriolis'))
        rows, cols = self._table(self.overlays[-1])
        self.assertEqual(cols, ['m', 'short', 'ship', 'carrier'])
        self.assertEqual(rows['steel']['short']['text'], '4,000')
        # Buying steel: the hold changes and "To get" falls with it.
        self.feed(c, cargo('2026-10-09T18:02:00Z', {'steel': 784}))
        rows, _ = self._table(self.overlays[-1])
        self.assertEqual((rows['steel']['ship'], rows['steel']['short']['text']), ('784', '3,216'))
        stats = next(b for b in self.overlays[-1]['blocks'] if b['type'] == 'stats')
        self.assertEqual([i['label'] for i in stats['items']], ['Still needed', 'Aboard', 'On carrier', 'Remaining'])

    def test_filling_the_carrier_has_its_own_view(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, {'timestamp': '2026-10-09T17:00:00Z', 'event': 'CarrierStats', 'CarrierID': CARRIER,
                      'Callsign': 'HBN-TXN', 'SpaceUsage': {'TotalCapacity': 25000, 'Cargo': 1000, 'FreeSpace': 24000}},
                  depot('2026-10-09T18:00:00Z'))
        c.on_action('setCarrier', {'row': 'steel', 'value': 1000})
        self.feed(c, docked('2026-10-09T18:05:00Z', market=CARRIER, name='HBN-TXN', kind='FleetCarrier'))
        self.assertEqual(views.overlay_mode(c.state), 'carrier')
        panel = self.overlays[-1]
        self.assertIn('Filling carrier for', panel['blocks'][0]['text'])
        self.assertIn('Carrier free space: 24,000 t', json.dumps(panel))
        rows, cols = self._table(panel)
        self.assertEqual(cols, ['m', 'short', 'carrier', 'ship'])
        self.assertEqual((rows['steel']['carrier'], rows['steel']['short']['text']), ('1,000', '3,000'))
        # Unknown aluminium on the carrier says so, never 0.
        self.assertEqual(rows['aluminium']['carrier'], '?')
        self.assertIn('not known yet', json.dumps(panel))
        # Moving steel from the ship onto the carrier changes where it is, not how much more is needed.
        self.feed(c, cargo('2026-10-09T18:06:00Z', {'steel': 500}))
        self.feed(c, transfer('2026-10-09T18:07:00Z', 500, 'tocarrier'), cargo('2026-10-09T18:07:00Z', {}))
        rows, _ = self._table(self.overlays[-1])
        self.assertEqual((rows['steel']['carrier'], rows['steel']['ship'], rows['steel']['short']['text']),
                         ('1,500', '—', '2,500'))

    def test_a_covered_material_is_ticked_in_words(self):
        c = self.controller()
        c.start(GAME_A)
        self.feed(c, depot('2026-10-09T18:00:00Z'), cargo('2026-10-09T18:01:00Z', {'steel': 4000}))
        rows, _ = self._table(self.overlays[-1])
        self.assertEqual(rows['steel']['short'], {'text': 'covered', 'mark': '✓', 'tone': 'ok'})

    def test_nothing_to_show_hides_the_panel(self):
        c = self.controller()
        c.start(GAME_A)
        self.assertIsNone(self.overlays[-1])
        self.feed(c, depot('2026-10-09T18:00:00Z', complete=True, progress=1.0))
        self.assertIsNone(views.overlay(c.state))


class Migration(Base):
    def test_imports_edfmc_logistics_rows_read_only_for_this_commander(self):
        db = os.path.join(self.tmp.name, 'edfm-companion.db')
        conn = sqlite3.connect(db)
        conn.execute('CREATE TABLE construction_sites (market_id TEXT PRIMARY KEY, progress REAL, complete INTEGER, '
                     'failed INTEGER, resources TEXT, name TEXT, priority INTEGER, updated_at TEXT, first_seen_at TEXT, '
                     'commander_fid TEXT)')
        res = json.dumps([{'commodity': 'steel', 'label': 'Steel', 'journalName': '$steel_name;', 'required': 100,
                           'provided': 40, 'remaining': 60, 'payment': None}])
        conn.execute('INSERT INTO construction_sites VALUES (?,?,?,?,?,?,?,?,?,?)',
                     ('111', 0.4, 0, 0, res, 'My depot', 2, '2026-09-03T12:00:00Z', '2026-09-01T00:00:00Z', 'F0000001'))
        conn.execute('INSERT INTO construction_sites VALUES (?,?,?,?,?,?,?,?,?,?)',
                     ('222', 0.1, 0, 0, res, None, 1, '2026-09-03T12:00:00Z', '2026-09-01T00:00:00Z', 'F0000009'))
        conn.commit()
        conn.close()
        before = os.path.getmtime(db)

        c = self.controller(edfmc_db=db)
        c.start(GAME_A)
        self.assertEqual(list(c.state['sites']), ['111'])
        site = c.state['sites']['111']
        self.assertEqual((site['source'], site['name'], site['priority']), ('imported', {'value': 'My depot', 'source': 'user'}, 2))
        self.assertIn('Imported 1 site', c.state['imports']['edfmc'])
        self.assertEqual(os.path.getmtime(db), before)
        # Once only, and a journal report then takes over.
        c.on_action('removeSite', {'site': '111'})
        c.stop()
        again = self.controller(edfmc_db=db)
        again.start(GAME_A)
        self.assertEqual(again.state['sites'], {})


class Page(Base):
    def test_page_is_plain_ui_v1_json_with_every_section(self):
        c = self.controller()
        c.start(GAME_A)
        self.assertIn('No construction sites yet', json.dumps(self.pages[-1]))
        self.feed(c, docked('2026-10-09T18:00:00Z'), depot('2026-10-09T18:00:05Z'))
        page = json.loads(json.dumps(self.pages[-1]))
        self.assertEqual(page['kind'], 'ui-v1')
        titles = [b['title'] for b in page['blocks'] if b['type'] == 'section']
        self.assertEqual(titles, ['Scholz Landing', 'Materials', 'Plan a trip', 'Where to buy', 'Sites', 'Overlay', 'Data'])
        text = json.dumps(page, ensure_ascii=False)
        self.assertIn("isn't known", text)          # an unknown carrier says so, never 0
        self.assertIn('✓', text)                   # status never relies on colour alone

    def test_cargo_json_is_used_only_when_it_matches_the_event(self):
        c = self.controller()
        c.start(GAME_A)
        with open(os.path.join(self.journal, 'Cargo.json'), 'w') as f:
            json.dump({'timestamp': '2026-10-09T18:00:00Z', 'event': 'Cargo', 'Vessel': 'Ship', 'Count': 5,
                       'Inventory': [{'Name': 'steel', 'Count': 5, 'Stolen': 0}]}, f)
        self.feed(c, {'timestamp': '2026-10-09T18:30:00Z', 'event': 'Cargo', 'Vessel': 'Ship', 'Count': 700})
        self.assertEqual(c.state['ship']['cargo'], {})          # the file is older: not used
        self.assertEqual(len(self.later), 1)                     # asked again shortly
        with open(os.path.join(self.journal, 'Cargo.json'), 'w') as f:
            json.dump({'timestamp': '2026-10-09T18:30:00Z', 'event': 'Cargo', 'Vessel': 'Ship', 'Count': 700,
                       'Inventory': [{'Name': 'steel', 'Count': 700, 'Stolen': 0}]}, f)
        self.later.pop()()
        self.assertEqual(c.state['ship']['cargo'], {'steel': 700})

    def test_a_bad_action_changes_nothing(self):
        c = self.controller()
        c.start(GAME_A)
        before = json.dumps(c.state, sort_keys=True)
        for name, args in [('setHold', {'value': 'lots'}), ('selectSite', {'value': 'nope'}),
                           ('addSite', {'value': 'abc'}), ('unknownAction', {}), ('setMargin', {'value': None})]:
            c.on_action(name, args)
        self.assertEqual(json.dumps(c.state, sort_keys=True), before)


if __name__ == '__main__':
    unittest.main()


class OlderApp(unittest.TestCase):
    """In an EDFM Companion from before plugin API 2 the plugin says so, and tracks nothing."""

    def test_says_it_needs_a_newer_app(self):
        import importlib
        import types
        old = types.ModuleType('edfmc')
        old.register_page = lambda on_action: None  # API 1: pages, but no overlay panels
        sys.modules['edfmc'] = old
        try:
            sys.modules.pop('load', None)
            load = importlib.import_module('load')
            self.assertEqual(load.plugin_start3(ROOT), 'Construction Logistics')
            self.assertIsNone(load._state['controller'])
            load.journal_entry('Alpha', False, None, None, {'event': 'Music'}, {})  # ignored, no error

            class Label(dict):
                pass
            label = Label()
            load._state['label'] = label
            load._refresh_label()
            self.assertIn('needs a newer EDFM Companion', label['text'])
            self.assertFalse(os.path.exists(os.path.join(ROOT, 'data')))
        finally:
            sys.modules.pop('edfmc', None)
            sys.modules.pop('load', None)
