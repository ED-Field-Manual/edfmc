"""
Build `router_core/data/fsd.json`: the frame shift drive figures the exact
plotter needs, from the Coriolis project's copy of the game's module data.

    python tools/build_fsd_data.py

Pinned to one commit so the table only changes when someone re-runs this on
purpose. The figures are Frontier Developments' game data, published by the
Coriolis project (github.com/EDCD/coriolis-data) under Frontier's terms; they
are the same figures Spansh uses for its own exact plotter.

One figure Coriolis does not carry: the neutron supercharge multiplier of the
Caspian's "Overcharge booster Mk II" drive, which Spansh's plotter sets to 6
(every other drive is 4). That one is listed here by hand, with its source.
"""

from __future__ import annotations

import json
import os
import urllib.request

COMMIT = '0db9234b5b9ce8c939ea84133d7ce336eea88e27'  # EDCD/coriolis-data, 2026-04-24
BASE = f'https://raw.githubusercontent.com/EDCD/coriolis-data/{COMMIT}/modules'
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'router_core', 'data', 'fsd.json')

#: From Spansh's exact plotter (its built-in FSD mapping), 2026-10-06.
SUPERCHARGE = {'int_hyperdrive_overcharge_size8_class5_overchargebooster_mkii': 6}


def get(path: str) -> dict:
    with urllib.request.urlopen(f'{BASE}/{path}', timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))


def main() -> None:
    fsd: dict[str, dict] = {}
    for m in get('standard/frame_shift_drive.json')['fsd']:
        key = m['symbol'].lower()
        # Coriolis lists some drives twice: the stock module and a
        # pre-engineered variant with the same symbol. The game's Loadout
        # reports engineering separately, so the stock figures are the base.
        if key in fsd and m.get('preEngineered'):
            continue
        fsd[key] = {k: m[k] for k in ('optmass', 'maxfuel', 'fuelmul', 'fuelpower')}
    gfsb = {m['symbol'].lower(): m['jumpboost'] for m in get('internal/guardian_fsd_booster.json')['gfsb']}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({
            'source': f'github.com/EDCD/coriolis-data@{COMMIT}',
            'notice': 'Game data is the intellectual property of Frontier Developments plc, '
                      'used under its terms. Compiled by the Coriolis project.',
            'fsd': dict(sorted(fsd.items())),
            'guardianBooster': dict(sorted(gfsb.items())),
            'superchargeMultiplier': SUPERCHARGE,
        }, f, indent=1)
    print(f'{len(fsd)} drives, {len(gfsb)} guardian boosters -> {OUT}')


if __name__ == '__main__':
    main()
