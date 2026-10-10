"""
Several sites as one shopping list, and how a purchase is split between them (§17).

Ported from EDFMC's TypeScript planner; pinned by tests/golden/planner.json.
Sites here are plain dicts with `marketId`, `complete`, `failed`, `priority`,
`name` and `resources` (each with `commodity`, `label`, `remaining`).
"""

from __future__ import annotations

from typing import Any


def combined_requirements(sites: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    One requirement per commodity across every unfinished site.

    Buying 10,400 once beats three trips for 4,000, 3,200 and 3,200. Finished
    and failed sites contribute nothing.
    """
    totals: dict[str, dict[str, Any]] = {}
    for site in sites:
        if site.get('complete') or site.get('failed'):
            continue
        for resource in site.get('resources', []):
            if resource['remaining'] <= 0:
                continue
            existing = totals.get(resource['commodity'])
            totals[resource['commodity']] = {
                'commodity': resource['commodity'],
                'label': resource['label'],
                'amount': (existing['amount'] if existing else 0) + resource['remaining'],
            }
    # Largest first: the hardest requirement is the one worth seeing first.
    return sorted(totals.values(), key=lambda r: -r['amount'])


def allocate(commodity: str, purchased: float, sites: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Split a purchased quantity between sites: by priority, then by need.

    Higher-priority sites are filled first rather than every site getting a
    trickle that completes none of them.
    """
    claimants = []
    for site in sites:
        if site.get('complete') or site.get('failed'):
            continue
        need = next((r['remaining'] for r in site.get('resources', []) if r['commodity'] == commodity), 0)
        if need > 0:
            claimants.append((site, need))
    claimants.sort(key=lambda c: (c[0].get('priority', 1), -c[1]))

    out = []
    left = purchased
    for site, need in claimants:
        if left <= 0:
            break
        amount = min(need, left)
        left -= amount
        out.append({'marketId': site['marketId'], 'siteName': site.get('name'), 'amount': amount})
    return out
