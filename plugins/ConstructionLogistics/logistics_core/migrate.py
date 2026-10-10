"""
Bring existing construction data in, once, without changing its source.

Two places can hold a commander's construction data already:

1. **EDFMC's old Logistics page**, in the `construction_sites` table of the
   app's database. Read once, read-only (SQLite `mode=ro`), for this
   commander's rows only -- exactly the rows that page showed them. The table
   is never written to or deleted, so the import can always be run again.
2. **The EDMC Construction Tracker plugin**, in `construction_tracker_data.json`
   in its own folder (in EDFMC's plugins folder, or EDMC's). Read once, never
   modified. Its carrier counts include the carrier bar's Odyssey goods from
   FCMaterials.json (Weapon Schematic, Atmospheric Data and the like), which
   are not construction commodities; only commodities some site needs are
   taken.

Imported values are marked `imported` and give way to the journal: the next
depot snapshot for a site replaces its materials, and the next transfer or
CarrierStats updates the carrier. A site that already exists here keeps what
it has; an import only fills gaps.
"""

from __future__ import annotations

import glob
import json
import os
import sqlite3
from typing import Any

from .tracker import _new_site


def _site_from_import(state: dict[str, Any], market_id: str, at: str) -> tuple[dict[str, Any], bool]:
    existing = state['sites'].get(market_id)
    if existing is not None:
        return existing, False
    site = _new_site(market_id, at)
    state['sites'][market_id] = site
    return site, True


def from_edfmc_database(state: dict[str, Any], db_path: str, fid: str | None, now: str) -> int:
    """Sites from EDFMC's old Logistics page. Returns how many were added."""
    if not fid or not os.path.isfile(db_path):
        return 0
    uri = 'file:' + db_path.replace('\\', '/') + '?mode=ro'
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=2)
    except sqlite3.Error:
        return 0
    try:
        rows = conn.execute(
            'SELECT market_id, progress, complete, failed, resources, name, priority, updated_at, first_seen_at '
            'FROM construction_sites WHERE commander_fid = ?', (fid,)).fetchall()
    except sqlite3.Error:
        return 0  # no such table: an install that never had the page
    finally:
        conn.close()

    added = 0
    for market_id, progress, complete, failed, resources, name, priority, updated_at, first_seen in rows:
        site, new = _site_from_import(state, str(market_id), first_seen or now)
        if name and site['name'] is None:
            # On that page a name could only have been typed by the commander.
            site['name'] = {'value': name, 'source': 'user'}
        if priority and site.get('source') != 'journal':
            site['priority'] = int(priority)
        if new:
            try:
                parsed = json.loads(resources) if resources else []
            except ValueError:
                parsed = []
            site.update({
                'resources': [
                    {'commodity': r['commodity'], 'label': r.get('label') or r['commodity'],
                     'journalName': r.get('journalName'), 'required': int(r.get('required') or 0),
                     'provided': int(r.get('provided') or 0), 'payment': r.get('payment')}
                    for r in parsed if isinstance(r, dict) and r.get('commodity')
                ],
                'progress': progress,
                'complete': bool(complete),
                'failed': bool(failed),
                'updatedAt': updated_at,
                'source': 'imported',
            })
            added += 1
    return added


def tracker_files(plugin_dir: str) -> list[str]:
    """Where the EDMC Construction Tracker may have left its data."""
    found = glob.glob(os.path.join(plugin_dir, '*', 'construction_tracker_data.json'))
    local = os.environ.get('LOCALAPPDATA')
    if local:
        found += glob.glob(os.path.join(local, 'EDMarketConnector', 'plugins', '*', 'construction_tracker_data.json'))
    # Newest first, so the most recently used copy wins.
    return sorted(set(found), key=lambda p: -os.path.getmtime(p))


def from_edmc_tracker(state: dict[str, Any], path: str, now: str) -> dict[str, int]:
    """Sites, selection and carrier capacity from the EDMC Construction Tracker."""
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    if not isinstance(data, dict):
        return {'sites': 0, 'carrier': 0, 'skipped': 0}

    added = 0
    needed: set[str] = set()
    for key, raw in (data.get('construction_sites') or {}).items():
        if not isinstance(raw, dict):
            continue
        market_id = str(raw.get('market_id') or key)
        site, new = _site_from_import(state, market_id, now)
        name = raw.get('site_name') or raw.get('display_name')
        if name and site['name'] is None:
            site['name'] = {'value': name, 'source': 'imported'}
        if raw.get('site_type') and site['siteType'] is None:
            site['siteType'] = {'value': raw['site_type'], 'source': 'imported'}
        if raw.get('system') and site['system'] is None:
            site['system'] = {'value': raw['system'], 'source': 'imported'}
        materials = [m for m in raw.get('materials') or [] if isinstance(m, dict) and m.get('name_key')]
        needed.update(str(m['name_key']).lower() for m in materials)
        if new:
            site.update({
                'resources': [
                    {'commodity': str(m['name_key']).lower(), 'label': m.get('name') or m['name_key'],
                     'journalName': None, 'required': int(m.get('required') or 0),
                     'provided': int(m.get('provided') or 0), 'payment': None}
                    for m in materials
                ],
                'progress': raw.get('progress'),
                'complete': bool(raw.get('complete')),
                'failed': bool(raw.get('failed')),
                'updatedAt': None,
                'source': 'imported',
            })
            added += 1

    selected = data.get('selected_site_id')
    if state.get('selectedSite') is None and selected is not None and str(selected) in state['sites']:
        state['selectedSite'] = str(selected)

    carrier = state['carrier']
    if carrier.get('capacity') is None and isinstance(data.get('carrier_total_capacity'), int):
        carrier['capacity'] = data['carrier_total_capacity']
    if carrier.get('freeSpace') is None and isinstance(data.get('carrier_free_space'), int):
        carrier['freeSpace'] = data['carrier_free_space']

    # Only construction commodities: the tracker's carrier list mixes in the
    # carrier bar's micro-resources from FCMaterials.json.
    taken = skipped = 0
    for symbol, amount in (data.get('carrier_cargo') or {}).items():
        symbol = str(symbol).lower()
        if symbol not in needed or not isinstance(amount, int):
            skipped += 1
            continue
        if symbol not in carrier['cargo']:
            carrier['cargo'][symbol] = {'amount': max(0, amount), 'source': 'imported', 'updatedAt': now}
            taken += 1
    if 'hide_completed_materials' in data and 'hideCompletedImported' not in state['imports']:
        state['prefs']['hideCompleted'] = bool(data['hide_completed_materials'])
        state['imports']['hideCompletedImported'] = True
    return {'sites': added, 'carrier': taken, 'skipped': skipped}
