"""
The Python planner against the TypeScript one it replaces.

`golden/planner.json` was produced by running EDFMC's TypeScript planner
(packages/logistics/test/golden.test.ts) on these inputs. Every output here must
match it: same stops, same purchases, same reasons word for word, same scores.
Floats are compared to 1e-9 relative; everything else exactly.
"""

from __future__ import annotations

import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from logistics_core.confidence import assess  # noqa: E402
from logistics_core.planner import build_plan  # noqa: E402
from logistics_core.projects import allocate, combined_requirements  # noqa: E402
from logistics_core.symbols import display_name, to_market_symbol  # noqa: E402

with open(os.path.join(HERE, 'golden', 'planner.json'), encoding='utf-8') as f:
    GOLDEN = json.load(f)


def same(a, b, path='$'):
    """Deep equality with float tolerance, raising with the path of the first difference."""
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b):
            raise AssertionError(f'{path}: keys {sorted(set(a) ^ set(b))} differ')
        for k in a:
            same(a[k], b[k], f'{path}.{k}')
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            raise AssertionError(f'{path}: length {len(a)} != {len(b)}')
        for i, (x, y) in enumerate(zip(a, b)):
            same(x, y, f'{path}[{i}]')
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        if not math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12):
            raise AssertionError(f'{path}: {a!r} != {b!r}')
    elif a != b:
        raise AssertionError(f'{path}: {a!r} != {b!r}')


def plain(value):
    """Through JSON, as the TypeScript output was: infinities become null, tuples lists."""
    return json.loads(json.dumps(value, allow_nan=True).replace('Infinity', 'null'))


class Parity(unittest.TestCase):
    def test_every_plan(self):
        self.assertGreater(len(GOLDEN['plans']), 50)
        for case in GOLDEN['plans']:
            with self.subTest(case['name']):
                i = case['input']
                same(plain(build_plan(i['requirements'], i['candidates'], i['options'])), case['output'])

    def test_confidence(self):
        for case in GOLDEN['confidence']:
            i = case['input']
            same(plain(assess(i['needed'], i['reported'], i['ageSeconds'], i.get('safetyMargin', 0))), case['output'])

    def test_symbols(self):
        for case in GOLDEN['symbols']:
            self.assertEqual(to_market_symbol(case['input']), case['output'], case['input'])
        for case in GOLDEN['displayNames']:
            self.assertEqual(display_name(case['symbol'], case['localised']), case['output'])

    def test_combined_and_allocation(self):
        for case in GOLDEN['combined']:
            same(combined_requirements(case['sites']), case['output'])
        for case in GOLDEN['allocate']:
            same(allocate(case['commodity'], case['amount'], case['sites']), case['output'])


if __name__ == '__main__':
    unittest.main()
