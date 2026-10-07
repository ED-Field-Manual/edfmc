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

import { HotkeyField } from './HotkeyField';
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
        <>
          <section className="card router-card">
            <h2>In game</h2>
            <HotkeyField
              label="Set a hotkey to copy the next waypoint without leaving the game"
              hint="The next system on your route is copied to the clipboard, ready to paste into the galaxy map. Use a modifier with one key, for example Ctrl + Shift + C."
              binding={snap.routeCopyHotkey}
              onSet={snap.setRouteCopyHotkey}
            />
          </section>
          <RouterPage state={state} act={act} />
        </>
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
      {route ? (
        <>
          <RouterFollow route={route} act={act} />
          <WaypointList route={route} act={act} />
        </>
      ) : (
        <RouterForm state={state} act={act} />
      )}
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
  const [via, setVia] = useState<string[]>([]);
  const remembered = state['settings'] && typeof state['settings'] === 'object' ? (state['settings'] as State) : {};
  const shipInfo = state['ship'] && typeof state['ship'] === 'object' ? (state['ship'] as State) : null;
  const [supercharge, setSupercharge] = useState(() =>
    num(shipInfo?.['superchargeMultiplier']) === 6 || num(state['supercharge']) === 6 ? 6 : 4,
  );
  const [type, setType] = useState<'neutron' | 'exact'>(remembered['type'] === 'exact' ? 'exact' : 'neutron');
  const [exact, setExact] = useState<ExactOptions>(() => ({
    ...EXACT_DEFAULTS,
    ...((remembered['options'] && typeof remembered['options'] === 'object' ? remembered['options'] : {}) as Partial<ExactOptions>),
  }));
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
      <div className="router-choice router-type" role="radiogroup" aria-label="Route type">
        {[
          { value: 'neutron' as const, title: 'Neutron route', detail: 'Fastest: boosts at neutron stars' },
          { value: 'exact' as const, title: 'Normal jumps', detail: 'Every jump and fuel stop, for your ship' },
        ].map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={type === o.value}
            className={type === o.value ? 'active' : ''}
            onClick={() => setType(o.value)}
          >
            <strong>{o.title}</strong>
            <span>{o.detail}</span>
          </button>
        ))}
      </div>
      <p className="muted">
        {type === 'neutron'
          ? "Spansh's neutron plotter. Start typing a system name for suggestions."
          : "Spansh's exact plotter, using your ship's drive and fuel tanks from the game. Start typing a system name for suggestions."}
      </p>
      {type === 'exact' && <ShipStatus ship={shipInfo} />}

      {plotting && (
        <div className="router-plotting" role="status" aria-live="polite">
          <span className="router-spinner" aria-hidden="true" />
          <div>
            <strong>Plotting your route… please wait</strong>
            <div className="muted">
              Spansh is working out the {type === 'exact' ? 'jumps' : 'neutron route'} to{' '}
              {destination || 'your destination'}.{' '}
              {type === 'exact'
                ? `This can take up to ${Math.round(exact.max_time / 60) || 1}–${Math.round(exact.max_time / 60) + 1} minutes.`
                : 'Long routes can take up to a minute.'}
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

      {type === 'neutron' && via.map((v, i) => (
        <div className="router-field" key={i}>
          <div className="router-label-row">
            <label className="field-label" htmlFor={`router-via-${i}`}>
              Via {via.length > 1 ? i + 1 : ''}
            </label>
            <button type="button" className="link" onClick={() => setVia(via.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
          <SystemInput
            id={`router-via-${i}`}
            field={`via-${i}`}
            value={v}
            onChange={(next) => setVia(via.map((x, j) => (j === i ? next : x)))}
            suggestions={suggestions}
            act={act}
          />
        </div>
      ))}

      <div className="router-field">
        <div className="router-label-row">
          <label className="field-label" htmlFor="router-to">
            To
          </label>
          <span className="router-label-actions">
            {type === 'neutron' && via.length < 10 && (
              <button type="button" className="link" onClick={() => setVia([...via, ''])}>
                Add a stop on the way
              </button>
            )}
            <button
              type="button"
              className="link"
              title="Swap From and To"
              onClick={() => {
                setSource(destination);
                setDestination(source);
                autoSource.current = null;
              }}
            >
              Swap ⇅
            </button>
          </span>
        </div>
        <SystemInput id="router-to" field="to" value={destination} onChange={setDestination} suggestions={suggestions} act={act} />
      </div>

      {type === 'exact' ? (
        <ExactFields options={exact} onChange={setExact} />
      ) : (
      <>
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
      <p className="field-hint">
        Efficiency: higher keeps closer to a straight line; lower takes longer detours to reach neutron
        stars.
      </p>

      <div className="router-field">
        <span className="field-label">Neutron supercharge</span>
        <div className="router-choice" role="radiogroup" aria-label="Neutron supercharge">
          {[
            { value: 4, title: 'Standard (4×)', detail: 'Every drive but the Caspian’s' },
            { value: 6, title: 'Caspian (6×)', detail: 'Overcharge booster Mk II drive' },
          ].map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={supercharge === o.value}
              className={supercharge === o.value ? 'active' : ''}
              onClick={() => setSupercharge(o.value)}
            >
              <strong>{o.title}</strong>
              <span>{o.detail}</span>
            </button>
          ))}
        </div>
      </div>
      </>
      )}

      <div className="row router-actions">
        <button
          type="button"
          className="primary"
          disabled={plotting || (type === 'exact' && shipInfo?.['ready'] !== true)}
          onClick={() =>
            type === 'exact'
              ? act('plot', { type, source, destination, options: exact })
              : act('plot', { type, source, destination, range, efficiency, supercharge, via: via.filter((v) => v.trim()) })
          }
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

/** The exact plotter's own options, named as Spansh names them. */
interface ExactOptions {
  algorithm: 'optimistic' | 'pessimistic' | 'fuel' | 'fuel_jumps' | 'guided';
  use_supercharge: boolean;
  is_supercharged: boolean;
  use_injections: boolean;
  exclude_secondary: boolean;
  refuel_every_scoopable: boolean;
  cargo: number;
  reserve_size: number;
  max_time: number;
}

/** Spansh's own defaults, apart from neutron boosts: this is the normal-jump plotter. */
const EXACT_DEFAULTS: ExactOptions = {
  algorithm: 'optimistic',
  use_supercharge: false,
  is_supercharged: false,
  use_injections: false,
  exclude_secondary: false,
  refuel_every_scoopable: true,
  cargo: 0,
  reserve_size: 0,
  max_time: 60,
};

/** In Spansh's own terms, shortened (from its plotter's descriptions). */
const ALGORITHMS: Array<{ value: ExactOptions['algorithm']; label: string }> = [
  { value: 'optimistic', label: 'Optimistic: favours neutron boosts, usually the fewest jumps' },
  { value: 'pessimistic', label: 'Pessimistic: calculates faster, routes usually a little longer' },
  { value: 'fuel', label: 'Fuel: smallest jumps to save fuel, no scooping or boosts' },
  { value: 'fuel_jumps', label: 'Fuel, then fewest jumps: saves fuel, then uses the whole tank' },
  { value: 'guided', label: 'Guided: follows a neutron-plotter route as its guide' },
];

function ShipStatus({ ship }: { ship: State | null }) {
  if (!ship) return null;
  if (ship['ready'] !== true) {
    return <p className="note">{str(ship['reason']) ?? 'Router cannot read your ship yet.'}</p>;
  }
  const name = str(ship['name']);
  const model = str(ship['ship']);
  return (
    <div className="router-ship">
      <span className="field-label">Your ship</span>
      <div>
        <strong>{name ?? model ?? 'Current ship'}</strong>
        {name && model && <span className="muted"> · {model}</span>}
        <span className="muted"> · {num(ship['gameRange'])?.toFixed(2) ?? '—'} ly max jump, matches the game</span>
      </div>
    </div>
  );
}

function ExactFields({ options, onChange }: { options: ExactOptions; onChange: (o: ExactOptions) => void }) {
  const set = <K extends keyof ExactOptions>(key: K, value: ExactOptions[K]) => onChange({ ...options, [key]: value });
  const check = (key: keyof ExactOptions, label: string, hint: string) => (
    <label className="router-check">
      <input type="checkbox" checked={options[key] as boolean} onChange={(e) => set(key, e.target.checked as never)} />
      <span>
        {label}
        <small>{hint}</small>
      </span>
    </label>
  );
  return (
    <>
      <div className="router-field">
        <label className="field-label" htmlFor="router-algorithm">
          Routing
        </label>
        <select
          id="router-algorithm"
          value={options.algorithm}
          onChange={(e) => set('algorithm', e.target.value as ExactOptions['algorithm'])}
        >
          {ALGORITHMS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>

      <div className="router-pair">
        <div className="router-field">
          <label className="field-label" htmlFor="router-cargo">
            Cargo carried (t)
          </label>
          <input
            id="router-cargo"
            type="text"
            inputMode="numeric"
            value={String(options.cargo)}
            onChange={(e) => set('cargo', Math.max(0, Number(e.target.value) || 0))}
          />
        </div>
        <div className="router-field">
          <label className="field-label" htmlFor="router-reserve">
            Fuel to keep in reserve (t)
          </label>
          <input
            id="router-reserve"
            type="text"
            inputMode="decimal"
            value={String(options.reserve_size)}
            onChange={(e) => set('reserve_size', Math.max(0, Number(e.target.value) || 0))}
          />
        </div>
        <div className="router-field">
          <label className="field-label" htmlFor="router-time">
            Search time (s)
          </label>
          <input
            id="router-time"
            type="text"
            inputMode="numeric"
            value={String(options.max_time)}
            onChange={(e) => set('max_time', Math.min(120, Math.max(60, Number(e.target.value) || 60)))}
          />
        </div>
      </div>

      <div className="router-checks">
        {check('refuel_every_scoopable', 'Refuel at every scoopable star', 'Keeps the tank topped up instead of only when needed.')}
        {check('exclude_secondary', 'Avoid secondary stars', 'Only arrive at a system’s main star.')}
        {check('use_supercharge', 'Use neutron boosts where they help', 'Off for strictly normal jumps.')}
        {check('is_supercharged', 'Already supercharged', 'Your drive is boosted from a neutron star right now.')}
        {check('use_injections', 'Use FSD injections', 'Synthesised jump boosts, when they help.')}
      </div>
    </>
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

interface WaypointCard {
  system: string;
  jumps: number;
  distanceLeft: number | null;
  distance: number | null;
  scoopable: boolean;
  refuel: boolean;
  neutron: boolean;
  state: 'done' | 'next' | 'upcoming';
}

function readWaypoints(v: unknown): WaypointCard[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((w) => {
    if (w === null || typeof w !== 'object') return [];
    const o = w as Record<string, unknown>;
    const system = str(o['system']);
    if (!system) return [];
    const state = o['state'] === 'done' || o['state'] === 'next' ? o['state'] : 'upcoming';
    return [
      {
        system,
        jumps: num(o['jumps']) ?? 0,
        distanceLeft: num(o['distanceLeft']),
        distance: num(o['distance']),
        scoopable: o['scoopable'] === true,
        refuel: o['refuel'] === true,
        neutron: o['neutron'] === true,
        state,
      },
    ];
  });
}

/**
 * Every waypoint as its own card, in order. Done ones are dimmed, the next one
 * is marked, and any of them can be copied or made the next stop.
 */
function WaypointList({ route, act }: { route: State; act: Act }) {
  const cards = readWaypoints(route['waypoints_list']);
  const [showDone, setShowDone] = useState(false);
  const nextRef = useRef<HTMLLIElement | null>(null);
  const doneCount = cards.filter((c) => c.state === 'done').length;
  const shown = showDone ? cards.map((c, i) => ({ c, i })) : cards.map((c, i) => ({ c, i })).filter(({ c }) => c.state !== 'done');

  if (cards.length === 0) return null;
  return (
    <section className="router-waypoints">
      <div className="router-waypoints-head">
        <h2>Waypoints</h2>
        {doneCount > 0 && (
          <button type="button" className="link" onClick={() => setShowDone(!showDone)}>
            {showDone ? 'Hide visited' : `Show ${doneCount} visited`}
          </button>
        )}
      </div>
      <ol className="router-waypoint-list">
        {shown.map(({ c, i }) => (
          <li key={i} ref={c.state === 'next' ? nextRef : undefined} className={`router-waypoint ${c.state}`}>
            <span className="router-waypoint-index">{c.state === 'done' ? '✓' : i + 1}</span>
            <div className="router-waypoint-main">
              <div className="router-waypoint-name">
                {c.system}
                {c.neutron && <span className="router-neutron">Neutron</span>}
                {c.state === 'next' && <span className="router-next-tag">Next</span>}
              </div>
              <div className="router-waypoint-meta">
                {i === 0
                  ? 'Start'
                  : c.distance !== null
                    ? `${c.distance.toFixed(2)} ly jump`
                    : `${c.jumps} ${c.jumps === 1 ? 'jump' : 'jumps'} from the previous waypoint`}
                {c.distanceLeft !== null && c.distanceLeft > 0 && ` · ${Math.round(c.distanceLeft).toLocaleString()} ly to go`}
                {c.refuel && <span className="router-refuel"> · Refuel here</span>}
                {!c.refuel && c.scoopable && ' · Scoopable'}
              </div>
            </div>
            <div className="router-waypoint-actions">
              <button type="button" className="secondary" onClick={() => act('copy_system', { system: c.system })}>
                Copy
              </button>
              {c.state !== 'next' && (
                <button type="button" className="link" onClick={() => act('goto', { index: i })}>
                  Set as next
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
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
