"""
The one authoritative construction state, per commander.

Tracking, planning, the overlay and carrier allocation all read and write this
one record. There is no second copy to drift out of step.

Every value says where it came from, because they are not equally certain:

- **journal**: confirmed by the game (a depot snapshot, a contribution, a dock,
  CarrierStats). Only these change what a site has been given.
- **user**: typed by the commander (a site name, a priority, a carrier count).
- **imported**: brought in from EDFMC's old Logistics page, and shown as such
  until the journal says otherwise.
- **estimated**: carrier cargo kept up to date from CargoTransfer changes. The
  journal never lists a carrier's whole hold, so this is a running estimate.

Plans (load plans, sourcing) are derived and never counted as delivered.

Stored as one JSON file per commander in the plugin's data folder, written to a
temporary file and swapped in, so a crash cannot leave half a file.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from typing import Any

SCHEMA = 1
#: How many recent delta-event keys are kept to refuse a repeat.
SEEN_LIMIT = 2000

DEFAULT_PREFS: dict[str, Any] = {
    'hideCompleted': False,
    'overlayMode': 'auto',
    'targetSite': 'selected',
    'holdOverride': 0,
    'sourcing': {
        'maxAgeHours': 12,
        'stationPreference': 'no-preference',
        'safetyMarginPct': 10,
        'allowFleetCarriers': False,
        # Off by default: "where to buy" is for the whole requirement; the load
        # plan is what fits one trip. On, no stop plans more than the hold.
        'limitToHold': False,
    },
}


def empty_state(fid: str | None, commander: str | None) -> dict[str, Any]:
    return {
        'schema': SCHEMA,
        'fid': fid,
        'commander': commander,
        'sites': {},
        'selectedSite': None,
        'materialPriority': {},
        'carrier': {'callsign': None, 'name': None, 'marketId': None, 'capacity': None,
                    'freeSpace': None, 'cargoTotal': None, 'statsAt': None, 'cargo': {}},
        'ship': {'cargo': {}, 'capacity': None, 'at': None, 'complete': False},
        # Where the commander is docked, from the journal. Not persisted as a fact
        # about now: cleared on undock and on every launch.
        'dock': None,
        'prefs': json.loads(json.dumps(DEFAULT_PREFS)),
        'loadPlan': None,
        'sourcing': {'result': None, 'at': None, 'error': None, 'requested': None},
        'seen': [],
        'imports': {},
    }


def _merge_defaults(state: dict[str, Any], fid: str | None, commander: str | None) -> dict[str, Any]:
    """Fill in anything an older file lacks, without touching what it has."""
    base = empty_state(fid, commander)
    for key, value in base.items():
        if key not in state:
            state[key] = value
    for key, value in base['carrier'].items():
        state['carrier'].setdefault(key, value)
    for key, value in base['ship'].items():
        state['ship'].setdefault(key, value)
    for key, value in DEFAULT_PREFS.items():
        if key not in state['prefs']:
            state['prefs'][key] = json.loads(json.dumps(value))
    for key, value in DEFAULT_PREFS['sourcing'].items():
        state['prefs']['sourcing'].setdefault(key, value)
    if commander:
        state['commander'] = commander
    return state


def file_for(data_dir: str, fid: str | None) -> str:
    """One file per commander. Before the commander is known, a holding file."""
    safe = re.sub(r'[^A-Za-z0-9_-]', '_', fid) if fid else 'unknown-commander'
    return os.path.join(data_dir, f'cmdr-{safe}.json')


def load(data_dir: str, fid: str | None, commander: str | None = None) -> dict[str, Any]:
    path = file_for(data_dir, fid)
    try:
        with open(path, encoding='utf-8') as f:
            state = json.load(f)
        if isinstance(state, dict) and state.get('schema') == SCHEMA:
            return _merge_defaults(state, fid, commander)
        # An unreadable or future file is kept aside, never overwritten.
        os.replace(path, path + '.unrecognised')
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        try:
            os.replace(path, path + '.corrupt')
        except OSError:
            pass
    return empty_state(fid, commander)


def save(data_dir: str, state: dict[str, Any]) -> None:
    path = file_for(data_dir, state.get('fid'))
    os.makedirs(data_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.cl-', suffix='.json', dir=data_dir)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(state, f, indent=1, sort_keys=True)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def remember(state: dict[str, Any], key: str) -> bool:
    """
    Note a delta event as applied. False if it already was.

    Contributions and carrier transfers add and subtract, so applying one twice
    corrupts a total. The host delivers each line once, but a key per line
    makes that a property of the data rather than an assumption about the host.
    """
    seen: list[str] = state['seen']
    if key in seen:
        return False
    seen.append(key)
    if len(seen) > SEEN_LIMIT:
        del seen[: len(seen) - SEEN_LIMIT]
    return True
