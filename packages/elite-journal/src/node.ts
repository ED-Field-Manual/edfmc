/**
 * Node filesystem adapter.
 *
 * Isolated behind the `@edfm/elite-journal/node` subpath so that browser and
 * webview bundles never see a `node:` import. Importing this module installs it as
 * the ambient default, so Node consumers (tests, replay tooling) get working
 * defaults from a single side-effecting import.
 */

import { open, readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { setDefaultFs, type JournalFs } from './fs.js';

export function createNodeFs(): JournalFs {
  return {
    async readDir(dir) {
      try {
        return await readdir(dir);
      } catch {
        return [];
      }
    },
    async size(file) {
      try {
        return (await stat(file)).size;
      } catch {
        return null;
      }
    },
    async readRange(file, offset, length) {
      const buf = Buffer.allocUnsafe(length);
      const handle = await open(file, 'r');
      try {
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        // Copy rather than aliasing the pooled Buffer: `allocUnsafe` can hand back
        // memory from a shared pool, and a view into it would be corrupted by the
        // next allocation.
        return new Uint8Array(buf.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    },
    join(...segments) {
      return join(...segments);
    },
    async isDirectory(dir) {
      try {
        return (await stat(dir)).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

export const nodeFs: JournalFs = createNodeFs();
export { sep as pathSeparator };

setDefaultFs(nodeFs);
