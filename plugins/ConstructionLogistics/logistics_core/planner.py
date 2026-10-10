"""
Sourcing plan (§16), ported from EDFMC's TypeScript planner.

A greedy set-cover: repeatedly take the station that best advances what is
still outstanding, subtract what it supplies, and go again. Greedy on purpose:
every choice can be explained stop by stop, at the cost of occasionally one
more stop than strictly necessary.

There is a score, because something has to be ranked, but every component is
returned with it, each chosen stop carries its reasons in words, and stations
that lost keep their reason too.

Behaviour is pinned to the TypeScript original by tests/golden/planner.json:
the same inputs give the same plan, field for field.
"""

from __future__ import annotations

import math
from typing import Any

from .confidence import DEFAULT_RULES, ConfidenceRules, assess, at_least
from .jsnum import grouped, js_round, parse_ms, to_fixed

PREFERENCES = ('orbital-only', 'strongly-prefer-orbital', 'no-preference', 'planetary-if-better')

DEFAULTS: dict[str, Any] = {
    'minConfidence': 'moderate',
    'stationPreference': 'no-preference',
    'priceImportance': 0.3,
    'arrivalDistanceImportance': 0.3,
    'safetyMargin': 0.1,
    'maxStops': 8,
}


def _age_seconds(observed_at: str, now_ms: float) -> float:
    t = parse_ms(observed_at)
    return math.inf if math.isnan(t) else max(0.0, (now_ms - t) / 1000)


def _exclusion_reason(station: dict[str, Any], options: dict[str, Any]) -> str | None:
    """A hard exclusion is not a low score, and says why."""
    if station.get('isFleetCarrier') and options.get('allowFleetCarriers') is not True:
        # A carrier's market is one owner's decision and can vanish before you arrive.
        return 'fleet carrier (not enabled)'
    preference = options.get('stationPreference') or DEFAULTS['stationPreference']
    if station.get('isPlanetary') is True:
        if options.get('allowPlanetary') is False:
            return 'planetary station (not enabled)'
        if preference == 'orbital-only':
            return 'planetary station (orbital only)'
    return None


def _orbital_factor(station: dict[str, Any], preference: str) -> float:
    if station.get('isPlanetary') is not True:
        return 1
    if preference == 'strongly-prefer-orbital':
        return 0.5
    if preference == 'planetary-if-better':
        return 0.9
    return 1


def _nearness(value: float | None, scale: float) -> float:
    """Nearer is better; unknown scores mid rather than best or worst."""
    if value is None:
        return 0.5
    return 1 / (1 + value / scale)


def _opt(options: dict[str, Any], key: str) -> Any:
    value = options.get(key)
    return DEFAULTS[key] if value is None else value


def build_plan(requirements: list[dict[str, Any]], candidates: list[dict[str, Any]],
               options: dict[str, Any] | None = None) -> dict[str, Any]:
    options = options or {}
    now_ms = options.get('nowMs')
    if now_ms is None:
        import time
        now_ms = time.time() * 1000
    rules: ConfidenceRules = options.get('rules') or DEFAULT_RULES
    min_confidence = _opt(options, 'minConfidence')
    preference = _opt(options, 'stationPreference')
    price_weight = _opt(options, 'priceImportance')
    arrival_weight = _opt(options, 'arrivalDistanceImportance')
    safety_margin = _opt(options, 'safetyMargin')
    max_stops = _opt(options, 'maxStops')
    max_age = options.get('maxDataAgeSeconds')

    outstanding: dict[str, dict[str, Any]] = {}
    for r in requirements:
        if r['amount'] > 0:
            outstanding[r['commodity']] = dict(r)

    rejected: list[dict[str, Any]] = []
    stops: list[dict[str, Any]] = []
    used: set[str] = set()

    usable = []
    for station in candidates:
        reason = _exclusion_reason(station, options)
        if reason is not None:
            rejected.append({'stationName': station['stationName'], 'systemName': station['systemName'],
                             'distanceLy': station.get('distanceLy'), 'reason': reason})
        else:
            usable.append(station)

    while outstanding and len(stops) < max_stops:
        best: dict[str, Any] | None = None
        round_rejections: list[dict[str, Any]] = []

        for station in usable:
            if station['marketId'] in used:
                continue

            purchases: list[dict[str, Any]] = []
            thin: str | None = None
            stale: str | None = None

            for offer in station['offers']:
                need = outstanding.get(offer['commodity'])
                if need is None:
                    continue
                age = _age_seconds(offer['observedAt'], now_ms)
                if max_age is not None and age > max_age:
                    stale = f"{offer['commodity']} data {js_round(age / 60)}m old"
                    continue

                # Never more than is reported: planning to buy unseen stock is inventing it.
                take = min(need['amount'], offer['stock'])
                # Confidence is judged against the take, so a requirement can be split
                # across stops. The margin is dropped when the take is the whole stock:
                # there is no headroom when clearing the shelf.
                clearing = take >= offer['stock']
                confidence = assess(take, offer['stock'], age, 0 if clearing else safety_margin, rules)

                if not at_least(confidence['level'], min_confidence):
                    of_requirement = js_round(offer['stock'] / max(1, need['amount']) * 100)
                    if age >= rules.age_stale:
                        thin = (f"{need['label']} data is {js_round(age / 3600)}h old and stock is "
                                f"{of_requirement}% of what is needed")
                    else:
                        thin = f"{need['label']} stock is only {of_requirement}% of what is needed"
                    continue

                purchases.append({'commodity': offer['commodity'], 'label': need['label'], 'amount': take,
                                  'buyPrice': offer.get('buyPrice'), 'confidence': confidence})

            if not purchases:
                why = thin if thin is not None else stale
                if why is not None:
                    round_rejections.append({'stationName': station['stationName'],
                                             'systemName': station['systemName'],
                                             'distanceLy': station.get('distanceLy'), 'reason': why})
                continue

            covered = len(purchases)
            distance = station.get('distanceLy')
            arrival = station.get('arrivalDistanceLs')
            system_nearness = _nearness(distance, 40)
            arrival_nearness = _nearness(arrival, 2000)
            avg_confidence = sum(min(p['confidence']['coverage'], 3) for p in purchases) / len(purchases)
            priced = [p for p in purchases if p['buyPrice'] is not None]
            avg_price = None if not priced else sum(p['buyPrice'] for p in priced) / len(priced)
            cheapness = 0.5 if avg_price is None else 1 / (1 + avg_price / 2000)
            orbital = _orbital_factor(station, preference)
            planetary = station.get('isPlanetary')

            components = [
                {'label': 'Commodities fulfilled', 'value': covered, 'detail': f'{covered} of {len(outstanding)} outstanding'},
                {'label': 'System distance', 'value': system_nearness,
                 'detail': 'unknown' if distance is None else f'{to_fixed(distance, 1)} ly'},
                {'label': 'Arrival distance', 'value': arrival_nearness,
                 'detail': 'unknown' if arrival is None else f'{grouped(js_round(arrival))} ls'},
                {'label': 'Stock headroom', 'value': avg_confidence,
                 'detail': f'{js_round(avg_confidence * 100)}% average coverage'},
                {'label': 'Price', 'value': cheapness,
                 'detail': 'unknown' if avg_price is None else f'{grouped(js_round(avg_price))} cr average'},
                {'label': 'Station type', 'value': orbital,
                 'detail': 'planetary' if planetary is True else 'orbital' if planetary is False else 'unknown'},
            ]

            # Coverage dominates: one station supplying three commodities beats a
            # marginally closer one supplying a single commodity.
            score = ((covered * 2 + avg_confidence) * (1 + system_nearness) * (1 + arrival_weight * arrival_nearness)
                     * (1 + price_weight * cheapness) * orbital)

            n = len(outstanding)
            reasons = [f"fulfils {covered} of {n} outstanding {'commodity' if n == 1 else 'commodities'}"]
            reasons += [f"{p['label']}: {p['confidence']['summary']}" for p in purchases]
            reasons.append('distance from you is unknown' if distance is None else f'{to_fixed(distance, 1)} ly from you')
            if planetary is False:
                reasons.append('orbital station')
            if planetary is True:
                reasons.append('planetary station')
            if arrival is not None:
                reasons.append(f'{grouped(js_round(arrival))} ls from arrival')

            estimated_cost = (sum(p['amount'] * (p['buyPrice'] or 0) for p in purchases)
                              if len(priced) == len(purchases) else None)

            candidate = {'station': station, 'purchases': purchases, 'reasons': reasons,
                         'components': components, 'score': score, 'estimatedCost': estimated_cost}
            if best is None or candidate['score'] > best['score']:
                best = candidate

        if best is None:
            # Nothing acceptable is left; report the rest unfulfilled.
            rejected.extend(round_rejections[:5])
            break

        # A hold limit truncates what is bought here; the rest stays outstanding.
        capacity = options.get('capacity')
        remaining_capacity = capacity if capacity and capacity > 0 else math.inf
        kept = []
        for purchase in best['purchases']:
            if remaining_capacity <= 0:
                break
            amount = min(purchase['amount'], remaining_capacity)
            remaining_capacity -= amount
            kept.append({**purchase, 'amount': amount})

        for purchase in kept:
            need = outstanding.get(purchase['commodity'])
            if need is None:
                continue
            left = need['amount'] - purchase['amount']
            if left > 0:
                outstanding[purchase['commodity']] = {**need, 'amount': left}
            else:
                del outstanding[purchase['commodity']]

        used.add(best['station']['marketId'])
        stops.append({**best, 'purchases': kept})
        rejected.extend(round_rejections[:3])

    cost = (sum(s['estimatedCost'] or 0 for s in stops)
            if all(s['estimatedCost'] is not None for s in stops) else None)

    seen: set[str] = set()
    unique_rejected = []
    for r in rejected:
        if r['stationName'] in seen:
            continue
        seen.add(r['stationName'])
        unique_rejected.append(r)

    return {
        'stops': stops,
        'unfulfilled': list(outstanding.values()),
        'rejected': unique_rejected,
        'totalStops': len(stops),
        'estimatedCost': cost,
        'confidenceRulesVersion': rules.version,
    }
