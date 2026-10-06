/**
 * The plugins dashboard.
 *
 * Its own screen rather than a Settings section, because a plugin is something
 * a commander installs, reads about, and turns on and off — not a preference
 * they set once. It also has to answer a question Settings could not: "is this
 * thing doing anything?"
 *
 * Context rules are invisible until something in the game matches them, so an
 * installed plugin and a broken one look identical from the outside. Every card
 * therefore shows what the plugin contributes by name, and whatever the author
 * wrote about how to use it.
 *
 * Author-supplied text — descriptions, instructions, README — is rendered as
 * plain text. React escapes it, and it is never treated as HTML or Markdown:
 * it comes from a stranger, and text that can style itself is text that can
 * misrepresent itself as part of the application.
 */

import { useState } from 'react';
import type { LoadedPlugin } from '@edfm/plugins';
import { companion, type CompanionSnapshot } from './lib/companion';
import type { PythonPluginStatus } from './lib/pythonPlugins';

function Instructions({ plugin }: { plugin: LoadedPlugin }) {
  const [open, setOpen] = useState(false);
  const text = plugin.manifest.instructions ?? plugin.readme;
  if (text === null || text === undefined) return null;

  return (
    <div>
      <button type="button" className="link" onClick={() => setOpen(!open)}>
        {open ? 'Hide instructions' : 'How to use this'}
      </button>
      {open && (
        // Whitespace preserved so an author's line breaks and lists survive,
        // without interpreting anything they wrote as markup.
        <pre className="instructions">{text}</pre>
      )}
    </div>
  );
}

/** A README, shown on request as plain text, never as markup. */
function Readme({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div>
      <button type="button" className="link" onClick={() => setOpen(!open)}>
        {open ? 'Hide instructions' : 'How to use this'}
      </button>
      {open && <pre className="instructions">{text}</pre>}
    </div>
  );
}

/** One Python plugin, laid out like a declarative plugin's card. */
export function PythonPluginCard({
  plugin,
  hostRunning,
  showToggle = true,
}: {
  plugin: PythonPluginStatus;
  hostRunning: boolean;
  /** The Enabled switch lives on the Plugins page only, not on a plugin's own tab. */
  showToggle?: boolean;
}) {
  const on = !plugin.disabled;
  return (
    <section className="card">
      <div className="row spread">
        <div>
          <h2>{plugin.name}</h2>
          <p className="muted">
            {plugin.version ?? 'Version not stated'} · Python plugin · <code>{plugin.folder}</code>
          </p>
        </div>
        {showToggle && (
          <label className="stack" htmlFor={`py-toggle-${plugin.folder}`}>
          <span>
            <input
              id={`py-toggle-${plugin.folder}`}
              type="checkbox"
              checked={on}
              onChange={(e) => void companion.setPythonPluginEnabled(plugin.folder, e.target.checked)}
            />{' '}
            {on ? 'Enabled' : 'Disabled'}
          </span>
        </label>
        )}
      </div>

      {plugin.disabled ? (
        <p className="muted">
          Switched off. It stays in the folder, and none of its code runs until you turn it back
          on.
        </p>
      ) : plugin.loaded ? (
        <p className="muted">
          {hostRunning ? 'Running.' : 'Loaded.'}
          {plugin.hasPanel && ' Its panel has its own tab, under Plugins in the sidebar.'}
          {plugin.hasSettings && ' It has settings under Plugin settings.'}
        </p>
      ) : (
        <p className="note">Could not start: {plugin.error ?? 'no reason given.'}</p>
      )}

      <Readme text={plugin.readme} />
    </section>
  );
}

export function PluginCard({
  plugin,
  enabled,
  showToggle = true,
}: {
  plugin: LoadedPlugin;
  enabled: boolean;
  /** The Enabled switch lives on the Plugins page only, not on a plugin's own tab. */
  showToggle?: boolean;
}) {
  const m = plugin.manifest;

  return (
    <section className="card">
      <div className="row spread">
        <div>
          <h2>{m.name}</h2>
          <p className="muted">
            {m.version}
            {m.author && ` · ${m.author}`} · <code>{m.id}</code>
          </p>
        </div>
        {showToggle && (
          <label className="stack" htmlFor={`toggle-${m.id}`}>
          <span>
            <input
              id={`toggle-${m.id}`}
              type="checkbox"
              checked={enabled}
              onChange={(e) => void companion.setPluginEnabled(m.id, e.target.checked)}
            />{' '}
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>
        )}
      </div>

      {m.description && <p>{m.description}</p>}

      {!enabled && (
        <p className="muted">
          Switched off. It stays installed and keeps its instructions; it just contributes
          nothing until you turn it back on.
        </p>
      )}

      {plugin.contextRules.length > 0 && (
        <>
          <h3>Context rules</h3>
          <ul className="muted">
            {plugin.contextRules.map((r) => (
              <li key={r.id}>{r.title}</li>
            ))}
          </ul>
        </>
      )}

      {plugin.researchProjects.length > 0 && (
        <>
          <h3>Research projects</h3>
          <ul className="muted">
            {plugin.researchProjects.map((r) => (
              <li key={r.id}>{r.title}</li>
            ))}
          </ul>
        </>
      )}

      <Instructions plugin={plugin} />

      {plugin.warnings.length > 0 && (
        <ul className="note">
          {plugin.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Plugins({ snap }: { snap: CompanionSnapshot }) {
  const p = snap.plugins;
  const py = snap.pythonPlugins;
  const disabled = new Set(p.disabledIds);
  const installed = p.loaded.length + py.plugins.length;
  const active =
    p.loaded.length - disabled.size + py.plugins.filter((x) => x.loaded && !x.disabled).length;
  const nothingInstalled =
    p.loaded.length === 0 && p.rejected.length === 0 && py.plugins.length === 0;

  // One button for both kinds: rule plugins are re-read, and Python plugins
  // restart, which is the only way to pick up a new or changed one.
  const reloadAll = async () => {
    await companion.reloadPlugins();
    await companion.restartPythonPlugins();
  };

  return (
    <>
      <header className="page-head">
        <h1>Plugins</h1>
        <p className="muted">
          {installed === 0 ? 'None installed.' : `${installed} installed, ${active} active`}
        </p>
      </header>

      {/*
        One card for both kinds, and no need to say which is which: the app
        tells a rule plugin (plugin.json) from a Python one (load.py) itself.
      */}
      <section className="card">
        <div className="row spread">
          <h2>Installing plugins</h2>
          {py.plugins.length > 0 && (
            <span className={`badge ${py.running ? 'ok' : ''}`}>
              Python plugins {py.running ? 'running' : 'stopped'}
            </span>
          )}
        </div>
        <p>
          To install a plugin, place its folder in the plugin directory below, then click{' '}
          <strong>Reload plugins</strong>. EDFM Companion will automatically detect the plugin type
          and load it appropriately.
        </p>

        {p.directory ? (
          <div>
            <p>
              <strong>Plugin folder:</strong>
            </p>
            <code>{p.directory}</code>
          </div>
        ) : (
          <p className="note">
            No usable plugins folder on this system.
            {p.fallbackReason && ` ${p.fallbackReason}`}
          </p>
        )}

        {p.fallbackReason && p.directory && (
          <p className="note">
            {p.fallbackReason} Plugins are being read from the path above instead.
          </p>
        )}

        <p>
          Plugins may be able to access files on your computer and connect to the internet. Only
          install plugins from sources you trust.
        </p>

        {py.python === null && py.plugins.length > 0 && (
          <p className="note">No Python could be found to run Python plugins.</p>
        )}
        {py.problem && <p className="note">{py.problem}</p>}

        <div className="row">
          <button type="button" onClick={() => void companion.openPluginsFolder()}>
            Open plugins folder
          </button>
          <button type="button" onClick={() => void reloadAll()}>
            Reload plugins
          </button>
          {py.running && (
            <button type="button" onClick={() => void companion.openPythonPluginSettings()}>
              Plugin settings
            </button>
          )}
        </div>
      </section>

      {snap.pythonPlugins.plugins.map((plugin) => (
        <PythonPluginCard
          key={plugin.folder}
          plugin={plugin}
          hostRunning={snap.pythonPlugins.running}
        />
      ))}

      {nothingInstalled && (
        <section className="card">
          <h2>Nothing installed yet</h2>
          <p className="muted">
            Put a plugin folder in the directory above and press Reload. Anything that fails to
            load will be listed here with the reason, so a plugin never simply disappears.
          </p>
        </section>
      )}

      {p.loaded.map((plugin) => (
        <PluginCard
          key={plugin.manifest.id}
          plugin={plugin}
          enabled={!disabled.has(plugin.manifest.id)}
        />
      ))}

      {p.unreadable.length > 0 && (
        <section className="card">
          <h2>Could not be read</h2>
          <ul className="note">
            {p.unreadable.map((u) => (
              <li key={u.directory}>
                <strong>{u.directory}</strong>: {u.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.rejected.length > 0 && (
        <section className="card">
          <h2>Refused</h2>
          <p className="muted">
            These were found but not loaded. A plugin that quietly did nothing would be
            indistinguishable from one that was never installed.
          </p>
          <table className="rows">
            <thead>
              <tr><th>Folder</th><th>Plugin</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {p.rejected.map((r) => (
                <tr key={r.directory}>
                  <td>{r.directory}</td>
                  <td className="muted">{r.id ?? '—'}</td>
                  <td className="note">
                    {r.problems.map((problem) => (
                      <div key={problem.message}>{problem.message}</div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2>When will I see a plugin working?</h2>
        <p className="muted">
          Context rules appear on the Context screen and in the overlay only while they match.
          A rule about core asteroids stays quiet until you prospect one, and a rule about
          Material Traders until you dock at a station that has one. That is why each plugin
          lists its rules by name here &mdash; it is how you tell an installed plugin from a
          working one without going looking for the situation that triggers it.
        </p>
      </section>
    </>
  );
}
