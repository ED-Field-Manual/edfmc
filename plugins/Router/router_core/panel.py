"""
The panel: plot a route, then follow it.

tkinter only, and only from the main thread. Plotting and name suggestions
happen on worker threads and hand their results back through queues the panel
polls, so a slow Spansh never freezes the window.

Two views share the panel. With no route it is a short form (From, To, jump
range, efficiency). With a route it leads with the one thing a commander needs
mid-flight, the next system, then progress and the controls.
"""

from __future__ import annotations

import queue
import tkinter as tk
from tkinter import filedialog, messagebox
from typing import Callable

from . import bridge, spansh, style
from .route import Route
from .suggest import SuggestEntry

POLL_MS = 200
PAD = 12


class Panel:
    def __init__(self, parent: tk.Misc, route: Route, *, current_system: Callable[[], str | None],
                 current_address: Callable[[], int | None], jump_range: Callable[[], float | None],
                 efficiency: Callable[[], int], set_efficiency: Callable[[int], None],
                 auto_copy: Callable[[], bool], changed: Callable[[], None]) -> None:
        self.route = route
        self._current_system = current_system
        self._current_address = current_address
        self._jump_range = jump_range
        self._efficiency = efficiency
        self._set_efficiency = set_efficiency
        self._auto_copy = auto_copy
        self._changed = changed
        self._results: queue.Queue[tuple[Route | None, str | None]] = queue.Queue()
        self.plotting = False
        #: The system the panel last filled into "From" itself. While the box
        #: still holds it, it follows the commander; once they type their own
        #: start, it is left alone.
        self._auto_source: str | None = None

        p = self.p = style.palette()
        f = self.f = style.Fonts(parent)

        self.frame = style.frame(parent, p)
        self.frame.columnconfigure(0, weight=1)

        self._build_form(p, f)
        self._build_follow(p, f)

        self.status = style.label(self.frame, '', p, f.small, muted=True, wraplength=420)
        self.status.grid(row=2, column=0, sticky=tk.EW, padx=PAD, pady=(6, PAD))
        self.frame.bind('<Configure>', lambda e: self.status.configure(wraplength=max(e.width - 2 * PAD, 200)))

        self.refresh()
        self.frame.after(POLL_MS, self._poll)

    # -- building ------------------------------------------------------------

    def _field(self, parent: tk.Misc, row: int, col: int, caption: str, colspan: int = 1) -> int:
        style.label(parent, caption.upper(), self.p, self.f.caption, muted=True).grid(
            row=row, column=col, columnspan=colspan, sticky=tk.W, pady=(8, 2), padx=(0, 8 if col == 0 and colspan == 1 else 0))
        return row + 1

    def _plain_entry(self, parent: tk.Misc, var: tk.StringVar, width: int) -> tk.Entry:
        e = tk.Entry(parent, textvariable=var, width=width, font=self.f.body)
        if self.p.surface is not None:
            e.configure(relief=tk.FLAT, bd=0, bg=self.p.raised, fg=self.p.text, insertbackground=self.p.text,
                        highlightthickness=1, highlightbackground=self.p.line, highlightcolor=self.p.accent)
        return e

    def _build_form(self, p: style.Palette, f: style.Fonts) -> None:
        self.form = style.frame(self.frame, p)
        self.form.columnconfigure(0, weight=1)
        self.form.columnconfigure(1, weight=1)

        style.label(self.form, 'Plot a route', p, f.title).grid(row=0, column=0, columnspan=2, sticky=tk.W)
        style.label(self.form, 'Neutron-boosted routes from Spansh. Start typing a system name for suggestions.',
                    p, f.small, muted=True).grid(row=1, column=0, columnspan=2, sticky=tk.W, pady=(2, 4))

        self.source_var = tk.StringVar()
        self.destination_var = tk.StringVar()
        self.range_var = tk.StringVar()
        self.efficiency_var = tk.StringVar(value=str(self._efficiency()))

        row = self._field(self.form, 2, 0, 'From', colspan=2)
        from_row = style.frame(self.form, p)
        from_row.grid(row=row, column=0, columnspan=2, sticky=tk.EW)
        from_row.columnconfigure(0, weight=1)
        self.source = SuggestEntry(from_row, self.source_var, p, f)
        self.source.grid(row=0, column=0, sticky=tk.EW, ipady=4)
        self.here_button = style.button(from_row, 'Current system', self.use_current, 'quiet', p, f)
        self.here_button.grid(row=0, column=1, sticky=tk.E, padx=(6, 0))

        row = self._field(self.form, row + 1, 0, 'To', colspan=2)
        self.destination = SuggestEntry(self.form, self.destination_var, p, f)
        self.destination.grid(row=row, column=0, columnspan=2, sticky=tk.EW, ipady=4)

        row += 1
        self._field(self.form, row, 0, 'Jump range (ly)')
        self._field(self.form, row, 1, 'Efficiency (%)')
        self._plain_entry(self.form, self.range_var, 10).grid(row=row + 1, column=0, sticky=tk.EW, ipady=4, padx=(0, 8))
        self._plain_entry(self.form, self.efficiency_var, 10).grid(row=row + 1, column=1, sticky=tk.EW, ipady=4)

        actions = style.frame(self.form, p)
        actions.grid(row=row + 2, column=0, columnspan=2, sticky=tk.W, pady=(14, 0))
        self.plot_button = style.button(actions, 'Plot route', self.plot, 'primary', p, f)
        self.plot_button.pack(side=tk.LEFT)
        style.button(actions, 'Import CSV…', self.import_csv, 'secondary', p, f).pack(side=tk.LEFT, padx=(8, 0))

    def _build_follow(self, p: style.Palette, f: style.Fonts) -> None:
        self.follow = style.frame(self.frame, p)
        self.follow.columnconfigure(0, weight=1)

        style.label(self.follow, 'NEXT WAYPOINT', p, f.caption, muted=True).grid(row=0, column=0, sticky=tk.W)
        head = style.frame(self.follow, p)
        head.grid(row=1, column=0, sticky=tk.EW, pady=(2, 0))
        head.columnconfigure(0, weight=1)
        self.next_label = style.label(head, '', p, f.title, cursor='hand2')
        self.next_label.grid(row=0, column=0, sticky=tk.W)
        self.next_label.bind('<Button-1>', lambda _e: self.copy_next())
        self.neutron_badge = tk.Label(head, text='NEUTRON', font=f.caption, padx=6, pady=1,
                                      bg=p.accent, fg=p.on_accent)
        self.neutron_badge.grid(row=0, column=1, sticky=tk.E, padx=(8, 0))
        style.button(head, 'Copy', self.copy_next, 'secondary', p, f).grid(row=0, column=2, sticky=tk.E, padx=(8, 0))

        self.bar = tk.Canvas(self.follow, height=6, highlightthickness=0, bd=0)
        style.colour(self.bar, bg=p.surface)
        self.bar.grid(row=2, column=0, sticky=tk.EW, pady=(10, 10))
        self.bar.bind('<Configure>', lambda _e: self._draw_bar())

        stats = style.frame(self.follow, p)
        stats.grid(row=3, column=0, sticky=tk.EW)
        self.stat_values: dict[str, tk.Label] = {}
        for col, key in enumerate(('Jumps left', 'Waypoint', 'Destination')):
            stats.columnconfigure(col, weight=1 if key == 'Destination' else 0)
            style.label(stats, key.upper(), p, f.caption, muted=True).grid(row=0, column=col, sticky=tk.W, padx=(0, 24))
            v = style.label(stats, '', p, f.stat)
            v.grid(row=1, column=col, sticky=tk.W, padx=(0, 24))
            self.stat_values[key] = v

        nav = style.frame(self.follow, p)
        nav.grid(row=4, column=0, sticky=tk.EW, pady=(14, 0))
        nav.columnconfigure(2, weight=1)
        style.button(nav, '◀  Previous', lambda: self.step(-1), 'secondary', p, f).grid(row=0, column=0)
        style.button(nav, 'Next  ▶', lambda: self.step(1), 'secondary', p, f).grid(row=0, column=1, padx=(8, 0))
        style.button(nav, 'Clear route', self.clear, 'quiet', p, f).grid(row=0, column=3, sticky=tk.E)

    def _draw_bar(self) -> None:
        self.bar.delete('all')
        w = max(self.bar.winfo_width(), 1)
        total = len(self.route.waypoints) - 1
        done = min(self.route.next_index, len(self.route.waypoints)) - 1
        frac = 1.0 if self.route.finished else (max(done, 0) / total if total > 0 else 0.0)
        self.bar.create_rectangle(0, 0, w, 6, fill=self.p.track, outline='')
        if frac > 0:
            self.bar.create_rectangle(0, 0, int(w * frac), 6, fill=self.p.accent, outline='')

    # -- showing -------------------------------------------------------------

    def refresh(self) -> None:
        if self.route.empty:
            self.follow.grid_remove()
            self.form.grid(row=0, column=0, sticky=tk.EW, padx=PAD, pady=(PAD, 0))
            here = self._current_system()
            typed = self.source_var.get().strip()
            if here and (not typed or typed == self._auto_source):
                self.source.set(here)
                self._auto_source = here
            if not self.range_var.get():
                r = self._jump_range()
                self.range_var.set(f'{r:.2f}' if r else '')
            self._update_here_button()
        else:
            self.form.grid_remove()
            self.follow.grid(row=0, column=0, sticky=tk.EW, padx=PAD, pady=(PAD, 0))
            nxt = self.route.next
            dest = self.route.destination
            if nxt is None:
                self.next_label.config(text='Arrived')
                self.neutron_badge.grid_remove()
            else:
                self.next_label.config(text=nxt.system)
                if nxt.neutron:
                    self.neutron_badge.grid()
                else:
                    self.neutron_badge.grid_remove()
            self.stat_values['Jumps left'].config(text=str(self.route.jumps_left()))
            self.stat_values['Waypoint'].config(
                text=f'{min(self.route.next_index + 1, len(self.route.waypoints))} of {len(self.route.waypoints)}')
            self.stat_values['Destination'].config(text=dest.system if dest else '—')
            self._draw_bar()
        bridge.publish(self.route)

    def _update_here_button(self) -> None:
        here = self._current_system()
        if here and here.lower() != self.source_var.get().strip().lower():
            self.here_button.grid()
        else:
            self.here_button.grid_remove()

    def say(self, text: str, error: bool = False) -> None:
        self.status.config(text=text)
        style.colour(self.status, fg=self.p.error if error else self.p.muted)
        if error and self.p.surface is None:
            self.status.config(fg=self.p.error)

    # -- actions -------------------------------------------------------------

    def use_current(self) -> None:
        here = self._current_system()
        if here:
            self.source.set(here)
            self._auto_source = here
        self._update_here_button()

    def plot(self) -> None:
        source = self.source_var.get().strip()
        destination = self.destination_var.get().strip()
        try:
            jump_range = float(self.range_var.get().strip())
        except ValueError:
            jump_range = 0
        try:
            efficiency = max(1, min(100, int(self.efficiency_var.get().strip())))
        except ValueError:
            efficiency = self._efficiency()
        self.efficiency_var.set(str(efficiency))
        if not source or not destination:
            self.say('Enter where to plot from and to.', error=True)
            return
        if jump_range <= 0:
            self.say('Enter your jump range in light years.', error=True)
            return
        self._set_efficiency(efficiency)
        self.source.close()
        self.destination.close()
        self.plotting = True
        self.plot_button.config(state=tk.DISABLED, text='Plotting…')
        self.say('Plotting your route… please wait. Long routes can take up to a minute.')
        spansh.plot_in_background(source, destination, jump_range, efficiency,
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
                self.say(error, error=True)
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
            with open(path, encoding='utf-8-sig') as fh:
                route = Route.from_csv(fh.read())
        except (OSError, ValueError) as e:
            self.say(f'Could not import that file: {e}', error=True)
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
        self.source.set('')
        self._auto_source = None
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

    # -- the game --------------------------------------------------------------

    def arrived(self, system: str | None, address: int | None) -> None:
        if self.route.arrived(system, address):
            self._changed()
            self.refresh()
            if self._auto_copy() and self.route.next is not None:
                self.copy_next(quiet=True)
                self.say(f'Next waypoint copied: {self.route.next.system}')
        elif self.route.empty and not self.plotting:
            # Keep "From" current while no route is set, unless the commander
            # has typed something else there.
            self.refresh()

    def located(self) -> None:
        """The current system became known (startup, or a jump)."""
        if self.route.empty:
            self.refresh()
