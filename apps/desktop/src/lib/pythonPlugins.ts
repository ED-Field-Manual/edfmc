/**
 * Python plugins: the switch, and what the plugin host reports.
 *
 * The host itself is a separate process (`src-tauri/plugin-host/host.py`,
 * started by `plugin_host.rs`). This side only decides whether it runs, and
 * shows what it says.
 *
 * Python plugins run whenever there are any in the plugins folder, as they
 * would in any other plugin host: a commander who put a plugin there wants it
 * to run. There is no separate global switch; each plugin has its own.
 *
 * (An earlier build had an "I understand. Run Python plugins." switch, off by
 * default. The user asked for it to go: plugins only run if the commander put
 * them in the folder, which is the same choice other hosts treat as consent.)
 */

import { invoke } from '@tauri-apps/api/core';

import { httpFetch } from './http.js';
import { logger } from './logger.js';
import { checkForUpdates, type UpdateResult } from './pluginUpdates.js';

export interface PythonPluginStatus {
  readonly folder: string;
  readonly name: string;
  readonly loaded: boolean;
  /** Switched off by the commander: listed, but none of its code runs. */
  readonly disabled: boolean;
  readonly error: string | null;
  /** As the plugin states it, or null. Never guessed. */
  readonly version: string | null;
  readonly hasPanel: boolean;
  readonly hasSettings: boolean;
  /** Drawn by the app from state the plugin publishes, not by tkinter. */
  readonly native?: boolean;
  /** The plugin's README, shown as plain text. */
  readonly readme: string | null;
  /** `origin` from the plugin's .git/config, when it was cloned. */
  readonly gitRemote?: string | null;
}

export interface PythonPluginView {
  readonly enabled: boolean;
  readonly running: boolean;
  /** Where plugin folders go. */
  readonly folder: string | null;
  /** The Python that runs them, or null when none could be found. */
  readonly python: string | null;
  readonly plugins: readonly PythonPluginStatus[];
  /** The last thing that went wrong, in words for the commander. */
  readonly problem: string | null;
  /** Whether to check GitHub for newer versions, at most once a day. */
  readonly updateChecks: boolean;
  readonly checking: boolean;
  /** The last check's result per plugin folder. */
  readonly updates: Readonly<Record<string, UpdateResult>>;
  /** The route a plugin published for the overlay, or null. */
  readonly route: PluginRoute | null;
  /** Native pages' latest state, by plugin folder. See `edfmc.register_page`. */
  readonly pages: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * A route a plugin published (`edfmc.publish('route', ...)`), for the overlay.
 * Every field is checked on arrival: this comes from a plugin, not from us.
 */
export interface PluginRoute {
  readonly next: string | null;
  readonly nextIsNeutron: boolean;
  readonly destination: string | null;
  readonly jumpsLeft: number;
  readonly waypoint: number;
  readonly waypoints: number;
  readonly finished: boolean;
}

export function readPluginRoute(data: unknown): PluginRoute | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 200 ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  return {
    next: str(d['next']),
    nextIsNeutron: d['nextIsNeutron'] === true,
    destination: str(d['destination']),
    jumpsLeft: num(d['jumpsLeft']),
    waypoint: num(d['waypoint']),
    waypoints: num(d['waypoints']),
    finished: d['finished'] === true,
  };
}

const DISABLED_SETTING = 'pythonPlugins.disabled';
const UPDATE_CHECKS_SETTING = 'pythonPlugins.updateChecks';
const UPDATES_SETTING = 'pythonPlugins.updates';
const REPOS_SETTING = 'pythonPlugins.repos';
/** GitHub allows 60 unauthenticated requests an hour; once a day is plenty. */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

interface Deps {
  readonly getSetting: (key: string) => Promise<string | null>;
  readonly setSetting: (key: string, value: string) => Promise<void>;
  readonly changed: () => void;
}

export class PythonPlugins {
  private enabled = false;
  private running = false;
  private folder: string | null = null;
  private python: string | null = null;
  private plugins: PythonPluginStatus[] = [];
  private problem: string | null = null;
  private journalDir: string | null = null;
  private listening = false;
  /** Set while we are the ones stopping it, so its exit is not reported as a crash. */
  private stopping = false;
  /** The host process we started. Messages from any other (an old one exiting after a restart) are ignored. */
  private pid: number | null = null;
  private disabled = new Set<string>();
  private updateChecks = true;
  private checking = false;
  private updates: Record<string, UpdateResult> = {};
  private route: PluginRoute | null = null;
  /** The latest page state each native plugin published, by folder. */
  private pages: Record<string, Readonly<Record<string, unknown>>> = {};
  /** Repos the commander pasted, by plugin folder. */
  private repos: Record<string, string> = {};

  constructor(private readonly deps: Deps) {}

  view(): PythonPluginView {
    return {
      enabled: this.enabled,
      running: this.running,
      folder: this.folder,
      python: this.python,
      plugins: this.plugins,
      problem: this.problem,
      updateChecks: this.updateChecks,
      checking: this.checking,
      updates: this.updates,
      route: this.route,
      pages: this.pages,
    };
  }

  /** Read the switch and, when it is on, start plugins for this journal folder. */
  async init(journalDir: string | null): Promise<void> {
    this.journalDir = journalDir;
    // Always on. The old setting is no longer read; see the note above.
    this.enabled = true;
    try {
      const stored = JSON.parse((await this.deps.getSetting(DISABLED_SETTING)) ?? '[]') as unknown;
      if (Array.isArray(stored)) {
        this.disabled = new Set(stored.filter((v): v is string => typeof v === 'string'));
      }
    } catch {
      this.disabled = new Set();
    }
    this.updateChecks = (await this.deps.getSetting(UPDATE_CHECKS_SETTING)) !== 'false';
    this.updates = readJson(await this.deps.getSetting(UPDATES_SETTING)) ?? {};
    this.repos = readJson(await this.deps.getSetting(REPOS_SETTING)) ?? {};
    await this.refreshInfo();
    if (this.enabled) await this.start();
    this.deps.changed();
  }

  /**
   * Switch one plugin on or off. Takes effect by restarting the host: a plugin
   * that has already run cannot be un-imported, so there is no gentler way.
   */
  async setPluginEnabled(folder: string, enabled: boolean): Promise<void> {
    if (enabled) this.disabled.delete(folder);
    else this.disabled.add(folder);
    await this.deps.setSetting(DISABLED_SETTING, JSON.stringify([...this.disabled]));
    await this.restart();
  }

  /** Turn the daily GitHub check on or off. Off means no request is made. */
  async setUpdateChecks(on: boolean): Promise<void> {
    this.updateChecks = on;
    await this.deps.setSetting(UPDATE_CHECKS_SETTING, String(on));
    if (on) void this.checkUpdates(false);
    this.deps.changed();
  }

  /**
   * Tell the check which repo a plugin comes from, when it could not find out.
   * An empty value forgets it and goes back to finding it automatically.
   */
  async setRepo(folder: string, link: string): Promise<void> {
    const trimmed = link.trim();
    if (trimmed) this.repos[folder] = trimmed;
    else delete this.repos[folder];
    await this.deps.setSetting(REPOS_SETTING, JSON.stringify(this.repos));
    await this.checkUpdates(true);
  }

  /**
   * Check GitHub for newer versions. Without `force`, only when the last check
   * is over a day old, so restarting the app does not re-ask GitHub.
   */
  async checkUpdates(force: boolean): Promise<void> {
    if (!this.updateChecks || this.checking || this.plugins.length === 0) return;
    if (!force) {
      const times = Object.values(this.updates).map((u) => Date.parse(u.checkedAt));
      const covered = this.plugins.every((p) => this.updates[p.folder]);
      const oldest = times.length ? Math.min(...times) : 0;
      if (covered && Date.now() - oldest < CHECK_EVERY_MS) return;
    }
    this.checking = true;
    this.deps.changed();
    try {
      const results = await checkForUpdates(
        (url, init) => httpFetch(url, init),
        this.plugins.map((p) => ({
          folder: p.folder,
          name: p.name,
          version: p.version,
          readme: p.readme,
          gitRemote: p.gitRemote ?? null,
        })),
        this.repos,
      );
      for (const r of results) this.updates[r.folder] = r;
      await this.deps.setSetting(UPDATES_SETTING, JSON.stringify(this.updates));
      logger.info('plugins', 'Checked plugins for updates', {
        updates: results.filter((r) => r.state === 'update').length,
        unknown: results.filter((r) => r.state === 'unknown').length,
      });
    } catch (err) {
      logger.warn('plugins', 'Plugin update check failed', { error: String(err) });
    } finally {
      this.checking = false;
      this.deps.changed();
    }
  }

  /**
   * Copy the next waypoint of the route being followed (the route hotkey).
   * Asked of the plugin that owns the route, which already copies on arrival,
   * so the clipboard has one writer.
   */
  async copyRouteWaypoint(): Promise<void> {
    const folder = Object.keys(this.pages).find((f) => {
      const page = this.pages[f]!;
      return page['kind'] === 'router-v1' && page['route'] !== null;
    });
    if (folder !== undefined) await this.action(folder, 'copy');
  }

  /** Send the commander's input on a native page to its plugin. */
  async action(folder: string, action: string, args: Record<string, unknown> = {}): Promise<void> {
    try {
      await invoke('plugin_host_action', { folder, action, args });
    } catch (err) {
      logger.warn('plugins', 'Could not send a plugin action', { error: String(err) });
    }
  }

  /** Stop and start again, so newly added plugin folders are picked up. */
  async restart(): Promise<void> {
    await this.stop();
    if (this.enabled) await this.start();
    this.deps.changed();
  }

  async showWindow(): Promise<void> {
    await this.send('show');
  }

  async openSettings(): Promise<void> {
    await this.send('settings');
  }

  async openFolder(): Promise<void> {
    try {
      await invoke('python_plugins_open_folder');
    } catch (err) {
      this.problem = String(err);
      this.deps.changed();
    }
  }

  private async send(kind: 'show' | 'settings'): Promise<void> {
    try {
      await invoke('plugin_host_send', { kind });
    } catch (err) {
      logger.warn('plugins', 'Could not reach the plugin host', { error: String(err) });
    }
  }

  private async refreshInfo(): Promise<void> {
    try {
      const info = await invoke<{ folder: string | null; python: string | null; running: boolean }>(
        'plugin_host_info',
      );
      this.folder = info.folder;
      this.python = info.python;
      this.running = info.running;
    } catch (err) {
      logger.warn('plugins', 'Could not read plugin host info', { error: String(err) });
    }
  }

  private async listen(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    const { listen } = await import('@tauri-apps/api/event');
    await listen<Record<string, unknown>>('plugin-host://message', (e) => this.onMessage(e.payload));
  }

  private onMessage(message: Record<string, unknown>): void {
    if (message['pid'] !== this.pid) return;
    switch (message['type']) {
      case 'status':
        this.plugins = Array.isArray(message['plugins'])
          ? (message['plugins'] as PythonPluginStatus[])
          : [];
        // Knowing which plugins are installed is what a check needs; it skips
        // itself when the last one is under a day old.
        void this.checkUpdates(false);
        break;
      case 'error':
        this.problem = typeof message['message'] === 'string' ? message['message'] : 'Plugins stopped.';
        break;
      case 'page': {
        const folder = message['folder'];
        const state = message['state'];
        if (typeof folder !== 'string' || state === null || typeof state !== 'object') return;
        this.pages = { ...this.pages, [folder]: state as Record<string, unknown> };
        break;
      }
      case 'publish':
        if (message['topic'] !== 'route') return;
        this.route = readPluginRoute(message['data']);
        break;
      case 'exited':
        this.route = null;
        this.pages = {};
        this.running = false;
        this.pid = null;
        if (!this.stopping && this.enabled && this.problem === null) {
          this.problem = 'Plugins stopped unexpectedly. Restart them to try again.';
        }
        break;
      default:
        return;
    }
    this.deps.changed();
  }

  private async start(): Promise<void> {
    if (!this.journalDir) {
      this.problem = 'Plugins need the journal folder, which has not been found yet.';
      return;
    }
    await this.listen();
    this.problem = null;
    this.stopping = false;
    try {
      this.pid = await invoke<number>('plugin_host_start', {
        journalDir: this.journalDir,
        disabled: [...this.disabled],
      });
      this.running = true;
      logger.info('plugins', 'Python plugin host started');
    } catch (err) {
      this.running = false;
      this.problem = String(err);
      logger.warn('plugins', 'Python plugin host did not start', { error: String(err) });
    }
  }

  private async stop(): Promise<void> {
    this.stopping = true;
    try {
      await invoke('plugin_host_stop');
    } catch {
      // Not running is the outcome we wanted.
    }
    this.running = false;
    this.pid = null;
    this.plugins = [];
    this.problem = null;
  }
}

function readJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
