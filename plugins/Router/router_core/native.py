"""
Router as a native EDFM Companion page.

Inside EDFM Companion, Router does not draw a tkinter panel. It registers a
page (`edfmc.register_page`), publishes its state as plain JSON whenever it
changes, and the app draws the Router tab itself: it scrolls, resizes and moves
with the window like every other page. The commander's input comes back as
actions (`plot`, `suggest`, `copy`, `step`, `clear`, `import`).

There are two routes, followed at the same time: the commander's own (`ship`)
and their fleet carrier's (`carrier`). Actions that act on a route name it in
`slot`; without one they mean the ship route, as before.

The route logic is the same as the tkinter panel's (`route.py`, `spansh.py`);
only who draws it differs. In EDMC this module is never used.
"""

from __future__ import annotations

import queue
import threading
import tkinter as tk
from tkinter import filedialog
from typing import Any, Callable

from . import bridge, carrier as carrier_mod, fleet as fleet_mod, ship, spansh
from .route import Route

POLL_MS = 150
KIND = 'router-v1'


class NativePage:
    def __init__(self, register: Callable[[Callable[[str, dict], None]], Any], route: Route, *,
                 current_system: Callable[[], str | None], current_address: Callable[[], int | None],
                 jump_range: Callable[[], float | None], efficiency: Callable[[], int],
                 set_efficiency: Callable[[int], None], auto_copy: Callable[[], bool],
                 changed: Callable[[], None],
                 supercharge: Callable[[], int] = lambda: 4,
                 set_supercharge: Callable[[int], None] = lambda v: None,
                 loadout: Callable[[], dict | None] = lambda: None,
                 settings: Callable[[], dict] = lambda: {},
                 save_settings: Callable[[dict], None] = lambda v: None,
                 journal_dir: Callable[[], str | None] = lambda: None,
                 carrier_route: Route | None = None,
                 carrier_changed: Callable[[], None] = lambda: None) -> None:
        self.route = route
        self.carrier_route = carrier_route if carrier_route is not None else Route()
        self._carrier_changed = carrier_changed
        self._current_system = current_system
        self._current_address = current_address
        self._jump_range = jump_range
        self._efficiency = efficiency
        self._set_efficiency = set_efficiency
        self._auto_copy = auto_copy
        self._changed = changed
        self._supercharge = supercharge
        self._set_supercharge = set_supercharge
        self._loadout = loadout
        self._settings = settings
        self._save_settings = save_settings
        #: Every owned ship, read from all the journals on a worker at start.
        self.fleet: fleet_mod.Fleet | None = None
        #: The commander's carriers, for the carrier planner's form.
        self.carriers: carrier_mod.Carriers | None = None
        #: Per route: the ship and the carrier can be plotted at the same time.
        self.plotting: dict[str, bool] = {'ship': False, 'carrier': False}
        self.status: dict[str, Any] = {'text': '', 'error': False, 'slot': 'ship'}
        self.suggestions: dict[str, Any] | None = None
        self._done: queue.Queue[Callable[[], None]] = queue.Queue()
        self._polling = False
        self._outstanding = 0
        self.page = register(self.on_action)
        self.push()
        self._load_fleet(journal_dir())

    def _load_fleet(self, journal_dir: str | None) -> None:
        if not journal_dir:
            return

        def work() -> None:
            try:
                built = fleet_mod.from_journals(journal_dir)
            except Exception:
                built = None
            try:
                carriers = carrier_mod.from_journals(journal_dir)
            except Exception:
                carriers = None
            self._later(lambda: self._fleet_loaded(built, carriers))

        threading.Thread(target=work, name='router-fleet', daemon=True).start()
        self._watch()

    def _fleet_loaded(self, built: 'fleet_mod.Fleet | None',
                      carriers: 'carrier_mod.Carriers | None' = None) -> None:
        # Events that arrived while reading are already in the journals read,
        # so the read result simply replaces.
        if built is not None:
            self.fleet = built
        if carriers is not None:
            self.carriers = carriers
        self.push()

    def journal_event(self, entry: dict) -> None:
        """Keep the fleet current: a new Loadout, a shipyard visit, a purchase."""
        changed = self.fleet is not None and self.fleet.fold(entry)
        if self.carriers is not None and self.carriers.fold(entry):
            changed = True
        if changed:
            self.push()

    def _selected_id(self) -> int | None:
        sid = self._settings().get('shipId')
        if self.fleet is not None and isinstance(sid, int) and sid in self.fleet.loadouts:
            return sid
        return self.fleet.current if self.fleet is not None else None

    def _selected_loadout(self) -> dict | None:
        sid = self._selected_id()
        if self.fleet is not None and sid is not None and sid in self.fleet.loadouts:
            return self.fleet.loadouts[sid]
        return self._loadout()

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
        return {
            'kind': KIND,
            'currentSystem': self._current_system(),
            'jumpRange': self._jump_range(),
            'efficiency': self._efficiency(),
            'supercharge': self._supercharge(),
            'settings': self._settings(),
            'ship': self._ship_state(),
            'fleet': self.fleet.ships() if self.fleet is not None else None,
            'selectedShip': self._selected_id(),
            'carriers': self.carriers.to_json() if self.carriers is not None else None,
            'plotting': self.plotting['ship'],
            'carrierPlotting': self.plotting['carrier'],
            'status': self.status,
            'route': self._route_view(self.route),
            'carrierRoute': self._route_view(self.carrier_route),
            'suggestions': self.suggestions,
        }

    @staticmethod
    def _route_view(r: Route) -> dict[str, Any] | None:
        route = None
        if not r.empty:
            s = bridge.summary(r) or {}
            last = len(r.waypoints) - 1
            done = max(min(r.next_index, len(r.waypoints)) - 1, 0)
            route = {
                **{k: s.get(k) for k in ('next', 'nextIsNeutron', 'destination', 'jumpsLeft',
                                         'waypoint', 'waypoints', 'finished')},
                'progress': 1.0 if r.finished else (done / last if last > 0 else 0.0),
                # Every waypoint, for the list of cards. A long route is a few
                # hundred entries of short strings, which is fine as JSON.
                'type': 'carrier' if r.is_carrier else ('exact' if r.source == 'spansh-exact' else 'neutron'),
                'waypoints_list': [
                    {
                        'system': w.system,
                        'jumps': w.jumps,
                        'distanceLeft': w.distance_left,
                        'neutron': w.neutron,
                        'distance': w.distance,
                        'scoopable': w.scoopable,
                        'refuel': w.refuel,
                        'tritiumUsed': w.tritium_used,
                        'tritiumLeft': w.tritium_left,
                        'restock': w.restock,
                        'icyRing': w.icy_ring,
                        'pristine': w.pristine,
                        'stop': w.stop,
                        'state': 'done' if i < r.next_index else ('next' if i == r.next_index else 'upcoming'),
                    }
                    for i, w in enumerate(r.waypoints)
                ],
            }
        return route

    def _ship_state(self) -> dict[str, Any]:
        """What the exact plotter will use: the ship, and whether its figures check out."""
        loadout = self._selected_loadout()
        if not loadout:
            return {'ready': False, 'reason': 'Waiting for your ship. Log in, or open the outfitting screen once.'}
        try:
            f = ship.from_loadout(loadout)
        except ship.ShipError as e:
            return {'ready': False, 'reason': str(e)}
        return {
            'ready': f.agrees,
            'ship': f.ship,
            'name': f.name,
            'gameRange': f.game_range,
            'calculatedRange': round(f.calculated_range, 2),
            'superchargeMultiplier': f.supercharge_multiplier,
            'reason': None if f.agrees else (
                f'These figures give {f.calculated_range:.2f} ly but the game says {f.game_range:.2f} ly, '
                'so a normal route would be planned on wrong numbers.'),
        }

    def push(self) -> None:
        try:
            self.page.update(self.state())
        except Exception:
            pass
        bridge.publish(self.route, self.carrier_route)

    def say(self, text: str, error: bool = False, slot: str = 'ship') -> None:
        self.status = {'text': text, 'error': error, 'slot': slot}

    @staticmethod
    def _slot(args: dict) -> str:
        return 'carrier' if args.get('slot') == 'carrier' else 'ship'

    def _route_for(self, slot: str) -> Route:
        return self.carrier_route if slot == 'carrier' else self.route

    # -- actions -----------------------------------------------------------

    def on_action(self, name: str, args: dict) -> None:
        handler = {
            'plot': self._plot, 'suggest': self._suggest, 'copy': self._copy,
            'step': self._step, 'clear': self._clear, 'import': self._import,
            'goto': self._goto, 'copy_system': self._copy_system,
            'select_ship': self._select_ship,
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
        via = [str(v).strip() for v in (args.get('via') or []) if isinstance(v, str) and v.strip()][:20]
        try:
            supercharge = int(args.get('supercharge') or self._supercharge())
        except (TypeError, ValueError):
            supercharge = 4
        if supercharge not in spansh.SUPERCHARGE:
            supercharge = 4
        if args.get('type') == 'carrier':
            self._plot_carrier(source, destination, args)
            return
        exact = None
        if args.get('type') == 'exact':
            loadout = self._selected_loadout()
            try:
                figures = ship.from_loadout(loadout) if loadout else None
            except ship.ShipError:
                figures = None
            if figures is None or not figures.agrees:
                # The ship card says why; the plotter must not route on bad numbers.
                self.say(self._ship_state().get('reason') or 'Router cannot read your ship yet.', error=True)
                self.push()
                return
            options = args.get('options') if isinstance(args.get('options'), dict) else {}
            exact = (figures, options)
            jump_range = figures.calculated_range  # not used by the exact plotter; keeps the check below quiet
        remembered: dict[str, Any] = {'type': 'exact' if exact else 'neutron'}
        if exact:
            remembered['options'] = exact[1]
        self._save_settings({**self._settings(), **remembered})
        if not source or not destination:
            self.say('Enter where to plot from and to.', error=True)
        elif jump_range <= 0:
            self.say('Enter your jump range in light years.', error=True)
        elif not self.plotting['ship']:
            self._set_efficiency(efficiency)
            self._set_supercharge(supercharge)
            self.plotting['ship'] = True
            self.suggestions = None
            self.say('Plotting your route… please wait. Long routes can take up to a minute.')
            spansh.plot_in_background(source, destination, jump_range, efficiency,
                                      lambda route, error: self._later(lambda: self._plotted(route, error, 'ship')),
                                      via=via, supercharge=supercharge, exact=exact)
            self._watch()
        self.push()

    def _plot_carrier(self, source: str, destination: str, args: dict) -> None:
        """A fleet carrier route. Stops on the way come first, then the destination."""
        kind = 'squadron' if args.get('carrier') == 'squadron' else 'fleet'
        stops = [str(v).strip() for v in (args.get('via') or []) if isinstance(v, str) and v.strip()][:20]
        stops.append(destination)
        try:
            used = max(0, int(float(args.get('usedCapacity') or 0)))
        except (TypeError, ValueError):
            used = 0
        fuel: int | None = None
        market = 0
        if args.get('fuelMode') == 'current':
            try:
                fuel = max(0, min(spansh.CARRIER_TANK, int(float(args.get('fuel') or 0))))
                market = max(0, int(float(args.get('market') or 0)))
            except (TypeError, ValueError):
                self.say('Enter the tritium in the tank and in the market as whole tonnes.', error=True, slot='carrier')
                self.push()
                return
        refuel_at = [str(v) for v in (args.get('refuelAt') or []) if isinstance(v, str)]
        self._save_settings({**self._settings(), 'carrierType': kind})
        if not source or not destination:
            self.say('Enter where the carrier is and where it should go.', error=True, slot='carrier')
        elif not self.plotting['carrier']:
            self.plotting['carrier'] = True
            self.suggestions = None
            self.say('Plotting the carrier route… please wait.', slot='carrier')
            spansh.plot_in_background(
                source, destination, 0, 0,
                lambda route, error: self._later(lambda: self._plotted(route, error, 'carrier')),
                carrier={'stops': stops, 'type': kind, 'used': used, 'fuel': fuel,
                         'market': market, 'refuel_at': refuel_at})
            self._watch()
        self.push()

    def carrier_kind(self) -> str:
        """Which carrier the current route is for: 'fleet' or 'squadron'."""
        return 'squadron' if self._settings().get('carrierType') == 'squadron' else 'fleet'

    def _plotted(self, route: Route | None, error: str | None, slot: str = 'ship') -> None:
        self.plotting[slot] = False
        if error or route is None:
            self.say(error or 'Spansh returned no route.', error=True, slot=slot)
        else:
            if slot == 'carrier':
                # The carrier starts where it is, which is the route's first system.
                route.next_index = min(1, len(route.waypoints))
                tritium = sum(w.tritium_used or 0 for w in route.waypoints)
                self.say(f'Carrier route plotted: {route.total_jumps()} jumps, {tritium:,} t of tritium.', slot=slot)
            else:
                route.start_from(self._current_system(), self._current_address())
                self.say(f'Route plotted: {len(route.waypoints)} waypoints, {route.total_jumps()} jumps.')
            self._set_route(route, slot)
            if self._auto_copy() and self._may_auto_copy(slot):
                self._copy({'quiet': True, 'slot': slot})
        self.push()

    def _may_auto_copy(self, slot: str) -> bool:
        """The clipboard has one owner: the ship route, while there is one.

        Copying a carrier jump as the carrier arrives would replace the system
        the commander is about to paste into their own galaxy map.
        """
        return slot == 'ship' or self.route.empty or self.route.finished

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
        slot = self._slot(args)
        nxt = self._route_for(slot).next
        root = self._root()
        if nxt is None or root is None:
            return
        root.clipboard_clear()
        root.clipboard_append(nxt.system)
        if not args.get('quiet'):
            self.say(f'Copied {nxt.system} to the clipboard.', slot=slot)
            self.push()

    def _step(self, args: dict) -> None:
        try:
            delta = int(args.get('delta') or 0)
        except (TypeError, ValueError):
            return
        slot = self._slot(args)
        self._route_for(slot).step(delta)
        self._notify_changed(slot)
        if self._auto_copy():
            self._copy({'quiet': True, 'slot': slot})
        self.push()

    def _select_ship(self, args: dict) -> None:
        sid = args.get('id')
        if isinstance(sid, int) and self.fleet is not None and sid in self.fleet.loadouts:
            self._save_settings({**self._settings(), 'shipId': sid})
            self.push()

    def _goto(self, args: dict) -> None:
        try:
            index = int(args.get('index'))
        except (TypeError, ValueError):
            return
        slot = self._slot(args)
        self._route_for(slot).goto(index)
        self._notify_changed(slot)
        if self._auto_copy():
            self._copy({'quiet': True, 'slot': slot})
        self.push()

    def _copy_system(self, args: dict) -> None:
        """Copy any waypoint's name, from its card."""
        name = args.get('system')
        root = self._root()
        if not isinstance(name, str) or not name or root is None:
            return
        root.clipboard_clear()
        root.clipboard_append(name)
        self.say(f'Copied {name} to the clipboard.')
        self.push()

    def _clear(self, args: dict) -> None:
        slot = self._slot(args)
        self._set_route(Route(), slot)
        self.say('', slot=slot)
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

    def _set_route(self, route: Route, slot: str = 'ship') -> None:
        if slot == 'carrier':
            self.carrier_route = route
        else:
            self.route = route
        self._notify_changed(slot)

    def _notify_changed(self, slot: str) -> None:
        if slot == 'carrier':
            self._carrier_changed()
        else:
            self._changed()

    # -- the game ----------------------------------------------------------

    def arrived(self, system: str | None, address: int | None) -> None:
        """The commander is now in a system: moves the ship route on."""
        if self.route.arrived(system, address):
            self._changed()
            if self._auto_copy() and self.route.next is not None:
                self._copy({'quiet': True})
                self.say(f'Next waypoint copied: {self.route.next.system}')
        self.push()

    def carrier_arrived(self, system: str | None, address: int | None) -> None:
        """The commander's carrier is now in a system: moves the carrier route on."""
        r = self.carrier_route
        if r.arrived(system, address):
            self._carrier_changed()
            if self._auto_copy() and self._may_auto_copy('carrier') and r.next is not None:
                self._copy({'quiet': True, 'slot': 'carrier'})
                self.say(f'Carrier arrived. Next carrier jump copied: {r.next.system}', slot='carrier')
            elif r.next is not None:
                self.say(f'Carrier arrived. Next carrier jump: {r.next.system}', slot='carrier')
        self.push()

    def located(self) -> None:
        self.push()
