"""
Construction Logistics: colonisation construction tracking, hauling plans,
sourcing and an in-game overlay, as one plugin.

Runs in EDFM Companion and in EDMC.

- In EDFM Companion the app draws its tab (`edfmc.register_page`, page kind
  `ui-v1`) and an overlay panel (`edfmc.register_overlay`), and its data lives
  in EDFMC's plugin-data folder. There is no tkinter window.
- In EDMC, which has no `edfmc`, it shows a small text panel in EDMC's window
  and keeps its data in its own folder.

The work is all in `logistics_core`; this file only connects it to the host.
"""

from __future__ import annotations

import os
import sys
import tkinter as tk
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from logistics_core.app import Controller  # noqa: E402

try:
    import edfmc  # type: ignore[import-not-found]  # EDFM Companion only
except ImportError:
    edfmc = None

try:
    from config import config  # provided by the host
except ImportError:  # pragma: no cover - outside a host
    config = None

try:
    from monitor import monitor  # provided by the host: what it knows of the game
except ImportError:  # pragma: no cover
    monitor = None

__version__ = '1.0.0'
NAME = 'Construction Logistics'

_state: dict[str, Any] = {'controller': None, 'label': None}


def _game(cmdr: str | None = None, state: dict[str, Any] | None = None) -> dict[str, Any]:
    game = dict(state if state is not None else (getattr(monitor, 'state', None) or {}))
    game['Commander'] = cmdr or getattr(monitor, 'cmdr', None)
    return game


def _schedule(ms: int, fn) -> None:
    """Run `fn` later on the main thread (tkinter's loop exists in both hosts)."""
    root = getattr(tk, '_default_root', None)
    if root is not None:
        root.after(ms, fn)


def _journal_dir() -> str | None:
    state = getattr(monitor, 'state', None) or {}
    return state.get('JournalDir') or (getattr(config, 'default_journal_dir_path', None) if config else None)


def plugin_start3(plugin_dir: str) -> str:
    native = edfmc is not None and hasattr(edfmc, 'register_page') and hasattr(edfmc, 'register_overlay')
    if native:
        data_dir = edfmc.data_dir()
        page = edfmc.register_page(lambda name, args: _state['controller'].on_action(name, args))
        panel = edfmc.register_overlay('Construction')
        show_page, show_overlay = page.update, panel.update
        # EDFMC's database, for the one-time import of its old Logistics page.
        app_dir = getattr(config, 'app_dir_path', None) if config else None
        edfmc_db = os.path.join(os.path.dirname(os.path.abspath(app_dir)), 'edfm-companion.db') if app_dir else None
    else:
        data_dir = os.path.join(plugin_dir, 'data')
        show_page = show_overlay = None
        edfmc_db = None

    agent = getattr(config, 'user_agent', None) if config else None
    controller = Controller(
        data_dir=data_dir,
        plugin_dir=os.path.dirname(plugin_dir),
        journal_dir=_journal_dir(),
        edfmc_db=edfmc_db,
        user_agent=f'{agent or "EDMC"} ConstructionLogistics/{__version__}',
        show_page=show_page,
        show_overlay=show_overlay,
        schedule=_schedule,
    )
    _state['controller'] = controller
    controller.start(_game())
    return NAME


def plugin_stop() -> None:
    if _state['controller'] is not None:
        _state['controller'].stop()


def journal_entry(cmdr: str, is_beta: bool, system: str | None, station: str | None,
                  entry: dict[str, Any], state: dict[str, Any]) -> None:
    controller = _state['controller']
    if controller is None or is_beta:
        return  # beta journals are not the live galaxy
    if controller.journal_dir is None:
        controller.journal_dir = _journal_dir()
    controller.journal_entry(entry, _game(cmdr, state))
    _refresh_label()


def plugin_app(parent: tk.Frame) -> tk.Frame | None:
    """EDMC only: EDFM Companion draws the page itself and never calls this."""
    frame = tk.Frame(parent)
    label = tk.Label(frame, justify=tk.LEFT, anchor=tk.W)
    label.grid(row=0, column=0, sticky=tk.W)
    _state['label'] = label
    _refresh_label()
    return frame


def _refresh_label() -> None:
    label = _state.get('label')
    controller = _state.get('controller')
    if label is not None and controller is not None:
        label['text'] = '\n'.join(controller.summary_lines())
