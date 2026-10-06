"""
The commander's current state, as plugins read it.

Folded from journal entries by the host (see `host.py`). Only what an entry
actually says is recorded; a key the game has not reported yet stays None
rather than being guessed.
"""

from __future__ import annotations

import copy
from typing import Any


def _blank_state() -> dict[str, Any]:
    return {
        'GameLanguage': None,
        'GameVersion': None,
        'GameBuild': None,
        'Captain': None,
        'Cargo': {},
        'CargoJSON': None,
        'Credits': None,
        'FID': None,
        'Horizons': None,
        'Odyssey': False,
        'Loan': None,
        'Raw': {},
        'Manufactured': {},
        'Encoded': {},
        'Engineers': {},
        'Rank': {},
        'Reputation': {},
        'Statistics': {},
        'Role': None,
        'Friends': set(),
        'ShipID': None,
        'ShipIdent': None,
        'ShipName': None,
        'ShipType': None,
        'HullValue': None,
        'ModulesValue': None,
        'Rebuy': None,
        'Modules': None,
        'NavRoute': None,
        'SystemName': None,
        'SystemAddress': None,
        'SystemPopulation': None,
        'StarPos': None,
        'Body': None,
        'BodyID': None,
        'BodyType': None,
        'StationName': None,
        'StationType': None,
        'MarketID': None,
        'IsDocked': False,
        'OnFoot': False,
        'Taxi': None,
        'Dropship': None,
        'JournalDir': None,
    }


def _lower(name: Any) -> Any:
    return name.lower() if isinstance(name, str) else name


class _Monitor:
    def __init__(self) -> None:
        self.state: dict[str, Any] = _blank_state()
        self.cmdr: str | None = None
        self.is_beta = False
        self.mode: str | None = None
        self.group: str | None = None
        self.system: str | None = None
        self.station: str | None = None
        self.station_marketid: int | None = None
        self.stationtype: str | None = None
        self.systemaddress: int | None = None
        self.coordinates: tuple | None = None
        self.planet: str | None = None
        self.started: int | None = None
        self.currentdir: str | None = None
        self.logfile: str | None = None
        self.live = True
        self._running = False

    def game_running(self) -> bool:
        return self._running

    def game_was_running(self) -> bool:
        return self._running

    def is_live_galaxy(self) -> bool:
        return not self.is_beta

    def snapshot(self) -> dict[str, Any]:
        """A copy for the `state` argument, so a plugin cannot mutate ours."""
        return copy.deepcopy(self.state)

    def fold(self, entry: dict[str, Any]) -> None:
        """Apply one journal entry."""
        s = self.state
        ev = entry.get('event')

        if ev == 'Fileheader':
            s.update(_blank_state())
            s['JournalDir'] = self.currentdir
            s['GameLanguage'] = entry.get('language')
            s['GameVersion'] = entry.get('gameversion')
            s['GameBuild'] = entry.get('build')
            self.is_beta = 'beta' in str(entry.get('gameversion', '')).lower()
            self.cmdr = None
            self._running = True
        elif ev == 'Commander':
            self.cmdr = entry.get('Name')
            s['FID'] = entry.get('FID')
        elif ev == 'LoadGame':
            self.cmdr = entry.get('Commander')
            s['FID'] = entry.get('FID', s['FID'])
            s['Horizons'] = entry.get('Horizons')
            s['Odyssey'] = bool(entry.get('Odyssey', False))
            s['Credits'] = entry.get('Credits')
            s['Loan'] = entry.get('Loan')
            s['ShipID'] = entry.get('ShipID')
            s['ShipType'] = _lower(entry.get('Ship'))
            s['ShipName'] = entry.get('ShipName')
            s['ShipIdent'] = entry.get('ShipIdent')
            if entry.get('gameversion'):
                s['GameVersion'] = entry.get('gameversion')
                s['GameBuild'] = entry.get('build')
            self.mode = entry.get('GameMode')
            self.group = entry.get('Group')
            s['IsDocked'] = False
            self._running = True
        elif ev in ('Location', 'FSDJump', 'CarrierJump'):
            self.system = entry.get('StarSystem')
            s['SystemName'] = self.system
            s['SystemAddress'] = entry.get('SystemAddress')
            self.systemaddress = s['SystemAddress']
            s['SystemPopulation'] = entry.get('Population')
            if entry.get('StarPos'):
                s['StarPos'] = tuple(entry['StarPos'])
                self.coordinates = s['StarPos']
            s['Body'] = entry.get('Body')
            s['BodyID'] = entry.get('BodyID')
            s['BodyType'] = entry.get('BodyType')
            docked = bool(entry.get('Docked', False)) if ev != 'FSDJump' else False
            s['IsDocked'] = docked
            if docked:
                self.station = entry.get('StationName')
                s['StationName'] = self.station
                s['StationType'] = entry.get('StationType')
                s['MarketID'] = entry.get('MarketID')
            else:
                self.station = None
                s['StationName'] = None
                s['StationType'] = None
                s['MarketID'] = None
            self.stationtype = s['StationType']
            self.station_marketid = s['MarketID']
            if ev in ('Location', 'CarrierJump'):
                s['Taxi'] = entry.get('Taxi')
        elif ev == 'Docked':
            self.station = entry.get('StationName')
            s['StationName'] = self.station
            s['StationType'] = entry.get('StationType')
            s['MarketID'] = entry.get('MarketID')
            s['IsDocked'] = True
            s['Taxi'] = entry.get('Taxi')
            self.stationtype = s['StationType']
            self.station_marketid = s['MarketID']
        elif ev == 'Undocked':
            s['IsDocked'] = False
            self.station = None
            s['StationName'] = None
            s['StationType'] = None
            s['MarketID'] = None
            self.stationtype = None
            self.station_marketid = None
        elif ev in ('ApproachBody', 'ApproachSettlement'):
            s['Body'] = entry.get('Body') or entry.get('BodyName')
            s['BodyID'] = entry.get('BodyID')
            self.planet = s['Body']
        elif ev == 'LeaveBody':
            s['Body'] = None
            s['BodyID'] = None
            self.planet = None
        elif ev == 'SupercruiseEntry':
            s['Body'] = None
            s['BodyID'] = None
            s['BodyType'] = None
            self.planet = None
        elif ev == 'SupercruiseExit':
            s['Body'] = entry.get('Body')
            s['BodyID'] = entry.get('BodyID')
            s['BodyType'] = entry.get('BodyType')
        elif ev == 'Cargo' and entry.get('Vessel', 'Ship') == 'Ship':
            if 'Inventory' in entry:
                cargo: dict[str, int] = {}
                for item in entry.get('Inventory') or []:
                    name = _lower(item.get('Name'))
                    if name:
                        cargo[name] = cargo.get(name, 0) + int(item.get('Count', 0))
                s['Cargo'] = cargo
                s['CargoJSON'] = entry
        elif ev == 'Materials':
            for kind in ('Raw', 'Manufactured', 'Encoded'):
                s[kind] = {_lower(m.get('Name')): m.get('Count', 0) for m in entry.get(kind) or []}
        elif ev == 'Rank':
            s['Rank'] = {k: (v, 0) for k, v in entry.items() if k not in ('event', 'timestamp')}
        elif ev == 'Progress':
            for k, v in entry.items():
                if k in s['Rank']:
                    s['Rank'][k] = (s['Rank'][k][0], min(v, 100))
        elif ev == 'Reputation':
            s['Reputation'] = {k: v for k, v in entry.items() if k not in ('event', 'timestamp')}
        elif ev == 'Statistics':
            s['Statistics'] = {k: v for k, v in entry.items() if k not in ('event', 'timestamp')}
        elif ev == 'Loadout':
            s['ShipID'] = entry.get('ShipID')
            s['ShipType'] = _lower(entry.get('Ship'))
            s['ShipName'] = entry.get('ShipName')
            s['ShipIdent'] = entry.get('ShipIdent')
            s['HullValue'] = entry.get('HullValue')
            s['ModulesValue'] = entry.get('ModulesValue')
            s['Rebuy'] = entry.get('Rebuy')
            s['Modules'] = {m.get('Slot'): m for m in entry.get('Modules') or []}
        elif ev == 'NavRoute':
            if entry.get('Route'):
                s['NavRoute'] = entry
        elif ev == 'NavRouteClear':
            s['NavRoute'] = None
        elif ev in ('Embark', 'Disembark'):
            s['OnFoot'] = ev == 'Disembark' and not entry.get('SRV', False)
            s['Taxi'] = entry.get('Taxi')
        elif ev == 'Shutdown':
            self._running = False
            self.system = None
            self.station = None
        elif ev in ('Died', 'Resurrect'):
            s['Cargo'] = {}


monitor = _Monitor()
