"""
The panel: plot a route, then follow it.

tkinter only, and only from the main thread. Plotting happens on a worker
thread (`spansh.plot_in_background`), which hands its result back through a
queue the panel polls, so a slow Spansh never freezes the window.
"""

from __future__ import annotations

import queue
import tkinter as tk
from tkinter import filedialog, messagebox
from typing import Callable

from . import bridge, spansh
from .route import Route

POLL_MS = 200


class Panel:
    def __init__(self, parent: tk.Misc, route: Route, *, current_system: Callable[[], str | None],
                 current_address: Callable[[], int | None], jump_range: Callable[[], float | None],
                 efficiency: Callable[[], int], auto_copy: Callable[[], bool],
                 changed: Callable[[], None]) -> None:
        self.route = route
        self._current_system = current_system
        self._current_address = current_address
        self._jump_range = jump_range
        self._efficiency = efficiency
        self._auto_copy = auto_copy
        self._changed = changed
        self._results: queue.Queue[tuple[Route | None, str | None]] = queue.Queue()
        self.plotting = False

        self.frame = tk.Frame(parent)
        self.frame.columnconfigure(1, weight=1)

        # --- plotting -----------------------------------------------------
        self.plot_frame = tk.Frame(self.frame)
        self.plot_frame.columnconfigure(1, weight=1)
        self.source = tk.StringVar()
        self.destination = tk.StringVar()
        self.range = tk.StringVar()
        for row, (label, var) in enumerate((('From', self.source), ('To', self.destination),
                                            ('Jump range (ly)', self.range))):
            tk.Label(self.plot_frame, text=label).grid(row=row, column=0, sticky=tk.W, padx=(0, 6))
            tk.Entry(self.plot_frame, textvariable=var).grid(row=row, column=1, sticky=tk.EW, pady=1)
        buttons = tk.Frame(self.plot_frame)
        buttons.grid(row=3, column=0, columnspan=2, sticky=tk.W, pady=(4, 0))
        self.plot_button = tk.Button(buttons, text='Plot route', command=self.plot)
        self.plot_button.pack(side=tk.LEFT)
        tk.Button(buttons, text='Import CSV…', command=self.import_csv).pack(side=tk.LEFT, padx=(6, 0))

        # --- following ----------------------------------------------------
        self.follow_frame = tk.Frame(self.frame)
        self.follow_frame.columnconfigure(1, weight=1)
        tk.Label(self.follow_frame, text='Next').grid(row=0, column=0, sticky=tk.W, padx=(0, 6))
        self.next_label = tk.Label(self.follow_frame, text='', cursor='hand2', anchor=tk.W,
                                   font=('TkDefaultFont', 11, 'bold'))
        self.next_label.grid(row=0, column=1, sticky=tk.EW)
        self.next_label.bind('<Button-1>', lambda _e: self.copy_next())
        self.progress_label = tk.Label(self.follow_frame, text='', anchor=tk.W, justify=tk.LEFT)
        self.progress_label.grid(row=1, column=0, columnspan=2, sticky=tk.EW)
        nav = tk.Frame(self.follow_frame)
        nav.grid(row=2, column=0, columnspan=2, sticky=tk.W, pady=(4, 0))
        tk.Button(nav, text='◀', width=3, command=lambda: self.step(-1)).pack(side=tk.LEFT)
        tk.Button(nav, text='Copy', command=self.copy_next).pack(side=tk.LEFT, padx=(4, 0))
        tk.Button(nav, text='▶', width=3, command=lambda: self.step(1)).pack(side=tk.LEFT, padx=(4, 0))
        tk.Button(nav, text='Clear route', command=self.clear).pack(side=tk.LEFT, padx=(12, 0))

        self.status = tk.Label(self.frame, text='', anchor=tk.W, justify=tk.LEFT, wraplength=320)
        self.status.grid(row=2, column=0, columnspan=2, sticky=tk.EW)

        self.refresh()
        self.frame.after(POLL_MS, self._poll)

    # -- showing -----------------------------------------------------------

    def refresh(self) -> None:
        if self.route.empty:
            self.follow_frame.grid_remove()
            self.plot_frame.grid(row=0, column=0, columnspan=2, sticky=tk.EW)
            if not self.source.get():
                self.source.set(self._current_system() or '')
            if not self.range.get():
                r = self._jump_range()
                self.range.set(f'{r:.2f}' if r else '')
        else:
            self.plot_frame.grid_remove()
            self.follow_frame.grid(row=0, column=0, columnspan=2, sticky=tk.EW)
            nxt = self.route.next
            dest = self.route.destination
            if nxt is None:
                self.next_label.config(text='Arrived')
                self.progress_label.config(text=f'You have reached {dest.system if dest else "the destination"}.')
            else:
                self.next_label.config(text=nxt.system + ('  (neutron)' if nxt.neutron else ''))
                self.progress_label.config(text=(
                    f'Waypoint {self.route.next_index + 1} of {len(self.route.waypoints)} · '
                    f'{self.route.jumps_left()} jumps left · to {dest.system if dest else "?"}'))
        bridge.publish(self.route)

    def say(self, text: str) -> None:
        self.status.config(text=text)

    # -- actions -----------------------------------------------------------

    def plot(self) -> None:
        source = self.source.get().strip()
        destination = self.destination.get().strip()
        try:
            jump_range = float(self.range.get().strip())
        except ValueError:
            jump_range = 0
        if not source or not destination:
            self.say('Enter where to plot from and to.')
            return
        if jump_range <= 0:
            self.say('Enter your jump range in light years.')
            return
        self.plotting = True
        self.plot_button.config(state=tk.DISABLED, text='Plotting…')
        self.say('Asking Spansh for a route…')
        spansh.plot_in_background(source, destination, jump_range, self._efficiency(),
                                  lambda route, error: self._results.put((route, error)))

    def _poll(self) -> None:
        try:
            route, error = self._results.get_nowait()
        except queue.Empty:
            pass
        else:
            self.plotting = False
            self.plot_button.config(state=tk.NORMAL, text='Plot route')
            if error:
                self.say(error)
            elif route is not None:
                route.start_from(self._current_system(), self._current_address())
                self.set_route(route)
                self.say(f'Route plotted: {len(route.waypoints)} waypoints, {route.total_jumps()} jumps.')
                if self._auto_copy():
                    self.copy_next(quiet=True)
        try:
            self.frame.after(POLL_MS, self._poll)
        except tk.TclError:
            pass  # the window is gone

    def import_csv(self) -> None:
        path = filedialog.askopenfilename(
            parent=self.frame, title='Import a route',
            filetypes=[('Spansh route (CSV)', '*.csv'), ('All files', '*.*')])
        if not path:
            return
        try:
            with open(path, encoding='utf-8-sig') as f:
                route = Route.from_csv(f.read())
        except (OSError, ValueError) as e:
            self.say(f'Could not import that file: {e}')
            return
        route.start_from(self._current_system(), self._current_address())
        self.set_route(route)
        self.say(f'Imported {len(route.waypoints)} waypoints.')

    def set_route(self, route: Route) -> None:
        self.route = route
        self._changed()
        self.refresh()

    def step(self, delta: int) -> None:
        self.route.step(delta)
        self._changed()
        self.refresh()
        if self._auto_copy():
            self.copy_next(quiet=True)

    def clear(self) -> None:
        if not messagebox.askyesno('Router', 'Clear the current route?', parent=self.frame):
            return
        self.set_route(Route())
        self.say('')

    def copy_next(self, quiet: bool = False) -> None:
        nxt = self.route.next
        if nxt is None:
            return
        self.frame.clipboard_clear()
        self.frame.clipboard_append(nxt.system)
        if not quiet:
            self.say(f'Copied {nxt.system} to the clipboard.')

    # -- the game ----------------------------------------------------------

    def arrived(self, system: str | None, address: int | None) -> None:
        if self.route.arrived(system, address):
            self._changed()
            self.refresh()
            if self._auto_copy() and self.route.next is not None:
                self.copy_next(quiet=True)
                self.say(f'Next waypoint copied: {self.route.next.system}')
        elif self.route.empty and not self.plotting:
            # Keep "From" current while no route is set.
            self.source.set(system or '')
