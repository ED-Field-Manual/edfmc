"""
Market confidence (§15), ported from EDFMC's TypeScript planner.

Two questions are kept apart:

- DATA CONFIDENCE: how much should this observation be trusted for the
  quantity actually being asked for?
- DESTINATION SCORE: how attractive is this station? (That is in planner.py.)

Every factor is returned with the verdict, so the reasoning is the result
rather than something a page reconstructs. Thresholds are data, versioned, so
they can change without new code.

Behaviour is pinned to the TypeScript original by tests/golden/planner.json.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .jsnum import grouped, js_round

LEVELS = ('unusable', 'poor', 'moderate', 'high', 'very-high')
_ORDER = {level: i for i, level in enumerate(LEVELS)}
LABELS = {'very-high': 'Very High', 'high': 'High', 'moderate': 'Moderate', 'poor': 'Poor', 'unusable': 'Unusable'}


@dataclass(frozen=True)
class ConfidenceRules:
    version: int = 1
    #: Coverage at or above this is comfortable: 7% headroom is one competing
    #: commander away from an empty market.
    coverage_strong: float = 2.0
    #: Below this there is not enough stock to bother.
    coverage_minimum: float = 1.0
    #: Markets restock over hours and EDDN reports arrive in seconds.
    age_fresh: float = 15 * 60
    age_stale: float = 60 * 60
    #: Beyond this the observation says nothing useful about now.
    age_useless: float = 12 * 60 * 60


DEFAULT_RULES = ConfidenceRules()


def human_age(seconds: float) -> str:
    if seconds < 90:
        return f'{js_round(seconds)}s'
    minutes = js_round(seconds / 60)
    if minutes < 90:
        return f'{minutes}m'
    hours = minutes // 60
    rest = minutes % 60
    return f'{hours}h' if rest == 0 else f'{hours}h {rest}m'


def assess(needed: float, reported: float, age_seconds: float, safety_margin: float = 0,
           rules: ConfidenceRules = DEFAULT_RULES) -> dict[str, Any]:
    """How far to trust one market observation for `needed` tonnes."""
    margin = safety_margin or 0
    # Ceil with a tolerance: 100 * 1.1 is 110.00000000000001, which a bare ceil
    # would turn into 111.
    target = max(1, math.ceil(needed * (1 + margin) - 1e-9))
    coverage = reported / target
    age = max(0, age_seconds)

    if coverage >= rules.coverage_strong:
        coverage_effect = 'supports'
    elif coverage < rules.coverage_minimum:
        coverage_effect = 'undermines'
    else:
        coverage_effect = 'neutral'
    if age <= rules.age_fresh:
        age_effect = 'supports'
    elif age >= rules.age_stale:
        age_effect = 'undermines'
    else:
        age_effect = 'neutral'

    margin_text = f', including a {js_round(margin * 100)}% safety margin' if margin > 0 else ''
    factors = [
        {
            'label': 'Coverage',
            'detail': f'{grouped(reported)} reported against {grouped(target)} needed '
                      f'({js_round(coverage * 100)}%){margin_text}',
            'effect': coverage_effect,
        },
        {'label': 'Observation age', 'detail': f'{human_age(age)} old', 'effect': age_effect},
    ]

    if coverage < rules.coverage_minimum:
        # Knowing precisely that there is too little does not help.
        level = 'unusable'
    elif age >= rules.age_useless:
        level = 'unusable'
    elif coverage >= rules.coverage_strong and age <= rules.age_fresh:
        level = 'very-high'
    elif coverage >= rules.coverage_strong and age < rules.age_stale:
        level = 'high'
    elif age >= rules.age_stale:
        # Thin stock and an old reading is the likeliest wasted trip.
        level = 'moderate' if coverage >= rules.coverage_strong else 'poor'
    else:
        level = 'high' if coverage >= rules.coverage_strong else 'moderate'

    return {
        'level': level,
        'coverage': coverage,
        'needed': target,
        'reported': reported,
        'ageSeconds': age,
        'factors': factors,
        'summary': f'{grouped(reported)} of {grouped(target)} needed ({js_round(coverage * 100)}%), {human_age(age)} old',
    }


def at_least(level: str, minimum: str) -> bool:
    return _ORDER[level] >= _ORDER[minimum]
