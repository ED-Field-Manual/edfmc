"""
A plotted route and where the commander is along it.

Pure data and logic: no tkinter, no network, so it can be tested on its own
and behaves the same in every host.
"""

from __future__ import annotations

import csv
import io
import json
import os
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Waypoint:
    system: str
    #: Jumps from the previous waypoint to this one. 0 for the start.
    jumps: int = 0
    #: SystemAddress (Spansh calls it id64), when known. Matching on this is
    #: exact; names are a fallback for routes imported from a file.
    address: int | None = None
    distance_left: float | None = None
    neutron: bool = False


@dataclass
class Route:
    waypoints: list[Waypoint] = field(default_factory=list)
    #: Index of the waypoint to fly to next.
    next_index: int = 0
    source: str = ''

    # -- reading ---------------------------------------------------------

    @property
    def empty(self) -> bool:
        return not self.waypoints

    @property
    def finished(self) -> bool:
        return not self.empty and self.next_index >= len(self.waypoints)

    @property
    def next(self) -> Waypoint | None:
        if self.empty or self.finished:
            return None
        return self.waypoints[self.next_index]

    @property
    def destination(self) -> Waypoint | None:
        return self.waypoints[-1] if self.waypoints else None

    def jumps_left(self) -> int:
        """Jumps from here to the destination, as the plotter counted them."""
        return sum(w.jumps for w in self.waypoints[self.next_index:])

    def total_jumps(self) -> int:
        return sum(w.jumps for w in self.waypoints)

    # -- moving along ----------------------------------------------------

    def arrived(self, system: str | None, address: int | None) -> bool:
        """Note that the commander is now in a system. True if the next waypoint moved.

        Looks ahead along the whole remaining route, not just at the next
        waypoint: a commander who skips a waypoint (a longer jump than the
        plotter assumed, or a neutron supercharge) is still on the route.
        """
        if self.empty or self.finished:
            return False
        for i in range(self.next_index, len(self.waypoints)):
            if self._is(self.waypoints[i], system, address):
                self.next_index = i + 1
                return True
        return False

    def start_from(self, system: str | None, address: int | None) -> None:
        """When a route is plotted from where the commander is, skip the start."""
        if self.waypoints and self._is(self.waypoints[0], system, address):
            self.next_index = 1

    def goto(self, index: int) -> None:
        """Make waypoint `index` the next one, e.g. picked from the list."""
        if not self.empty:
            self.next_index = max(0, min(len(self.waypoints) - 1, index))

    def step(self, delta: int) -> None:
        """Move the next waypoint by hand, staying within the route."""
        if self.empty:
            return
        self.next_index = max(0, min(len(self.waypoints), self.next_index + delta))

    @staticmethod
    def _is(w: Waypoint, system: str | None, address: int | None) -> bool:
        if address is not None and w.address is not None:
            return address == w.address
        return system is not None and system.lower() == w.system.lower()

    # -- building --------------------------------------------------------

    @classmethod
    def from_spansh(cls, result: dict[str, Any]) -> 'Route':
        """From the `result` object of a finished Spansh route job."""
        waypoints = []
        for j in result.get('system_jumps') or []:
            name = j.get('system')
            if not isinstance(name, str) or not name:
                continue
            waypoints.append(Waypoint(
                system=name,
                jumps=_int(j.get('jumps')),
                address=j.get('id64') if isinstance(j.get('id64'), int) else None,
                distance_left=_float(j.get('distance_left')),
                neutron=bool(j.get('neutron_star', False)),
            ))
        return cls(waypoints=waypoints, source='spansh')

    @classmethod
    def from_csv(cls, text: str) -> 'Route':
        """From a CSV exported by Spansh: a `System Name` column, and `Jumps` if present."""
        reader = csv.DictReader(io.StringIO(text.lstrip('﻿')))
        headers = {h.strip().lower(): h for h in (reader.fieldnames or [])}
        name_col = headers.get('system name')
        if name_col is None:
            raise ValueError('The file has no "System Name" column.')
        jumps_col = headers.get('jumps')
        left_col = headers.get('distance remaining') or headers.get('distance left')
        neutron_col = headers.get('neutron star')
        waypoints = []
        for row in reader:
            name = (row.get(name_col) or '').strip()
            if not name:
                continue
            waypoints.append(Waypoint(
                system=name,
                jumps=_int(row.get(jumps_col)) if jumps_col else 1,
                distance_left=_float(row.get(left_col)) if left_col else None,
                neutron=(row.get(neutron_col) or '').strip().lower() in ('yes', 'true', '1') if neutron_col else False,
            ))
        if not waypoints:
            raise ValueError('The file lists no systems.')
        return cls(waypoints=waypoints, source='csv')

    # -- saving ----------------------------------------------------------

    def to_json(self) -> str:
        return json.dumps({'version': 1, **asdict(self)}, indent=1)

    @classmethod
    def from_json(cls, text: str) -> 'Route':
        d = json.loads(text)
        return cls(
            waypoints=[Waypoint(**w) for w in d.get('waypoints', [])],
            next_index=int(d.get('next_index', 0)),
            source=str(d.get('source', '')),
        )

    def save(self, path: str) -> None:
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(self.to_json())
        os.replace(tmp, path)

    @classmethod
    def load(cls, path: str) -> 'Route':
        try:
            with open(path, encoding='utf-8') as f:
                return cls.from_json(f.read())
        except (OSError, ValueError, TypeError, KeyError):
            return cls()


def _int(v: Any) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _float(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
