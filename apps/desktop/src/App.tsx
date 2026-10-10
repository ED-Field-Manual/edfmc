import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { isKnown, type Known } from '@edfm/elite-journal';

import { resourceUrl, type GuidanceMode } from '@edfm/context';
import {
  explainMission,
  hasDeliveryProgress,
  missionCaveat,
  remainingCargo,
  type Mission,
} from '@edfm/missions';
import { openUrl } from '@tauri-apps/plugin-opener';

import logo from './assets/logo.png';
import { Logistics } from './Logistics';
import { FirstRunGuidance, GuidanceChoice } from './Guidance';
import { Integrations } from './Integrations';
import { ScreenshotDialog, ScreenshotSettings, Screenshots } from './Screenshots';
import { aboutStatus, newerBuildNotice } from './lib/about';
import { Journal } from './Journal';
import { Research } from './Research';
import { Contributions } from './Contributions';
import { PluginCard, Plugins as PluginsScreen, PythonPluginCard } from './Plugins';
import { PluginPanel } from './PluginPanels';
import { NativePluginPage } from './NativePluginPage';
import { Dashboard } from './Dashboard';
import { SESSION_LABEL } from './lib/session';
import { companion, relativeExpiry, travelLabel } from './lib/companion.js';
import { logger, type LogEntry } from './lib/logger.js';
import {
  onEditMode,
  onEliteWindow,
  overlayApi,
  APPEARANCE_BOUNDS,
  type OverlayAppearance,
  type DisplayModeInfo,
  type EliteWindowInfo,
} from './lib/overlay.js';
import './App.css';

/**
 * Render a possibly-unknown value.
 *
 * "Unknown" is shown as its own word rather than an em dash or a blank, because §4
 * requires the difference between "the game did not tell us" and "there is none" to
 * stay visible to the user, not just inside the type system.
 */
function show(value: Known<unknown>, fallback = 'Unknown'): string {
  if (!isKnown(value)) return fallback;
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

const SECTIONS = [
  'Dashboard',
  'Context',
  'Missions',
  'Logistics',
  'Overlay',
  'Journal',
  'Research',
  'Contributions',
  'Connections',
  'Screenshots',
  'Plugins',
  'Settings',
  'Diagnostics',
] as const;
type Section = (typeof SECTIONS)[number];

const IMPLEMENTED: ReadonlySet<Section> = new Set<Section>([
  'Context',
  'Missions',
  'Dashboard',
  'Overlay',
  'Logistics',
  'Journal',
  'Research',
  'Contributions',
  'Connections',
  'Screenshots',
  'Plugins',
  'Settings',
  'Diagnostics',
]);

const PHASE: Partial<Record<Section, string>> = {};

export default function App() {
  const [section, setSection] = useState<Section>('Dashboard');
  /**
   * A plugin's own tab, or null when a regular section is showing. Every
   * installed plugin gets one, listed under Plugins: `rule:<id>` for a
   * declarative plugin, `py:<folder>` for a Python one.
   */
  const [pluginTab, setPluginTab] = useState<string | null>(null);

  const snap = useSyncExternalStore(
    (cb) => companion.subscribe(cb),
    () => companion.snapshot(),
  );

  // The Companion is app-scoped, not component-scoped: it must keep ingesting for
  // the lifetime of the window. Deliberately no cleanup — tearing it down here
  // would stop the engine during StrictMode's dev remount, and the idempotent
  // start() would then decline to restart it.
  useEffect(() => {
    void companion.start();
  }, []);

  const pluginTabs = [
    // A switched-off plugin has no tab; it is switched back on from the Plugins page.
    ...snap.plugins.loaded
      .filter((p) => !snap.plugins.disabledIds.includes(p.manifest.id))
      .map((p) => ({ key: `rule:${p.manifest.id}`, name: p.manifest.name })),
    ...snap.pythonPlugins.plugins
      .filter((p) => !p.disabled)
      .map((p) => ({ key: `py:${p.folder}`, name: p.name })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  // A plugin removed from the folder takes its tab with it.
  const openPlugin =
    pluginTab !== null && pluginTabs.some((t) => t.key === pluginTab) ? pluginTab : null;

  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <img className="brand-logo" src={logo} alt="EDFM Companion" />
        </div>
        <ul>
          {SECTIONS.map((s) => (
            <Fragment key={s}>
              <li>
                <button
                  type="button"
                  className={openPlugin === null && s === section ? 'active' : ''}
                  aria-current={openPlugin === null && s === section ? 'page' : undefined}
                  onClick={() => {
                    setPluginTab(null);
                    setSection(s);
                  }}
                >
                  <span>{s}</span>
                  {!IMPLEMENTED.has(s) && <span className="pill">{PHASE[s]}</span>}
                </button>
              </li>
              {s === 'Plugins' &&
                pluginTabs.map((t) => (
                  <li key={t.key}>
                    <button
                      type="button"
                      className={`nav-sub ${openPlugin === t.key ? 'active' : ''}`}
                      aria-current={openPlugin === t.key ? 'page' : undefined}
                      onClick={() => setPluginTab(t.key)}
                    >
                      <span>{t.name}</span>
                    </button>
                  </li>
                ))}
            </Fragment>
          ))}
        </ul>
        <ConnectionBadge snap={snap} />
      </nav>

      <main className="main">
        {/*
          Asked once, before anything else, and only when it has never been
          answered. Not a modal: it does not block the app, because a commander
          who wants to get straight to their journal should be able to.
        */}
        {!snap.guidanceChosen && <FirstRunGuidance />}
        {openPlugin !== null ? (
          <PluginTab snap={snap} tab={openPlugin} />
        ) : (
          <>
          {section === 'Dashboard' && <Dashboard snap={snap} />}
          {section === 'Context' && <ContextPanel snap={snap} />}
          {section === 'Missions' && <MissionsPanel snap={snap} />}
          {section === 'Overlay' && <OverlayPanel />}
          {section === 'Logistics' && <Logistics snap={snap} />}
          {section === 'Journal' && <Journal snap={snap} />}
          {section === 'Research' && <Research snap={snap} />}
          {section === 'Contributions' && <Contributions snap={snap} />}
          {section === 'Connections' && <Integrations snap={snap} />}
          {section === 'Screenshots' && <Screenshots snap={snap} />}
          {section === 'Plugins' && <PluginsScreen snap={snap} />}
          {section === 'Settings' && <Settings snap={snap} />}
          {section === 'Diagnostics' && <Diagnostics snap={snap} />}
          {!IMPLEMENTED.has(section) && <Placeholder section={section} />}
          </>
        )}
        {/* Above whatever is open: a capture needs answering now, not after
            navigating somewhere. */}
        <ScreenshotDialog snap={snap} />
      </main>
    </div>
  );
}

type Snap = ReturnType<typeof companion.snapshot>;

function ConnectionBadge({ snap }: { snap: Snap }) {
  // §29: never rely on colour alone. Each state carries a distinct glyph and word.
  const map = {
    'game-active': { icon: '●', cls: 'ok', sub: 'Following the game' },
    'game-offline': { icon: '○', cls: 'idle', sub: 'Showing last known state' },
    'game-unknown': { icon: '◌', cls: 'idle', sub: 'Game status not confirmed' },
    'waiting-for-journal': {
      icon: '◐',
      cls: 'warn',
      sub: snap.connection === 'no-directory' ? 'No journal folder found' : 'Starting up',
    },
    'journal-error': { icon: '✕', cls: 'bad', sub: 'See Diagnostics' },
  } as const;
  const s = map[snap.session];

  return (
    <div className={`status ${s.cls}`} role="status">
      <span aria-hidden="true">{s.icon}</span>
      <div>
        <div className="status-label">{SESSION_LABEL[snap.session]}</div>
        <div className="status-sub">{s.sub}</div>
      </div>
    </div>
  );
}

function Field({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  const unknown = value === 'Unknown';
  return (
    <div className={`field${wide ? ' wide' : ''}`}>
      <div className="field-label">{label}</div>
      <div className={`field-value${unknown ? ' unknown' : ''}`}>{value}</div>
    </div>
  );
}

function ContextPanel({ snap }: { snap: Snap }) {
  const contexts = snap.contexts;

  return (
    <>
      <header className="page-head">
        <h1>Context</h1>
        <p className="muted">
          EDFM material relevant to what you are doing right now, matched from journal
          events by fixed rules. Nothing here is inferred by a model — a context appears
          only when a rule's conditions are literally satisfied.
        </p>
      </header>

      {contexts.length === 0 ? (
        <section className="card">
          <h2>Nothing active</h2>
          <p className="muted">
            No context rule currently matches. Contexts appear when you do something a
            rule recognises — prospecting an asteroid, docking at an Engineer, sampling
            biology, delivering to a construction site — and fade once they stop being
            relevant.
          </p>
        </section>
      ) : (
        contexts.map((ctx) => (
          <section className="card" key={ctx.rule.id}>
            {/* The resolved text, not the rule's template: a rule may state a
                count taken from the event that matched it. */}
            <h2>{ctx.title}</h2>
            {ctx.subtitle && <p className="muted">{ctx.subtitle}</p>}

            {ctx.rule.actions && ctx.rule.actions.length > 0 && (
              <ol className="context-actions">
                {ctx.rule.actions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ol>
            )}

            <ul className="resources">
              {ctx.rule.resources.map((resource) => {
                const url = resourceUrl(resource);
                if (!url) return null;
                return (
                  <li key={url}>
                    <button type="button" className="resource" onClick={() => void openUrl(url)}>
                      <span className="resource-label">{resource.label}</span>
                      <span className="resource-go" aria-hidden="true">
                        ↗
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {ctx.rule.note && <p className="muted">EDFM Note: {ctx.rule.note}</p>}

            {/* Provenance: which event caused this, per §27. */}
            <p className="provenance">
              Triggered by <code>{ctx.triggerEvent}</code> · rule <code>{ctx.rule.id}</code>
            </p>
          </section>
        ))
      )}

      <section className="card">
        <h2>Rule set</h2>
        <div className="grid">
          <Field label="Version" value={String(snap.contextRuleVersion)} />
          <Field label="Source" value={snap.contextRuleSource} />
          <Field label="Active contexts" value={String(contexts.length)} />
        </div>
        <p className="muted">
          Rules are versioned and will be served by the EDFM backend, so recommendations
          can change without shipping a new build. This build uses the bundled set, which
          is also the offline fallback.
        </p>
      </section>
    </>
  );
}

type MissionViewMode = 'destination' | 'expiry' | 'type';

function MissionsPanel({ snap }: { snap: Snap }) {
  const [mode, setMode] = useState<MissionViewMode>('destination');
  const { summary, groups, withoutDestination, byExpiry } = snap.missions;

  return (
    <>
      <header className="page-head">
        <h1>Missions</h1>
        <p className="muted">
          Active missions from the journal. Fields the game did not report are shown as
          Unknown — around half of accepted missions carry no destination at all.
        </p>
      </header>

      <section className="card">
        <h2>Summary</h2>
        <div className="grid">
          <Field label="Active" value={String(summary.active)} />
          <Field label="Cargo required" value={`${summary.totalCargo} t`} />
          <Field label="Expiring within an hour" value={String(summary.expiringSoon)} />
          <Field label="No destination given" value={String(summary.withoutDestination)} />
        </div>
        {Object.keys(summary.categories).length > 0 && (
          <ul className="tags">
            {Object.entries(summary.categories)
              .sort((a, b) => b[1] - a[1])
              .map(([category, n]) => (
                <li key={category}>
                  {category} <span className="count">{n}</span>
                </li>
              ))}
          </ul>
        )}
      </section>

      {summary.active === 0 ? (
        <section className="card">
          <h2>No active missions</h2>
          <p className="muted">
            Missions appear here as you accept them, and are remembered across restarts.
          </p>
        </section>
      ) : (
        <>
          <div className="tabs" role="tablist" aria-label="Mission grouping">
            {(['destination', 'expiry', 'type'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                className={mode === m ? 'tab active' : 'tab'}
                onClick={() => setMode(m)}
              >
                By {m}
              </button>
            ))}
          </div>

          {mode === 'destination' && (
            <>
              {groups.map((g) => (
                <section className="card" key={g.key}>
                  <h2>
                    {g.system}
                    {g.station ? ` · ${g.station}` : ''}
                  </h2>
                  <div className="grid">
                    <Field label="Missions" value={String(g.missionCount)} />
                    <Field
                      label="Cargo"
                      // A carrying mission that reported no count must not be
                      // silently averaged away into a confident total.
                      value={g.cargoIncomplete ? `${g.cargoRequired} t (incomplete)` : `${g.cargoRequired} t`}
                    />
                    <Field label="Kills" value={g.killsRequired > 0 ? String(g.killsRequired) : '—'} />
                    <Field label="Earliest expiry" value={g.earliestExpiry ?? 'Unknown'} />
                  </div>
                  {g.targetFactions.length > 0 && (
                    <p className="muted">Targets: {g.targetFactions.join(', ')}</p>
                  )}
                  <MissionList missions={g.missions} />
                </section>
              ))}

              {withoutDestination.length > 0 && (
                <section className="card">
                  <h2>No destination given</h2>
                  <p className="muted">
                    The journal recorded no destination for these. That is a gap in what
                    Elite reports, not a lookup failure — they are shown here rather than
                    guessed at.
                  </p>
                  <MissionList missions={withoutDestination} />
                </section>
              )}
            </>
          )}

          {mode === 'expiry' && (
            <section className="card">
              <h2>By expiry</h2>
              <MissionList missions={byExpiry} showDestination />
            </section>
          )}

          {mode === 'type' && <MissionsByType missions={byExpiry} />}
        </>
      )}
    </>
  );
}

function MissionsByType({ missions }: { missions: readonly Mission[] }) {
  const grouped = useMemo(() => {
    const out = new Map<string, Mission[]>();
    for (const m of missions) {
      const bucket = out.get(m.category);
      if (bucket) bucket.push(m);
      else out.set(m.category, [m]);
    }
    return [...out.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [missions]);

  return (
    <>
      {grouped.map(([category, list]) => (
        <section className="card" key={category}>
          <h2>
            {category} ({list.length})
          </h2>
          <MissionList missions={list} showDestination />
        </section>
      ))}
    </>
  );
}

function MissionList({
  missions,
  showDestination,
}: {
  missions: readonly Mission[];
  showDestination?: boolean;
}) {
  return (
    <ul className="missions">
      {missions.map((m) => {
        const explanation = explainMission(m);
        const caveat = missionCaveat(m);
        return (
        <li key={m.missionId} className="mission">
          <div className="mission-main">
            <span className="mission-name">
              {isKnown(m.localisedName) ? m.localisedName : m.name}
            </span>
            <span className="mission-meta">
              {isKnown(m.faction) ? m.faction : 'Unknown faction'}
              {m.redirected && <span className="badge">redirected</span>}
              {/* Kill counts are accepted/completed only — Elite does not journal
                  incremental progress, so no partial counter is shown (§8). */}
              {isKnown(m.killCount) && <span className="badge">{m.killCount} kills</span>}
              {/* Real progress, from CargoDepot — the one kind Elite journals.
                  Shows what is still owed, since that is the number the next run
                  is planned around. */}
              {hasDeliveryProgress(m) ? (
                <span className="badge progress">
                  {remainingCargo(m)} t left of {m.totalToDeliver as number}
                  {isKnown(m.commodityLocalised) ? ` ${m.commodityLocalised}` : ''}
                </span>
              ) : (
                isKnown(m.count) &&
                isKnown(m.commodity) && (
                  <span className="badge">
                    {m.count} t {isKnown(m.commodityLocalised) ? m.commodityLocalised : ''}
                  </span>
                )
              )}
            </span>
            {showDestination && (
              <span className="mission-meta">
                {isKnown(m.destinationSystem) ? (
                  <>
                    {m.destinationSystem}
                    {isKnown(m.destinationStation) ? ` · ${m.destinationStation}` : ''}
                  </>
                ) : (
                  <span className="unknown-inline">No destination given</span>
                )}
              </span>
            )}

            {/* Frontier's own mission titles assume the mechanic is already
                understood: "Source and return" never says you buy the cargo.
                Labelled, because this is EDFM's editorial guidance rather than
                something read out of the journal — everything else on this row
                came from the game, and the difference should be visible. */}
            {explanation && (
              <span className="mission-explain">
                <span className="mission-explain-label">EDFM note</span>
                {explanation}
              </span>
            )}
            {caveat && (
              <span className="mission-caveat">
                <span aria-hidden="true">▲ </span>
                {caveat}
              </span>
            )}
          </div>
          <div className="mission-side">
            {isKnown(m.expiry) ? (
              <span title={m.expiry}>{relativeExpiry(m.expiry)}</span>
            ) : (
              <span className="unknown-inline">No expiry</span>
            )}
          </div>
        </li>
        );
      })}
    </ul>
  );
}

/**
 * One opacity slider.
 *
 * Shows the percentage as a number as well as a slider position: a handle
 * somewhere along a track is not a value anyone can report or reproduce.
 */
function OpacityControl({
  label,
  hint,
  value,
  bounds,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  bounds: { min: number; max: number };
  onChange: (value: number) => void;
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
        // Live: the real overlay updates as this is dragged, so the commander is
        // not alt-tabbing into Elite to evaluate every notch.
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <span className="field-hint">{hint}</span>
    </label>
  );
}

/**
 * A sample of the overlay, using the real overlay variables.
 *
 * Exists so opacity can be judged without switching into the game. It is a
 * sample, not a simulation: the panel behind it in Elite is arbitrary scenery,
 * so this sits on a dark gradient and says so by being obviously a preview.
 */
function OverlayPreview({
  appearance,
  guidance,
}: {
  appearance: OverlayAppearance;
  guidance: GuidanceMode;
}) {
  return (
    <div className="overlay-preview" aria-label="Overlay appearance preview">
      <div
        className="overlay-preview-panel"
        style={
          {
            '--overlay-bg-opacity': String(appearance.backgroundOpacity),
            '--overlay-text-opacity': String(appearance.textOpacity),
          } as React.CSSProperties
        }
      >
        <div className="overlay-preview-title">◆ Current Context</div>
        <div className="overlay-preview-heading">Biological signals</div>
        <div className="overlay-preview-sub">3 biological signals detected</div>
        {guidance === 'new-cmdr' && (
          <div className="overlay-preview-guidance">
            Biological signals mean this body has organisms you can sample on foot.
          </div>
        )}
        <div className="overlay-preview-row">Wregoe XX-X d1-42 3 A</div>
      </div>
    </div>
  );
}

function OverlayPanel() {
  const widgets = useSyncExternalStore(
    (cb) => companion.subscribe(cb),
    () => companion.overlayWidgets,
  );
  // Read from the companion rather than held locally: both are persisted, so the
  // toggle has to show the restored value on first paint instead of defaulting to
  // off and contradicting an overlay that is already on screen.
  const enabled = useSyncExternalStore(
    (cb) => companion.subscribe(cb),
    () => companion.overlayOn,
  );
  const hideInactive = useSyncExternalStore(
    (cb) => companion.subscribe(cb),
    () => companion.overlayHideWhenInactive,
  );
  const snap = useSyncExternalStore(
    (cb) => companion.subscribe(cb),
    () => companion.snapshot(),
  );
  const appearance = snap.appearance;
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<DisplayModeInfo | null>(null);
  const [win, setWin] = useState<EliteWindowInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void overlayApi.displayMode().then(setMode).catch(() => undefined);
    void overlayApi.eliteWindow().then(setWin).catch(() => undefined);
    const stopWin = onEliteWindow(setWin);
    // The overlay can leave edit mode on its own (Escape, Done, or losing focus),
    // so this control follows the real state rather than assuming it owns it.
    const stopEdit = onEditMode(setEditing);
    return () => {
      stopWin();
      stopEdit();
    };
  }, []);

  async function toggle(next: boolean) {
    setError(null);
    try {
      if (next) {
        await overlayApi.start(hideInactive);
        companion.setOverlayEnabled(true, hideInactive);
      } else {
        if (editing) {
          await overlayApi.setEditMode(false);
          setEditing(false);
        }
        await overlayApi.stop();
        companion.setOverlayEnabled(false, hideInactive);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleEdit(next: boolean) {
    setError(null);
    try {
      await overlayApi.setEditMode(next);
      setEditing(next);
    } catch (e) {
      setError(String(e));
    }
  }

  // §29: the warning is carried by glyph and wording, not by colour alone.
  const unsupported = mode?.overlay_supported === false;
  const unknownSupport = mode?.overlay_supported === null;

  return (
    <>
      <header className="page-head">
        <h1>Overlay</h1>
        <p className="muted">
          An external, transparent window aligned to the Elite Dangerous window. It never
          injects code into the game, reads its memory, or sends it input.
        </p>
      </header>

      <section className="card">
        <h2>Elite Dangerous display mode</h2>
        {mode === null ? (
          <p className="muted">Checking…</p>
        ) : (
          <>
            <div className="grid">
              <Field label="Mode" value={mode.mode === 'unknown' ? 'Unknown' : mode.mode} />
              <Field label="Raw setting" value={mode.raw === null ? 'Unknown' : String(mode.raw)} />
              <Field
                label="Overlay supported"
                value={
                  mode.overlay_supported === null
                    ? 'Unknown'
                    : mode.overlay_supported
                      ? 'Yes'
                      : 'No'
                }
              />
            </div>
            <p className={unsupported || unknownSupport ? 'note' : 'muted'}>
              {(unsupported || unknownSupport) && <span aria-hidden="true">▲ </span>}
              {mode.detail}
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2>Game window</h2>
        {win?.found ? (
          <div className="grid">
            <Field label="Position" value={`${win.x}, ${win.y}`} />
            <Field label="Size" value={`${win.width} x ${win.height}`} />
            <Field label="Monitor" value={`${win.monitor_width} x ${win.monitor_height}`} />
            <Field label="Reported DPI" value={String(win.dpi)} />
            <Field label="Focused" value={win.is_foreground ? 'Yes' : 'No'} />
            <Field label="Covers monitor" value={win.covers_monitor ? 'Yes' : 'No'} />
          </div>
        ) : (
          <p className="muted">
            Elite Dangerous is not running, or its window has not been found. The overlay
            will appear automatically once the game window exists.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Controls</h2>
        <div className="controls">
          <label className="check">
            <input type="checkbox" checked={enabled} onChange={(e) => void toggle(e.target.checked)} />
            <span>Enable overlay</span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={editing}
              disabled={!enabled}
              onChange={(e) => void toggleEdit(e.target.checked)}
            />
            <span>
              Edit mode{' '}
              <span className="muted-inline">
                — widgets become draggable. Leave with the Done button or Esc.
              </span>
            </span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={hideInactive}
              onChange={(e) => {
                const next = e.target.checked;
                companion.setOverlayEnabled(enabled, next);
                if (enabled) void overlayApi.start(next);
              }}
            />
            <span>Hide while Elite is not the active window</span>
          </label>
        </div>

        <p className="muted">
          In normal mode the overlay is click-through: mouse input passes straight to the
          game. Edit mode makes it interactive so widgets can be positioned, and positions
          are remembered.
        </p>
        {error && (
          <p className="note">
            <span aria-hidden="true">✕ </span>
            {error}
          </p>
        )}
      </section>

      <section className="card">
        <h2>Widgets</h2>
        <p className="muted">
          Each widget is positioned independently in edit mode and remembers where you
          put it.
        </p>
        <div className="controls">
          <label className="check">
            <input
              type="checkbox"
              checked={widgets.context}
              onChange={(e) => void companion.setOverlayWidgets({ ...widgets, context: e.target.checked })}
            />
            <span>
              Current Context{' '}
              <span className="muted-inline">— commander, location, and relevant EDFM material</span>
            </span>
          </label>

          <h3 className="subhead">Appearance</h3>
          <OpacityControl
            label="Background opacity"
            hint="How solid the panels are. Text is unaffected."
            value={appearance.backgroundOpacity}
            bounds={APPEARANCE_BOUNDS.background}
            onChange={(v) => void companion.setAppearance({ ...appearance, backgroundOpacity: v })}
          />
          <OpacityControl
            label="Text opacity"
            hint="Kept above a readable minimum, since faint text over bright scenery is unusable."
            value={appearance.textOpacity}
            bounds={APPEARANCE_BOUNDS.text}
            onChange={(v) => void companion.setAppearance({ ...appearance, textOpacity: v })}
          />
          <OverlayPreview appearance={appearance} guidance={snap.guidance} />

          <h3 className="subhead">Widgets</h3>

          <label className="check">
            <input
              type="checkbox"
              checked={widgets.missions}
              onChange={(e) => void companion.setOverlayWidgets({ ...widgets, missions: e.target.checked })}
            />
            <span>
              Missions{' '}
              <span className="muted-inline">
                — so mission details are readable without leaving the game
              </span>
            </span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={widgets.edfmNotes}
              disabled={!widgets.missions}
              onChange={(e) => void companion.setOverlayWidgets({ ...widgets, edfmNotes: e.target.checked })}
            />
            <span>
              Show EDFM notes on missions{' '}
              <span className="muted-inline">— explains what a mission type actually asks</span>
            </span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={widgets.carrierJump}
              onChange={(e) =>
                void companion.setOverlayWidgets({ ...widgets, carrierJump: e.target.checked })
              }
            />
            <span>
              Carrier jump countdown{' '}
              <span className="muted-inline">
                — your own carriers only; the game never reveals anyone else&apos;s
              </span>
            </span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={widgets.route}
              onChange={(e) => void companion.setOverlayWidgets({ ...widgets, route: e.target.checked })}
            />
            <span>
              Route{' '}
              <span className="muted-inline">
                — the next jump on a route a plugin such as Router is following
              </span>
            </span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={widgets.liveJournal}
              onChange={(e) =>
                void companion.setOverlayWidgets({ ...widgets, liveJournal: e.target.checked })
              }
            />
            <span>
              Live Journal{' '}
              <span className="muted-inline">
                — the newest thing recorded, collapsing to a count after five minutes
              </span>
            </span>
          </label>
        </div>
        <p className="muted">
          The Missions widget shows the five soonest to expire. The full list, with
          links, stays in this window.
        </p>
      </section>
    </>
  );
}

function Settings({ snap }: { snap: Snap }) {
  const [path, setPath] = useState('');
  const [saved, setSaved] = useState(false);

  return (
    <>
      <header className="page-head">
        <h1>Settings</h1>
      </header>

      <ScreenshotSettings snap={snap} />

      <section className="card">
        <h2>Guidance</h2>
        <p className="muted">
          How much is explained as you play. This never changes which facts are shown, and
          never hides a feature.
        </p>
        <GuidanceChoice />
      </section>

      <section className="card">
        <h2>Journal folder</h2>
        <div className="grid">
          <Field label="Resolved folder" value={snap.directory ?? 'Unknown'} wide />
        </div>
        <p className="muted">{snap.directoryDetail}</p>

        <label className="stack" htmlFor="journal-path">
          <span>Manual override</span>
          <input
            id="journal-path"
            type="text"
            value={path}
            placeholder="Leave blank to use the Saved Games folder"
            onChange={(e) => {
              setPath(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <button
          type="button"
          className="primary"
          onClick={async () => {
            await companion.setSetting('journalDirectory', path);
            setSaved(true);
          }}
        >
          Save
        </button>
        {saved && <p className="note">Saved. Restart the application to apply.</p>}
      </section>

      <section className="card">
        <h2>Verification</h2>
        <p className="muted">
          Compares what your game reports about stations against the community observation set,
          and reports disagreements so EDFM can be corrected.
        </p>
        <label className="stack" htmlFor="verification-enabled">
          <span>
            <input
              id="verification-enabled"
              type="checkbox"
              checked={snap.verificationEnabled}
              onChange={(e) => void companion.setVerificationEnabled(e.target.checked)}
            />{' '}
            Contribute station observations
          </span>
        </label>
        <p className="muted">
          Off by default. While it is on, EDFM Companion looks up the station you are docked at,
          which tells the server where you are. Observations are sent without your commander name
          or ID: the server stores a one-way hash instead, which lets it tell two reporters apart
          without knowing who either of them is. Turning this off clears what has been cached.
        </p>
        {snap.verificationEnabled && (
          <p className="note">
            Observations checked: {snap.verification.checked} · findings: {snap.verification.discrepancies}
          </p>
        )}
      </section>

      <section className="card">
        <h2>Privacy</h2>
        <p className="muted">
          Everything else is local. Your journals are read on this machine and never uploaded,
          and there are no analytics. Chat, friends, private groups and travel history are never
          sent anywhere, whatever the settings above.
        </p>
      </section>
    </>
  );
}

function Diagnostics({ snap }: { snap: Snap }) {
  const [entries, setEntries] = useState<readonly LogEntry[]>(() => logger.entries().slice(-100));

  useEffect(() => logger.subscribe(() => setEntries(logger.entries().slice(-100))), []);

  const unknown = useMemo(
    () => Object.entries(snap.stats.unknownEventKinds).sort((a, b) => b[1] - a[1]).slice(0, 12),
    [snap.stats.unknownEventKinds],
  );

  const status = useMemo(
    () =>
      aboutStatus({
        appVersion: snap.diagnostics.appVersion,
        connectedBuild: snap.diagnostics.gameVersion,
      }),
    [snap.diagnostics.appVersion, snap.diagnostics.gameVersion],
  );
  const notice = newerBuildNotice(status);

  return (
    <>
      <header className="page-head">
        <h1>Diagnostics</h1>
      </header>

      <section className="card">
        <h2>Version &amp; status</h2>
        <div className="grid">
          <Field label="Companion" value={status.appVersion} />
          <Field label="Context rules" value={`v${status.contentVersion} (${status.contentSource})`} />
          <Field label="Rules loaded" value={String(status.contextRules)} />
          <Field label="Plugin API" value={`v${status.pluginApi}`} />
          <Field label="Activity schema" value={`v${status.exobiologySchema}`} />
          <Field label="Journal validated through" value={status.validatedBuild} />
          <Field label="Game build" value={status.connectedBuild ?? 'Not reported yet'} />
        </div>
        {/*
          Informational, and worded to say so. "We have not measured this build
          yet" is not "this is broken", and implying otherwise would teach people
          to ignore the notice.
        */}
        {notice && <p className="note">{notice}</p>}
      </section>

      {/*
        Safe diagnostics for the EDFM connection. Credential presence, never the
        credential; error categories, never a server body or a token.
      */}
      <JournalStateCard snap={snap} />

      <section className="card">
        <h2>EDFM Commander Journal</h2>
        <div className="grid">
          <Field label="Connection" value={snap.journalSync.state} />
          <Field label="Credential stored" value={snap.journalSync.hasCredential ? 'Yes' : 'No'} />
          <Field label="Pending" value={String(snap.journalSync.pending)} />
          <Field label="Permanently failed" value={String(snap.journalSync.failed)} />
          <Field label="Last attempt" value={snap.journalSync.lastAttemptAt ?? 'Never'} />
          <Field label="Last success" value={snap.journalSync.lastSuccessAt ?? 'Never'} />
          <Field
            label="Syncing activity since"
            value={snap.journalSync.syncingSince ?? 'Not connected'}
          />
          <Field label="EDFM entry count" value={String(snap.journalSync.server?.entryCount ?? '—')} />
        </div>
        {snap.journalSync.message && <p className="note">{snap.journalSync.message}</p>}
      </section>

      <section className="card">
        <h2>Journal shape</h2>
        <p className="muted">
          Fields whose type changed from the first shape seen this session. Event and field names,
          the two types, a count and the game build — never a field&apos;s contents, so this panel is
          safe to screenshot into a bug report.
        </p>
        <div className="grid">
          <Field label="Event types seen" value={String(snap.diagnostics.eventsTracked)} />
          <Field label="Fields tracked" value={String(snap.diagnostics.fieldsTracked)} />
          <Field label="Changed shape" value={String(snap.diagnostics.anomalies.length)} />
        </div>
        {snap.diagnostics.anomalies.length === 0 ? (
          <p className="muted">
            Nothing has changed shape. This is the expected state — across the reference corpus of
            289,725 events the journal was entirely type-stable.
          </p>
        ) : (
          <table className="anomaly-table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Field</th>
                <th scope="col">Was</th>
                <th scope="col">Now</th>
                <th scope="col">Count</th>
                <th scope="col">Build</th>
              </tr>
            </thead>
            <tbody>
              {snap.diagnostics.anomalies.slice(0, 40).map((a) => (
                <tr key={`${a.event}.${a.field}`}>
                  <td>{a.event}</td>
                  <td>{a.field}</td>
                  <td>{a.expected}</td>
                  <td>{a.observed}</td>
                  <td className="num">{a.count}</td>
                  <td>{a.observedBuild ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {snap.diagnostics.truncated > 0 && (
          <p className="note">
            {snap.diagnostics.truncated} further {snap.diagnostics.truncated === 1 ? 'field was' : 'fields were'}{' '}
            not tracked because a bound was reached. This list is not complete.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Ingest</h2>
        <div className="grid">
          <Field label="Lines read" value={String(snap.stats.linesRead)} />
          <Field label="Events emitted" value={String(snap.stats.eventsEmitted)} />
          <Field label="Malformed JSON" value={String(snap.stats.malformedJson)} />
          <Field label="Rotations" value={String(snap.stats.rotations)} />
          <Field label="Files opened" value={String(snap.stats.filesOpened)} />
          <Field label="Empty files skipped" value={String(snap.stats.emptyFilesSkipped)} />
        </div>
      </section>

      <section className="card">
        <h2>Events without a typed shape</h2>
        <p className="muted">
          These are delivered with full provenance and are not errors — they are the
          normalization backlog.
        </p>
        {unknown.length === 0 ? (
          <p className="muted">None seen yet.</p>
        ) : (
          <ul className="tags">
            {unknown.map(([name, n]) => (
              <li key={name}>
                {name} <span className="count">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Recent log</h2>
        <div className="log" role="log">
          {entries.length === 0 && <p className="muted">Nothing logged yet.</p>}
          {entries.map((e, i) => (
            <div key={`${e.at}-${i}`} className={`log-row ${e.level}`}>
              <span className="log-level">{e.level.toUpperCase()}</span>
              <span className="log-scope">{e.scope}</span>
              <span>{e.message}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/**
 * Journal and game state, in full: what the Dashboard summarises in words.
 * Identifiers and raw values are fine here; this is the screen for them.
 */
function JournalStateCard({ snap }: { snap: Snap }) {
  const s = snap.state;
  const pos = isKnown(s.starPos) ? s.starPos.map((n) => n.toFixed(2)).join(' / ') : 'Unknown';
  return (
    <section className="card">
      <h2>Journal &amp; game state</h2>
      <div className="grid">
        <Field label="Game status" value={SESSION_LABEL[snap.session]} />
        <Field label="Journal reader" value={snap.connection} />
        <Field label="Shutdown seen" value={s.shutdown ? 'Yes' : 'No'} />
        <Field label="Active journal" value={snap.activeFile ?? 'None'} wide />
        <Field label="Game version" value={show(s.gameVersion)} />
        <Field label="Build" value={show(s.build).trim() || 'Unknown'} />
        <Field label="Frontier ID" value={show(s.fid)} />
        <Field label="Game mode" value={show(s.gameMode)} />
        <Field label="System address" value={show(s.systemAddress)} />
        <Field label="Coordinates" value={pos} wide />
        <Field label="Body (raw)" value={show(s.body)} />
        <Field label="Body type" value={show(s.bodyType)} />
        <Field label="Station type" value={show(s.stationType)} />
        <Field label="Market ID" value={show(s.marketId)} />
        <Field
          label="Services reported"
          value={isKnown(s.stationServices) ? String(s.stationServices.length) : 'Unknown'}
        />
        <Field label="Travel state" value={`${s.travel} (${travelLabel(s.travel)})`} />
        <Field label="Vehicle" value={s.vehicle} />
        <Field label="Ship symbol" value={show(s.ship)} />
        <Field label="Ship ID" value={show(s.shipId)} />
        <Field label="Cargo / capacity" value={`${show(s.cargoCount)} / ${show(s.cargoCapacity)}`} />
        <Field label="Last event" value={s.lastEventName ?? 'Unknown'} />
        <Field label="Last event time" value={s.lastEventAt ?? 'Unknown'} />
        <Field label="Last event ID" value={s.lastEventId ?? 'Unknown'} wide />
      </div>
    </section>
  );
}

function Placeholder({ section }: { section: Section }) {
  return (
    <>
      <header className="page-head">
        <h1>{section}</h1>
      </header>
      <section className="card">
        <p className="muted">
          Planned for {PHASE[section]}. The foundation this depends on is in place; the module
          itself is deliberately not built yet.
        </p>
      </section>
    </>
  );
}

/**
 * One plugin's tab. A Python plugin with a panel shows the panel itself; any
 * other plugin (a declarative one, or a Python one with no panel, switched off
 * or failed to start) shows its card.
 */
function PluginTab({ snap, tab }: { snap: Snap; tab: string }) {
  if (tab.startsWith('py:')) {
    const folder = tab.slice(3);
    const plugin = snap.pythonPlugins.plugins.find((p) => p.folder === folder);
    if (!plugin) return null;
    if (plugin.loaded && plugin.native && snap.pythonPlugins.running) {
      return <NativePluginPage snap={snap} plugin={plugin} />;
    }
    if (plugin.loaded && plugin.hasPanel && snap.pythonPlugins.running) {
      return <PluginPanel snap={snap} folder={folder} />;
    }
    return (
      <PythonPluginCard
        plugin={plugin}
        hostRunning={snap.pythonPlugins.running}
        update={snap.pythonPlugins.updates[plugin.folder]}
        showToggle={false}
      />
    );
  }
  const id = tab.slice(5);
  const plugin = snap.plugins.loaded.find((p) => p.manifest.id === id);
  if (!plugin) return null;
  return (
    <PluginCard
      plugin={plugin}
      enabled={!snap.plugins.disabledIds.includes(id)}
      showToggle={false}
    />
  );
}
