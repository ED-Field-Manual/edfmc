/**
 * Journal directory resolution and file ordering.
 *
 * §3 forbids hardcoded `C:\Users\...` logic. The correct source on Windows is the
 * Saved Games known folder (FOLDERID_SavedGames), which the Rust layer resolves via
 * the shell API and injects here. Everything in this module is therefore
 * platform-agnostic and testable without touching a real machine.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Two filename shapes have shipped over the game's life; both are supported. */
const MODERN = /^Journal\.(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d+)\.log$/;
const LEGACY = /^Journal\.(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)\.log$/;

export interface JournalFile {
  readonly fileName: string;
  readonly fullPath: string;
  /** Sortable key derived from the filename, not from mtime. */
  readonly sortKey: number;
  /** The `.NN.` component. Always 1 across the validation corpus, never assumed. */
  readonly part: number;
  readonly sizeBytes: number;
}

/** Parse a journal filename into a sort key. Returns null for non-journal files. */
export function parseJournalFileName(
  fileName: string,
): { sortKey: number; part: number } | null {
  const modern = MODERN.exec(fileName);
  if (modern) {
    const [, y, mo, d, h, mi, s, part] = modern;
    return {
      sortKey: Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!),
      part: Number(part),
    };
  }
  const legacy = LEGACY.exec(fileName);
  if (legacy) {
    const [, y, mo, d, h, mi, s, part] = legacy;
    // Two-digit years in this format are 20xx; the game did not exist before 2014.
    return {
      sortKey: Date.UTC(2000 + +y!, +mo! - 1, +d!, +h!, +mi!, +s!),
      part: Number(part),
    };
  }
  return null;
}

/**
 * List journal files in chronological order.
 *
 * Ordering is by (filename timestamp, part) rather than mtime, because mtime is
 * rewritten by file copies, backups and cloud sync, and would reorder history.
 */
export async function listJournalFiles(directory: string): Promise<JournalFile[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const files: JournalFile[] = [];
  for (const fileName of entries) {
    const parsed = parseJournalFileName(fileName);
    if (!parsed) continue;
    const fullPath = join(directory, fileName);
    let sizeBytes = 0;
    try {
      sizeBytes = (await stat(fullPath)).size;
    } catch {
      continue; // vanished between readdir and stat
    }
    files.push({ fileName, fullPath, sortKey: parsed.sortKey, part: parsed.part, sizeBytes });
  }

  files.sort((a, b) => a.sortKey - b.sortKey || a.part - b.part || a.fileName.localeCompare(b.fileName));
  return files;
}

/**
 * Choose the journal to tail.
 *
 * Skips zero-byte files. This is not defensive theatre: the validation corpus
 * contains two genuinely empty journals, and selecting "the newest file" naively
 * lands on one and stalls forever waiting for content that never arrives.
 *
 * Empty files are still returned in `listJournalFiles`, so rotation detection can
 * see them appear.
 */
export function selectActiveJournal(files: readonly JournalFile[]): JournalFile | null {
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const f = files[i]!;
    if (f.sizeBytes > 0) return f;
  }
  return null;
}

export type ResolutionStrategy = 'manual-override' | 'known-folder' | 'env-fallback' | 'none';

export interface DirectoryResolution {
  readonly directory: string | null;
  readonly strategy: ResolutionStrategy;
  /** Human-readable explanation surfaced in Settings and diagnostics. */
  readonly detail: string;
}

export interface ResolveOptions {
  /** User-supplied path from Settings. Always wins when set. */
  readonly manualOverride?: string | undefined;
  /**
   * Supplied by the Rust layer via SHGetKnownFolderPath(FOLDERID_SavedGames).
   * Injected rather than computed so this module stays testable and portable.
   */
  readonly savedGamesPath?: string | undefined;
  /** Existence probe, injected for testability. */
  readonly exists?: (path: string) => Promise<boolean>;
}

const GAME_SUBPATH = join('Frontier Developments', 'Elite Dangerous');

async function defaultExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the journal directory, reporting which strategy succeeded so the UI can
 * tell the user *why* it is looking where it is looking.
 */
export async function resolveJournalDirectory(
  options: ResolveOptions = {},
): Promise<DirectoryResolution> {
  const exists = options.exists ?? defaultExists;

  if (options.manualOverride) {
    const ok = await exists(options.manualOverride);
    return {
      directory: ok ? options.manualOverride : null,
      strategy: 'manual-override',
      detail: ok
        ? 'Using the path configured in Settings.'
        : `Configured path does not exist: ${options.manualOverride}`,
    };
  }

  if (options.savedGamesPath) {
    const candidate = join(options.savedGamesPath, GAME_SUBPATH);
    if (await exists(candidate)) {
      return {
        directory: candidate,
        strategy: 'known-folder',
        detail: 'Resolved from the Windows Saved Games known folder.',
      };
    }
  }

  // Last resort only. Documented as a fallback because USERPROFILE can be
  // relocated or absent, and Saved Games can be redirected away from it.
  const home = process.env['USERPROFILE'] ?? process.env['HOME'];
  if (home) {
    const candidate = join(home, 'Saved Games', GAME_SUBPATH);
    if (await exists(candidate)) {
      return {
        directory: candidate,
        strategy: 'env-fallback',
        detail:
          'Known-folder lookup unavailable; located via the user profile directory. ' +
          'Set an explicit path in Settings if this is wrong.',
      };
    }
  }

  return {
    directory: null,
    strategy: 'none',
    detail: 'Could not locate the Elite Dangerous journal directory. Set it in Settings.',
  };
}
