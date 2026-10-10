"""
The plugin's controller: one state, journal in, page and overlay out.

Host-agnostic on purpose. `load.py` wires it to EDFMC (a native page and an
overlay panel through `edfmc`) or to EDMC (a small tkinter panel), and the
tests drive it directly with plain dicts.

Threading follows the host's rule: only the main thread touches state. The
market search runs on a worker, which hands its result back through `later`
(a queue drained from the main thread), and never touches tkinter or state.
"""

from __future__ import annotations

import os
import queue
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable

from . import hauling, market, migrate, store, tracker, views

#: Cargo.json is written beside the journal line; a read can beat the write.
CARGO_RETRIES = 3


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class Controller:
    def __init__(self, *, data_dir: str, plugin_dir: str, journal_dir: str | None, edfmc_db: str | None,
                 user_agent: str, show_page: Callable[[dict[str, Any]], None] | None,
                 show_overlay: Callable[[dict[str, Any] | None], None] | None,
                 schedule: Callable[[int, Callable[[], None]], None] | None = None,
                 fetcher: Callable[..., Any] = market.fetch, threaded: bool = True) -> None:
        self.data_dir = data_dir
        self.plugin_dir = plugin_dir
        self.journal_dir = journal_dir
        self.edfmc_db = edfmc_db
        self.user_agent = user_agent
        self.show_page = show_page
        self.show_overlay = show_overlay
        self.schedule = schedule
        self.fetcher = fetcher
        self.threaded = threaded
        self.state = store.empty_state(None, None)
        self.ui: dict[str, Any] = {'searching': False, 'message': None, 'showArchived': False}
        self.origin: tuple[float, float, float] | None = None
        self._results: queue.Queue[Callable[[], None]] = queue.Queue()
        self._last_overlay: Any = object()
        self._loaded = False

    # -- lifecycle -----------------------------------------------------------

    def start(self, game: dict[str, Any]) -> None:
        """From plugin_start3, with what the host already knows of the game."""
        self._switch(game.get('FID'), game.get('Captain') or game.get('Commander'))
        if game.get('IsDocked') and game.get('MarketID') is not None:
            tracker.apply(self.state, {'event': 'Docked', 'timestamp': _now_iso(), 'MarketID': game['MarketID'],
                                       'StationName': game.get('StationName'), 'StationType': game.get('StationType'),
                                       'StarSystem': game.get('SystemName')})
        self.origin = tuple(game['StarPos']) if game.get('StarPos') else None  # type: ignore[assignment]
        # The newest Cargo.json is the hold as the game last wrote it.
        inventory = self._cargo_file(None)
        if inventory is not None:
            tracker.set_ship_cargo(self.state, inventory, _now_iso())
        self._save()
        self.push()

    def stop(self) -> None:
        self._save()

    def _switch(self, fid: str | None, commander: str | None) -> None:
        """Another commander: save this one, load theirs. Nothing crosses between them."""
        if fid == self.state.get('fid') and self._loaded:
            return
        if fid is None and self._loaded:
            return  # not known yet on this line; stay with the commander we have
        if self.state.get('fid') is not None:
            self._save()
        self.state = store.load(self.data_dir, fid, commander)
        self._loaded = True
        self.state['dock'] = None  # where the commander is docked is learned again, never assumed
        self.state['loadPlan'] = None
        self.ui['message'] = None
        if fid is not None:
            self._first_imports(fid)

    def _first_imports(self, fid: str) -> None:
        """Bring in this commander's sites from EDFMC's old Logistics page, once, read-only."""
        imports = self.state['imports']
        now = _now_iso()
        if 'edfmc' not in imports and self.edfmc_db:
            added = migrate.from_edfmc_database(self.state, self.edfmc_db, fid, now)
            imports['edfmc'] = (f'Imported {added} site{"s" if added != 1 else ""} from EDFMC\'s old Logistics page, {now[:10]}.'
                                if added else '')

    # -- journal -------------------------------------------------------------

    def journal_entry(self, entry: dict[str, Any], game: dict[str, Any]) -> None:
        self._switch(game.get('FID'), game.get('Captain') or game.get('Commander'))
        if game.get('StarPos'):
            self.origin = tuple(game['StarPos'])  # type: ignore[assignment]
        changed = tracker.apply(self.state, entry)
        if entry.get('event') == 'Cargo' and entry.get('Vessel', 'Ship') == 'Ship' and 'Inventory' not in entry:
            self._read_cargo(entry.get('timestamp'), 0)
        if changed:
            self._save()
            self.push()

    def _cargo_file(self, expected_at: str | None) -> list[dict[str, Any]] | None:
        if expected_at is None:
            # Startup: whatever the game wrote last.
            import json
            try:
                with open(os.path.join(self.journal_dir or '', 'Cargo.json'), encoding='utf-8') as f:
                    data = json.load(f)
                inv = data.get('Inventory') if isinstance(data, dict) and data.get('Vessel', 'Ship') == 'Ship' else None
                return inv if isinstance(inv, list) else None
            except (OSError, ValueError):
                return None
        return tracker.read_cargo_file(self.journal_dir, expected_at)

    def _read_cargo(self, expected_at: str | None, attempt: int) -> None:
        inventory = self._cargo_file(expected_at)
        if inventory is not None:
            tracker.set_ship_cargo(self.state, inventory, expected_at or _now_iso())
            self._save()
            self.push()
        elif attempt < CARGO_RETRIES and self.schedule is not None:
            self.schedule(300, lambda: self._read_cargo(expected_at, attempt + 1))

    # -- the commander's input -------------------------------------------------

    def on_action(self, name: str, args: dict[str, Any]) -> None:
        s = self.state
        prefs = s['prefs']
        value = args.get('value')
        self.ui['message'] = None
        site_id = str(args.get('site') or s.get('selectedSite') or '')
        site = s['sites'].get(site_id)

        if name == 'selectSite' and str(value) in s['sites']:
            s['selectedSite'] = str(value)
        elif name == 'setHideCompleted':
            prefs['hideCompleted'] = bool(value)
        elif name == 'setCarrier' and isinstance(value, (int, float)):
            # The commander's own count overrides the estimate until the next transfer.
            s['carrier']['cargo'][str(args.get('row'))] = {'amount': max(0, int(value)), 'source': 'user',
                                                            'known': True, 'updatedAt': _now_iso()}
        elif name == 'setPriority' and isinstance(value, (int, float)):
            s['materialPriority'][str(args.get('row'))] = max(1, min(5, int(value)))
        elif name == 'setTarget' and value in ('selected', 'all'):
            prefs['targetSite'] = value
        elif name == 'setHold' and isinstance(value, (int, float)):
            prefs['holdOverride'] = max(0, int(value))
        elif name == 'setMaxAge' and isinstance(value, (int, float)):
            prefs['sourcing']['maxAgeHours'] = max(1, min(720, int(value)))
        elif name == 'setStationPreference' and value in [p for p, _ in views.PREFERENCES]:
            prefs['sourcing']['stationPreference'] = value
        elif name == 'setMargin' and isinstance(value, (int, float)):
            prefs['sourcing']['safetyMarginPct'] = max(0, min(100, int(value)))
        elif name == 'setAllowCarriers':
            prefs['sourcing']['allowFleetCarriers'] = bool(value)
        elif name == 'setLimitToHold':
            prefs['sourcing']['limitToHold'] = bool(value)
        elif name == 'setOverlayMode' and value in [m for m, _ in views.OVERLAY_MODES]:
            prefs['overlayMode'] = value
        elif name == 'setShowArchived':
            self.ui['showArchived'] = bool(value)
        elif name == 'renameSite' and site is not None and isinstance(value, str):
            name_text = value.strip()[:80]
            site['name'] = {'value': name_text, 'source': 'user'} if name_text else None
        elif name == 'setSitePriority' and isinstance(value, (int, float)):
            target = s['sites'].get(str(args.get('row')))
            if target is not None:
                target['priority'] = max(1, min(99, int(value)))
        elif name == 'archiveSite' and site is not None:
            site['archived'] = True
            if s['selectedSite'] == site['marketId']:
                remaining = hauling.active_sites(s)
                s['selectedSite'] = remaining[0]['marketId'] if remaining else site['marketId']
        elif name == 'restoreSite' and site is not None:
            site['archived'] = False
        elif name == 'removeSite' and site is not None:
            del s['sites'][site['marketId']]
            if s['selectedSite'] == site['marketId']:
                rest = hauling.active_sites(s) or list(s['sites'].values())
                s['selectedSite'] = rest[0]['marketId'] if rest else None
            self.ui['message'] = f'{hauling.site_label(site)} removed. It returns if the game reports it again.'
        elif name == 'addSite' and isinstance(value, str):
            market_id = value.strip()
            if not market_id.isdigit() or len(market_id) > 20:
                self.ui['message'] = 'A Market ID is a number, as shown in the journal or on Inara.'
                self.ui['messageTone'] = 'warn'
            elif market_id in s['sites']:
                s['selectedSite'] = market_id
            else:
                s['sites'][market_id] = tracker._new_site(market_id, _now_iso())
                s['selectedSite'] = market_id
                self.ui['message'] = 'Site added. Its materials load the next time you dock there.'
        elif name == 'source':
            self._source()
            return
        else:
            return
        self._save()
        self.push()

    # -- sourcing ---------------------------------------------------------------

    def _source(self) -> None:
        if self.ui['searching']:
            return
        requirements = hauling.requirements_to_source(self.state)
        if not requirements:
            self.state['sourcing'] = {'result': None, 'at': _now_iso(), 'error': None, 'requested': []}
            self.ui['message'] = 'Nothing to source: what the planned site(s) need is on your ship or carrier.'
            self.push()
            return
        prefs = dict(self.state['prefs']['sourcing'])
        capacity = hauling.hold_capacity(self.state) if prefs.get('limitToHold') else None
        origin = self.origin
        fid = self.state.get('fid')
        self.ui['searching'] = True
        self.push()

        def work() -> None:
            try:
                plan = market.source(requirements, prefs, origin, capacity, self.user_agent, self.fetcher)
                outcome: dict[str, Any] = {'result': plan, 'error': None}
            except Exception as e:  # noqa: BLE001 - a failed search is reported, never raised into the host
                outcome = {'result': None, 'error': str(e) or 'The search failed.'}
            self._results.put(lambda: self._sourced(fid, requirements, outcome))

        if self.threaded:
            threading.Thread(target=work, name='construction-sourcing', daemon=True).start()
            self._poll()
        else:
            work()
            self.drain()

    def _poll(self) -> None:
        if self.schedule is None:
            return
        self.schedule(200, lambda: (self.drain(), self.ui['searching'] and self._poll()))

    def drain(self) -> None:
        while True:
            try:
                fn = self._results.get_nowait()
            except queue.Empty:
                return
            fn()

    def _sourced(self, fid: str | None, requested: list[dict[str, Any]], outcome: dict[str, Any]) -> None:
        self.ui['searching'] = False
        if fid != self.state.get('fid'):
            return  # the commander changed while it ran; it was their plan, not this one's
        self.state['sourcing'] = {'result': outcome['result'], 'error': outcome['error'], 'at': _now_iso(),
                                  'requested': requested}
        self._save()
        self.push()

    # -- output -----------------------------------------------------------------

    def _save(self) -> None:
        if self.state.get('fid') is None and not self.state['sites']:
            return  # nothing worth a file before the commander is known
        try:
            store.save(self.data_dir, self.state)
        except OSError as e:
            self.ui['message'] = f'Could not save construction data: {e}'
            self.ui['messageTone'] = 'bad'

    def push(self) -> None:
        if self.show_page is not None:
            self.show_page(views.page(self.state, self.ui))
        if self.show_overlay is not None:
            panel = views.overlay(self.state)
            if panel != self._last_overlay:
                self._last_overlay = panel
                self.show_overlay(panel)

    # -- for EDMC's panel ----------------------------------------------------------

    def summary_lines(self) -> list[str]:
        site = self.state['sites'].get(self.state.get('selectedSite') or '')
        if site is None:
            return ['No construction site yet. Dock at one to start.']
        rows = hauling.material_rows(self.state, site)
        pct = f" {round((site.get('progress') or 0) * 100)}%" if site.get('progress') is not None else ''
        out = [f'{hauling.site_label(site)}{pct}']
        for r in sorted(rows, key=lambda r: -r['toSource'])[:12]:
            if r['remaining'] > 0:
                out.append(f"{r['label']}: {r['remaining']:,} left, {r['toSource']:,} to source")
        return out


def now_ms() -> float:
    return time.time() * 1000
