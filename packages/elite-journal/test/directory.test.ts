import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listJournalFiles,
  parseJournalFileName,
  resolveJournalDirectory,
  selectActiveJournal,
} from '../src/directory.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'edfm-dir-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseJournalFileName', () => {
  it('parses the modern filename form', () => {
    expect(parseJournalFileName('Journal.2026-09-01T082623.01.log')).toEqual({
      sortKey: Date.UTC(2026, 8, 1, 8, 26, 23),
      part: 1,
    });
  });

  it('parses the legacy filename form', () => {
    expect(parseJournalFileName('Journal.180101120000.01.log')).toEqual({
      sortKey: Date.UTC(2018, 0, 1, 12, 0, 0),
      part: 1,
    });
  });

  it('rejects non-journal files', () => {
    expect(parseJournalFileName('Status.json')).toBeNull();
    expect(parseJournalFileName('Market.json')).toBeNull();
    expect(parseJournalFileName('edmc-journal-lock.txt')).toBeNull();
  });
});

describe('listJournalFiles', () => {
  it('orders by filename timestamp and part, not mtime', async () => {
    // Written newest-first so mtime order is the reverse of true chronology.
    await writeFile(join(dir, 'Journal.2026-09-01T100000.01.log'), 'c\r\n');
    await writeFile(join(dir, 'Journal.2026-08-01T100000.01.log'), 'b\r\n');
    await writeFile(join(dir, 'Journal.2026-07-01T100000.01.log'), 'a\r\n');

    const files = await listJournalFiles(dir);
    expect(files.map((f) => f.fileName)).toEqual([
      'Journal.2026-07-01T100000.01.log',
      'Journal.2026-08-01T100000.01.log',
      'Journal.2026-09-01T100000.01.log',
    ]);
  });

  it('orders continuation parts after their first part', async () => {
    await writeFile(join(dir, 'Journal.2026-09-01T100000.02.log'), 'b\r\n');
    await writeFile(join(dir, 'Journal.2026-09-01T100000.01.log'), 'a\r\n');
    const files = await listJournalFiles(dir);
    expect(files.map((f) => f.part)).toEqual([1, 2]);
  });

  it('ignores non-journal files in the directory', async () => {
    await writeFile(join(dir, 'Status.json'), '{}');
    await writeFile(join(dir, 'Journal.2026-09-01T100000.01.log'), 'a\r\n');
    expect((await listJournalFiles(dir)).length).toBe(1);
  });

  it('returns empty for a missing directory rather than throwing', async () => {
    expect(await listJournalFiles(join(dir, 'nope'))).toEqual([]);
  });
});

describe('selectActiveJournal', () => {
  it('skips zero-byte journals, which really do occur', async () => {
    // Mirrors Journal.2026-07-28T190946.01.log in the validation corpus.
    await writeFile(join(dir, 'Journal.2026-09-01T100000.01.log'), '');
    await writeFile(join(dir, 'Journal.2026-08-31T100000.01.log'), 'real\r\n');

    const files = await listJournalFiles(dir);
    expect(files.length).toBe(2); // still listed, so rotation can see it
    expect(selectActiveJournal(files)?.fileName).toBe('Journal.2026-08-31T100000.01.log');
  });

  it('returns null when every journal is empty', async () => {
    await writeFile(join(dir, 'Journal.2026-09-01T100000.01.log'), '');
    expect(selectActiveJournal(await listJournalFiles(dir))).toBeNull();
  });

  it('returns null for an empty directory', () => {
    expect(selectActiveJournal([])).toBeNull();
  });
});

describe('resolveJournalDirectory', () => {
  const exists = (ok: string[]) => async (p: string) => ok.includes(p);

  it('prefers a manual override', async () => {
    const r = await resolveJournalDirectory({ manualOverride: dir, exists: exists([dir]) });
    expect(r.strategy).toBe('manual-override');
    expect(r.directory).toBe(dir);
  });

  it('reports a manual override that does not exist instead of silently falling back', async () => {
    const r = await resolveJournalDirectory({ manualOverride: '/bogus', exists: exists([]) });
    expect(r.strategy).toBe('manual-override');
    expect(r.directory).toBeNull();
    expect(r.detail).toContain('does not exist');
  });

  it('uses the injected Saved Games known folder', async () => {
    const saved = join('C:', 'Users', 'Someone', 'Saved Games');
    const expected = join(saved, 'Frontier Developments', 'Elite Dangerous');
    const r = await resolveJournalDirectory({ savedGamesPath: saved, exists: exists([expected]) });
    expect(r.strategy).toBe('known-folder');
    expect(r.directory).toBe(expected);
  });

  it('reports failure clearly when nothing resolves', async () => {
    const r = await resolveJournalDirectory({ exists: exists([]) });
    expect(r.strategy).toBe('none');
    expect(r.directory).toBeNull();
  });
});
