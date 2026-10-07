"""
Router as a native EDFM Companion page.

Inside EDFM Companion, Router does not draw a tkinter panel. It registers a
page (`edfmc.register_page`), publishes its state as plain JSON whenever it
changes, and the app draws the Router tab itself: it scrolls, resizes and moves
with the window like every other page. The commander's input comes back as
actions (`plot`, `suggest`, `copy`, `step`, `clear`, `import`).

The route logic is the same as the tkinter panel's (`route.py`, `spansh.py`);
only who draws it differs. In EDMC this module is never used.
"""

from __future__ import annotations

import queue
import threading
import tkinter as tk
from tkinter import filedialog
from typing import Any, Callable

from . import bridge, spansh
from .route import Route

POLL_MS = 150
KIND = 'router-v1'


class NativePage:
    def __init__(self, register: Callable[[Callable[[str, dict], None]], Any], route: Route, *,
                 current_system: Callable[[], str | None], current_address: Callable[[], int | None],
                 jump_range: Callable[[], float | None], efficiency: Callable[[], int],
                 set_efficiency: Callable[[int], None], auto_copy: Callable[[], bool],
                 changed: Callable[[], None]) -> None:
        self.route = route
        self._current_system = current_system
        self._current_address = current_address
        self._jump_range = jump_range
        self._efficiency = efficiency
        self._set_efficiency = set_efficiency
        self._auto_copy = auto_copy
        self._changed = changed
        self.plotting = False
        self.status: dict[str, Any] = {'text': '', 'error': False}
        self.suggestions: dict[str, Any] | None = None
        self._done: queue.Queue[Callable[[], None]] = queue.Queue()
        self._polling = False
        self._outstanding = 0
        self.page = register(self.on_action)
        self.push()

    # -- the main thread ---------------------------------------------------

    @staticmethod
    def _root() -> tk.Misc | None:
        return getattr(tk, '_default_root', None)

    def _later(self, fn: Callable[[], None]) -> None:
        """Hand a result to the main thread. Called from worker threads only.

        Workers never touch tkinter, not even `after`: Tk refuses calls from
        other threads. They only queue; `_drain`, scheduled from the main
        thread by `_watch`, runs what they queued.
        """
        self._done.put(fn)

    def _watch(self) -> None:
        """From the main thread: poll for worker results until none are due."""
        self._outstanding += 1
        if not self._polling:
            root = self._root()
            if root is not None:
                self._polling = True
                root.after(POLL_MS, self._drain)

    def _drain(self) -> None:
        self._polling = False
        while True:
            try:
                fn = self._done.get_nowait()
            except queue.Empty:
                break
            self._outstanding = max(0, self._outstanding - 1)
            fn()
        if self._outstanding > 0:
            root = self._root()
            if root is not None:
                self._polling = True
                root.after(POLL_MS, self._drain)

    # -- state -------------------------------------------------------------

    def state(self) -> dict[str, Any]:
        r = self.route
        route = None
        if not r.empty:
            s = bridge.summary(r) or {}
            last = len(r.waypoints) - 1
            done = max(min(r.next_index, len(r.waypoints)) - 1, 0)
            route = {
                **{k: s.get(k) for k in ('next', 'nextIsNeutron', 'destination', 'jumpsLeft',
                                         'waypoint', 'waypoints', 'finished')},
                'progress': 1.0 if r.finished else (done / last if last > 0 else 0.0),
            }
        return {
            'kind': KIND,
            'currentSystem': self._current_system(),
            'jumpRange': self._jump_range(),
            'efficiency': self._efficiency(),
            'plotting': self.plotting,
            'status': self.status,
            'route': route,
            'suggestions': self.suggestions,
        }

    def push(self) -> None:
        try:
            self.page.update(self.state())
        except Exception:
            pass
        bridge.publish(self.route)

    def say(self, text: str, error: bool = False) -> None:
        self.status = {'text': text, 'error': error}

    # -- actions -----------------------------------------------------------

    def on_action(self, name: str, args: dict) -> None:
        handler = {
            'plot': self._plot, 'suggest': self._suggest, 'copy': self._copy,
            'step': self._step, 'clear': self._clear, 'import': self._import,
        }.get(name)
        if handler is not None:
            handler(args)

    def _plot(self, args: dict) -> None:
        source = str(args.get('source') or '').strip()
        destination = str(args.get('destination') or '').strip()
        try:
            jump_range = float(args.get('range') or 0)
        except (TypeError, ValueError):
            jump_range = 0
        try:
            efficiency = max(1, min(100, int(args.get('efficiency') or self._efficiency())))
        except (TypeError, ValueError):
            efficiency = self._efficiency()
        if not source or not destination:
            self.say('Enter where to plot from and to.', error=True)
        elif jump_range <= 0:
            self.say('Enter your jump range in light years.', error=True)
        elif not self.plotting:
            self._set_efficiency(efficiency)
            self.plotting = True
            self.suggestions = None
            self.say('Plotting your route… please wait. Long routes can take up to a minute.')
            spansh.plot_in_background(source, destination, jump_range, efficiency,
                                      lambda route, error: self._later(lambda: self._plotted(route, error)))
            self._watch()
        self.push()

    def _plotted(self, route: Route | None, error: str | None) -> None:
        self.plotting = False
        if error or route is None:
            self.say(error or 'Spansh returned no route.', error=True)
        else:
            route.start_from(self._current_system(), self._current_address())
            self._set_route(route)
            self.say(f'Route plotted: {len(route.waypoints)} waypoints, {route.total_jumps()} jumps.')
            if self._auto_copy():
                self._copy({'quiet': True})
        self.push()

    def _suggest(self, args: dict) -> None:
        field = str(args.get('field') or '')
        text = str(args.get('text') or '')

        def work() -> None:
            try:
                names = spansh.suggest(text)
            except Exception:
                names = []
            self._later(lambda: self._suggested(field, text, names))

        threading.Thread(target=work, name='router-suggest', daemon=True).start()
        self._watch()

    def _suggested(self, field: str, text: str, names: list[str]) -> None:
        self.suggestions = {'field': field, 'text': text, 'names': names}
        self.push()

    def _copy(self, args: dict) -> None:
        nxt = self.route.next
        root = self._root()
        if nxt is None or root is None:
            return
        root.clipboard_clear()
        root.clipboard_append(nxt.system)
        if not args.get('quiet'):
            self.say(f'Copied {nxt.system} to the clipboard.')
            self.push()

    def _step(self, args: dict) -> None:
        try:
            delta = int(args.get('delta') or 0)
        except (TypeError, ValueError):
            return
        self.route.step(delta)
        self._changed()
        if self._auto_copy():
            self._copy({'quiet': True})
        self.push()

    def _clear(self, args: dict) -> None:
        self._set_route(Route())
        self.say('')
        self.push()

    def _import(self, args: dict) -> None:
        path = filedialog.askopenfilename(title='Import a route',
                                          filetypes=[('Spansh route (CSV)', '*.csv'), ('All files', '*.*')])
        if not path:
            return
        try:
            with open(path, encoding='utf-8-sig') as fh:
                route = Route.from_csv(fh.read())
        except (OSError, ValueError) as e:
            self.say(f'Could not import that file: {e}', error=True)
            self.push()
            return
        route.start_from(self._current_system(), self._current_address())
        self._set_route(route)
        self.say(f'Imported {len(route.waypoints)} waypoints.')
        self.push()

    def _set_route(self, route: Route) -> None:
        self.route = route
        self._changed()

    # -- the game ----------------------------------------------------------

    def arrived(self, system: str | None, address: int | None) -> None:
        if self.route.arrived(system, address):
            self._changed()
            if self._auto_copy() and self.route.next is not None:
                self._copy({'quiet': True})
                self.say(f'Next waypoint copied: {self.route.next.system}')
        self.push()

    def located(self) -> None:
        self.push()
