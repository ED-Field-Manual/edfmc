"""
Optional extras when running inside EDFM Companion.

EDFM Companion's plugin host provides an `edfmc` module; other hosts do not.
Everything here is a no-op without it, so the plugin behaves identically in
EDMC and simply gains the overlay widget in EDFM Companion.
"""

from __future__ import annotations

from typing import Any

from .route import Route

try:
    import edfmc  # type: ignore[import-not-found]
except ImportError:
    edfmc = None


def available() -> bool:
    return edfmc is not None and hasattr(edfmc, 'publish')


def summary(route: Route) -> dict[str, Any] | None:
    """What the overlay shows. None when there is no route to show."""
    if route.empty:
        return None
    nxt = route.next
    dest = route.destination
    return {
        'next': nxt.system if nxt else None,
        'nextIsNeutron': bool(nxt and nxt.neutron),
        'destination': dest.system if dest else None,
        'jumpsLeft': route.jumps_left(),
        'totalJumps': route.total_jumps(),
        'waypoint': min(route.next_index + 1, len(route.waypoints)),
        'waypoints': len(route.waypoints),
        'distanceLeft': nxt.distance_left if nxt else 0,
        'finished': route.finished,
    }


def overlay(route: Route, carrier: Route | None = None) -> dict[str, Any] | None:
    """The ship route's summary, with the carrier route's under `carrier`.

    Either may be absent. None when there is nothing to show at all.
    """
    ship = summary(route)
    fc = summary(carrier) if carrier is not None else None
    if ship is None and fc is None:
        return None
    out: dict[str, Any] = dict(ship) if ship is not None else {'next': None, 'finished': False, 'noShipRoute': True}
    if fc is not None:
        out['carrier'] = {k: fc[k] for k in ('next', 'destination', 'jumpsLeft', 'finished')}
    return out


def publish(route: Route, carrier: Route | None = None) -> None:
    if not available():
        return
    try:
        edfmc.publish('route', overlay(route, carrier))
    except Exception:
        # The overlay is a convenience; the plugin must keep working without it.
        pass
