"""
Materials, hauling and delivery: everything derived from the one state.

Nothing here is stored as fact. Every number is worked out from the journal's
site snapshots, the ship's hold and the carrier estimate each time it is
needed, so tracking, planning and the overlay can never disagree.

Carrier and ship stock are shared between sites by priority, the same rule the
sourcing planner uses (projects.allocate): 500 t of steel on the carrier is
counted once, against the most important site that needs it, not once per site.
"""

from __future__ import annotations

from typing import Any

from .projects import allocate

#: 1 is most urgent. Materials without one are in the middle.
DEFAULT_PRIORITY = 3


def active_sites(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Sites still being built, most important first."""
    sites = [s for s in state['sites'].values() if not s['archived'] and not s['complete'] and not s['failed']]
    return sorted(sites, key=lambda s: (s.get('priority', 1), s.get('firstSeenAt') or ''))


def site_label(site: dict[str, Any]) -> str:
    name = (site.get('name') or {}).get('value')
    return name or f"Site {site['marketId']}"


def _planner_site(site: dict[str, Any]) -> dict[str, Any]:
    """The shape projects.allocate and combined_requirements read."""
    return {
        'marketId': site['marketId'],
        'name': site_label(site),
        'priority': site.get('priority', 1),
        'complete': site['complete'] or site['archived'],
        'failed': site['failed'],
        'resources': [
            {'commodity': r['commodity'], 'label': r['label'], 'remaining': max(0, r['required'] - r['provided'])}
            for r in site['resources']
        ],
    }


def carrier_amount(state: dict[str, Any], commodity: str) -> int:
    return int(state['carrier']['cargo'].get(commodity, {}).get('amount', 0))


def ship_amount(state: dict[str, Any], commodity: str) -> int:
    return int(state['ship']['cargo'].get(commodity, 0))


def allocations(state: dict[str, Any]) -> dict[str, dict[str, dict[str, int]]]:
    """
    How the ship's and the carrier's stock divide between active sites.

    Ship cargo first (it is the next delivery), then the carrier's, each by site
    priority. Returns commodity -> marketId -> {'ship': n, 'carrier': n}.
    """
    sites = [_planner_site(s) for s in active_sites(state)]
    out: dict[str, dict[str, dict[str, int]]] = {}
    commodities = {r['commodity'] for s in sites for r in s['resources']}
    for commodity in commodities:
        per: dict[str, dict[str, int]] = {}
        for a in allocate(commodity, ship_amount(state, commodity), sites):
            per.setdefault(a['marketId'], {'ship': 0, 'carrier': 0})['ship'] = a['amount']
        # What the ship already covers is no longer needed from the carrier.
        reduced = [
            {**s, 'resources': [
                {**r, 'remaining': max(0, r['remaining'] - per.get(s['marketId'], {}).get('ship', 0))}
                if r['commodity'] == commodity else r
                for r in s['resources']
            ]}
            for s in sites
        ]
        for a in allocate(commodity, carrier_amount(state, commodity), reduced):
            per.setdefault(a['marketId'], {'ship': 0, 'carrier': 0})['carrier'] = a['amount']
        out[commodity] = per
    return out


def material_rows(state: dict[str, Any], site: dict[str, Any]) -> list[dict[str, Any]]:
    """One row per material of one site: required, provided, held, still to find."""
    alloc = allocations(state) if not (site['complete'] or site['failed'] or site['archived']) else {}
    priorities = state.get('materialPriority', {})
    rows = []
    for r in site['resources']:
        remaining = max(0, r['required'] - r['provided'])
        mine = alloc.get(r['commodity'], {}).get(site['marketId'], {'ship': 0, 'carrier': 0})
        to_source = max(0, remaining - mine['ship'] - mine['carrier'])
        if remaining == 0:
            status = 'done'
        elif to_source == 0:
            status = 'held'      # aboard or on the carrier; delivery still pending
        else:
            status = 'needed'
        rows.append({
            'commodity': r['commodity'],
            'label': r['label'],
            'required': r['required'],
            'provided': r['provided'],
            'remaining': remaining,
            'carrier': carrier_amount(state, r['commodity']),
            'carrierSource': state['carrier']['cargo'].get(r['commodity'], {}).get('source'),
            'ship': ship_amount(state, r['commodity']),
            'allocatedShip': mine['ship'],
            'allocatedCarrier': mine['carrier'],
            'toSource': to_source,
            'status': status,
            'priority': int(priorities.get(r['commodity'], DEFAULT_PRIORITY)),
        })
    return rows


def target_sites(state: dict[str, Any]) -> list[dict[str, Any]]:
    """The site(s) a plan is for: the selected site, or every active site."""
    if state['prefs'].get('targetSite') == 'all':
        return active_sites(state)
    selected = state['sites'].get(state.get('selectedSite') or '')
    if selected is None or selected['complete'] or selected['failed'] or selected['archived']:
        return []
    return [selected]


def requirements_to_source(state: dict[str, Any]) -> list[dict[str, Any]]:
    """What still has to be bought for the target site(s): not on the ship, not on the carrier."""
    totals: dict[str, dict[str, Any]] = {}
    for site in target_sites(state):
        for row in material_rows(state, site):
            if row['toSource'] <= 0:
                continue
            t = totals.setdefault(row['commodity'], {'commodity': row['commodity'], 'label': row['label'], 'amount': 0})
            t['amount'] += row['toSource']
    return sorted(totals.values(), key=lambda r: -r['amount'])


def hold_capacity(state: dict[str, Any]) -> int | None:
    override = int(state['prefs'].get('holdOverride') or 0)
    if override > 0:
        return override
    return state['ship'].get('capacity')


def load_plan(state: dict[str, Any]) -> dict[str, Any]:
    """
    One trip's load for the target site(s), within the hold.

    Takes from the carrier first (already bought), then lists what to buy.
    Ordered by the commander's material priority, then by the largest need.
    A plan is a suggestion: nothing in it counts as delivered.
    """
    capacity = hold_capacity(state)
    aboard_total = sum(state['ship']['cargo'].values())
    free = None if capacity is None else max(0, capacity - aboard_total)

    needs: dict[str, dict[str, Any]] = {}
    for site in target_sites(state):
        for row in material_rows(state, site):
            remaining_after_ship = max(0, row['remaining'] - row['allocatedShip'])
            if remaining_after_ship <= 0:
                continue
            n = needs.setdefault(row['commodity'], {'commodity': row['commodity'], 'label': row['label'],
                                                     'need': 0, 'priority': row['priority']})
            n['need'] += remaining_after_ship

    ordered = sorted(needs.values(), key=lambda n: (n['priority'], -n['need']))
    left = free if free is not None else float('inf')
    carrier_left = {c: carrier_amount(state, c) for c in needs}
    lines = []
    for n in ordered:
        if left <= 0:
            break
        take = min(n['need'], left)
        from_carrier = min(take, carrier_left[n['commodity']])
        carrier_left[n['commodity']] -= from_carrier
        buy = take - from_carrier
        left -= take
        lines.append({'commodity': n['commodity'], 'label': n['label'], 'fromCarrier': int(from_carrier),
                      'buy': int(buy), 'total': int(take), 'priority': n['priority']})

    planned = sum(line['total'] for line in lines)
    return {
        'capacity': capacity,
        'aboard': aboard_total,
        'freeBefore': free,
        'planned': planned,
        'freeAfter': None if free is None else free - planned,
        'lines': lines,
        'unlimited': capacity is None,
    }


def after_delivery(state: dict[str, Any], site: dict[str, Any]) -> list[dict[str, Any]]:
    """What a site would still need if the ship's hold were delivered now. Not a confirmed delivery."""
    rows = []
    for row in material_rows(state, site):
        if row['remaining'] <= 0:
            continue
        delivering = row['allocatedShip']
        rows.append({'commodity': row['commodity'], 'label': row['label'], 'remaining': row['remaining'],
                     'delivering': delivering, 'after': row['remaining'] - delivering})
    return rows


def export_text(site: dict[str, Any], rows: list[dict[str, Any]]) -> str:
    lines = [f"{site_label(site)}: materials still required"]
    for r in rows:
        if r['remaining'] > 0:
            lines.append(f"{r['label']}: {r['remaining']:,} t")
    return '\n'.join(lines)


def export_csv(site: dict[str, Any], rows: list[dict[str, Any]]) -> str:
    def q(text: Any) -> str:
        s = str(text)
        return '"' + s.replace('"', '""') + '"' if any(c in s for c in ',"\n') else s
    out = ['Site,Material,Required,Provided,Remaining,Carrier,Ship,To source']
    for r in rows:
        out.append(','.join(q(v) for v in (site_label(site), r['label'], r['required'], r['provided'],
                                            r['remaining'], r['carrier'], r['ship'], r['toSource'])))
    return '\n'.join(out)
