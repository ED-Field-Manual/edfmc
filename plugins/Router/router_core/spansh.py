"""
Spansh's route plotter, over its public API.

Plotting is a job: submit it, then poll until the route is ready. Both steps
run on a worker thread so the window never waits on the network; the caller
gets the outcome through a callback it schedules back onto its own thread.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

from .route import Route

API = 'https://spansh.co.uk/api'
USER_AGENT = 'Router (Elite Dangerous route plugin)'
#: How long to wait for Spansh to finish a job before giving up.
TIMEOUT_S = 90
POLL_EVERY_S = 1.5


class PlotError(Exception):
    """A plot that failed, with a message fit to show the commander."""


def _request(url: str, method: str = 'GET', form: dict[str, Any] | None = None) -> tuple[int, Any]:
    data = urllib.parse.urlencode(form).encode('utf-8') if form is not None else None
    headers = {'User-Agent': USER_AGENT}
    if data is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode('utf-8'))
        except ValueError:
            body = None
        return e.code, body


#: Spansh's neutron-boost multipliers: 4x for a normal FSD supercharge, 6x
#: for an overcharged one (the Caspian / SCO drives).
SUPERCHARGE = (4, 6)


def plot(source: str, destination: str, jump_range: float, efficiency: int = 60,
         request: Callable[[str, str], tuple[int, Any]] = _request,
         sleep: Callable[[float], None] = time.sleep,
         via: list[str] | None = None, supercharge: int = 4) -> Route:
    """Plot a neutron route. Blocks; call it from a worker thread.

    `via` systems are visited in order on the way. Both options are Spansh's
    own: checked live, it echoed `via: ['Alioth']` and `supercharge_multiplier:
    '6'` back and routed Sol, Alioth, Achenar.
    """
    params: list[tuple[str, Any]] = [
        ('efficiency', efficiency),
        ('range', f'{jump_range:.2f}'),
        ('from', source),
        ('to', destination),
        ('supercharge_multiplier', supercharge if supercharge in SUPERCHARGE else 4),
    ]
    params += [('via', v) for v in (via or []) if v.strip()]
    query = urllib.parse.urlencode(params)
    try:
        status, body = request(f'{API}/route?{query}', 'POST')
    except (urllib.error.URLError, OSError) as e:
        raise PlotError(f'Spansh could not be reached ({e}).') from e

    if status not in (200, 202) or not isinstance(body, dict) or 'job' not in body:
        # Spansh explains a bad request itself, e.g. "Could not find finishing system".
        message = body.get('error') if isinstance(body, dict) else None
        raise PlotError(message or f'Spansh refused the request (HTTP {status}).')

    job = urllib.parse.quote(str(body['job']))
    deadline = time.monotonic() + TIMEOUT_S
    while True:
        try:
            status, body = request(f'{API}/results/{job}', 'GET')
        except (urllib.error.URLError, OSError) as e:
            raise PlotError(f'Spansh could not be reached ({e}).') from e
        if status == 200 and isinstance(body, dict) and isinstance(body.get('result'), dict):
            route = Route.from_spansh(body['result'])
            if route.empty:
                raise PlotError('Spansh returned an empty route.')
            return route
        if status != 202:
            message = body.get('error') if isinstance(body, dict) else None
            raise PlotError(message or f'Spansh could not plot the route (HTTP {status}).')
        if time.monotonic() > deadline:
            raise PlotError('Spansh is taking too long. Try again in a moment.')
        sleep(POLL_EVERY_S)


#: The exact plotter's search strategies, as Spansh names them.
ALGORITHMS = ('optimistic', 'pessimistic', 'fuel', 'fuel_jumps', 'guided')


def plot_exact(source: str, destination: str, ship: Any, options: dict[str, Any] | None = None,
               request: Callable[[str, str], tuple[int, Any]] = _request,
               sleep: Callable[[float], None] = time.sleep) -> Route:
    """Plot normal jumps with Spansh's exact plotter. Blocks; call from a worker.

    `ship` is a `ship.Figures`. `options` are the plotter's own settings; any
    left out take Spansh's defaults. Checked live: Sol to Achenar in the
    commander's Corsair came back as 7 jumps with refuel stops marked.
    """
    o = options or {}
    algorithm = o.get('algorithm') if o.get('algorithm') in ALGORITHMS else 'optimistic'
    params: dict[str, Any] = {
        'source': source,
        'destination': destination,
        'is_supercharged': 1 if o.get('is_supercharged') else 0,
        'use_supercharge': 1 if o.get('use_supercharge') else 0,
        'use_injections': 1 if o.get('use_injections') else 0,
        'exclude_secondary': 1 if o.get('exclude_secondary') else 0,
        'refuel_every_scoopable': 0 if o.get('refuel_every_scoopable') is False else 1,
        'reserve_size': max(0.0, float(o.get('reserve_size') or 0)),
        'cargo': max(0, int(o.get('cargo') or 0)),
        'max_time': max(60, min(120, int(o.get('max_time') or 60))),
        'algorithm': algorithm,
        'injection_multiplier': 1,
        **ship.params(),
    }
    try:
        status, body = request(f'{API}/generic/route', 'POST', params)  # type: ignore[call-arg]
    except (urllib.error.URLError, OSError) as e:
        raise PlotError(f'Spansh could not be reached ({e}).') from e
    if status not in (200, 202) or not isinstance(body, dict) or 'job' not in body:
        message = body.get('error') if isinstance(body, dict) else None
        raise PlotError(message or f'Spansh refused the request (HTTP {status}).')
    # The plotter is allowed `max_time` seconds to search, then needs a moment.
    result = _await(str(body['job']), request, sleep, timeout=params['max_time'] + 60)
    route = Route.from_exact(result)
    if route.empty:
        raise PlotError('Spansh returned an empty route.')
    return route


def _await(job: str, request: Callable[..., tuple[int, Any]], sleep: Callable[[float], None],
           timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        try:
            status, body = request(f'{API}/results/{urllib.parse.quote(job)}', 'GET')
        except (urllib.error.URLError, OSError) as e:
            raise PlotError(f'Spansh could not be reached ({e}).') from e
        if status == 200 and isinstance(body, dict) and isinstance(body.get('result'), dict):
            return body['result']
        if status != 202:
            message = body.get('error') if isinstance(body, dict) else None
            raise PlotError(message or f'Spansh could not plot the route (HTTP {status}).')
        if time.monotonic() > deadline:
            raise PlotError('Spansh is taking too long. Try again in a moment.')
        sleep(POLL_EVERY_S)


def suggest(prefix: str, limit: int = 8,
            request: Callable[[str, str], tuple[int, Any]] = _request) -> list[str]:
    """System names starting with `prefix`, for predictive text. Blocks.

    Spansh answers `{"values": [...names...], "min_max": [...]}`. An exact
    match comes first, then names that start with what was typed, so "sol"
    offers Sol before Solati, and "wregoe fh-d d12-45" offers that system
    before Wregoe FH-D d12-9.
    """
    prefix = prefix.strip()
    if len(prefix) < 2:
        return []
    status, body = request(f'{API}/systems/field_values/system_names?q={urllib.parse.quote(prefix)}', 'GET')
    if status != 200 or not isinstance(body, dict):
        return []
    names = [v for v in body.get('values') or [] if isinstance(v, str)]
    if not names:
        names = [m.get('name') for m in body.get('min_max') or [] if isinstance(m, dict) and isinstance(m.get('name'), str)]
    low = prefix.lower()
    # The exact system first (so a fully typed name is offered back with
    # Frontier's casing), then names that start with the text, then the rest.
    names.sort(key=lambda n: (n.lower() != low, not n.lower().startswith(low), len(n), n.lower()))
    seen: set[str] = set()
    out = []
    for n in names:
        if n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return out[:limit]


def plot_in_background(source: str, destination: str, jump_range: float, efficiency: int,
                       done: Callable[[Route | None, str | None], None],
                       via: list[str] | None = None, supercharge: int = 4,
                       exact: tuple[Any, dict[str, Any]] | None = None) -> None:
    """Plot on a worker thread. `done(route, error)` is called on that thread.

    With `exact=(ship_figures, options)` it plots normal jumps with the exact
    plotter instead of a neutron route.
    """
    def work() -> None:
        try:
            if exact is not None:
                done(plot_exact(source, destination, exact[0], exact[1]), None)
            else:
                done(plot(source, destination, jump_range, efficiency, via=via, supercharge=supercharge), None)
        except PlotError as e:
            done(None, str(e))
        except Exception as e:  # never let a worker die silently
            done(None, f'Plotting failed: {e}')
    threading.Thread(target=work, name='router-plot', daemon=True).start()
