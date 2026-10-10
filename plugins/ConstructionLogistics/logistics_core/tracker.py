"""
Journal events into the construction state.

What the journal confirms, measured across 324 journals:

- `ColonisationConstructionDepot` (6,097 lines) is a complete snapshot of a
  site: required and provided per commodity, progress, complete, failed. It
  replaces what was known, so a missed event cannot corrupt a total.
- `ColonisationContribution` (380) is a confirmed delivery. It is applied at
  once, and the next snapshot supersedes it.
- `Docked` at the depot names the site: "Planetary Construction Site: Scholz
  Landing" (type PlanetaryConstructionDepot or SpaceConstructionDepot), or
  "$EXT_PANEL_ColonisationShip; Egerton Enterprise" for the colonisation ship.
  A finished site docks under its final name and type.
- `CarrierStats` (542) gives the carrier's capacity, free space and total cargo.
- `CargoTransfer` (533) gives changes to the carrier's hold, never the whole
  hold. A commodity's carrier amount is therefore *known* only from a starting
  figure the commander gave; transfers then keep it current. Without one, a
  transfer proves only a lower bound ("at least 358 t"), never "0 t". Rebuilding
  the hold from every transfer in the journals was measured and rejected: across
  this commander's journals it gave titanium 6,039 t against 4,944 t on the
  carrier's own screen, liquid oxygen 2,631 t against 5,760 t (three carriers,
  journals starting mid-history, and carrier market orders the journal does not
  show).

What it does not do: buying commodities is not delivering them, and a planned
load is not a contribution. Only the two colonisation events above change what
a site has been given.
"""

from __future__ import annotations

import json
from typing import Any

from .store import remember
from .symbols import display_name, to_market_symbol

DEPOT_TYPES = {'PlanetaryConstructionDepot', 'SpaceConstructionDepot'}
_SHIP_PREFIX = '$EXT_PANEL_ColonisationShip;'


def parse_station(name: str | None, station_type: str | None) -> tuple[str | None, str | None]:
    """A station name and type as a site name and a readable site type."""
    if not name:
        return None, None
    if name.startswith(_SHIP_PREFIX):
        return name[len(_SHIP_PREFIX):].strip() or None, 'Colonisation ship'
    if ': ' in name and (station_type in DEPOT_TYPES or 'Construction Site' in name):
        kind, _, rest = name.partition(': ')
        return rest.strip() or None, kind.strip() or None
    readable = None
    if station_type:
        # CraterOutpost -> Crater outpost: the finished station's own type.
        words = ''.join(' ' + c.lower() if c.isupper() and i else c for i, c in enumerate(station_type)).strip()
        readable = words[:1].upper() + words[1:]
    return name, readable


def _key(entry: dict[str, Any]) -> str:
    return f"{entry.get('timestamp')}|{entry.get('event')}|{json.dumps(entry, sort_keys=True)}"


def _new_site(market_id: str, at: str) -> dict[str, Any]:
    return {
        'marketId': market_id,
        'name': None,          # {'value', 'source'}
        'siteType': None,      # {'value', 'source'}
        'system': None,        # {'value', 'source'}
        'progress': None,
        'complete': False,
        'failed': False,
        'resources': [],
        'updatedAt': None,     # time of the snapshot `resources` came from
        'source': None,        # 'journal' | 'imported'
        'priority': 1,
        'archived': False,
        'firstSeenAt': at,
        'lastContribution': None,
    }


def _name_from_dock(site: dict[str, Any], dock: dict[str, Any] | None) -> None:
    """Name a site from the dock it is, unless the commander has named it."""
    if not dock or dock.get('marketId') != site['marketId']:
        return
    name, kind = parse_station(dock.get('stationName'), dock.get('stationType'))
    if name and (site['name'] is None or site['name']['source'] != 'user'):
        site['name'] = {'value': name, 'source': 'journal'}
    if kind and (site['siteType'] is None or site['siteType']['source'] != 'user'):
        site['siteType'] = {'value': kind, 'source': 'journal'}
    if dock.get('system'):
        site['system'] = {'value': dock['system'], 'source': 'journal'}


def apply(state: dict[str, Any], entry: dict[str, Any]) -> bool:
    """Fold one journal line in. True when anything a commander would see changed."""
    event = entry.get('event')
    at = entry.get('timestamp') or ''

    if event == 'ColonisationConstructionDepot':
        market = entry.get('MarketID')
        if market is None:
            return False
        market_id = str(market)
        site = state['sites'].get(market_id)
        if site is None:
            site = _new_site(market_id, at)
            state['sites'][market_id] = site
            if state['selectedSite'] is None:
                state['selectedSite'] = market_id
        elif site.get('updatedAt') and at and at < site['updatedAt'] and site.get('source') == 'journal':
            return False  # an older snapshot never replaces a newer one
        resources = []
        for r in entry.get('ResourcesRequired') or []:
            symbol = to_market_symbol(r.get('Name') or '')
            if symbol is None:
                continue  # an unrecognised name is never guessed at
            resources.append({
                'commodity': symbol,
                'label': display_name(symbol, r.get('Name_Localised')),
                'journalName': r.get('Name'),
                'required': int(r.get('RequiredAmount') or 0),
                'provided': int(r.get('ProvidedAmount') or 0),
                'payment': r.get('Payment'),
            })
        site.update({
            'resources': resources,
            'progress': entry.get('ConstructionProgress'),
            'complete': bool(entry.get('ConstructionComplete')),
            'failed': bool(entry.get('ConstructionFailed')),
            'updatedAt': at,
            'source': 'journal',
        })
        _name_from_dock(site, state.get('dock'))
        return True

    if event == 'ColonisationContribution':
        site = state['sites'].get(str(entry.get('MarketID')))
        if site is None or not remember(state, _key(entry)):
            return False
        delivered = []
        for c in entry.get('Contributions') or []:
            symbol = to_market_symbol(c.get('Name') or '')
            amount = int(c.get('Amount') or 0)
            if symbol is None or amount <= 0:
                continue
            delivered.append({'commodity': symbol, 'label': display_name(symbol, c.get('Name_Localised')), 'amount': amount})
            # Applied only if it is newer than the snapshot: a snapshot written
            # after it already includes it, and the next one will anyway.
            if site.get('updatedAt') and at <= site['updatedAt']:
                continue
            for r in site['resources']:
                if r['commodity'] == symbol:
                    r['provided'] = min(r['required'], r['provided'] + amount)
        site['lastContribution'] = {'at': at, 'items': delivered}
        return True

    if event in ('Docked', 'Location'):
        if event == 'Location' and not entry.get('Docked'):
            state['dock'] = None
            return False
        dock = {
            'marketId': str(entry.get('MarketID')) if entry.get('MarketID') is not None else None,
            'stationName': entry.get('StationName'),
            'stationType': entry.get('StationType'),
            'system': entry.get('StarSystem'),
            'at': at,
        }
        state['dock'] = dock
        site = state['sites'].get(dock['marketId'] or '')
        if site is not None:
            _name_from_dock(site, dock)
        return True

    if event == 'Undocked':
        state['dock'] = None
        return True

    if event == 'CarrierStats':
        space = entry.get('SpaceUsage') or {}
        c = state['carrier']
        c.update({
            'callsign': entry.get('Callsign') or c.get('callsign'),
            'name': entry.get('Name') or c.get('name'),
            'marketId': str(entry.get('CarrierID')) if entry.get('CarrierID') is not None else c.get('marketId'),
            'capacity': space.get('TotalCapacity', c.get('capacity')),
            'freeSpace': space.get('FreeSpace', c.get('freeSpace')),
            'cargoTotal': space.get('Cargo', c.get('cargoTotal')),
            'statsAt': at,
        })
        return True

    if event == 'CargoTransfer':
        if not remember(state, _key(entry)):
            return False
        cargo = state['carrier']['cargo']
        for t in entry.get('Transfers') or []:
            symbol = to_market_symbol(t.get('Type') or '')
            count = int(t.get('Count') or 0)
            direction = t.get('Direction')
            if symbol is None or count <= 0 or direction not in ('tocarrier', 'toship'):
                continue
            current = cargo.get(symbol)
            known = carrier_known(current)
            base = current['amount'] if current else 0
            amount = base + (count if direction == 'tocarrier' else -count)
            # Never below zero. For an unknown amount this is a lower bound: what
            # was moved there is certainly there, what was taken says nothing.
            cargo[symbol] = {'amount': max(0, amount), 'source': 'estimated', 'known': known, 'updatedAt': at}
        return True

    if event == 'Loadout':
        capacity = entry.get('CargoCapacity')
        if isinstance(capacity, int):
            state['ship']['capacity'] = capacity
            return True
        return False

    if event == 'Cargo' and entry.get('Vessel', 'Ship') == 'Ship':
        if 'Inventory' in entry:
            set_ship_cargo(state, entry.get('Inventory') or [], at)
        else:
            # The count changed; what is in the hold comes from Cargo.json.
            state['ship']['complete'] = False
            state['ship']['at'] = at
        return True

    return False


def carrier_known(entry: dict[str, Any] | None) -> bool:
    """Whether a carrier amount is a count rather than a lower bound."""
    if not entry:
        return False
    if 'known' in entry:
        return bool(entry['known'])
    # Saved before `known` existed: only a typed or imported figure was ever a count.
    return entry.get('source') in ('user', 'imported')


def set_ship_cargo(state: dict[str, Any], inventory: list[dict[str, Any]], at: str) -> None:
    """The ship's hold, from a Cargo event's Inventory or Cargo.json."""
    cargo: dict[str, int] = {}
    for item in inventory:
        symbol = to_market_symbol(item.get('Name') or '')
        if symbol is None:
            continue
        cargo[symbol] = cargo.get(symbol, 0) + int(item.get('Count') or 0)
    state['ship'].update({'cargo': cargo, 'at': at, 'complete': True})


def read_cargo_file(journal_dir: str | None, expected_at: str | None) -> list[dict[str, Any]] | None:
    """
    Cargo.json's inventory, when it belongs to the latest Cargo event.

    The game writes the file and the journal line together; one written for an
    earlier event is not used, so an old list never sits beside a new total.
    """
    import os
    if not journal_dir or not expected_at:
        return None
    try:
        with open(os.path.join(journal_dir, 'Cargo.json'), encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get('Vessel', 'Ship') != 'Ship':
        return None
    if data.get('timestamp') != expected_at:
        return None
    inventory = data.get('Inventory')
    return inventory if isinstance(inventory, list) else None
