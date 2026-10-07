"""
Your ship's jump figures, from the game's own Loadout.

Spansh's exact plotter routes normal jumps, which needs the frame shift drive's
figures: optimal mass, maximum fuel per jump, the fuel curve, the tanks and the
ship's mass. This reads them the same way Spansh does from a journal Loadout:

- the drive's stock figures from `data/fsd.json` (see tools/build_fsd_data.py),
- replaced by the engineered values the Loadout reports (`FSDOptimalMass`,
  `MaxFuelPerJump`), which are exact, so nothing about engineering is modelled,
- tanks from `FuelCapacity`, mass as `UnladenMass` plus the reservoir,
- a Guardian FSD booster's range bonus, if fitted.

Then it checks itself: the range these figures give is compared with the
`MaxJumpRange` the game wrote in the same Loadout. A mismatch means the figures
are wrong, and the plotter would route on wrong numbers, so it is reported.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

_DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'fsd.json')
_table: dict[str, Any] | None = None

#: Within this many light years of the game's figure counts as agreeing.
TOLERANCE_LY = 0.05


def _data() -> dict[str, Any]:
    global _table
    if _table is None:
        with open(_DATA, encoding='utf-8') as f:
            _table = json.load(f)
    return _table


@dataclass(frozen=True)
class Figures:
    ship: str | None
    name: str | None
    optimal_mass: float
    max_fuel_per_jump: float
    fuel_multiplier: float
    fuel_power: float
    tank_size: float
    internal_tank_size: float
    base_mass: float
    range_boost: float
    supercharge_multiplier: int
    #: What the game says the ship's best jump is, and what these figures give.
    game_range: float | None
    calculated_range: float

    @property
    def agrees(self) -> bool:
        return self.game_range is None or abs(self.game_range - self.calculated_range) <= TOLERANCE_LY

    def params(self) -> dict[str, Any]:
        """The ship part of Spansh's /api/generic/route request."""
        return {
            'fuel_power': self.fuel_power,
            'fuel_multiplier': self.fuel_multiplier,
            'optimal_mass': self.optimal_mass,
            'base_mass': self.base_mass,
            'tank_size': self.tank_size,
            'internal_tank_size': self.internal_tank_size,
            'max_fuel_per_jump': self.max_fuel_per_jump,
            'range_boost': self.range_boost,
            'supercharge_multiplier': self.supercharge_multiplier,
        }


class ShipError(ValueError):
    """Why the figures could not be read, fit to show the commander."""


def max_range(optimal_mass: float, max_fuel: float, fuel_mul: float, fuel_power: float,
              mass: float, boost: float = 0.0) -> float:
    """The standard jump-range formula for a jump using `max_fuel`."""
    return optimal_mass / mass * (max_fuel / fuel_mul) ** (1 / fuel_power) + boost


def from_loadout(loadout: dict[str, Any]) -> Figures:
    modules = loadout.get('Modules')
    if not isinstance(modules, list):
        raise ShipError('The ship loadout lists no modules.')
    fsd_module = next((m for m in modules if str(m.get('Slot', '')).lower() == 'frameshiftdrive'), None)
    if fsd_module is None:
        raise ShipError('The ship has no frame shift drive in its loadout.')
    item = str(fsd_module.get('Item', '')).lower()
    base = _data()['fsd'].get(item)
    if base is None:
        raise ShipError(f'Router does not know the drive "{item}" yet.')

    optimal_mass = float(base['optmass'])
    max_fuel = float(base['maxfuel'])
    for mod in (fsd_module.get('Engineering') or {}).get('Modifiers') or []:
        label = str(mod.get('Label', '')).lower()
        if label == 'fsdoptimalmass':
            optimal_mass = float(mod['Value'])
        elif label == 'maxfuelperjump':
            max_fuel = float(mod['Value'])

    fuel = loadout.get('FuelCapacity') or {}
    tank = float(fuel.get('Main') or 0)
    reserve = float(fuel.get('Reserve') or 0)
    unladen = loadout.get('UnladenMass')
    if not isinstance(unladen, (int, float)) or tank <= 0:
        raise ShipError("The loadout does not state the ship's mass and fuel tank.")

    boost = 0.0
    boosters = _data()['guardianBooster']
    for m in modules:
        b = boosters.get(str(m.get('Item', '')).lower())
        if b:
            boost = float(b)

    supercharge = int(_data()['superchargeMultiplier'].get(item, 4))
    # The game's MaxJumpRange is the jump with only that jump's fuel aboard.
    calculated = max_range(optimal_mass, max_fuel, float(base['fuelmul']), float(base['fuelpower']),
                           float(unladen) + max_fuel, boost)
    game = loadout.get('MaxJumpRange')
    return Figures(
        ship=loadout.get('Ship') if isinstance(loadout.get('Ship'), str) else None,
        name=loadout.get('ShipName') if isinstance(loadout.get('ShipName'), str) else None,
        optimal_mass=optimal_mass,
        max_fuel_per_jump=max_fuel,
        fuel_multiplier=float(base['fuelmul']),
        fuel_power=float(base['fuelpower']),
        tank_size=tank,
        internal_tank_size=reserve,
        base_mass=float(unladen) + reserve,
        range_boost=boost,
        supercharge_multiplier=supercharge,
        game_range=float(game) if isinstance(game, (int, float)) else None,
        calculated_range=calculated,
    )
