/**
 * Tauri implementation of the `JournalFs` port.
 *
 * Backed by the narrow native commands in `src-tauri/src/journal.rs` rather than a
 * broad filesystem permission, so the webview can read journals and nothing else.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { JournalFs } from '@edfm/elite-journal';

/** Windows-style joining; the desktop target is Windows-first (§2). */
function joinPath(...segments: string[]): string {
  return segments
    .filter((s) => s.length > 0)
    .map((s, i) => (i === 0 ? s.replace(/[\\/]+$/, '') : s.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('\\');
}

export const tauriFs: JournalFs = {
  async readDir(path) {
    return await invoke<string[]>('journal_read_dir', { path });
  },
  async size(path) {
    return await invoke<number | null>('journal_file_size', { path });
  },
  async readRange(path, offset, length) {
    // The command returns raw bytes, not a JSON number array.
    const buf = await invoke<ArrayBuffer>('journal_read_range', { path, offset, length });
    return new Uint8Array(buf);
  },
  join: joinPath,
  async isDirectory(path) {
    return await invoke<boolean>('journal_is_dir', { path });
  },
};

/** Resolve the Saved Games known folder via the shell API. Null off Windows. */
export async function savedGamesDir(): Promise<string | null> {
  try {
    return await invoke<string | null>('saved_games_dir');
  } catch {
    return null;
  }
}

/**
 * Subscribe to journal-directory activity.
 *
 * Returns an unsubscribe function shaped for `JournalEngineOptions.watchDirectory`.
 * Registration is asynchronous, so the returned function tears down whichever of the
 * two resources has been established by the time it is called.
 */
export function watchJournalDirectory(directory: string, onChange: () => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;

  void (async () => {
    try {
      const stop = await listen('journal://changed', () => onChange());
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      await invoke('journal_watch', { path: directory });
    } catch {
      // Watching is an optimisation; the engine's safety poll still drives ingest.
    }
  })();

  return () => {
    disposed = true;
    unlisten?.();
    void invoke('journal_unwatch').catch(() => undefined);
  };
}
