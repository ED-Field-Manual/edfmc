/**
 * Pages the app draws for plugins that ask it to (`edfmc.register_page`).
 *
 * Plugins draw with tkinter elsewhere, and in this app a tkinter panel can only
 * be a separate window pinned over the tab: it lags when the window moves and
 * sits above anything the page shows. A plugin written for EDFM Companion can
 * instead publish its state as JSON, and the app draws the page itself. It
 * moves, scrolls and resizes with the window like every other page. The
 * commander's input goes back to the plugin as actions.
 *
 * The app only draws page kinds it knows. Everything a plugin publishes is
 * checked here before use, because it comes from a plugin.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { companion, type CompanionSnapshot } from './lib/companion';
import type { PythonPluginStatus } from './lib/pythonPlugins';

type State = Readonly<Record<string, unknown>>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function NativePluginPage({ snap, plugin }: { snap: CompanionSnapshot; plugin: PythonPluginStatus }) {
  const state = snap.pythonPlugins.pages[plugin.folder];
  const act = (action: string, args: Record<string, unknown> = {}) =>
    void companion.pluginAction(plugin.folder, action, args);

  return (
    <>
      <header className="page-head">
        <h1>{plugin.name}</h1>
        <p className="muted">
          {plugin.version ? `${plugin.version} · ` : ''}Plugin
        </p>
      </header>
      {state === undefined ? (
        <section className="card">
          <p className="muted">Waiting for the plugin…</p>
        </section>
      ) : state['kind'] === 'router-v1' ? (
        <RouterPage state={state} act={act} />
      ) : (
        <section className="card">
          <p className="muted">This plugin's page needs a newer version of EDFM Companion.</p>
        </section>
      )}
    </>
  );
}

/* --------------------------------------------------------------- Router */

type Act = (action: string, args?: Record<string, unknown>) => void;

function RouterPage({ state, act }: { state: State; act: Act }) {
  const route = state['route'] && typeof state['route'] === 'object' ? (state['route'] as State) : null;
  const status = state['status'] && typeof state['status'] === 'object' ? (state['status'] as State) : null;
  const statusText = status ? str(status['text']) : null;

  return (
    <>
      {route ? <RouterFollow route={route} act={act} /> : <RouterForm state={state} act={act} />}
      {/* While plotting, the plotting panel says it; the status line would repeat it. */}
      {statusText && state['plotting'] !== true && (
        <p className={status?.['error'] === true ? 'router-status bad' : 'router-status'}>{statusText}</p>
      )}
    </>
  );
}

function RouterForm({ state, act }: { state: State; act: Act }) {
  const current = str(state['currentSystem']);
  const plotting = state['plotting'] === true;
  const [source, setSource] = useState(current ?? '');
  const [destination, setDestination] = useState('');
  const [range, setRange] = useState(() => {
    const r = num(state['jumpRange']);
    return r ? r.toFixed(2) : '';
  });
  const [efficiency, setEfficiency] = useState(String(num(state['efficiency']) ?? 60));
  /** The start the page filled in itself; while the box holds it, it follows the commander. */
  const autoSource = useRef<string | null>(current);

  useEffect(() => {
    if (current && (source === '' || source === autoSource.current)) {
      setSource(current);
      autoSource.current = current;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  useEffect(() => {
    const r = num(state['jumpRange']);
    if (r && range === '') setRange(r.toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state['jumpRange']]);

  const suggestions = state['suggestions'] && typeof state['suggestions'] === 'object' ? (state['suggestions'] as State) : null;

  return (
    <section className="card router-card">
      <h2>Plot a route</h2>
      <p className="muted">Neutron-boosted routes from Spansh. Start typing a system name for suggestions.</p>

      {plotting && (
        <div className="router-plotting" role="status" aria-live="polite">
          <span className="router-spinner" aria-hidden="true" />
          <div>
            <strong>Plotting your route… please wait</strong>
            <div className="muted">
              Spansh is working out the neutron route to {destination || 'your destination'}. Long routes can
              take up to a minute.
            </div>
          </div>
        </div>
      )}

      <fieldset className="router-fieldset" disabled={plotting}>

      <div className="router-field">
        <div className="router-label-row">
          <label className="field-label" htmlFor="router-from">
            From
          </label>
          {current && source !== current && (
            <button
              type="button"
              className="link"
              onClick={() => {
                setSource(current);
                autoSource.current = current;
              }}
            >
              Use current system
            </button>
          )}
        </div>
        <SystemInput id="router-from" field="from" value={source} onChange={setSource} suggestions={suggestions} act={act} />
      </div>

      <div className="router-field">
        <label className="field-label" htmlFor="router-to">
          To
        </label>
        <SystemInput id="router-to" field="to" value={destination} onChange={setDestination} suggestions={suggestions} act={act} />
      </div>

      <div className="router-pair">
        <div className="router-field">
          <label className="field-label" htmlFor="router-range">
            Jump range (ly)
          </label>
          <input id="router-range" type="text" inputMode="decimal" value={range} onChange={(e) => setRange(e.target.value)} />
        </div>
        <div className="router-field">
          <label className="field-label" htmlFor="router-efficiency">
            Efficiency (%)
          </label>
          <input
            id="router-efficiency"
            type="text"
            inputMode="numeric"
            value={efficiency}
            onChange={(e) => setEfficiency(e.target.value)}
          />
        </div>
      </div>

      <div className="row router-actions">
        <button
          type="button"
          className="primary"
          disabled={plotting}
          onClick={() => act('plot', { source, destination, range, efficiency })}
        >
          {plotting ? 'Plotting…' : 'Plot route'}
        </button>
        <button type="button" className="secondary" onClick={() => act('import')}>
          Import CSV…
        </button>
      </div>
      </fieldset>
    </section>
  );
}

/**
 * A system name box with suggestions from the plugin (which asks Spansh).
 * Typing is never restricted; a suggestion is only an offer.
 */
function SystemInput({
  id,
  field,
  value,
  onChange,
  suggestions,
  act,
}: {
  id: string;
  field: string;
  value: string;
  onChange: (v: string) => void;
  suggestions: State | null;
  act: Act;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<number | undefined>(undefined);

  // Only suggestions answering this box's current text are shown; a slow reply
  // to an earlier keystroke is ignored.
  const names =
    suggestions && suggestions['field'] === field && str(suggestions['text'])?.trim().toLowerCase() === value.trim().toLowerCase()
      ? ((suggestions['names'] as unknown[]) ?? []).filter((n): n is string => typeof n === 'string')
      : [];
  const shown = names.length === 1 && names[0] === value.trim() ? [] : names.slice(0, 8);

  const type = (v: string) => {
    onChange(v);
    setOpen(true);
    setActive(-1);
    window.clearTimeout(timer.current);
    if (v.trim().length >= 3) {
      timer.current = window.setTimeout(() => act('suggest', { field, text: v }), 300);
    }
  };

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
    setActive(-1);
  };

  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open || shown.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0) {
      e.preventDefault();
      pick(shown[active]!);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="router-suggest">
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => type(e.target.value)}
        onKeyDown={keys}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        aria-autocomplete="list"
        aria-expanded={open && shown.length > 0}
      />
      {open && shown.length > 0 && (
        <ul className="router-suggestions" role="listbox">
          {shown.map((name, i) => (
            <li
              key={name}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(name);
              }}
            >
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RouterFollow({ route, act }: { route: State; act: Act }) {
  const next = str(route['next']);
  const finished = route['finished'] === true || next === null;
  const progress = Math.max(0, Math.min(1, num(route['progress']) ?? 0));
  const jumpsLeft = num(route['jumpsLeft']) ?? 0;
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="card router-card">
      <h2>{finished ? 'Route complete' : 'Next waypoint'}</h2>
      <div className="router-next">
        <button
          type="button"
          className="router-next-name"
          title="Copy to the clipboard"
          onClick={() => act('copy')}
          disabled={finished}
        >
          {finished ? `Arrived${str(route['destination']) ? ` at ${str(route['destination'])}` : ''}` : next}
        </button>
        {!finished && route['nextIsNeutron'] === true && <span className="router-neutron">Neutron</span>}
        {!finished && (
          <button type="button" className="secondary" onClick={() => act('copy')}>
            Copy
          </button>
        )}
      </div>

      <div className="router-progress" aria-label={`${Math.round(progress * 100)}% of the route done`}>
        <div style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="router-stats">
        <div>
          <div className="field-label">Jumps left</div>
          <div className="router-stat">{jumpsLeft}</div>
        </div>
        <div>
          <div className="field-label">Waypoint</div>
          <div className="router-stat">
            {num(route['waypoint']) ?? 0} of {num(route['waypoints']) ?? 0}
          </div>
        </div>
        <div>
          <div className="field-label">Destination</div>
          <div className="router-stat">{str(route['destination']) ?? '—'}</div>
        </div>
      </div>

      <div className="row router-actions">
        <button type="button" className="secondary" onClick={() => act('step', { delta: -1 })}>
          ◀ Previous
        </button>
        <button type="button" className="secondary" onClick={() => act('step', { delta: 1 })}>
          Next ▶
        </button>
        <span className="router-spacer" />
        {confirming ? (
          <>
            <span className="muted">Clear this route?</span>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setConfirming(false);
                act('clear');
              }}
            >
              Clear
            </button>
            <button type="button" className="link" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="link" onClick={() => setConfirming(true)}>
            Clear route
          </button>
        )}
      </div>
    </section>
  );
}
