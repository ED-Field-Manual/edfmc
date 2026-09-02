/**
 * The journal pipeline.
 *
 * There is exactly one path from bytes to normalized events, and both live tailing
 * and replay go through it (`processLines`). That identity is the point: a replay
 * regression test is only meaningful if it exercises the same code the game does.
 */

import { listJournalFiles, selectActiveJournal, type JournalFile } from './directory.js';
import { getDefaultFs, type JournalFs } from './fs.js';
import { JournalSessionContext, parseLine } from './parser.js';
import { normalize } from './normalizer.js';
import { FileTailer, type TailedLine } from './tailer.js';
import {
  emptyStats,
  type IngestFailure,
  type IngestStats,
  type JournalCheckpoint,
  type NormalizedEvent,
} from './types.js';

export interface JournalEngineOptions {
  readonly directory: string;
  /** Resume point from SQLite. Null starts from the newest journal. */
  readonly checkpoint?: JournalCheckpoint | null;
  /**
   * When resuming with no checkpoint, start at the end of the active journal rather
   * than replaying the whole session. Elite may already have been running for hours.
   */
  readonly startAtEndWhenFresh?: boolean;
  /** Low-frequency backstop behind fs.watch. Not the primary trigger (§30). */
  readonly safetyPollMs?: number;
  /**
   * Directory watching. Defaults to true; tests disable it so that pumping is
   * driven purely by explicit calls and event ordering is deterministic.
   */
  readonly useWatcher?: boolean;
  /**
   * Change-notification source. Injected because the mechanism differs by host:
   * `node:fs.watch` under Node, the Tauri fs-watch plugin in the webview. Returns
   * an unsubscribe function. Falls back to the safety poll when absent.
   */
  readonly watchDirectory?: (directory: string, onChange: () => void) => () => void;
  /** Filesystem port. Defaults to the Node adapter. */
  readonly fs?: JournalFs;
  readonly onEvent: (event: NormalizedEvent) => void;
  readonly onFailure?: (failure: IngestFailure) => void;
  readonly onCheckpoint?: (checkpoint: JournalCheckpoint) => void;
  readonly onRotate?: (from: string | null, to: string) => void;
}

/**
 * Push raw lines through parse -> normalize.
 *
 * Shared verbatim by the live engine and the replay harness.
 */
export function processLines(
  lines: readonly TailedLine[],
  sourceFile: string,
  context: JournalSessionContext,
  stats: IngestStats,
  onEvent: (e: NormalizedEvent) => void,
  onFailure?: (f: IngestFailure) => void,
): void {
  for (const { line, byteOffset } of lines) {
    stats.linesRead += 1;
    const result = parseLine(line, sourceFile, byteOffset, context);
    if (result === null) continue; // blank padding line

    if (!result.ok) {
      const { reason } = result.failure;
      if (reason === 'malformed-json') stats.malformedJson += 1;
      else if (reason === 'not-an-object') stats.notAnObject += 1;
      else stats.missingEventField += 1;
      onFailure?.(result.failure);
      continue;
    }

    const normalized = normalize(result.event);
    if (!normalized.known) {
      const name = result.event.event;
      stats.unknownEventKinds[name] = (stats.unknownEventKinds[name] ?? 0) + 1;
    }
    stats.eventsEmitted += 1;
    onEvent(normalized);
  }
}

export class JournalEngine {
  private readonly opts: JournalEngineOptions;
  private tailer: FileTailer | null = null;
  private activeFile: JournalFile | null = null;
  private context = new JournalSessionContext();
  private unwatch: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fs: JournalFs;
  /** Serialises pumps so overlapping triggers cannot interleave offset bookkeeping. */
  private pumpChain: Promise<void> = Promise.resolve();
  /** A queued-but-not-yet-started pump, used to coalesce watcher bursts. */
  private pendingPump: Promise<void> | null = null;
  private running = false;
  private lastEventId: string | null = null;

  readonly stats: IngestStats = emptyStats();

  constructor(options: JournalEngineOptions) {
    this.opts = options;
    this.fs = options.fs ?? getDefaultFs();
  }

  get currentFile(): string | null {
    return this.activeFile?.fileName ?? null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.selectFile(this.opts.checkpoint ?? null);

    // Primary trigger: directory watch catches both appends to the active journal
    // and the appearance of a new one on rotation.
    if (this.opts.useWatcher !== false && this.opts.watchDirectory) {
      try {
        this.unwatch = this.opts.watchDirectory(this.opts.directory, () => void this.pump());
      } catch {
        this.unwatch = null; // fall back to the safety poll alone
      }
    }

    const interval = this.opts.safetyPollMs ?? 2000;
    this.timer = setInterval(() => void this.pump(), interval);
    (this.timer as { unref?: () => void }).unref?.();

    await this.pump();
  }

  stop(): void {
    this.running = false;
    this.unwatch?.();
    this.unwatch = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Decide which journal to read and from what offset.
   *
   * The checkpoint is honoured only if that file still exists and has not shrunk
   * below the recorded offset; otherwise we fall forward to the newest journal
   * rather than reading from a meaningless position.
   */
  private async selectFile(checkpoint: JournalCheckpoint | null): Promise<void> {
    const files = await listJournalFiles(this.opts.directory, this.fs);
    const empties = files.filter((f) => f.sizeBytes === 0).length;
    this.stats.emptyFilesSkipped = empties;

    let target: JournalFile | null = null;
    let offset = 0;

    if (checkpoint) {
      const match = files.find((f) => f.fileName === checkpoint.sourceFile);
      if (match && match.sizeBytes >= checkpoint.byteOffset) {
        target = match;
        offset = checkpoint.byteOffset;
        this.lastEventId = checkpoint.lastEventId;
      }
    }

    if (!target) {
      target = selectActiveJournal(files);
      // No checkpoint: optionally skip history Elite wrote before we launched.
      offset = target && this.opts.startAtEndWhenFresh ? target.sizeBytes : 0;
    }

    if (!target) {
      this.activeFile = null;
      this.tailer = null;
      return;
    }

    const previous = this.activeFile?.fileName ?? null;
    this.activeFile = target;
    this.tailer = new FileTailer(target.fullPath, offset, this.fs);
    this.context = new JournalSessionContext();
    this.stats.filesOpened += 1;
    if (previous && previous !== target.fileName) {
      this.stats.rotations += 1;
      this.opts.onRotate?.(previous, target.fileName);
    }
  }

  /**
   * Read pending bytes, then check for rotation.
   *
   * Runs on a serial chain so overlapping fs.watch bursts cannot interleave reads
   * and corrupt offset bookkeeping.
   *
   * The returned promise resolves only once a pump that began *after* this call has
   * finished. That guarantee matters: callers (and the shutdown flush) must be able
   * to rely on "await pump()" meaning every byte written so far has been delivered.
   * Simply returning early while another pump was in flight would break it.
   */
  pump(): Promise<void> {
    // Coalesce: if a pump is queued but has not started, it will observe our writes.
    if (this.pendingPump) return this.pendingPump;

    const queued = this.pumpChain.then(async () => {
      this.pendingPump = null;
      await this.drainActive();
      await this.checkRotation();
    });
    this.pendingPump = queued;
    // Keep the chain alive even if one pump rejects; a transient I/O error must not
    // wedge the engine permanently.
    this.pumpChain = queued.catch(() => undefined);
    return queued;
  }

  private async drainActive(): Promise<void> {
    if (!this.tailer || !this.activeFile) return;
    const fileName = this.activeFile.fileName;
    const result = await this.tailer.read();
    if (result.lines.length === 0) return;

    processLines(
      result.lines,
      fileName,
      this.context,
      this.stats,
      (e) => {
        this.lastEventId = e.source.provenance.eventId;
        this.opts.onEvent(e);
      },
      this.opts.onFailure,
    );

    this.opts.onCheckpoint?.({
      sourceFile: fileName,
      byteOffset: result.safeOffset,
      lastEventId: this.lastEventId,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Switch to a newer journal once the current one has been fully drained.
   *
   * Draining first matters: rotating early would silently discard the tail of the
   * previous session.
   */
  private async checkRotation(): Promise<void> {
    const files = await listJournalFiles(this.opts.directory, this.fs);
    const newest = selectActiveJournal(files);
    if (!newest) return;

    if (!this.activeFile) {
      await this.selectFile(null);
      await this.drainActive();
      return;
    }
    if (newest.fileName === this.activeFile.fileName) return;

    const newer =
      newest.sortKey > this.activeFile.sortKey ||
      (newest.sortKey === this.activeFile.sortKey && newest.part > this.activeFile.part);
    if (!newer) return;

    // Final drain of the outgoing file before letting go of it.
    await this.drainActive();

    const previous = this.activeFile.fileName;
    this.activeFile = newest;
    this.tailer = new FileTailer(newest.fullPath, 0, this.fs);
    this.context = new JournalSessionContext();
    this.stats.filesOpened += 1;
    this.stats.rotations += 1;
    this.opts.onRotate?.(previous, newest.fileName);

    await this.drainActive();
  }
}

/* ----------------------------------------------------------------- replay */

export interface ReplayResult {
  readonly events: readonly NormalizedEvent[];
  readonly failures: readonly IngestFailure[];
  readonly stats: IngestStats;
}

/**
 * Replay a journal file through the live pipeline.
 *
 * Reads via FileTailer so the same partial-line and offset logic applies, which
 * means replayed events carry byte-identical `eventId`s to live ingestion.
 */
export async function replayFile(
  filePath: string,
  fs?: JournalFs,
): Promise<ReplayResult> {
  const events: NormalizedEvent[] = [];
  const failures: IngestFailure[] = [];
  const stats = emptyStats();
  const context = new JournalSessionContext();
  const tailer = new FileTailer(filePath, 0, fs ?? getDefaultFs());

  const result = await tailer.read();
  processLines(
    result.lines,
    // Basename without node:path, so replay works in the webview too. The source
    // file name is part of every eventId, so it must match live ingestion exactly.
    filePath.split(/[\\/]/).pop() ?? filePath,
    context,
    stats,
    (e) => events.push(e),
    (f) => failures.push(f),
  );

  return { events, failures, stats };
}
