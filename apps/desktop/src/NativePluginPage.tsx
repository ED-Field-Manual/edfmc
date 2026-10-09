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
            <HotkeyField
              label="Set a hotkey to copy your carrier's next jump"
              hint="The next system on your fleet carrier's route, ready to paste into the carrier's galaxy map. Works alongside the one above, so you can fly one route and move your carrier along another."
              binding={snap.carrierCopyHotkey}
              onSet={snap.setCarrierCopyHotkey}
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

type Slot = 'ship' | 'carrier';

const obj = (v: unknown): State | null => (v && typeof v === 'object' ? (v as State) : null);

/**
 * Two routes followed at once: the commander's own, and their fleet carrier's.
 * Each has its own tab; both keep following the game whichever is shown.
 */
function RouterPage({ state, act }: { state: State; act: Act }) {
  const ship = obj(state['route']);
  const carrier = obj(state['carrierRoute']);
  const status = obj(state['status']);
  const [slot, setSlot] = useState<Slot>(() => (!ship && carrier ? 'carrier' : 'ship'));
  const route = slot === 'carrier' ? carrier : ship;
  const plotting = state[slot === 'carrier' ? 'carrierPlotting' : 'plotting'] === true;
  const statusSlot = status?.['slot'] === 'carrier' ? 'carrier' : 'ship';
  const statusText = status && statusSlot === slot ? str(status['text']) : null;
  // Each action names the route it is for.
  const slotAct: Act = (action, args = {}) => act(action, { ...args, slot });

  const summary = (r: State | null, busy: boolean) =>
    busy ? 'Plotting…' : !r ? 'No route' : r['finished'] === true ? 'Arrived' : `Next: ${str(r['next']) ?? '—'}`;

  return (
    <>
      <div className="router-choice router-slots" role="tablist" aria-label="Which route">
        {(
          [
            { value: 'ship' as const, title: 'Your route', r: ship, busy: state['plotting'] === true },
            { value: 'carrier' as const, title: 'Carrier route', r: carrier, busy: state['carrierPlotting'] === true },
          ]
        ).map((o) => (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={slot === o.value}
            className={slot === o.value ? 'active' : ''}
            onClick={() => setSlot(o.value)}
          >
            <strong>{o.title}</strong>
            <span>{summary(o.r, o.busy)}</span>
          </button>
        ))}
      </div>
      {route ? (
        <>
          <RouterFollow route={route} act={slotAct} flying={slot === 'ship' ? obj(state['flying']) : null} />
          <WaypointList route={route} act={slotAct} />
        </>
      ) : (
        <RouterForm key={slot} state={state} act={act} mode={slot} plotting={plotting} />
      )}
      {/* While plotting, the plotting panel says it; the status line would repeat it. */}
      {statusText && !plotting && (
        <p className={status?.['error'] === true ? 'router-status bad' : 'router-status'}>{statusText}</p>
      )}
    </>
  );
}

function RouterForm({
  state,
  act,
  mode,
  plotting,
}: {
  state: State;
  act: Act;
  /** Which route this form plots: the commander's own, or their carrier's. */
  mode: Slot;
  plotting: boolean;
}) {
  const current = str(state['currentSystem']);
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
  const [type, setType] = useState<RouteType>(
    mode === 'carrier' ? 'carrier' : remembered['type'] === 'exact' ? 'exact' : 'neutron',
  );
  const carriers = readCarriers(state['carriers']);
  const [carrier, setCarrier] = useState<CarrierForm>(() => ({
    ...CARRIER_DEFAULTS,
    kind: remembered['carrierType'] === 'squadron' ? 'squadron' : 'fleet',
  }));
  const ownCarrier = carriers?.[carrier.kind] ?? null;
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

  useEffect(() => {
    if (type !== 'carrier' || !ownCarrier) return;
    setCarrier((c) => ({
      ...c,
      usedCapacity: c.usedCapacity === '' && ownCarrier.usedCapacity !== null ? String(ownCarrier.usedCapacity) : c.usedCapacity,
      fuel: c.fuel === '' && ownCarrier.fuel !== null ? String(ownCarrier.fuel) : c.fuel,
    }));
    if (ownCarrier.system && (source === '' || source === autoSource.current)) {
      setSource(ownCarrier.system);
      autoSource.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, carrier.kind, ownCarrier?.system, ownCarrier?.fuel, ownCarrier?.usedCapacity]);

  const suggestions = state['suggestions'] && typeof state['suggestions'] === 'object' ? (state['suggestions'] as State) : null;

  return (
    <section className="card router-card">
      <h2>{mode === 'carrier' ? 'Plot a carrier route' : 'Plot a route'}</h2>
      {mode === 'ship' && (
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
      )}
      <p className="muted">
        {type === 'neutron'
          ? "Spansh's neutron plotter. Start typing a system name for suggestions."
          : type === 'exact'
            ? "Spansh's exact plotter, using your ship's drive and fuel tanks from the game. Start typing a system name for suggestions."
            : "Spansh's fleet carrier planner: each jump of up to 500 ly, the tritium it burns, and where to restock. Start typing a system name for suggestions."}
      </p>
      {type !== 'carrier' && (
      <ShipPicker
        fleet={state['fleet']}
        selected={num(state['selectedShip'])}
        onPick={(ship) => {
          act('select_ship', { id: ship.id });
          // The neutron plotter takes a range and a supercharge rather than a
          // ship, so picking one fills both in.
          if (ship.maxJump) setRange(ship.maxJump.toFixed(2));
          setSupercharge(ship.supercharge === 6 ? 6 : 4);
        }}
      />
      )}
      {type === 'exact' && shipInfo && shipInfo['ready'] !== true && (
        <p className="note">{str(shipInfo['reason']) ?? 'Router cannot read this ship yet.'}</p>
      )}

      {plotting && (
        <div className="router-plotting" role="status" aria-live="polite">
          <span className="router-spinner" aria-hidden="true" />
          <div>
            <strong>Plotting your route… please wait</strong>
            <div className="muted">
              Spansh is working out the{' '}
              {type === 'exact' ? 'jumps' : type === 'carrier' ? 'carrier jumps' : 'neutron route'} to{' '}
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
          {type === 'carrier' && ownCarrier?.system && source !== ownCarrier.system ? (
            <button
              type="button"
              className="link"
              onClick={() => {
                setSource(ownCarrier.system!);
                autoSource.current = null;
              }}
            >
              Use where your carrier is
            </button>
          ) : (
            current &&
            source !== current && (
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
            )
          )}
        </div>
        <SystemInput id="router-from" field="from" value={source} onChange={setSource} suggestions={suggestions} act={act} />
      </div>

      {type !== 'exact' && via.map((v, i) => (
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
            {type !== 'exact' && via.length < 10 && (
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

      {type === 'carrier' ? (
        <CarrierFields
          form={carrier}
          onChange={setCarrier}
          carriers={carriers}
          stops={[...via.filter((v) => v.trim()), destination].filter((v) => v.trim())}
        />
      ) : type === 'exact' ? (
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
            type === 'carrier'
              ? act('plot', {
                  type,
                  source,
                  destination,
                  via: via.filter((v) => v.trim()),
                  carrier: carrier.kind,
                  usedCapacity: carrier.usedCapacity,
                  fuelMode: carrier.fuelMode,
                  fuel: carrier.fuel,
                  market: carrier.market,
                  refuelAt: carrier.refuelAt,
                })
              : type === 'exact'
                ? act('plot', { type, source, destination, options: exact })
                : act('plot', { type, source, destination, range, efficiency, supercharge, via: via.filter((v) => v.trim()) })
          }
        >
          {plotting ? 'Plotting…' : 'Plot route'}
        </button>
        {mode === 'ship' && (
          <button type="button" className="secondary" onClick={() => act('import')}>
            Import CSV…
          </button>
        )}
      </div>
      </fieldset>
    </section>
  );
}

type RouteType = 'neutron' | 'exact' | 'carrier';

interface CarrierInfo {
  name: string | null;
  callsign: string | null;
  fuel: number | null;
  usedCapacity: number | null;
  capacity: number | null;
  system: string | null;
  asOf: string | null;
}

function readCarriers(v: unknown): Partial<Record<'fleet' | 'squadron', CarrierInfo>> | null {
  if (v === null || typeof v !== 'object') return null;
  const out: Partial<Record<'fleet' | 'squadron', CarrierInfo>> = {};
  for (const kind of ['fleet', 'squadron'] as const) {
    const o = (v as Record<string, unknown>)[kind];
    if (o === null || typeof o !== 'object') continue;
    const c = o as Record<string, unknown>;
    out[kind] = {
      name: str(c['name']),
      callsign: str(c['callsign']),
      fuel: num(c['fuel']),
      usedCapacity: num(c['used_capacity']),
      capacity: num(c['capacity']),
      system: str(c['system']),
      asOf: str(c['as_of']),
    };
  }
  return out;
}

interface CarrierForm {
  kind: 'fleet' | 'squadron';
  usedCapacity: string;
  /** `calculate`: Spansh works out the tritium to start with and where to restock. */
  fuelMode: 'calculate' | 'current';
  fuel: string;
  market: string;
  /** Stops where restocking is allowed, when Spansh calculates the tritium. */
  refuelAt: string[];
}

const CARRIER_DEFAULTS: CarrierForm = {
  kind: 'fleet',
  usedCapacity: '',
  fuelMode: 'calculate',
  fuel: '',
  market: '0',
  refuelAt: [],
};

/** Capacity from Spansh's own planner: a fleet carrier 25,000 t, a squadron carrier 60,000 t. */
const CARRIER_CAPACITY = { fleet: 25000, squadron: 60000 } as const;

function CarrierFields({
  form,
  onChange,
  carriers,
  stops,
}: {
  form: CarrierForm;
  onChange: (f: CarrierForm) => void;
  carriers: Partial<Record<'fleet' | 'squadron', CarrierInfo>> | null;
  stops: string[];
}) {
  const set = (patch: Partial<CarrierForm>) => onChange({ ...form, ...patch });
  const own = carriers?.[form.kind] ?? null;
  return (
    <>
      <div className="router-field">
        <span className="field-label">Carrier</span>
        <div className="router-choice" role="radiogroup" aria-label="Carrier">
          {(['fleet', 'squadron'] as const).map((kind) => {
            const c = carriers?.[kind];
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={form.kind === kind}
                className={form.kind === kind ? 'active' : ''}
                // Switching carrier clears what the other one filled in.
                onClick={() => set({ kind, usedCapacity: '', fuel: '' })}
              >
                <strong>{kind === 'fleet' ? 'Fleet carrier' : 'Squadron carrier'}</strong>
                <span>
                  {c?.name ? `${c.name}${c.callsign ? ` (${c.callsign})` : ''}` : `${CARRIER_CAPACITY[kind].toLocaleString()} t capacity`}
                  {c?.system ? ` · in ${c.system}` : ''}
                </span>
              </button>
            );
          })}
        </div>
        {own ? (
          <p className="field-hint">
            Filled in from the game{own.asOf ? `, as of ${new Date(own.asOf).toLocaleString()}` : ''}. Open carrier
            management in game to refresh it.
          </p>
        ) : (
          <p className="field-hint">
            Router has not seen this carrier in your journals yet. Open its carrier management screen in game once, or
            fill this in yourself.
          </p>
        )}
      </div>

      <div className="router-field">
        <label className="field-label" htmlFor="router-capacity">
          Capacity used (t)
        </label>
        <input
          id="router-capacity"
          type="text"
          inputMode="numeric"
          value={form.usedCapacity}
          onChange={(e) => set({ usedCapacity: e.target.value })}
        />
        <span className="field-hint">
          Cargo, crew, services and stored ships all count: a heavier carrier burns more tritium per jump.
        </span>
      </div>

      <div className="router-field">
        <span className="field-label">Tritium</span>
        <div className="router-choice" role="radiogroup" aria-label="Tritium">
          {[
            { value: 'calculate' as const, title: 'Work it out', detail: 'How much to load, and where to restock' },
            { value: 'current' as const, title: 'What I have', detail: 'Plan with the tank and market as they are' },
          ].map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={form.fuelMode === o.value}
              className={form.fuelMode === o.value ? 'active' : ''}
              onClick={() => set({ fuelMode: o.value })}
            >
              <strong>{o.title}</strong>
              <span>{o.detail}</span>
            </button>
          ))}
        </div>
      </div>

      {form.fuelMode === 'current' ? (
        <div className="router-pair">
          <div className="router-field">
            <label className="field-label" htmlFor="router-tank">
              In the tank (t)
            </label>
            <input
              id="router-tank"
              type="text"
              inputMode="numeric"
              value={form.fuel}
              onChange={(e) => set({ fuel: e.target.value })}
            />
          </div>
          <div className="router-field">
            <label className="field-label" htmlFor="router-market">
              In the carrier&apos;s market (t)
            </label>
            <input
              id="router-market"
              type="text"
              inputMode="numeric"
              value={form.market}
              onChange={(e) => set({ market: e.target.value })}
            />
          </div>
        </div>
      ) : (
        stops.length > 1 && (
          <div className="router-field">
            <span className="field-label">Restock only at</span>
            <div className="router-checks">
              {stops.slice(0, -1).map((stop) => (
                <label key={stop} className="check">
                  <input
                    type="checkbox"
                    checked={form.refuelAt.includes(stop)}
                    onChange={(e) =>
                      set({
                        refuelAt: e.target.checked
                          ? [...form.refuelAt, stop]
                          : form.refuelAt.filter((s) => s !== stop),
                      })
                    }
                  />
                  <span>{stop}</span>
                </label>
              ))}
            </div>
            <span className="field-hint">Leave all unticked and Spansh picks where to restock.</span>
          </div>
        )
      )}
    </>
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

interface FleetShip {
  id: number;
  name: string | null;
  model: string | null;
  current: boolean;
  maxJump: number | null;
  asOf: string | null;
  ready: boolean;
  supercharge: number | null;
  reason: string | null;
}

function readFleet(v: unknown): FleetShip[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((x) => {
    if (x === null || typeof x !== 'object') return [];
    const o = x as Record<string, unknown>;
    const id = num(o['id']);
    if (id === null) return [];
    return [
      {
        id,
        name: str(o['name']),
        model: str(o['model']),
        current: o['current'] === true,
        maxJump: num(o['maxJump']),
        asOf: str(o['asOf']),
        ready: o['ready'] === true,
        supercharge: num(o['supercharge']),
        reason: str(o['reason']),
      },
    ];
  });
}

const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null;

/**
 * Every ship you own, to plot with, whichever you are flying. Each one's
 * figures are from the last time you flew it; one never flown since your
 * journals began cannot be picked, and says so.
 */
function ShipPicker({
  fleet,
  selected,
  onPick,
}: {
  fleet: unknown;
  selected: number | null;
  onPick: (ship: FleetShip) => void;
}) {
  const ships = readFleet(fleet);
  const [open, setOpen] = useState(false);
  if (ships === null) {
    // Still reading the journals; say which ship is in use meanwhile.
    return (
      <div className="router-ship">
        <span className="field-label">Ship</span>
        <div className="muted">Reading your ships from the journal…</div>
      </div>
    );
  }
  const chosen = ships.find((s) => s.id === selected) ?? ships.find((s) => s.current) ?? null;
  const title = (s: FleetShip) => s.name ?? s.model ?? `Ship ${s.id}`;

  return (
    <div className="router-ship-picker">
      <div className="router-label-row">
        <span className="field-label">Plot for</span>
        <button type="button" className="link" onClick={() => setOpen(!open)}>
          {open ? 'Done' : `Change ship (${ships.filter((s) => s.ready).length} available)`}
        </button>
      </div>
      {chosen && !open && <ShipTile ship={chosen} selected title={title(chosen)} onPick={() => setOpen(true)} />}
      {open && (
        <div className="router-ship-grid" role="radiogroup" aria-label="Ship to plot for">
          {ships.map((s) => (
            <ShipTile
              key={s.id}
              ship={s}
              title={title(s)}
              selected={chosen?.id === s.id}
              onPick={() => {
                if (!s.ready) return;
                onPick(s);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ShipTile({
  ship,
  title,
  selected,
  onPick,
}: {
  ship: FleetShip;
  title: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={!ship.ready}
      title={ship.reason ?? undefined}
      className={`router-ship-tile${selected ? ' active' : ''}`}
      onClick={onPick}
    >
      <span className="router-ship-top">
        <strong>{title}</strong>
        {ship.current && <span className="router-next-tag">Flying</span>}
      </span>
      <span className="router-ship-sub">
        {ship.name && ship.model ? `${ship.model} · ` : ''}
        {ship.ready && ship.maxJump !== null ? `${ship.maxJump.toFixed(2)} ly max jump` : ship.reason}
      </span>
      {ship.ready && !ship.current && ship.asOf && (
        <span className="router-ship-asof">As last flown, {shortDate(ship.asOf)}</span>
      )}
    </button>
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
  /** Carrier routes only. */
  tritiumUsed: number | null;
  tritiumLeft: number | null;
  restock: number | null;
  icyRing: boolean;
  pristine: boolean;
  stop: boolean;
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
        tritiumUsed: num(o['tritiumUsed']),
        tritiumLeft: num(o['tritiumLeft']),
        restock: num(o['restock']),
        icyRing: o['icyRing'] === true,
        pristine: o['pristine'] === true,
        stop: o['stop'] === true,
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
                {c.stop && <span className="router-stop-tag">Your stop</span>}
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
                {c.tritiumUsed !== null && ` · ${c.tritiumUsed} t tritium`}
                {c.tritiumLeft !== null && ` · ${c.tritiumLeft} t left in the tank`}
                {c.restock !== null && (
                  <span className="router-refuel"> · Load {c.restock.toLocaleString()} t of tritium here</span>
                )}
                {c.icyRing && ` · Icy ring${c.pristine ? ' (pristine)' : ''}: tritium can be mined`}
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

function RouterFollow({ route, act, flying }: { route: State; act: Act; flying: State | null }) {
  const next = str(route['next']);
  const planned = obj(route['plannedFor']);
  // Planned for one ship and flown in another: jumps longer than this ship
  // can make need stops the game adds, and those are not waypoints.
  const mismatch =
    planned !== null && flying !== null && num(planned['id']) !== null && num(planned['id']) !== num(flying['id']);
  const finished = route['finished'] === true || next === null;
  const progress = Math.max(0, Math.min(1, num(route['progress']) ?? 0));
  const jumpsLeft = num(route['jumpsLeft']) ?? 0;
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="card router-card">
      <h2>{finished ? 'Route complete' : 'Next waypoint'}</h2>
      {mismatch && !finished && (
        <p className="note">
          This route was planned for your {str(planned!['name']) ?? 'other ship'}
          {num(planned!['maxJump']) !== null ? ` (${num(planned!['maxJump'])!.toFixed(2)} ly)` : ''}, but you are flying
          your {str(flying!['name']) ?? 'current ship'}
          {num(flying!['maxJump']) !== null ? ` (${num(flying!['maxJump'])!.toFixed(2)} ly)` : ''}. Where a jump is
          longer than this ship can make, the game adds stops on the way, and the route moves on only when you reach
          the next waypoint. Clear it and plot again to plan for this ship.
        </p>
      )}
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
        {route['type'] === 'carrier' && (
          <div>
            <div className="field-label">Tritium to go</div>
            <div className="router-stat">
              {readWaypoints(route['waypoints_list'])
                .filter((w) => w.state !== 'done')
                .reduce((t, w) => t + (w.tritiumUsed ?? 0), 0)
                .toLocaleString()}{' '}
              t
            </div>
          </div>
        )}
      </div>
      {route['type'] === 'carrier' && (
        <p className="field-hint">
          Paste the next system into the carrier&apos;s galaxy map to schedule the jump. The route moves on when your
          carrier arrives, whether or not you are aboard.
        </p>
      )}

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
