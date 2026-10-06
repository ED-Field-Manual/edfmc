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


def _request(url: str, method: str = 'GET') -> tuple[int, Any]:
    req = urllib.request.Request(url, method=method, headers={'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode('utf-8'))
        except ValueError:
            body = None
        return e.code, body


def plot(source: str, destination: str, jump_range: float, efficiency: int = 60,
         request: Callable[[str, str], tuple[int, Any]] = _request,
         sleep: Callable[[float], None] = time.sleep) -> Route:
    """Plot a neutron route. Blocks; call it from a worker thread."""
    query = urllib.parse.urlencode({
        'efficiency': efficiency,
        'range': f'{jump_range:.2f}',
        'from': source,
        'to': destination,
    })
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


def plot_in_background(source: str, destination: str, jump_range: float, efficiency: int,
                       done: Callable[[Route | None, str | None], None]) -> None:
    """Plot on a worker thread. `done(route, error)` is called on that thread."""
    def work() -> None:
        try:
            done(plot(source, destination, jump_range, efficiency), None)
        except PlotError as e:
            done(None, str(e))
        except Exception as e:  # never let a worker die silently
            done(None, f'Plotting failed: {e}')
    threading.Thread(target=work, name='router-plot', daemon=True).start()
