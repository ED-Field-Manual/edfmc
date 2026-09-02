/**
 * Application service: wires the journal engine to local persistence and state.
 *
 * Deliberately framework-free so the same object can drive the React UI today and
 * the overlay window (Phase 2) without duplication.
 */

import Database from '@tauri-apps/plugin-sql';
import {
  JournalEngine,
  applyEvent,
  initialState,
  resolveJournalDirectory,
  setDefaultFs,
  type CommanderState,
  type IngestStats,
  type JournalCheckpoint,
  type NormalizedEvent,
} from '@edfm/elite-journal';

import { logger } from './logger.js';
import { savedGamesDir, tauriFs, watchJournalDirectory } from './tauriFs.js';

/**
 * Events that fire constantly and carry no dashboard value.
 * `FSSSignalDiscovered` alone was 45,545 of 197,164 lines in the validation corpus;
 * re-rendering for each would burn CPU beside a running game for nothing (§30).
 */
const HIGH_FREQUENCY_NOISE = new Set([
  'Music',
  'FSSSignalDiscovered',
  'ReservoirReplenished',
  'UnderAttack',
  'ShipTargeted',
  'ReceiveText',
]);

/**
 * Install the Tauri adapter as this host's filesystem.
 *
 * Call sites also pass it explicitly; registering it here means any future code
 * path that relies on the default gets the right one rather than throwing.
 */
setDefaultFs(tauriFs);

export type ConnectionState = 'starting' | 'watching' | 'no-directory' | 'stopped' | 'error';

export interface CompanionSnapshot {
  readonly state: CommanderState;
  readonly stats: IngestStats;
  readonly connection: ConnectionState;
  readonly directory: string | null;
  readonly directoryDetail: string;
  readonly activeFile: string | null;
  readonly lastError: string | null;
}

export class Companion {
  private db: Database | null = null;
  private engine: JournalEngine | null = null;
  private state: CommanderState = initialState();
  private connection: ConnectionState = 'starting';
  private directory: string | null = null;
  private directoryDetail = '';
  private lastError: string | null = null;
  private readonly listeners = new Set<() => void>();
  /** Coalesces renders: the UI does not need one per journal line. */
  private notifyScheduled = false;
  private dirtyCheckpoint: JournalCheckpoint | null = null;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): CompanionSnapshot {
    return {
      state: this.state,
      stats: this.engine?.stats ?? {
        linesRead: 0, eventsEmitted: 0, malformedJson: 0, notAnObject: 0,
        missingEventField: 0, unknownEventKinds: {}, filesOpened: 0,
        rotations: 0, emptyFilesSkipped: 0,
      },
      connection: this.connection,
      directory: this.directory,
      directoryDetail: this.directoryDetail,
      activeFile: this.engine?.currentFile ?? null,
      lastError: this.lastError,
    };
  }

  private notify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const fn of this.listeners) fn();
    });
  }

  async start(): Promise<void> {
    try {
      this.db = await Database.load('sqlite:edfm-companion.db');
      logger.info('db', 'Local database ready');
    } catch (err) {
      this.lastError = `Database unavailable: ${String(err)}`;
      logger.error('db', 'Failed to open local database', { error: String(err) });
    }

    const override = await this.getSetting('journalDirectory');
    const saved = await savedGamesDir();
    const resolution = await resolveJournalDirectory({
      manualOverride: override ?? undefined,
      savedGamesPath: saved ?? undefined,
      fs: tauriFs,
    });

    this.directory = resolution.directory;
    this.directoryDetail = resolution.detail;
    logger.info('journal', 'Directory resolution', {
      strategy: resolution.strategy,
      found: resolution.directory !== null,
    });

    if (!resolution.directory) {
      this.connection = 'no-directory';
      this.notify();
      return;
    }

    const checkpoint = await this.loadCheckpoint();
    this.engine = new JournalEngine({
      directory: resolution.directory,
      checkpoint,
      fs: tauriFs,
      watchDirectory: watchJournalDirectory,
      safetyPollMs: 2000,
      onEvent: (e) => this.onEvent(e),
      onFailure: (f) =>
        // Excerpt only, never the whole line: §21.
        logger.warn('journal', `Unusable line (${f.reason})`, {
          file: f.sourceFile,
          offset: f.byteOffset,
        }),
      onCheckpoint: (c) => {
        this.dirtyCheckpoint = c;
      },
      onRotate: (from, to) => logger.info('journal', 'Rotated journal', { from, to }),
    });

    try {
      await this.engine.start();
      this.connection = 'watching';
      logger.info('journal', 'Watching', { file: this.engine.currentFile });
    } catch (err) {
      this.connection = 'error';
      this.lastError = String(err);
      logger.error('journal', 'Engine failed to start', { error: String(err) });
    }

    // Checkpoints are written on a timer rather than per event: at 45k events per
    // session a write per event would be pointless disk churn.
    setInterval(() => void this.flushCheckpoint(), 3000);
    this.notify();
  }

  stop(): void {
    this.engine?.stop();
    this.connection = 'stopped';
    void this.flushCheckpoint();
    this.notify();
  }

  private onEvent(event: NormalizedEvent): void {
    applyEvent(this.state, event);
    if (!HIGH_FREQUENCY_NOISE.has(event.source.event)) {
      logger.trace('journal', event.source.event, { id: event.source.provenance.eventId });
      this.notify();
    }
  }

  /* ------------------------------------------------------------ persistence */

  private async getSetting(key: string): Promise<string | null> {
    if (!this.db) return null;
    try {
      const rows = await this.db.select<Array<{ value: string }>>(
        'SELECT value FROM settings WHERE key = $1',
        [key],
      );
      return rows[0]?.value ?? null;
    } catch {
      return null;
    }
  }

  async setSetting(key: string, value: string): Promise<void> {
    if (!this.db) return;
    await this.db.execute(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, new Date().toISOString()],
    );
  }

  /**
   * Checkpoints are scoped per commander FID where known.
   *
   * A single global checkpoint would let one commander resume at another's byte
   * offset after a commander switch, which §35 calls out explicitly.
   */
  private checkpointScope(): string {
    const fid = this.state.fid;
    return typeof fid === 'string' ? `fid:${fid}` : 'default';
  }

  private async loadCheckpoint(): Promise<JournalCheckpoint | null> {
    if (!this.db) return null;
    try {
      const rows = await this.db.select<
        Array<{ source_file: string; byte_offset: number; last_event_id: string | null; updated_at: string }>
      >('SELECT source_file, byte_offset, last_event_id, updated_at FROM journal_checkpoint WHERE scope = $1', [
        this.checkpointScope(),
      ]);
      const row = rows[0];
      if (!row) return null;
      return {
        sourceFile: row.source_file,
        byteOffset: row.byte_offset,
        lastEventId: row.last_event_id,
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  private async flushCheckpoint(): Promise<void> {
    const c = this.dirtyCheckpoint;
    if (!c || !this.db) return;
    this.dirtyCheckpoint = null;
    try {
      await this.db.execute(
        `INSERT INTO journal_checkpoint (scope, source_file, byte_offset, last_event_id, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(scope) DO UPDATE SET
           source_file = excluded.source_file,
           byte_offset = excluded.byte_offset,
           last_event_id = excluded.last_event_id,
           updated_at = excluded.updated_at`,
        [this.checkpointScope(), c.sourceFile, c.byteOffset, c.lastEventId, c.updatedAt],
      );
    } catch (err) {
      logger.warn('db', 'Checkpoint write failed', { error: String(err) });
    }
  }
}

export const companion = new Companion();
