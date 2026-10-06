/**
 * Python plugins: the switch, and what the plugin host reports.
 *
 * The host itself is a separate process (`src-tauri/plugin-host/host.py`,
 * started by `plugin_host.rs`). This side only decides whether it runs, and
 * shows what it says.
 *
 * Off until the commander turns it on. These plugins are programs, and the
 * warning they switch it on past says so plainly; nothing starts them sooner.
 */

import { invoke } from '@tauri-apps/api/core';

import { logger } from './logger.js';

export interface PythonPluginStatus {
  readonly folder: string;
  readonly name: string;
  readonly loaded: boolean;
  readonly error: string | null;
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
}

const SETTING = 'pythonPlugins.enabled';

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

  constructor(private readonly deps: Deps) {}

  view(): PythonPluginView {
    return {
      enabled: this.enabled,
      running: this.running,
      folder: this.folder,
      python: this.python,
      plugins: this.plugins,
      problem: this.problem,
    };
  }

  /** Read the switch and, when it is on, start plugins for this journal folder. */
  async init(journalDir: string | null): Promise<void> {
    this.journalDir = journalDir;
    this.enabled = (await this.deps.getSetting(SETTING)) === 'true';
    await this.refreshInfo();
    if (this.enabled) await this.start();
    this.deps.changed();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    await this.deps.setSetting(SETTING, String(enabled));
    if (enabled) await this.start();
    else await this.stop();
    this.deps.changed();
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
    switch (message['type']) {
      case 'status':
        this.plugins = Array.isArray(message['plugins'])
          ? (message['plugins'] as PythonPluginStatus[])
          : [];
        break;
      case 'error':
        this.problem = typeof message['message'] === 'string' ? message['message'] : 'Plugins stopped.';
        break;
      case 'exited':
        this.running = false;
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
      await invoke('plugin_host_start', { journalDir: this.journalDir });
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
    this.plugins = [];
    this.problem = null;
  }
}
