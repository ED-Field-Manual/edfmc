"""
Every ship the commander owns, and the figures to plot with each.

The game only writes a ship's `Loadout` while you fly it, so a ship's figures
are the ones from the last time it was flown. They are read from all the
journals, then kept current as new events arrive:

- `Loadout`: the newest one per `ShipID` is that ship's build.
- `StoredShips` (written at every shipyard): the ships you own besides the one
  you are in. The newest list decides what is still yours, so a ship sold or
  traded in drops out; ships bought or flown since then are added back.
- `ShipyardBuy`, `ShipyardNew`, `ShipyardSell`: buying and selling after that
  list. `ShipyardBuy` can sell or store the old ship in the same event.

A ship you own but have not flown since your journals began has no `Loadout`,
so there are no figures to plot with; it is listed with that reason.

Read only. Nothing here writes to the game's folder.
"""

from __future__ import annotations

import glob
import json
import os
from dataclasses import dataclass, field
from typing import Any

from . import ship

#: Events this module reads. Lines without one are skipped without parsing.
_EVENTS = ('"Loadout"', '"StoredShips"', '"ShipyardBuy"', '"ShipyardNew"', '"ShipyardSell"',
           '"ShipyardSwap"', '"SetUserShipName"')


@dataclass
class Fleet:
    loadouts: dict[int, dict[str, Any]] = field(default_factory=dict)
    #: ShipID -> what the game calls the ship type ("Type-11 Prospector").
    models: dict[int, str] = field(default_factory=dict)
    names: dict[int, str] = field(default_factory=dict)
    #: None until a StoredShips list has been seen; then the ShipIDs owned.
    owned: set[int] | None = None
    current: int | None = None

    def fold(self, e: dict[str, Any]) -> bool:
        """Apply one journal entry. True if the fleet changed."""
        ev = e.get('event')
        if ev == 'Loadout' and isinstance(e.get('ShipID'), int):
            sid = e['ShipID']
            self.loadouts[sid] = e
            self.current = sid
            if self.owned is not None:
                self.owned.add(sid)
            name = str(e.get('ShipName') or '').strip()
            if name:
                self.names[sid] = name
            return True
        if ev == 'StoredShips':
            owned: set[int] = set()
            for s in (e.get('ShipsHere') or []) + (e.get('ShipsRemote') or []):
                sid = s.get('ShipID')
                if not isinstance(sid, int):
                    continue
                owned.add(sid)
                if isinstance(s.get('ShipType_Localised'), str) and s['ShipType_Localised']:
                    self.models[sid] = s['ShipType_Localised']
                elif isinstance(s.get('ShipType'), str) and s['ShipType'].isalpha() and sid not in self.models:
                    # No _Localised when the name is the symbol (Dolphin, Corsair).
                    self.models[sid] = s['ShipType'].capitalize()
                name = str(s.get('Name') or '').strip()
                if name:
                    self.names[sid] = name
            if self.current is not None:
                owned.add(self.current)  # the list leaves out the ship you are in
            self.owned = owned
            return True
        if ev == 'ShipyardBuy':
            for key in ('SellShipID',):
                if isinstance(e.get(key), int) and self.owned is not None:
                    self.owned.discard(e[key])
            return True
        if ev == 'ShipyardNew' and isinstance(e.get('NewShipID'), int):
            if self.owned is not None:
                self.owned.add(e['NewShipID'])
            if isinstance(e.get('ShipType_Localised'), str):
                self.models[e['NewShipID']] = e['ShipType_Localised']
            return True
        if ev == 'ShipyardSell' and isinstance(e.get('SellShipID'), int):
            if self.owned is not None:
                self.owned.discard(e['SellShipID'])
            self.loadouts.pop(e['SellShipID'], None)
            return True
        if ev == 'SetUserShipName' and isinstance(e.get('ShipID'), int):
            name = str(e.get('UserShipName') or '').strip()
            if name:
                self.names[e['ShipID']] = name
            return True
        return False

    def ships(self) -> list[dict[str, Any]]:
        """Every owned ship, the current one first, then the best jump first."""
        ids = set(self.loadouts) if self.owned is None else set(self.owned)
        out = []
        for sid in ids:
            loadout = self.loadouts.get(sid)
            entry: dict[str, Any] = {
                'id': sid,
                'name': self.names.get(sid),
                'model': self._model(sid, loadout),
                'current': sid == self.current,
                'asOf': loadout.get('timestamp') if loadout else None,
                'maxJump': loadout.get('MaxJumpRange') if loadout else None,
            }
            if loadout is None:
                entry.update(ready=False, reason='Not flown since your journals began. Board it once to read it.')
            else:
                try:
                    f = ship.from_loadout(loadout)
                    entry.update(ready=f.agrees, supercharge=f.supercharge_multiplier,
                                 reason=None if f.agrees else
                                 f"Its figures give {f.calculated_range:.2f} ly, not the game's {f.game_range:.2f} ly.")
                except ship.ShipError as e:
                    entry.update(ready=False, reason=str(e))
            out.append(entry)
        out.sort(key=lambda s: (not s['current'], -(s['maxJump'] or 0)))
        return out

    def _model(self, sid: int, loadout: dict[str, Any] | None) -> str | None:
        if sid in self.models:
            return self.models[sid]
        symbol = loadout.get('Ship') if loadout else None
        # The game leaves out ShipType_Localised when the name is the symbol
        # itself (corsair, anaconda, dolphin), so those read as the symbol.
        return symbol.capitalize() if isinstance(symbol, str) and symbol.isalpha() else symbol


def from_journals(journal_dir: str) -> Fleet:
    """Read every journal, oldest first. Lines are filtered before parsing."""
    fleet = Fleet()
    for path in sorted(glob.glob(os.path.join(journal_dir, 'Journal.*.log'))):
        try:
            with open(path, encoding='utf-8', errors='replace') as f:
                for line in f:
                    if '"event"' not in line or not any(k in line for k in _EVENTS):
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(entry, dict):
                        fleet.fold(entry)
        except OSError:
            continue
    return fleet
