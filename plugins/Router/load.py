"""
Router: plot a neutron route with Spansh and follow it, waypoint by waypoint.

A standard plugin for Elite Dangerous companion apps. It runs unchanged in EDMC
and in EDFM Companion; in EDFM Companion it also shows the route in the game
overlay.

The plugin entry points below are the interface both hosts call. Everything
else lives in the `router_core` package next to this file.
"""

from __future__ import annotations

import json
import os
import sys
import tkinter as tk
from typing import Any

# Make the `router_core` package importable however the host loads this file.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from router_core import bridge  # noqa: E402
from router_core.native import NativePage  # noqa: E402
from router_core.panel import Panel  # noqa: E402
from router_core.route import Route  # noqa: E402

plugin_name = 'Router'
plugin_version = '0.4.0'

try:
    from config import config  # provided by the host
except ImportError:  # running outside a host, e.g. in tests
    config = None

try:
    import myNotebook as nb  # provided by the host, for the settings tab
except ImportError:
    nb = None

try:
    from monitor import monitor  # provided by the host: what it knows of the game
except ImportError:
    monitor = None

_state: dict[str, Any] = {
    'dir': _HERE,
    'route': Route(),
    'panel': None,
    'system': None,
    'address': None,
}


def _route_path() -> str:
    return os.path.join(_state['dir'], 'route.json')


def _save() -> None:
    try:
        _state['route'].save(_route_path())
    except OSError:
        pass


def _get(key: str, default: Any) -> Any:
    if config is None:
        return default
    try:
        if isinstance(default, bool):
            v = config.get_int(f'router_{key}', default=int(default))
            return bool(v)
        if isinstance(default, int):
            return config.get_int(f'router_{key}', default=default)
        v = config.get_str(f'router_{key}', default=None)
        return default if v is None else v
    except Exception:
        return default


def _set(key: str, value: Any) -> None:
    if config is None:
        return
    try:
        config.set(f'router_{key}', int(value) if isinstance(value, bool) else value)
    except Exception:
        pass


def _jump_range() -> float | None:
    try:
        return float(_get('range', ''))
    except ValueError:
        return None


def _where_am_i() -> None:
    """Learn the current system (and jump range) before the next jump.

    Hosts load plugins after the game is already running, and the next
    `journal_entry` may be a whole jump away. Both EDMC and EDFM Companion keep
    the current system in `monitor.state`; the jump range is only in the
    journal, so the newest `Loadout` in the current journal is read for it.
    """
    if monitor is None:
        return
    state = getattr(monitor, 'state', None) or {}
    name = state.get('SystemName') or getattr(monitor, 'system', None)
    if isinstance(name, str) and name:
        _state['system'] = name
        address = state.get('SystemAddress') or getattr(monitor, 'systemaddress', None)
        _state['address'] = address if isinstance(address, int) else None
    if _jump_range() is None:
        path = getattr(monitor, 'logfile', None)
        jump = _last_loadout_range(path) if isinstance(path, str) else None
        if jump:
            _set('range', f'{jump:.2f}')


def _last_loadout_range(path: str) -> float | None:
    """MaxJumpRange from the newest Loadout in a journal file. Read only."""
    found = None
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                if '"event":"Loadout"' not in line.replace(' ', ''):
                    continue
                try:
                    v = json.loads(line).get('MaxJumpRange')
                except ValueError:
                    continue
                if isinstance(v, (int, float)) and v > 0:
                    found = float(v)
    except OSError:
        return None
    return found


# --- entry points --------------------------------------------------------

def _route_changed() -> None:
    _state['route'] = _state['panel'].route
    _save()


def _hooks() -> dict[str, Any]:
    return dict(
        current_system=lambda: _state['system'],
        current_address=lambda: _state['address'],
        jump_range=_jump_range,
        efficiency=lambda: max(1, min(100, _get('efficiency', 60))),
        set_efficiency=lambda v: _set('efficiency', v),
        supercharge=lambda: 6 if _get('supercharge', 4) == 6 else 4,
        set_supercharge=lambda v: _set('supercharge', v),
        auto_copy=lambda: _get('autocopy', True),
        changed=_route_changed,
    )


def plugin_start3(plugin_dir: str) -> str:
    _state['dir'] = plugin_dir
    _state['route'] = Route.load(_route_path())
    _where_am_i()
    # In EDFM Companion the app draws Router's tab natively from the state
    # published here, instead of hosting a tkinter panel. Elsewhere there is no
    # `edfmc`, and plugin_app draws the panel as usual.
    if bridge.edfmc is not None and hasattr(bridge.edfmc, 'register_page'):
        _state['panel'] = NativePage(bridge.edfmc.register_page, _state['route'], **_hooks())
    return plugin_name


def plugin_stop() -> None:
    _save()


def plugin_app(parent: tk.Frame) -> tk.Frame | None:
    if isinstance(_state['panel'], NativePage):
        return None  # drawn by EDFM Companion itself
    panel = Panel(parent, _state['route'], **_hooks())
    _state['panel'] = panel
    return panel.frame


def plugin_prefs(parent: Any, cmdr: str, is_beta: bool) -> Any:
    if nb is None:
        return None
    frame = nb.Frame(parent)
    _state['pref_autocopy'] = tk.IntVar(value=int(_get('autocopy', True)))
    _state['pref_efficiency'] = tk.StringVar(value=str(_get('efficiency', 60)))
    nb.Checkbutton(frame, text='Copy the next waypoint to the clipboard automatically',
                   variable=_state['pref_autocopy']).grid(row=0, column=0, columnspan=2, sticky=tk.W, padx=10, pady=(10, 4))
    nb.Label(frame, text='Route efficiency (1-100)').grid(row=1, column=0, sticky=tk.W, padx=10)
    nb.EntryMenu(frame, textvariable=_state['pref_efficiency'], width=6).grid(row=1, column=1, sticky=tk.W)
    nb.Label(frame, text='Higher stays closer to a straight line; lower allows more neutron detours.'
             ).grid(row=2, column=0, columnspan=2, sticky=tk.W, padx=10, pady=(2, 10))
    return frame


def prefs_changed(cmdr: str, is_beta: bool) -> None:
    if 'pref_autocopy' in _state:
        _set('autocopy', bool(_state['pref_autocopy'].get()))
    try:
        _set('efficiency', max(1, min(100, int(_state['pref_efficiency'].get()))))
    except (KeyError, ValueError):
        pass


def journal_entry(cmdr: str, is_beta: bool, system: str | None, station: str | None,
                  entry: dict[str, Any], state: dict[str, Any]) -> None:
    event = entry.get('event')

    # Jump range: the game states it on every Loadout (login, outfitting, ship swap).
    if event == 'Loadout' and isinstance(entry.get('MaxJumpRange'), (int, float)):
        _set('range', f"{entry['MaxJumpRange']:.2f}")
        panel = _state['panel']
        if isinstance(panel, NativePage):
            panel.push()
        elif panel is not None and _state['route'].empty:
            panel.range_var.set(f"{entry['MaxJumpRange']:.2f}")

    if event in ('Location', 'FSDJump', 'CarrierJump'):
        _state['system'] = entry.get('StarSystem')
        _state['address'] = entry.get('SystemAddress')
        panel = _state['panel']
        if panel is not None:
            panel.arrived(_state['system'], _state['address'])
        else:
            if _state['route'].arrived(_state['system'], _state['address']):
                _save()
    elif _state['system'] is None and system:
        # Started mid-session: the host knows the system even before a jump.
        _state['system'] = system
        _state['address'] = state.get('SystemAddress') if isinstance(state, dict) else None
        if _state['panel'] is not None:
            _state['panel'].located()
