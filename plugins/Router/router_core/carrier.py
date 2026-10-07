"""
The commander's fleet carriers, as the journal reports them.

Read only, and only what the carrier planner needs to fill in its form:

- `CarrierStats` (written when the carrier management screen opens):
  `CarrierType`, `Name`, `Callsign`, `FuelLevel` (tritium in the tank) and
  `SpaceUsage` with `TotalCapacity` and `FreeSpace`, so used capacity is
  their difference.
- `CarrierLocation` (written at login and after a jump): `CarrierType`,
  `StarSystem`, `SystemAddress`.
- `CarrierJumpCancelled` / `CarrierJumpRequest` are not needed: a carrier
  route moves on when the carrier actually arrives.

`CarrierType` is `FleetCarrier` for a player's own carrier and
`SquadronCarrier` for a squadron's; both appear in the corpus. One of each
is kept, the newest.
"""

from __future__ import annotations

import glob
import json
import os
from dataclasses import asdict, dataclass, field
from typing import Any

_EVENTS = ('"CarrierStats"', '"CarrierLocation"')

#: Journal `CarrierType` to the planner's own name for it.
KINDS = {'FleetCarrier': 'fleet', 'SquadronCarrier': 'squadron'}


@dataclass
class Carrier:
    kind: str
    name: str | None = None
    callsign: str | None = None
    #: Tritium in the tank.
    fuel: int | None = None
    used_capacity: int | None = None
    capacity: int | None = None
    system: str | None = None
    address: int | None = None
    as_of: str | None = None


@dataclass
class Carriers:
    by_kind: dict[str, Carrier] = field(default_factory=dict)

    def fold(self, e: dict[str, Any]) -> bool:
        """Apply one journal entry. True if anything changed."""
        ev = e.get('event')
        if ev not in ('CarrierStats', 'CarrierLocation'):
            return False
        kind = KINDS.get(e.get('CarrierType'))  # type: ignore[arg-type]
        if kind is None:
            return False
        c = self.by_kind.setdefault(kind, Carrier(kind=kind))
        c.as_of = e.get('timestamp') if isinstance(e.get('timestamp'), str) else c.as_of
        if ev == 'CarrierLocation':
            if isinstance(e.get('StarSystem'), str):
                c.system = e['StarSystem']
            if isinstance(e.get('SystemAddress'), int):
                c.address = e['SystemAddress']
            return True
        if isinstance(e.get('Name'), str):
            c.name = e['Name']
        if isinstance(e.get('Callsign'), str):
            c.callsign = e['Callsign']
        if isinstance(e.get('FuelLevel'), int):
            c.fuel = e['FuelLevel']
        usage = e.get('SpaceUsage')
        if isinstance(usage, dict):
            total, free = usage.get('TotalCapacity'), usage.get('FreeSpace')
            if isinstance(total, int):
                c.capacity = total
                if isinstance(free, int):
                    c.used_capacity = max(0, total - free)
        return True

    def to_json(self) -> dict[str, Any]:
        return {k: asdict(v) for k, v in self.by_kind.items()}


def from_journals(journal_dir: str) -> Carriers:
    """Read every journal, oldest first, keeping the newest of each. Lines are filtered before parsing."""
    out = Carriers()
    for path in sorted(glob.glob(os.path.join(journal_dir, 'Journal.*.log'))):
        try:
            with open(path, encoding='utf-8', errors='replace') as f:
                for line in f:
                    if not any(k in line for k in _EVENTS):
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(entry, dict):
                        out.fold(entry)
        except OSError:
            continue
    return out
