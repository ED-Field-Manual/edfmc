/**
 * Byte-offset file tailer.
 *
 * Correctness requirements this exists to satisfy (§3):
 *  - never emit a line that has not been fully written (no terminating newline yet);
 *  - never advance the persisted offset past an incomplete line;
 *  - survive being pointed at a file that Elite is actively appending to;
 *  - detect truncation/replacement rather than reading garbage.
 *
 * Buffers are kept as raw bytes, not strings, precisely because a UTF-8 sequence can
 * straddle a read boundary. Decoding only ever happens on a complete line.
 */

import { open, stat } from 'node:fs/promises';

const LF = 0x0a;
const CR = 0x0d;

export interface TailedLine {
  /** Decoded line with any trailing CR removed. */
  readonly line: string;
  /** Absolute byte offset of the first byte of this line within the file. */
  readonly byteOffset: number;
}

export interface TailReadResult {
  readonly lines: readonly TailedLine[];
  /**
   * Offset just past the last complete line. Safe to persist: resuming here can
   * never replay an emitted line nor skip a partially written one.
   */
  readonly safeOffset: number;
  /** File shrank below our offset — replaced or truncated. Offset was reset to 0. */
  readonly truncated: boolean;
  /** Bytes currently buffered as an incomplete trailing line. */
  readonly pendingBytes: number;
}

export class FileTailer {
  /** Absolute offset of the first byte held in `remainder`. */
  private offset: number;
  private remainder: Buffer = Buffer.alloc(0);

  constructor(
    readonly filePath: string,
    startOffset = 0,
  ) {
    this.offset = startOffset;
  }

  /** Offset that is safe to persist (start of the incomplete trailing line). */
  get safeOffset(): number {
    return this.offset;
  }

  /**
   * Read everything appended since the last call.
   *
   * Returns an empty result rather than throwing when the file is missing, so a
   * rotation racing with a read degrades to "nothing new yet".
   */
  async read(): Promise<TailReadResult> {
    let size: number;
    try {
      size = (await stat(this.filePath)).size;
    } catch {
      return { lines: [], safeOffset: this.offset, truncated: false, pendingBytes: this.remainder.length };
    }

    const consumed = this.offset + this.remainder.length;

    // File shrank below where we already are: it was truncated or swapped out.
    // Restart from the beginning rather than reading from a meaningless offset.
    let truncated = false;
    if (size < consumed) {
      truncated = true;
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
    }

    const from = this.offset + this.remainder.length;
    if (size <= from) {
      return { lines: [], safeOffset: this.offset, truncated, pendingBytes: this.remainder.length };
    }

    const length = size - from;
    const chunk = Buffer.allocUnsafe(length);
    const handle = await open(this.filePath, 'r');
    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(chunk, 0, length, from));
    } finally {
      await handle.close();
    }

    const combined =
      this.remainder.length > 0
        ? Buffer.concat([this.remainder, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);

    const lines: TailedLine[] = [];
    let cursor = 0;

    for (;;) {
      const nl = combined.indexOf(LF, cursor);
      if (nl === -1) break;

      let end = nl;
      if (end > cursor && combined[end - 1] === CR) end -= 1; // strip CRLF's CR

      lines.push({
        line: combined.subarray(cursor, end).toString('utf8'),
        byteOffset: this.offset + cursor,
      });
      cursor = nl + 1;
    }

    // Anything after the last newline is an incomplete write. Hold it; do not emit,
    // and do not let the persisted offset move past it.
    this.remainder = Buffer.from(combined.subarray(cursor));
    this.offset += cursor;

    return { lines, safeOffset: this.offset, truncated, pendingBytes: this.remainder.length };
  }

  /** Discard buffered state and restart at `offset`. Used on rotation. */
  reset(offset = 0): void {
    this.offset = offset;
    this.remainder = Buffer.alloc(0);
  }
}
