/**
 * The Overlay page: switch the overlay on, choose widgets, arrange them, and
 * set how they look.
 *
 * Written for players, not for debugging. Window coordinates, DPI and raw
 * display-mode values are on the Diagnostics page (`OverlayDiagnostics`
 * below); here they become one status line.
 *
 * The overlay engine is unchanged: an external, transparent, click-through
 * window that follows the game window. It never injects code into Elite
 * Dangerous, reads its memory, or sends it input.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { HotkeyField } from './HotkeyField';
import { companion } from './lib/companion.js';
import {
  APPEARANCE_BOUNDS,
  onEditMode,
  onEliteWindow,
  onOverlayRuntime,
  overlayApi,
  overlayStatus,
  type DisplayModeInfo,
  type EliteWindowInfo,
  type OverlayAppearance,
  type OverlayRuntime,
  type OverlayWidgets,
} from './lib/overlay.js';
import {
  MAX_PROFILES,
  MAX_PROFILE_NAME,
  MISSION_ROWS_BOUNDS,
  PRESETS,
  type OverlayWidgetOptions,
  type PresetId,
} from './lib/overlayLayout.js';
import {
  CarrierJumpWidget,
  ContextWidget,
  LiveExobiologyWidget,
  MissionsWidget,
  RouteWidget,
  WidgetFrame,
} from './overlay/widgets';
import './overlay/widgets.css';

type Snap = ReturnType<typeof companion.snapshot>;

/* ------------------------------------------------------- live game state */

/** Display mode, game window and the overlay's real state, kept current. */
function useOverlayEnvironment() {
  const [mode, setMode] = useState<DisplayModeInfo | null>(null);
  const [win, setWin] = useState<EliteWindowInfo | null>(null);
  const [runtime, setRuntime] = useState<OverlayRuntime | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    void overlayApi.displayMode().then(setMode).catch(() => undefined);
    void overlayApi.eliteWindow().then(setWin).catch(() => undefined);
    void overlayApi
      .runtime()
      .then((r) => {
        setRuntime(r);
        setEditing(r.editing);
      })
      .catch(() => undefined);
    // Window updates arrive while the overlay runs. When it is off nothing
    // emits them, so the game window is checked on a slow timer instead.
    const poll = setInterval(() => void overlayApi.eliteWindow().then(setWin).catch(() => undefined), 5000);
    const stops = [
      onEliteWindow(setWin),
      onOverlayRuntime(setRuntime),
      // The overlay leaves edit mode on its own (Escape, Done), so this follows
      // the real state rather than assuming the page owns it.
      onEditMode(setEditing),
    ];
    return () => {
      clearInterval(poll);
      stops.forEach((s) => s());
    };
  }, []);

  return { mode, win, runtime, editing };
}

/* ------------------------------------------------------------- the page */

export function OverlayManager() {
  const snap = useSyncExternalStore(
    (cb) => companion.subscribe(cb),
    () => companion.snapshot(),
  );
  const enabled = useSyncExternalStore(
    (cb) => companion.subscribe(cb),
    () => companion.overlayOn,
  );
  const hideInactive = useSyncExternalStore(
    (cb) => companion.subscribe(cb),
    () => companion.overlayHideWhenInactive,
  );
  const widgets = useSyncExternalStore(
    (cb) => companion.subscribe(cb),
    () => companion.overlayWidgets,
  );
  const env = useOverlayEnvironment();
  const [error, setError] = useState<string | null>(null);

  const status = overlayStatus({
    enabled,
    runtime: env.runtime,
    window: env.win,
    mode: env.mode,
    hideWhenInactive: hideInactive,
  });

  async function toggle(next: boolean) {
    setError(null);
    const problem = await companion.setOverlayOn(next);
    if (problem) setError(problem);
  }

  async function arrange(next: boolean) {
    setError(null);
    try {
      await overlayApi.setEditMode(next);
    } catch (e) {
      setError(String(e));
    }
  }

  // Arranging needs the overlay on screen: it is the overlay that becomes movable.
  const canArrange = enabled && env.runtime?.visible === true;

  return (
    <>
      <header className="page-head ow-head">
        <h1>Overlay</h1>
        <Toggle label="Overlay" checked={enabled} onChange={(v) => void toggle(v)} showState />
      </header>

      <section className="card ow-status-card" aria-label="Overlay status">
        <p className={`ow-status ow-${status.tone}`} role="status">
          <span aria-hidden="true">{GLYPH[status.tone]}</span> {status.text}
        </p>
        <div className="ow-actions">
          {env.editing ? (
            <button type="button" className="primary" onClick={() => void arrange(false)}>
              Done arranging
            </button>
          ) : (
            <button type="button" className="primary" disabled={!canArrange} onClick={() => void arrange(true)}>
              Arrange widgets
            </button>
          )}
          <ResetLayout customised={snap.overlay.layoutCustomised} />
          <label className="check ow-inline-check">
            <input
              type="checkbox"
              checked={hideInactive}
              onChange={(e) => void companion.setOverlayHideWhenInactive(e.target.checked)}
            />
            <span>Hide when Elite isn’t the active window</span>
          </label>
        </div>
        {env.editing ? (
          <p className="field-hint">Drag widgets in the game to move them, and the right edge to resize. Press Done or Esc there to finish.</p>
        ) : (
          !canArrange && (
            <p className="field-hint">
              {enabled ? 'Arranging works while the overlay is showing over the game.' : 'Switch the overlay on to arrange it.'}
            </p>
          )
        )}
        {error && (
          <p className="note">
            <span aria-hidden="true">✕ </span>
            {error}
          </p>
        )}
      </section>

      <WidgetsSection snap={snap} widgets={widgets} />
      <AppearanceSection snap={snap} widgets={widgets} />
      <LayoutsSection snap={snap} />

      <section className="card">
        <h2>Shortcut</h2>
        <HotkeyField
          label="Show or hide the overlay"
          hint="Works while you play. Not set unless you choose one, so it never clashes with your game bindings."
          binding={snap.overlay.toggleHotkey}
          onSet={companion.setOverlayToggleHotkey}
        />
      </section>
    </>
  );
}

const GLYPH: Record<'ok' | 'warn' | 'off' | 'idle', string> = { ok: '●', warn: '▲', off: '○', idle: '◐' };

/* -------------------------------------------------------------- pieces */

function Toggle({
  label,
  checked,
  onChange,
  disabled,
  showState,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Say On or Off beside it as well, so the state is never colour alone. */
  showState?: boolean;
}) {
  return (
    <label className={`ow-toggle${disabled ? ' disabled' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ow-track" aria-hidden="true" />
      {showState && <span className="ow-state">{checked ? 'On' : 'Off'}</span>}
    </label>
  );
}

/** Asks first when the layout has been customised: a reset cannot be undone. */
function ResetLayout({ customised }: { customised: boolean }) {
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <span className="ow-confirm" role="group" aria-label="Confirm reset">
        Put every widget back in its standard place?
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setAsking(false);
            void companion.resetOverlayLayout();
          }}
        >
          Reset
        </button>
        <button type="button" className="secondary" onClick={() => setAsking(false)}>
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="secondary"
      disabled={!customised}
      title={customised ? undefined : 'Already in the standard layout'}
      onClick={() => setAsking(true)}
    >
      Reset layout
    </button>
  );
}

/* -------------------------------------------------------------- widgets */

interface WidgetRowSpec {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly on: boolean;
  readonly set: (on: boolean) => void;
  readonly note?: string | null;
  readonly options?: ReactNode;
}

function WidgetRow({ spec }: { spec: WidgetRowSpec }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`ow-row${spec.on ? '' : ' ow-row-off'}`}>
      <div className="ow-row-main">
        <div className="ow-row-text">
          <span className="ow-name">{spec.name}</span>
          <span className="ow-desc">{spec.description}</span>
          {spec.note && <span className="ow-desc ow-row-note">{spec.note}</span>}
        </div>
        {spec.options && (
          <button
            type="button"
            className="ow-options-btn"
            aria-expanded={open}
            disabled={!spec.on}
            onClick={() => setOpen(!open)}
          >
            Options {open ? '▴' : '▾'}
          </button>
        )}
        <Toggle label={spec.name} checked={spec.on} onChange={spec.set} />
      </div>
      {open && spec.on && spec.options && <div className="ow-options">{spec.options}</div>}
    </li>
  );
}

function WidgetsSection({ snap, widgets }: { snap: Snap; widgets: OverlayWidgets }) {
  const options = snap.overlay.options;
  const setW = (patch: Partial<OverlayWidgets>) => void companion.setOverlayWidgets({ ...widgets, ...patch });
  const setO = (patch: Partial<OverlayWidgetOptions>) => void companion.setWidgetOptions({ ...options, ...patch });
  const sources = snap.overlay.routeSources;
  const pluginName = (folder: string) => snap.pythonPlugins.plugins.find((p) => p.folder === folder)?.name ?? folder;

  const builtIns: WidgetRowSpec[] = [
    {
      key: 'context',
      name: 'Current Context',
      description: 'Where you are, and what EDFM says matters here.',
      on: widgets.context,
      set: (v) => setW({ context: v }),
    },
    {
      key: 'missions',
      name: 'Missions',
      description: 'Active missions, soonest to expire first.',
      on: widgets.missions,
      set: (v) => setW({ missions: v }),
      options: (
        <>
          <NumberChoice
            label="Missions listed"
            value={options.missionRows}
            min={MISSION_ROWS_BOUNDS.min}
            max={MISSION_ROWS_BOUNDS.max}
            onChange={(n) => setO({ missionRows: n })}
          />
          <label className="check">
            <input type="checkbox" checked={widgets.edfmNotes} onChange={(e) => setW({ edfmNotes: e.target.checked })} />
            <span>Show EDFM notes on what each mission type asks</span>
          </label>
        </>
      ),
    },
    {
      key: 'carrierJump',
      name: 'Carrier Jump',
      description: 'Countdown to your own carrier’s scheduled jump.',
      note: 'Shown only while a jump is scheduled.',
      on: widgets.carrierJump,
      set: (v) => setW({ carrierJump: v }),
    },
    {
      key: 'route',
      name: 'Route',
      description: 'The next jump on a route a plugin is following.',
      note: sources.length === 0 ? 'Shown when a route plugin, such as Router, is following a route.' : null,
      on: widgets.route,
      set: (v) => setW({ route: v }),
      options: (
        <>
          <Segmented
            label="Detail"
            value={options.routeDetail}
            choices={[
              ['compact', 'Compact'],
              ['detailed', 'Detailed'],
            ]}
            onChange={(v) => setO({ routeDetail: v })}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={options.routeShowWaypoints}
              disabled={options.routeDetail === 'compact'}
              onChange={(e) => setO({ routeShowWaypoints: e.target.checked })}
            />
            <span>Waypoint count</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={options.routeShowDestination}
              disabled={options.routeDetail === 'compact'}
              onChange={(e) => setO({ routeShowDestination: e.target.checked })}
            />
            <span>Destination</span>
          </label>
          {/* Only when there is a choice to make. */}
          {sources.length > 1 && (
            <label className="ow-field">
              <span>Route from</span>
              <select
                value={options.routeSource ?? ''}
                onChange={(e) => setO({ routeSource: e.target.value || null })}
              >
                <option value="">Whichever changed last</option>
                {sources.map((f) => (
                  <option key={f} value={f}>
                    {pluginName(f)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      ),
    },
    {
      key: 'liveJournal',
      name: 'Live Journal / Exobiology',
      description: 'Your sampling progress on this body, or the newest thing recorded.',
      on: widgets.liveJournal,
      set: (v) => setW({ liveJournal: v }),
      options: (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={options.journalShowEntries}
              onChange={(e) => setO({ journalShowEntries: e.target.checked })}
            />
            <span>Show the newest journal entry when you are not sampling</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={options.exoShowValues}
              onChange={(e) => setO({ exoShowValues: e.target.checked })}
            />
            <span>Show value and sample distance for each organism</span>
          </label>
        </>
      ),
    },
  ];

  // Plugin widgets: one row each, from plugins that are running.
  const off = widgets.pluginPanelsOff ?? [];
  const running = new Set(snap.pythonPlugins.plugins.filter((p) => p.loaded && !p.disabled).map((p) => p.folder));
  const plugins: WidgetRowSpec[] = Object.entries(snap.pythonPlugins.overlays)
    .filter(([, w]) => running.has(w.folder))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, w]) => ({
      key: `plugin:${key}`,
      name: w.title,
      description: w.description ?? `From ${pluginName(w.folder)}.`,
      note: w.description ? `From ${pluginName(w.folder)}.` : null,
      on: !off.includes(key),
      set: (v: boolean) =>
        setW({ pluginPanelsOff: v ? off.filter((k) => k !== key) : [...off.filter((k) => k !== key), key] }),
    }));

  return (
    <section className="card">
      <h2>Widgets</h2>
      <ul className="ow-list">
        {builtIns.map((spec) => (
          <WidgetRow key={spec.key} spec={spec} />
        ))}
      </ul>
      {plugins.length > 0 && (
        <>
          <h3 className="subhead">From plugins</h3>
          <ul className="ow-list">
            {plugins.map((spec) => (
              <WidgetRow key={spec.key} spec={spec} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function NumberChoice({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="ow-field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
        }}
      />
    </label>
  );
}

function Segmented<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="ow-field">
      <span>{label}</span>
      <div className="ow-seg" role="group" aria-label={label}>
        {choices.map(([v, text]) => (
          <button
            key={v}
            type="button"
            className={v === value ? 'chip chip-on' : 'chip'}
            aria-pressed={v === value}
            onClick={() => onChange(v)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- appearance */

function Slider({
  label,
  value,
  bounds,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  bounds: { min: number; max: number };
  onChange: (v: number) => void;
  hint?: string;
}) {
  const pct = Math.round(value * 100);
  return (
    <label className="opacity-control">
      <span className="opacity-label">
        {label}
        <span className="opacity-value">{pct}%</span>
      </span>
      <input
        type="range"
        min={Math.round(bounds.min * 100)}
        max={Math.round(bounds.max * 100)}
        step={5}
        value={pct}
        aria-label={label}
        // Live: the real overlay updates as this is dragged.
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function AppearanceSection({ snap, widgets }: { snap: Snap; widgets: OverlayWidgets }) {
  const a = snap.appearance;
  const set = (patch: Partial<OverlayAppearance>) => void companion.setAppearance({ ...a, ...patch });
  return (
    <section className="card">
      <h2>Appearance</h2>
      <div className="ow-appearance">
        <div className="ow-appearance-controls">
          <Slider
            label="Background"
            value={a.backgroundOpacity}
            bounds={APPEARANCE_BOUNDS.background}
            onChange={(v) => set({ backgroundOpacity: v })}
            hint="Text is unaffected."
          />
          <Slider
            label="Text"
            value={a.textOpacity}
            bounds={APPEARANCE_BOUNDS.text}
            onChange={(v) => set({ textOpacity: v })}
            hint="Never below 35%, so it stays readable over bright scenery."
          />
          <Slider label="Size" value={a.scale} bounds={APPEARANCE_BOUNDS.scale} onChange={(v) => set({ scale: v })} />
          <Segmented
            label="Spacing"
            value={a.spacing}
            choices={[
              ['comfortable', 'Comfortable'],
              ['compact', 'Compact'],
            ]}
            onChange={(v) => set({ spacing: v })}
          />
        </div>
        <OverlayPreview snap={snap} widgets={widgets} />
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- preview */

/*
 * Sample data, named as such. Nothing here is the commander's: the preview
 * must never look like it is reporting where they are.
 */
const SAMPLE_NOW = Date.parse('2026-01-01T12:00:00Z');
const SAMPLE = {
  context: {
    commander: 'Sample Commander',
    starSystem: 'Sample System',
    station: 'Sample Station',
    body: null,
    jumpTarget: null,
    remainingJumps: null,
    context: {
      title: 'Material Trader',
      subtitle: 'Raw materials',
      actions: ['Trade surplus materials up or down a grade'],
      note: null,
      guidance: 'A Material Trader swaps engineering materials you have for ones you need.',
      resources: [],
    },
    alsoActive: [],
  },
  missions: {
    active: 2,
    cargo: 12,
    expiringSoon: 0,
    withoutDestination: 0,
    nextStop: { system: 'Sample System', station: 'Sample Station', missions: 2, cargo: 12, cargoIncomplete: false, kills: 0, expiry: '1d 4h' },
    rows: [
      { id: 1, name: 'Deliver 12 units of Sample Goods', destination: 'Sample System · Sample Station', expiry: '1d 4h', cargo: '12 t', awaitingTurnIn: false, note: null },
      { id: 2, name: 'Sample courier mission', destination: 'Sample System · Sample Station', expiry: null, cargo: null, awaitingTurnIn: true, note: null },
    ],
    more: 0,
  },
  carrier: [{ carrierId: 1, name: 'Sample Carrier', system: 'Sample System', body: null, departureTime: '2026-01-01T12:08:42Z' }],
  route: {
    next: 'Sample Waypoint',
    nextIsNeutron: true,
    destination: 'Sample Destination',
    jumpsLeft: 14,
    waypoint: 3,
    waypoints: 9,
    finished: false,
    noShipRoute: false,
    carrier: null,
  },
  exo: {
    kind: 'exobiology' as const,
    bodyName: 'Sample Body',
    rows: [
      { genus: 'Bacterium', species: 'Bacterium Sample', colour: 'Gold', status: 'complete' as const, samplesTaken: 3, samplesRequired: 3, value: '1.7M', sampleDistance: 500 },
      { genus: 'Stratum', species: 'Stratum Sample', colour: null, status: 'sampling' as const, samplesTaken: 1, samplesRequired: 3, value: '19.0M', sampleDistance: 500 },
      { genus: 'Concha', species: null, colour: null, status: 'unscanned' as const, samplesTaken: 0, samplesRequired: 3, value: null, sampleDistance: null },
    ],
    completedCount: 1,
    unscannedCount: 1,
    total: 3,
    updatedAt: '2026-01-01T12:00:00Z',
  },
};

/**
 * The enabled widgets, drawn by the overlay's own components with sample data,
 * with the current appearance. Static: nothing ticks, so it costs nothing while
 * the page is open.
 */
export function OverlayPreview({ snap, widgets }: { snap: Snap; widgets: OverlayWidgets }) {
  const [scene, setScene] = useState<'dark' | 'bright'>('dark');
  const a = snap.appearance;
  const o = snap.overlay.options;
  const off = widgets.pluginPanelsOff ?? [];
  const pluginWidgets = Object.entries(snap.pythonPlugins.overlays).filter(([key]) => !off.includes(key));
  const shown: ReactNode[] = [];

  if (widgets.context)
    shown.push(
      <WidgetFrame key="context" id="context" title="Current Context" placement={null}>
        <ContextWidget state={{ ...SAMPLE.context, guidance: snap.guidance }} />
      </WidgetFrame>,
    );
  if (widgets.missions)
    shown.push(
      <WidgetFrame key="missions" id="missions" title="Missions" placement={null}>
        <MissionsWidget missions={{ ...SAMPLE.missions, rows: SAMPLE.missions.rows.slice(0, o.missionRows) }} />
      </WidgetFrame>,
    );
  if (widgets.carrierJump)
    shown.push(
      <WidgetFrame key="carrier" id="carrierJump" title="Carrier Jump" placement={null}>
        <CarrierJumpWidget jumps={SAMPLE.carrier} now={SAMPLE_NOW} />
      </WidgetFrame>,
    );
  if (widgets.route)
    shown.push(
      <WidgetFrame key="route" id="route" title="Route" placement={null}>
        <RouteWidget route={SAMPLE.route} options={o} />
      </WidgetFrame>,
    );
  if (widgets.liveJournal)
    shown.push(
      <WidgetFrame key="exo" id="liveJournal" title="Exobiology" placement={null}>
        <LiveExobiologyWidget live={SAMPLE.exo} showValues={o.exoShowValues} />
      </WidgetFrame>,
    );
  for (const [key, w] of pluginWidgets) {
    shown.push(
      <WidgetFrame key={key} id={`plugin:${key}`} title={w.title} placement={null}>
        <div className="row muted">Drawn by the plugin in the game</div>
      </WidgetFrame>,
    );
  }

  return (
    <figure className={`ow-preview ow-scene-${scene}`} aria-label="Overlay preview with sample data">
      <figcaption className="ow-preview-head">
        <span className="ow-sample">Sample data</span>
        <span className="ow-seg" role="group" aria-label="Preview background">
          {(['dark', 'bright'] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={s === scene ? 'chip chip-on' : 'chip'}
              aria-pressed={s === scene}
              onClick={() => setScene(s)}
            >
              {s === 'dark' ? 'Dark scene' : 'Bright scene'}
            </button>
          ))}
        </span>
      </figcaption>
      <div
        className={`overlay-root ow-preview-root${a.spacing === 'compact' ? ' spacing-compact' : ''}`}
        style={
          {
            '--overlay-bg-opacity': String(a.backgroundOpacity),
            '--overlay-text-opacity': String(a.textOpacity),
            '--overlay-scale': String(a.scale),
          } as React.CSSProperties
        }
      >
        {shown.length === 0 ? <p className="ow-preview-empty">No widgets switched on.</p> : shown}
      </div>
    </figure>
  );
}

/* --------------------------------------------------------------- layouts */

function LayoutsSection({ snap }: { snap: Snap }) {
  const [pending, setPending] = useState<{ kind: 'preset'; id: PresetId } | { kind: 'profile'; name: string } | null>(null);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const profiles = snap.overlay.profiles;
  const chosen = profiles.find((p) => p.name === selected) ?? null;

  async function confirm() {
    if (!pending) return;
    if (pending.kind === 'preset') await companion.applyOverlayPreset(pending.id);
    else await companion.applyOverlayProfile(pending.name);
    setPending(null);
  }

  return (
    <section className="card">
      <h2>Layouts</h2>
      <div className="ow-presets">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="ow-preset"
            onClick={() => setPending({ kind: 'preset', id: p.id })}
          >
            <span className="ow-name">{p.label}</span>
            <span className="ow-desc">{p.description}</span>
          </button>
        ))}
      </div>

      {pending && (
        <p className="note ow-confirm-line" role="group" aria-label="Confirm layout change">
          {pending.kind === 'preset'
            ? `Use the ${PRESETS.find((p) => p.id === pending.id)?.label} layout? It replaces your current positions and which widgets are on.`
            : `Switch to “${pending.name}”? It replaces your current positions and which widgets are on.`}{' '}
          <button type="button" className="secondary" onClick={() => void confirm()}>
            Use it
          </button>{' '}
          <button type="button" className="secondary" onClick={() => setPending(null)}>
            Cancel
          </button>
        </p>
      )}

      <h3 className="subhead">Your layouts</h3>
      <div className="ow-profiles">
        {profiles.length > 0 && (
          <>
            <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Saved layouts">
              <option value="">Choose a saved layout…</option>
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="secondary"
              disabled={!chosen}
              onClick={() => chosen && setPending({ kind: 'profile', name: chosen.name })}
            >
              Switch to it
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!chosen}
              onClick={() => {
                if (!chosen) return;
                void companion.deleteOverlayProfile(chosen.name);
                setSelected('');
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>
      <form
        className="ow-profiles"
        onSubmit={(e) => {
          e.preventDefault();
          void companion.saveOverlayProfile(name).then((reason) => {
            setProblem(reason);
            if (!reason) setName('');
          });
        }}
      >
        <input
          type="text"
          value={name}
          maxLength={MAX_PROFILE_NAME}
          placeholder="Name this layout, e.g. Exploring"
          aria-label="Layout name"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="secondary" disabled={!name.trim()}>
          Save current
        </button>
      </form>
      <p className="field-hint">
        Saves positions, sizes, which widgets are on and their options. Up to {MAX_PROFILES}. Saving under an existing
        name replaces it.
      </p>
      {problem && <p className="note">{problem}</p>}
    </section>
  );
}

/* ----------------------------------------------------------- diagnostics */

/**
 * The overlay's technical detail, for the Diagnostics page: what used to fill
 * the Overlay page. Raw values are fine here; this is the screen for them.
 */
export function OverlayDiagnostics({ snap }: { snap: Snap }) {
  const env = useOverlayEnvironment();
  const layout = snap.overlay.layout;
  const field = (label: string, value: string) => (
    <div className="field" key={label}>
      <div className="field-label">{label}</div>
      <div className="field-value">{value}</div>
    </div>
  );
  const yesNo = (v: boolean | null | undefined) => (v === null || v === undefined ? 'Unknown' : v ? 'Yes' : 'No');
  return (
    <section className="card">
      <h2>Overlay</h2>
      <div className="grid">
        {field('Display mode', env.mode ? env.mode.mode : 'Checking…')}
        {field('Raw FullScreen value', env.mode?.raw === null || env.mode === null ? 'Unknown' : String(env.mode.raw))}
        {field('Overlay supported', yesNo(env.mode?.overlay_supported))}
        {field('Game window', env.win?.found ? 'Found' : 'Not found')}
        {env.win?.found && field('Window position', `${env.win.x}, ${env.win.y}`)}
        {env.win?.found && field('Window size', `${env.win.width} x ${env.win.height}`)}
        {env.win?.found && field('Monitor', `${env.win.monitor_width} x ${env.win.monitor_height}`)}
        {env.win?.found && field('Reported DPI', String(env.win.dpi))}
        {env.win?.found && field('Focused', yesNo(env.win.is_foreground))}
        {env.win?.found && field('Minimised', yesNo(env.win.is_minimised))}
        {env.win?.found && field('Covers monitor', yesNo(env.win.covers_monitor))}
        {field('Tracking running', yesNo(env.runtime?.running))}
        {field('Overlay visible', yesNo(env.runtime?.visible))}
        {field('Arranging', yesNo(env.runtime?.editing))}
        {field(
          'Layout arranged at',
          layout.viewport ? `${Math.round(layout.viewport.width)} x ${Math.round(layout.viewport.height)}` : 'Standard positions',
        )}
        {field('Widgets positioned', String(Object.keys(layout.widgets).length))}
      </div>
      {env.mode?.detail && <p className="muted">{env.mode.detail}</p>}
    </section>
  );
}
