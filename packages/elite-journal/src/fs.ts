/**
 * Filesystem port.
 *
 * The journal engine runs in three places: Node (tests, replay, CLI tooling), the
 * Tauri webview (live play), and eventually a headless importer. Only the I/O
 * primitives differ, so they are isolated behind this interface and everything
 * above it — tailing, parsing, normalization, state — stays identical.
 *
 * This is what keeps §3's "replay through the same event pipeline used for live
 * play" literally true rather than approximately true.
 *
 * This module deliberately contains **no** `node:` imports. The Node adapter lives
 * in `./node.ts` behind the `@edfm/elite-journal/node` subpath, so bundling for the
 * webview cannot pull `node:fs` into the graph — which would ship a stub whose only
 * possible behaviour is to fail confusingly at runtime.
 */

export interface JournalFs {
  /** Entry names (not paths) directly inside `path`. Empty array if unreadable. */
  readDir(path: string): Promise<string[]>;
  /** Size in bytes, or null when the file does not exist or cannot be read. */
  size(path: string): Promise<number | null>;
  /**
   * Read up to `length` bytes starting at `offset`.
   * Returning fewer bytes than requested is legal (the file may be shrinking).
   */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** Join path segments using the platform separator. */
  join(...segments: string[]): string;
  /** True when `path` exists and is a directory. */
  isDirectory(path: string): Promise<boolean>;
}

let defaultFs: JournalFs | null = null;

/**
 * Install the ambient filesystem adapter for this host.
 *
 * Called once at startup: importing `@edfm/elite-journal/node` does it for Node,
 * and the desktop app installs its Tauri adapter. Making the host wire this
 * explicitly is the point — there is no silent platform guess to be wrong about.
 */
export function setDefaultFs(fs: JournalFs): void {
  defaultFs = fs;
}

export function getDefaultFs(): JournalFs {
  if (!defaultFs) {
    throw new Error(
      'No JournalFs configured. Import "@edfm/elite-journal/node" under Node, or call ' +
        'setDefaultFs() with a host adapter, or pass one explicitly.',
    );
  }
  return defaultFs;
}
