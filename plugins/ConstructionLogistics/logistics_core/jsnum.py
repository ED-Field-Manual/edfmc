"""
Number formatting that matches the TypeScript planner exactly.

The planner was written in TypeScript and its plans are pinned by golden test
cases (tests/golden/planner.json). Python's own rounding differs from
JavaScript's in ways that would change visible text: `round(2.5)` is 2 in
Python and `Math.round(2.5)` is 3; `f'{2.25:.1f}'` and `(2.25).toFixed(1)` can
disagree on a tie. These reproduce JavaScript's rules, so the same plan reads
the same in both.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal


def js_round(x: float) -> int:
    """`Math.round`: halves go up, towards positive infinity."""
    return int(math.floor(x + 0.5))


def to_fixed(x: float, digits: int) -> str:
    """`Number.prototype.toFixed`, which rounds the exact binary value half-up."""
    q = Decimal(1).scaleb(-digits)
    return str(Decimal(x).quantize(q, rounding=ROUND_HALF_UP))


def grouped(n: float) -> str:
    """`toLocaleString()` for the whole numbers the planner prints (en-US grouping)."""
    if float(n).is_integer():
        return f'{int(n):,}'
    # Not reached by the planner, which only prints whole numbers; kept honest anyway.
    return f'{n:,.3f}'.rstrip('0').rstrip('.')


def parse_ms(iso: str) -> float:
    """`Date.parse` for the ISO timestamps the market data carries; NaN when unreadable."""
    try:
        text = iso.strip()
        if text.endswith('Z'):
            text = text[:-1] + '+00:00'
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp() * 1000.0
    except (ValueError, AttributeError):
        return math.nan
