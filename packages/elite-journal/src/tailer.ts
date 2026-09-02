/**
 * Byte-offset file tailer.
 *
 * Correctness requirements this exists to satisfy (§3):
 *  - never emit a line that has not been fully written (no terminating newline yet);
 *  - never advance the persisted offset past an incomplete line;
 *  - survive being pointed at a file Elite is actively appending to;
 *  - detect truncation/replacement rather than reading garbage.
 *
 * Buffers are kept as raw bytes, not strings, precisely because a UTF-8 sequence can
 * straddle a read boundary. Decoding only ever happens on a complete line.
 */

import { getDefaultFs, type JournalFs } from './fs.js';

const LF = 0x0a;
const CR = 0x0d;

const decoder = new TextDecoder('utf-8');

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

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOfByte(buf: Uint8Array, byte: number, from: number): number {
  for (let i = from; i < buf.length; i += 1) if (buf[i] === byte) return i;
  return -1;
}

export class FileTailer {
  /** Absolute offset of the first byte held in `remainder`. */
  private offset: number;
  private remainder: Uint8Array = new Uint8Array(0);
  private readonly fs: JournalFs;

  constructor(
    readonly filePath: string,
    startOffset = 0,
    fs?: JournalFs,
  ) {
    this.offset = startOffset;
    this.fs = fs ?? getDefaultFs();
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
    const size = await this.fs.size(this.filePath);
    if (size === null) {
      return {
        lines: [],
        safeOffset: this.offset,
        truncated: false,
        pendingBytes: this.remainder.length,
      };
    }

    // File shrank below where we already are: it was truncated or swapped out.
    // Restart from the beginning rather than reading from a meaningless offset.
    let truncated = false;
    if (size < this.offset + this.remainder.length) {
      truncated = true;
      this.offset = 0;
      this.remainder = new Uint8Array(0);
    }

    const from = this.offset + this.remainder.length;
    if (size <= from) {
      return { lines: [], safeOffset: this.offset, truncated, pendingBytes: this.remainder.length };
    }

    const chunk = await this.fs.readRange(this.filePath, from, size - from);
    const combined = concat(this.remainder, chunk);

    const lines: TailedLine[] = [];
    let cursor = 0;

    for (;;) {
      const nl = indexOfByte(combined, LF, cursor);
      if (nl === -1) break;

      let end = nl;
      if (end > cursor && combined[end - 1] === CR) end -= 1; // strip CRLF's CR

      lines.push({
        line: decoder.decode(combined.subarray(cursor, end)),
        byteOffset: this.offset + cursor,
      });
      cursor = nl + 1;
    }

    // Anything after the last newline is an incomplete write. Hold it; do not emit,
    // and do not let the persisted offset move past it.
    this.remainder = combined.slice(cursor);
    this.offset += cursor;

    return { lines, safeOffset: this.offset, truncated, pendingBytes: this.remainder.length };
  }

  /** Discard buffered state and restart at `offset`. Used on rotation. */
  reset(offset = 0): void {
    this.offset = offset;
    this.remainder = new Uint8Array(0);
  }
}
