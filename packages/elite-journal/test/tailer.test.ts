import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileTailer } from '../src/tailer.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'edfm-tailer-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileTailer', () => {
  it('reads complete CRLF lines and reports a safe offset', async () => {
    const f = join(dir, 'a.log');
    await writeFile(f, 'one\r\ntwo\r\n');
    const t = new FileTailer(f);
    const r = await t.read();

    expect(r.lines.map((l) => l.line)).toEqual(['one', 'two']);
    expect(r.lines.map((l) => l.byteOffset)).toEqual([0, 5]);
    expect(r.safeOffset).toBe(10);
    expect(r.pendingBytes).toBe(0);
  });

  it('handles bare LF as well as CRLF', async () => {
    const f = join(dir, 'a.log');
    await writeFile(f, 'one\ntwo\n');
    const r = await new FileTailer(f).read();
    expect(r.lines.map((l) => l.line)).toEqual(['one', 'two']);
  });

  it('never emits a partially written trailing line', async () => {
    const f = join(dir, 'a.log');
    await writeFile(f, 'complete\r\nincomp');
    const t = new FileTailer(f);
    const first = await t.read();

    expect(first.lines.map((l) => l.line)).toEqual(['complete']);
    expect(first.safeOffset).toBe(10); // NOT past the fragment
    expect(first.pendingBytes).toBe(6);

    // The rest of the line arrives.
    await appendFile(f, 'lete\r\n');
    const second = await t.read();
    expect(second.lines.map((l) => l.line)).toEqual(['incomplete']);
    expect(second.lines[0]!.byteOffset).toBe(10);
  });

  it('does not split a multi-byte UTF-8 sequence across reads', async () => {
    const f = join(dir, 'a.log');
    // U+00E9 is two bytes; write only its first byte, then the rest.
    const full = Buffer.from('café\r\n', 'utf8');
    await writeFile(f, full.subarray(0, full.length - 3)); // cuts mid-'é'
    const t = new FileTailer(f);
    expect((await t.read()).lines).toEqual([]);

    await appendFile(f, full.subarray(full.length - 3));
    const r = await t.read();
    expect(r.lines.map((l) => l.line)).toEqual(['café']);
  });

  it('detects truncation and restarts from zero', async () => {
    const f = join(dir, 'a.log');
    await writeFile(f, 'aaaa\r\nbbbb\r\n');
    const t = new FileTailer(f);
    await t.read();

    await truncate(f, 0);
    await writeFile(f, 'fresh\r\n');
    const r = await t.read();

    expect(r.truncated).toBe(true);
    expect(r.lines.map((l) => l.line)).toEqual(['fresh']);
  });

  it('returns empty rather than throwing when the file is missing', async () => {
    const r = await new FileTailer(join(dir, 'nope.log')).read();
    expect(r.lines).toEqual([]);
    expect(r.safeOffset).toBe(0);
  });

  it('resumes from a supplied offset without replaying earlier lines', async () => {
    const f = join(dir, 'a.log');
    await writeFile(f, 'first\r\nsecond\r\n');
    const r = await new FileTailer(f, 7).read();
    expect(r.lines.map((l) => l.line)).toEqual(['second']);
  });

  it('snaps forward to the next line when told it started mid-line', async () => {
    // Starting "at the end" uses a size sampled from a directory listing. If Elite
    // was mid-write, that offset lands inside a line; emitting the tail of it would
    // surface as a spurious malformed-JSON failure.
    const f = join(dir, 'a.log');
    await writeFile(f, 'first\r\nsecond\r\n');
    const t = new FileTailer(f, 10, undefined, true); // 10 is inside "second"
    const r = await t.read();

    expect(r.lines).toEqual([]); // the partial "cond" is discarded, not emitted

    await appendFile(f, 'third\r\n');
    const r2 = await t.read();
    expect(r2.lines.map((l) => l.line)).toEqual(['third']);
    expect(r2.lines[0]!.byteOffset).toBe(15);
  });

  it('stays armed when a mid-line start sees no newline yet', async () => {
    const f = join(dir, 'a.log');
    await writeFile(f, 'abcdefgh');
    const t = new FileTailer(f, 2, undefined, true);
    expect((await t.read()).lines).toEqual([]);

    await appendFile(f, '\r\nreal\r\n');
    const r = await t.read();
    expect(r.lines.map((l) => l.line)).toEqual(['real']);
  });

  it('treats a zero start offset as a line boundary even when flagged', async () => {
    const f = join(dir, 'a.log');
    await writeFile(f, 'first\r\n');
    const r = await new FileTailer(f, 0, undefined, true).read();
    expect(r.lines.map((l) => l.line)).toEqual(['first']);
  });

  it('reads an empty file without producing anything', async () => {
    const f = join(dir, 'empty.log');
    await writeFile(f, '');
    const r = await new FileTailer(f).read();
    expect(r.lines).toEqual([]);
    expect(r.safeOffset).toBe(0);
  });
});
