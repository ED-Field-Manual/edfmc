"""
The plugin's page and overlay panel, as `ui-v1` blocks the app draws.

Built from the one state every time, so the page, the overlay and the plan
always agree. Status is never colour alone: each material row carries a mark
and the legend says what it means, and every estimate says it is one.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from .confidence import LABELS
from .hauling import (
    active_sites, after_delivery, export_csv, export_text, hold_capacity, load_plan, material_rows,
    site_label, target_sites,
)

MARK = {'done': '✓', 'held': '↑', 'needed': ''}
TONE = {'done': 'muted', 'held': 'normal', 'needed': 'normal'}
PREFERENCES = [
    ('no-preference', 'No preference'),
    ('strongly-prefer-orbital', 'Strongly prefer orbital'),
    ('planetary-if-better', 'Planetary if clearly better'),
    ('orbital-only', 'Orbital stations only'),
]
OVERLAY_MODES = [
    ('auto', 'Automatic (follows where you are)'),
    ('hauling', 'Hauling'),
    ('delivery', 'Delivery'),
    ('shopping', 'Shopping / loading'),
]


def t(n: Any) -> str:
    return f'{int(n):,} t' if isinstance(n, (int, float)) else '—'


def when(iso: str | None) -> str:
    if not iso:
        return 'unknown time'
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone()
    except ValueError:
        return iso
    return dt.strftime('%d %b %H:%M')


def _site_text(site: dict[str, Any], key: str) -> str:
    v = site.get(key)
    return v['value'] if v else 'Not known yet'


def _source_note(site: dict[str, Any]) -> str:
    if site.get('source') == 'journal':
        return f"Materials from the game's depot report, {when(site['updatedAt'])}."
    if site.get('source') == 'imported':
        return 'Materials imported from earlier tracking. They update the next time you dock at this site.'
    return 'No depot report yet. Dock at the site, or open its construction screen, to load its materials.'


def _site_option(site: dict[str, Any]) -> dict[str, str]:
    pct = f" ({round((site.get('progress') or 0) * 100)}%)" if site.get('progress') is not None else ''
    system = f" — {site['system']['value']}" if site.get('system') else ''
    status = ' (archived)' if site['archived'] else ' (complete)' if site['complete'] else ''
    return {'value': site['marketId'], 'label': f'{site_label(site)}{system}{pct}{status}'}


# --------------------------------------------------------------------- page


def page(state: dict[str, Any], ui: dict[str, Any]) -> dict[str, Any]:
    """The whole tab. `ui` holds things that are not data: searching, messages, imports found."""
    blocks: list[dict[str, Any]] = []
    if ui.get('message'):
        blocks.append({'type': 'text', 'text': ui['message'], 'tone': ui.get('messageTone', 'normal')})

    sites = [s for s in state['sites'].values() if not s['archived'] or ui.get('showArchived')]
    site = state['sites'].get(state.get('selectedSite') or '')

    if not state['sites']:
        blocks.append({'type': 'section', 'title': 'Construction sites', 'blocks': [
            {'type': 'text', 'text': 'No construction sites yet. Dock at a construction site, or open its '
                                     'construction screen, and it appears here with everything it needs.'},
            *_add_site_controls(),
            *_import_blocks(state, ui),
        ]})
        return {'kind': 'ui-v1', 'blocks': blocks}

    if site is None:
        site = sorted(state['sites'].values(), key=lambda s: s.get('priority', 1))[0]

    blocks.append(_overview(state, site, sites))
    blocks.append(_materials(state, site))
    blocks.append(_trip(state))
    blocks.append(_sourcing(state, ui))
    blocks.append(_management(state, site, ui))
    blocks.append({'type': 'section', 'title': 'Overlay', 'blocks': [
        {'type': 'controls', 'items': [{'type': 'select', 'label': 'Overlay view', 'action': 'setOverlayMode',
                                        'value': state['prefs']['overlayMode'],
                                        'options': [{'value': v, 'label': lbl} for v, lbl in OVERLAY_MODES]}]},
        {'type': 'text', 'tone': 'muted', 'text': 'Automatic shows Delivery when you are docked at one of your '
         'sites, Shopping when docked anywhere else, and Hauling in flight. Turn the panel on or off, and move '
         'it, on the Overlay page.'},
    ]})
    blocks.append({'type': 'section', 'title': 'Data', 'blocks': _import_blocks(state, ui)})
    return {'kind': 'ui-v1', 'blocks': blocks}


def _overview(state: dict[str, Any], site: dict[str, Any], sites: list[dict[str, Any]]) -> dict[str, Any]:
    rows = material_rows(state, site)
    fulfilled = sum(1 for r in rows if r['status'] == 'done')
    to_source = sum(r['toSource'] for r in rows)
    carrier = state['carrier']
    free = (f"{t(carrier['freeSpace'])}" + (f" (as of {when(carrier['statsAt'])})" if carrier.get('statsAt')
                                            else ' (imported)')) if carrier.get('freeSpace') is not None \
        else 'Open carrier management in game to report it'
    status = 'Complete' if site['complete'] else 'Failed' if site['failed'] else 'Archived' if site['archived'] \
        else 'Under construction'
    blocks: list[dict[str, Any]] = [
        {'type': 'controls', 'items': [{'type': 'select', 'label': 'Site', 'action': 'selectSite',
                                        'value': site['marketId'],
                                        'options': [_site_option(s) for s in sorted(
                                            sites, key=lambda s: (s['archived'], s['complete'], s.get('priority', 1)))]}]},
    ]
    if site.get('progress') is not None:
        blocks.append({'type': 'progress', 'label': 'Construction progress', 'value': site['progress'],
                       'text': f"{round(site['progress'] * 100)}%"})
    blocks.append({'type': 'stats', 'items': [
        {'label': 'System', 'value': _site_text(site, 'system')},
        {'label': 'Type', 'value': _site_text(site, 'siteType')},
        {'label': 'Status', 'value': status},
        {'label': 'Materials fulfilled', 'value': f'{fulfilled} of {len(rows)}'},
        {'label': 'Still to source', 'value': t(to_source)},
        {'label': 'Carrier free space', 'value': free},
    ]})
    blocks.append({'type': 'text', 'tone': 'muted', 'text': _source_note(site)})
    return {'type': 'section', 'title': site_label(site), 'blocks': blocks}


def _materials(state: dict[str, Any], site: dict[str, Any]) -> dict[str, Any]:
    rows = material_rows(state, site)
    hide = state['prefs']['hideCompleted']
    shown = [r for r in rows if not (hide and r['status'] == 'done')]
    shown.sort(key=lambda r: (r['status'] == 'done', r['priority'], -r['toSource'], r['label']))
    table_rows = []
    for r in shown:
        carrier_value: dict[str, Any] = {'text': f"{r['carrier']:,}",
                                         'edit': {'action': 'setCarrier', 'kind': 'number', 'value': r['carrier'], 'min': 0}}
        table_rows.append({
            'id': r['commodity'],
            'tone': TONE[r['status']],
            'cells': {
                'material': {'text': r['label'], 'mark': MARK[r['status']] or None,
                             'tone': 'ok' if r['status'] == 'done' else 'normal'},
                'required': f"{r['required']:,}",
                'provided': f"{r['provided']:,}",
                'carrier': carrier_value,
                'ship': f"{r['ship']:,}",
                'remaining': f"{r['remaining']:,}",
                'toSource': {'text': f"{r['toSource']:,}", 'tone': 'warn' if r['toSource'] > 0 else 'muted'},
                'priority': {'text': str(r['priority']),
                             'edit': {'action': 'setPriority', 'kind': 'number', 'value': r['priority'], 'min': 1, 'max': 5}},
            },
        })
    estimated = sum(1 for r in rows if r['carrierSource'] == 'estimated')
    entered = sum(1 for r in rows if r['carrierSource'] == 'user')
    imported = sum(1 for r in rows if r['carrierSource'] == 'imported')
    sources = []
    if estimated:
        sources.append(f'{estimated} estimated from transfers')
    if entered:
        sources.append(f'{entered} entered by you')
    if imported:
        sources.append(f'{imported} imported')
    return {'type': 'section', 'title': 'Materials', 'blocks': [
        {'type': 'controls', 'items': [
            {'type': 'toggle', 'label': 'Hide delivered materials', 'action': 'setHideCompleted', 'value': hide},
            {'type': 'copy', 'label': 'Copy what is still needed', 'text': export_text(site, rows)},
            {'type': 'copy', 'label': 'Copy as CSV', 'text': export_csv(site, rows)},
        ]},
        {'type': 'table', 'empty': 'Every material has been delivered.' if rows else 'No materials reported yet.',
         'columns': [
             {'key': 'material', 'label': 'Material'},
             {'key': 'required', 'label': 'Required', 'align': 'right'},
             {'key': 'provided', 'label': 'Provided', 'align': 'right'},
             {'key': 'carrier', 'label': 'Carrier', 'align': 'right'},
             {'key': 'ship', 'label': 'Ship', 'align': 'right'},
             {'key': 'remaining', 'label': 'Remaining', 'align': 'right'},
             {'key': 'toSource', 'label': 'To source', 'align': 'right'},
             {'key': 'priority', 'label': 'Priority', 'align': 'right'},
         ], 'rows': table_rows},
        {'type': 'text', 'tone': 'muted', 'text':
            '✓ delivered · ↑ on your ship or carrier, not yet delivered. Required and Provided come from the '
            "game. Remaining is what the site still needs; To source is what is not already on your ship or "
            'carrier. Priority 1 is hauled first.'},
        {'type': 'text', 'tone': 'muted', 'text':
            'Carrier counts are an estimate: the game reports transfers to and from your carrier, never its whole '
            'hold. Correct a count by typing over it' + (f" ({', '.join(sources)})." if sources else '.')},
    ]}


def _trip(state: dict[str, Any]) -> dict[str, Any]:
    plan = load_plan(state)
    targets = target_sites(state)
    blocks: list[dict[str, Any]] = [
        {'type': 'controls', 'items': [
            {'type': 'select', 'label': 'Plan for', 'action': 'setTarget', 'value': state['prefs']['targetSite'],
             'options': [{'value': 'selected', 'label': 'The selected site'},
                         {'value': 'all', 'label': 'All active sites, by priority'}]},
            {'type': 'number', 'label': 'Hold size', 'action': 'setHold', 'value': int(state['prefs']['holdOverride'] or 0),
             'min': 0, 'max': 100000, 'step': 1, 'suffix': "t (0 = your ship's)"},
        ]},
    ]
    if not targets:
        blocks.append({'type': 'text', 'tone': 'muted', 'text': 'Nothing to haul: the selected site is complete or archived.'})
        return {'type': 'section', 'title': 'Plan a trip', 'blocks': blocks}

    capacity = plan['capacity']
    blocks.append({'type': 'stats', 'items': [
        {'label': 'Hold', 'value': t(capacity) if capacity is not None else 'Unknown',
         'note': None if capacity is not None else '(set a size, or the game reports it after your next outfitting change or login)'},
        {'label': 'Already aboard', 'value': t(plan['aboard'])},
        {'label': 'Free for this trip', 'value': t(plan['freeBefore']) if plan['freeBefore'] is not None else 'Unknown'},
        {'label': 'Planned load', 'value': t(plan['planned'])},
    ]})
    blocks.append({'type': 'table', 'caption': 'Load for the next trip', 'empty': 'Nothing more to load: what is aboard covers it.',
                   'columns': [{'key': 'material', 'label': 'Material'},
                               {'key': 'fromCarrier', 'label': 'From carrier', 'align': 'right'},
                               {'key': 'buy', 'label': 'Buy', 'align': 'right'},
                               {'key': 'total', 'label': 'Total', 'align': 'right'}],
                   'rows': [{'id': line['commodity'], 'cells': {
                       'material': line['label'], 'fromCarrier': f"{line['fromCarrier']:,}",
                       'buy': f"{line['buy']:,}", 'total': f"{line['total']:,}"}} for line in plan['lines']]})
    lines = '\n'.join(f"{line['label']}: {line['total']:,} t"
                      + (f" ({line['fromCarrier']:,} from carrier)" if line['fromCarrier'] else '')
                      for line in plan['lines'])
    if lines:
        blocks.append({'type': 'controls', 'items': [{'type': 'copy', 'label': 'Copy load plan', 'text': lines}]})

    if len(targets) == 1:
        rows = after_delivery(state, targets[0])
        delivering = [r for r in rows if r['delivering'] > 0]
        blocks.append({'type': 'heading', 'text': 'After delivering what is aboard'})
        blocks.append({'type': 'table', 'empty': 'Nothing aboard is needed by this site.',
                       'columns': [{'key': 'material', 'label': 'Material'},
                                   {'key': 'remaining', 'label': 'Remaining now', 'align': 'right'},
                                   {'key': 'delivering', 'label': 'Delivering', 'align': 'right'},
                                   {'key': 'after', 'label': 'Remaining after', 'align': 'right'}],
                       'rows': [{'id': r['commodity'], 'cells': {
                           'material': r['label'], 'remaining': f"{r['remaining']:,}",
                           'delivering': f"{r['delivering']:,}", 'after': f"{r['after']:,}"}} for r in delivering]})
    blocks.append({'type': 'text', 'tone': 'muted', 'text': 'Plans are suggestions. A site\'s totals change only '
                   'when the game confirms a contribution.'})
    return {'type': 'section', 'title': 'Plan a trip', 'blocks': blocks}


def _sourcing(state: dict[str, Any], ui: dict[str, Any]) -> dict[str, Any]:
    p = state['prefs']['sourcing']
    searching = ui.get('searching', False)
    blocks: list[dict[str, Any]] = [
        {'type': 'text', 'tone': 'muted', 'text': 'Finds stations selling what the planned site(s) still need '
         'to source, using EDFM market data (from EDDN). Needs an internet connection.'},
        {'type': 'controls', 'items': [
            {'type': 'number', 'label': 'Market data no older than', 'action': 'setMaxAge', 'value': p['maxAgeHours'],
             'min': 1, 'max': 720, 'step': 1, 'suffix': 'hours'},
            {'type': 'select', 'label': 'Stations', 'action': 'setStationPreference', 'value': p['stationPreference'],
             'options': [{'value': v, 'label': lbl} for v, lbl in PREFERENCES]},
            {'type': 'number', 'label': 'Safety margin', 'action': 'setMargin', 'value': p['safetyMarginPct'],
             'min': 0, 'max': 100, 'step': 5, 'suffix': '%'},
            {'type': 'toggle', 'label': 'Include fleet carriers', 'action': 'setAllowCarriers', 'value': p['allowFleetCarriers']},
            {'type': 'toggle', 'label': 'No stop larger than my hold', 'action': 'setLimitToHold', 'value': p['limitToHold']},
            {'type': 'button', 'label': 'Searching…' if searching else 'Find where to buy', 'action': 'source',
             'primary': True, 'disabled': searching},
        ]},
    ]
    s = state['sourcing']
    if s.get('error'):
        blocks.append({'type': 'text', 'tone': 'bad', 'text': s['error']})
    result = s.get('result')
    if result:
        blocks.append({'type': 'text', 'tone': 'muted', 'text':
                       f"Planned {when(s.get('at'))} from {result.get('candidatesConsidered', 0)} stations. "
                       'Stock can change after it is reported.'})
        for i, stop in enumerate(result['stops'], 1):
            st = stop['station']
            distance = f" · {st['distanceLy']:.1f} ly" if st.get('distanceLy') is not None else ''
            blocks.append({'type': 'heading', 'text': f"Stop {i}: {st['stationName']}, {st['systemName']}{distance}"})
            blocks.append({'type': 'table', 'columns': [
                {'key': 'material', 'label': 'Material'}, {'key': 'amount', 'label': 'Buy', 'align': 'right'},
                {'key': 'confidence', 'label': 'Confidence'}, {'key': 'why', 'label': 'Stock'}],
                'rows': [{'id': f"{i}-{pur['commodity']}", 'cells': {
                    'material': pur['label'], 'amount': f"{pur['amount']:,}",
                    'confidence': {'text': LABELS[pur['confidence']['level']],
                                   'tone': 'ok' if pur['confidence']['level'] in ('very-high', 'high') else 'warn'},
                    'why': pur['confidence']['summary']}} for pur in stop['purchases']]})
            blocks.append({'type': 'text', 'tone': 'muted', 'text': 'Why: ' + '; '.join(stop['reasons'])})
        if result['unfulfilled']:
            blocks.append({'type': 'text', 'tone': 'warn', 'text': 'No acceptable market found for: ' + ', '.join(
                f"{u['label']} ({u['amount']:,} t)" for u in result['unfulfilled'])})
        if not result['stops'] and not result['unfulfilled']:
            blocks.append({'type': 'text', 'text': 'Nothing left to source.'})
    return {'type': 'section', 'title': 'Where to buy', 'blocks': blocks}


def _add_site_controls() -> list[dict[str, Any]]:
    return [{'type': 'controls', 'items': [
        {'type': 'text', 'label': 'Add a site by Market ID', 'action': 'addSite', 'value': '',
         'placeholder': 'e.g. 4387351555'}]}]


def _management(state: dict[str, Any], site: dict[str, Any], ui: dict[str, Any]) -> dict[str, Any]:
    all_sites = sorted(state['sites'].values(), key=lambda s: (s['archived'], s.get('priority', 1)))
    rows = []
    for s in all_sites:
        if s['archived'] and not ui.get('showArchived'):
            continue
        status = 'Archived' if s['archived'] else 'Complete' if s['complete'] else 'Failed' if s['failed'] else 'Active'
        rows.append({'id': s['marketId'], 'tone': 'muted' if s['archived'] or s['complete'] else 'normal', 'cells': {
            'name': {'text': site_label(s), 'mark': '●' if s['marketId'] == state.get('selectedSite') else None},
            'system': s['system']['value'] if s.get('system') else '—',
            'progress': f"{round(s['progress'] * 100)}%" if s.get('progress') is not None else '—',
            'status': status,
            'priority': {'text': str(s.get('priority', 1)),
                         'edit': {'action': 'setSitePriority', 'kind': 'number', 'value': s.get('priority', 1), 'min': 1, 'max': 99}},
        }})
    name = site['name']['value'] if site.get('name') else ''
    archive = ({'type': 'button', 'label': 'Restore', 'action': 'restoreSite', 'args': {'site': site['marketId']}}
               if site['archived'] else
               {'type': 'button', 'label': 'Archive', 'action': 'archiveSite', 'args': {'site': site['marketId']},
                'confirm': f'Archive {site_label(site)}? It leaves your plans but is kept.'})
    return {'type': 'section', 'title': 'Sites', 'blocks': [
        {'type': 'table', 'columns': [
            {'key': 'name', 'label': 'Site'}, {'key': 'system', 'label': 'System'},
            {'key': 'progress', 'label': 'Progress', 'align': 'right'}, {'key': 'status', 'label': 'Status'},
            {'key': 'priority', 'label': 'Priority', 'align': 'right'}], 'rows': rows},
        {'type': 'text', 'tone': 'muted', 'text': '● is the selected site. Priority 1 sites are planned and '
         'supplied first.'},
        {'type': 'heading', 'text': f'Selected: {site_label(site)}'},
        {'type': 'controls', 'items': [
            {'type': 'text', 'label': 'Name', 'action': 'renameSite', 'value': name,
             'placeholder': 'Name it yourself, or dock there'},
            archive,
            {'type': 'button', 'label': 'Remove', 'action': 'removeSite', 'args': {'site': site['marketId']},
             'confirm': f'Remove {site_label(site)} from tracking? It comes back if the game reports it again.'},
            {'type': 'toggle', 'label': 'Show archived sites', 'action': 'setShowArchived',
             'value': bool(ui.get('showArchived'))},
        ]},
        *_add_site_controls(),
    ]}


def _import_blocks(state: dict[str, Any], ui: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    imports = state.get('imports', {})
    if imports.get('edfmc'):
        out.append({'type': 'text', 'tone': 'muted', 'text': imports['edfmc']})
    if imports.get('edmcTracker'):
        out.append({'type': 'text', 'tone': 'muted', 'text': imports['edmcTracker']})
    if ui.get('trackerFile'):
        out.append({'type': 'controls', 'items': [{
            'type': 'button', 'label': 'Import from EDMC Construction Tracker', 'action': 'importTracker',
            'confirm': 'Add sites and carrier capacity from the Construction Tracker? Nothing here is overwritten.'}]})
    c = state['carrier']
    if c.get('callsign') or c.get('capacity') is not None:
        who = ' '.join(x for x in (c.get('name'), f"({c['callsign']})" if c.get('callsign') else None) if x)
        out.append({'type': 'text', 'tone': 'muted', 'text':
                    f"Carrier {who or ''}: {t(c.get('cargoTotal'))} of cargo, {t(c.get('capacity'))} capacity"
                    + (f", reported {when(c.get('statsAt'))}." if c.get('statsAt') else ' (imported).')})
    out.append({'type': 'text', 'tone': 'muted', 'text': 'Saved per commander in your EDFMC plugin-data folder.'})
    return out


# ------------------------------------------------------------------ overlay


def overlay_mode(state: dict[str, Any]) -> str:
    mode = state['prefs'].get('overlayMode', 'auto')
    if mode != 'auto':
        return mode
    dock = state.get('dock')
    if dock:
        site = state['sites'].get(dock.get('marketId') or '')
        if site is not None and not site['complete'] and not site['archived']:
            return 'delivery'
        return 'shopping'
    return 'hauling'


def overlay(state: dict[str, Any]) -> dict[str, Any] | None:
    """The panel for the game overlay, or None when there is nothing to show."""
    mode = overlay_mode(state)
    if mode == 'delivery':
        dock = state.get('dock') or {}
        site = state['sites'].get(dock.get('marketId') or '') or state['sites'].get(state.get('selectedSite') or '')
        if site is None:
            return None
        rows = after_delivery(state, site)
        blocks: list[dict[str, Any]] = [
            {'type': 'heading', 'text': f'Delivery · {site_label(site)}'},
        ]
        if site.get('progress') is not None:
            blocks.append({'type': 'progress', 'label': 'Progress', 'value': site['progress']})
        blocks.append({'type': 'table', 'columns': [
            {'key': 'm', 'label': 'Material'}, {'key': 'aboard', 'label': 'Aboard', 'align': 'right'},
            {'key': 'after', 'label': 'Left after', 'align': 'right'}],
            'rows': [{'id': r['commodity'], 'cells': {'m': r['label'], 'aboard': f"{r['delivering']:,}",
                                                       'after': f"{r['after']:,}"}}
                     for r in sorted(rows, key=lambda r: -r['delivering']) if r['delivering'] > 0][:10],
            'empty': 'Nothing aboard that this site needs.'})
        last = site.get('lastContribution')
        if last and last.get('items'):
            total = sum(i['amount'] for i in last['items'])
            blocks.append({'type': 'text', 'tone': 'ok', 'text': f"✓ Confirmed: {total:,} t delivered {when(last['at'])}"})
        return {'blocks': blocks}

    targets = target_sites(state) or active_sites(state)[:1]
    if not targets:
        return None
    site = targets[0]

    if mode == 'shopping':
        plan = load_plan(state)
        title = site_label(site) if len(targets) == 1 else f'{len(targets)} sites'
        free = t(plan['freeBefore']) if plan['freeBefore'] is not None else 'unknown'
        return {'blocks': [
            {'type': 'heading', 'text': f'Shopping · {title}'},
            {'type': 'stats', 'items': [{'label': 'Free hold', 'value': free},
                                        {'label': 'Aboard', 'value': t(plan['aboard'])}]},
            {'type': 'table', 'columns': [
                {'key': 'm', 'label': 'Material'}, {'key': 'buy', 'label': 'Buy', 'align': 'right'},
                {'key': 'fc', 'label': 'Carrier', 'align': 'right'}],
                'rows': [{'id': line['commodity'], 'cells': {'m': line['label'], 'buy': f"{line['buy']:,}",
                                                             'fc': f"{line['fromCarrier']:,}"}}
                         for line in plan['lines']][:10],
                'empty': 'Nothing more to load.'},
        ]}

    # Hauling
    rows = [r for r in material_rows(state, site) if r['remaining'] > 0]
    rows.sort(key=lambda r: (-(r['allocatedShip'] > 0), r['priority'], -r['remaining']))
    aboard = sum(r['allocatedShip'] for r in rows)
    capacity = hold_capacity(state)
    blocks = [{'type': 'heading', 'text': f'Hauling · {site_label(site)}'}]
    if site.get('progress') is not None:
        blocks.append({'type': 'progress', 'label': 'Progress', 'value': site['progress']})
    blocks.append({'type': 'stats', 'items': [
        {'label': 'Aboard for this site', 'value': t(aboard)},
        {'label': 'Hold', 'value': t(capacity) if capacity else 'unknown'},
        {'label': 'Still needed', 'value': t(sum(r['remaining'] for r in rows))}]})
    blocks.append({'type': 'table', 'columns': [
        {'key': 'm', 'label': 'Material'}, {'key': 'need', 'label': 'Needed', 'align': 'right'},
        {'key': 'aboard', 'label': 'Aboard', 'align': 'right'}],
        'rows': [{'id': r['commodity'], 'cells': {
            'm': {'text': r['label'], 'mark': '↑' if r['allocatedShip'] else None},
            'need': f"{r['remaining']:,}", 'aboard': f"{r['allocatedShip']:,}"}} for r in rows][:10],
        'empty': 'Every material delivered.'})
    return {'blocks': blocks}
