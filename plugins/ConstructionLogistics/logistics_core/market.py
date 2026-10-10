"""
Where to buy what a construction site still needs, from EDFM's market data.

Construction only. The request carries just the commodities the commander's
sites still need -- the colonisation materials the journal listed -- so this
answers "where do I buy the steel for Scholz Landing", not "find me anything".

The request goes to EDFM's market search (api.edfieldmanual.com), the same
service EDFMC's old Logistics page used, built on EDDN market data. The
commander's position from the journal is sent as the search origin, so
stations come back with real distances; the old page never sent it, so every
distance was "unknown". Planning happens here, not on the server, so the
reasoning can be shown.

Standard library only: no package to install, in EDFMC or EDMC.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any

from .planner import build_plan

API = 'https://api.edfieldmanual.com/v1/market/search'
TIMEOUT_S = 30
#: The service's own limits (services/api/src/schema.ts).
MAX_COMMODITIES = 64
MAX_CANDIDATES = 120


def request_body(requirements: list[dict[str, Any]], prefs: dict[str, Any],
                 origin: tuple[float, float, float] | None) -> dict[str, Any]:
    body: dict[str, Any] = {
        'commodities': [r['commodity'] for r in requirements][:MAX_COMMODITIES],
        'minStock': 1,
        'limit': MAX_CANDIDATES,
        'includeFleetCarriers': bool(prefs.get('allowFleetCarriers')),
        'maxAgeSeconds': int(max(1, min(720, prefs.get('maxAgeHours') or 12)) * 3600),
    }
    if prefs.get('stationPreference') == 'orbital-only':
        body['includePlanetary'] = False
    if origin is not None and all(isinstance(v, (int, float)) for v in origin):
        body['origin'] = {'x': float(origin[0]), 'y': float(origin[1]), 'z': float(origin[2])}
    return body


def plan_options(prefs: dict[str, Any], capacity: int | None, now_ms: float | None = None) -> dict[str, Any]:
    options: dict[str, Any] = {
        'stationPreference': prefs.get('stationPreference') or 'no-preference',
        'allowFleetCarriers': bool(prefs.get('allowFleetCarriers')),
        'maxDataAgeSeconds': int(max(1, min(720, prefs.get('maxAgeHours') or 12)) * 3600),
        'safetyMargin': max(0, min(100, prefs.get('safetyMarginPct') or 0)) / 100,
    }
    if capacity:
        options['capacity'] = int(capacity)
    if now_ms is not None:
        options['nowMs'] = now_ms
    return options


def fetch(body: dict[str, Any], user_agent: str) -> list[dict[str, Any]]:
    """POST the search. Raises RuntimeError with words for the commander on failure."""
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(API, data=data, method='POST', headers={
        'content-type': 'application/json',
        'user-agent': user_agent,
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'The market service refused the search ({e.code}).') from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise RuntimeError('The market service could not be reached. Sourcing needs an internet connection; '
                           'everything else works offline.') from None
    except ValueError:
        raise RuntimeError('The market service sent something unreadable.') from None
    candidates = payload.get('candidates') if isinstance(payload, dict) else None
    if not isinstance(candidates, list):
        raise RuntimeError('The market service sent something unreadable.')
    return candidates


def source(requirements: list[dict[str, Any]], prefs: dict[str, Any], origin: tuple[float, float, float] | None,
           capacity: int | None, user_agent: str, fetcher=fetch) -> dict[str, Any]:
    """Search and plan. Runs on a worker thread; touches no plugin state."""
    candidates = fetcher(request_body(requirements, prefs, origin), user_agent)
    plan = build_plan(requirements, candidates, plan_options(prefs, capacity, time.time() * 1000))
    plan['candidatesConsidered'] = len(candidates)
    return plan
