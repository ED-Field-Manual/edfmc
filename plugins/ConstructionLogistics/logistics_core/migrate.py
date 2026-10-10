"""
Bring existing construction data in, once, without changing its source.

EDFMC's old Logistics page kept sites in the `construction_sites` table of the
app's database. They are read once, read-only (SQLite `mode=ro`), for this
commander's rows only -- exactly the rows that page showed them. The table is
never written to or deleted.

Imported values are marked `imported` and give way to the journal: the next
depot snapshot for a site replaces its materials. A site that already exists
here keeps what it has; an import only fills gaps.
"""

from __future__ import annotations

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
