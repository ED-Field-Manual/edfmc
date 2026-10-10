"""
The join between what a construction site needs and what a market sells.

Two naming schemes for one commodity:

    journal (ColonisationConstructionDepot) : $ceramiccomposites_name;
    EDDN / EDFM market data                 : ceramiccomposites

Measured across 224 journals: colonisation events carry 84 distinct names for
42 commodities, because Frontier writes each in two cases ($aluminium_name;
and $Aluminium_name;). Case-folding is what makes them one commodity.
"""

from __future__ import annotations

import re

_WRAPPED = re.compile(r'^\$([A-Za-z0-9_]+)_name;$')
_BARE = re.compile(r'^[a-z0-9_]+$')


def to_market_symbol(journal_name: str) -> str | None:
    """Journal commodity name to the market symbol, or None for an unfamiliar shape."""
    if not isinstance(journal_name, str):
        return None
    match = _WRAPPED.match(journal_name.strip())
    if match:
        return match.group(1).lower()
    bare = journal_name.strip().lower()
    return bare if bare and _BARE.match(bare) else None


def display_name(symbol: str, localised: str | None = None) -> str:
    """Frontier's localised name when there is one; otherwise the symbol, capitalised."""
    if localised:
        return localised
    return symbol[:1].upper() + symbol[1:]
