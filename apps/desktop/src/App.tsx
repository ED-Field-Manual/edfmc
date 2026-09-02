import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { isKnown, type Known } from '@edfm/elite-journal';

import { resourceUrl } from '@edfm/context';
import { openUrl } from '@tauri-apps/plugin-opener';

import { companion } from './lib/companion.js';
import { logger, type LogEntry } from './lib/logger.js';
import {
  onEditMode,
  onEliteWindow,
  overlayApi,
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
  'Research',
  'Contributions',
  'Overlay',
  'Settings',
  'Diagnostics',
] as const;
type Section = (typeof SECTIONS)[number];

const IMPLEMENTED: ReadonlySet<Section> = new Set<Section>([
  'Context',
  'Dashboard',
  'Overlay',
  'Settings',
  'Diagnostics',
]);

const PHASE: Partial<Record<Section, string>> = {
  Missions: 'Phase 4',
  Logistics: 'Phase 8',
  Research: 'Phase 6',
  Contributions: 'Phase 5',
};

export default function App() {
  const [section, setSection] = useState<Section>('Dashboard');

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

  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◆
          </span>
          <span>
            EDFM <strong>Companion</strong>
          </span>
        </div>
        <ul>
          {SECTIONS.map((s) => (
            <li key={s}>
              <button
                type="button"
                className={s === section ? 'active' : ''}
                aria-current={s === section ? 'page' : undefined}
                onClick={() => setSection(s)}
              >
                <span>{s}</span>
                {!IMPLEMENTED.has(s) && <span className="pill">{PHASE[s]}</span>}
              </button>
            </li>
          ))}
        </ul>
        <ConnectionBadge snap={snap} />
      </nav>

      <main className="main">
        {section === 'Dashboard' && <Dashboard snap={snap} />}
        {section === 'Context' && <ContextPanel snap={snap} />}
        {section === 'Overlay' && <OverlayPanel />}
        {section === 'Settings' && <Settings snap={snap} />}
        {section === 'Diagnostics' && <Diagnostics snap={snap} />}
        {!IMPLEMENTED.has(section) && <Placeholder section={section} />}
      </main>
    </div>
  );
}

type Snap = ReturnType<typeof companion.snapshot>;

function ConnectionBadge({ snap }: { snap: Snap }) {
  // §29: never rely on colour alone. Each state carries a distinct glyph and word.
  const map = {
    starting: { icon: '◐', label: 'Starting', cls: 'warn' },
    watching: { icon: '●', label: 'Watching journal', cls: 'ok' },
    'no-directory': { icon: '▲', label: 'No journal folder', cls: 'warn' },
    stopped: { icon: '■', label: 'Stopped', cls: 'warn' },
    error: { icon: '✕', label: 'Error', cls: 'bad' },
  } as const;
  const s = map[snap.connection];

  return (
    <div className={`status ${s.cls}`} role="status">
      <span aria-hidden="true">{s.icon}</span>
      <div>
        <div className="status-label">{s.label}</div>
        <div className="status-sub">{snap.activeFile ?? 'No active journal'}</div>
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

function Dashboard({ snap }: { snap: Snap }) {
  const s = snap.state;
  const pos = isKnown(s.starPos) ? s.starPos.map((n) => n.toFixed(2)).join(' / ') : 'Unknown';
  const services = isKnown(s.stationServices) ? String(s.stationServices.length) : 'Unknown';

  return (
    <>
      <header className="page-head">
        <h1>Dashboard</h1>
        <p className="muted">
          Live state built from journal events. Values the game did not report are shown as
          Unknown rather than guessed.
        </p>
      </header>

      <section className="card">
        <h2>Commander</h2>
        <div className="grid">
          <Field label="CMDR" value={show(s.commander)} />
          <Field label="Game version" value={show(s.gameVersion)} />
          <Field label="Build" value={show(s.build).trim() || 'Unknown'} />
          <Field label="Mode" value={show(s.gameMode)} />
        </div>
      </section>

      <section className="card">
        <h2>Location</h2>
        <div className="grid">
          <Field label="System" value={show(s.starSystem)} />
          <Field label="System address" value={show(s.systemAddress)} />
          <Field label="Body" value={show(s.body)} />
          <Field label="Coordinates" value={pos} wide />
          <Field label="Station" value={show(s.stationName)} />
          <Field label="Market ID" value={show(s.marketId)} />
          <Field label="Docking" value={s.docking === 'unknown' ? 'Unknown' : s.docking} />
          <Field label="Services reported" value={services} />
        </div>
      </section>

      <section className="card">
        <h2>Ship &amp; cargo</h2>
        <div className="grid">
          <Field label="Ship" value={show(s.ship)} />
          <Field label="Ship name" value={show(s.shipName)} />
          <Field label="Vehicle" value={s.vehicle === 'unknown' ? 'Unknown' : s.vehicle} />
          <Field label="Cargo" value={show(s.cargoCount)} />
        </div>
      </section>

      <section className="card">
        <h2>Last event</h2>
        <div className="grid">
          <Field label="Event" value={s.lastEventName ?? 'Unknown'} />
          <Field label="Timestamp" value={s.lastEventAt ?? 'Unknown'} />
          <Field label="Event ID" value={s.lastEventId ?? 'Unknown'} wide />
        </div>
        {s.shutdown && (
          <p className="note">
            <span aria-hidden="true">■</span> A Shutdown event was seen — the game has exited.
          </p>
        )}
      </section>
    </>
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
            <h2>{ctx.rule.title}</h2>
            {ctx.rule.subtitle && <p className="muted">{ctx.rule.subtitle}</p>}

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

function OverlayPanel() {
  const [enabled, setEnabled] = useState(false);
  const [editing, setEditing] = useState(false);
  const [hideInactive, setHideInactive] = useState(true);
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
        companion.setOverlayEnabled(true);
      } else {
        if (editing) {
          await overlayApi.setEditMode(false);
          setEditing(false);
        }
        await overlayApi.stop();
        companion.setOverlayEnabled(false);
      }
      setEnabled(next);
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
                setHideInactive(e.target.checked);
                if (enabled) void overlayApi.start(e.target.checked);
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
          Phase 2 ships the overlay engine plus a single Current Context widget, on purpose.
          Building the full widget set against unproven positioning and click-through
          handling would mean rebuilding it.
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
        <h2>Privacy</h2>
        <p className="muted">
          This build is entirely local. No journal data is uploaded, and there are no analytics.
          Contribution and research uploads arrive in later phases and will be opt-in, with the
          exact fields sent shown before anything leaves this machine.
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

  return (
    <>
      <header className="page-head">
        <h1>Diagnostics</h1>
      </header>

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
