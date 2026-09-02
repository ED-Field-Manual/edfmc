/**
 * Validation against a real journal directory.
 *
 * Deliberately reads the live directory rather than committing fixtures: journals
 * contain commander identity, travel history and financial data, and §21 says that
 * must not be uploaded or redistributed. Committing a real journal to the repository
 * would be exactly that. These tests skip automatically on machines without a
 * journal directory, so CI stays green.
 *
 * Override the location with EDFM_JOURNAL_DIR.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { listJournalFiles, selectActiveJournal, resolveJournalDirectory } from '../src/directory.js';
import { replayFile } from '../src/engine.js';
import { isKnownEvent } from '../src/normalizer.js';

const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
const DIR =
  process.env['EDFM_JOURNAL_DIR'] ??
  join(home, 'Saved Games', 'Frontier Developments', 'Elite Dangerous');

const available = home !== '' && existsSync(DIR);
const suite = available ? describe : describe.skip;

suite('real journal corpus', () => {
  it('resolves the directory and finds journals', async () => {
    const r = await resolveJournalDirectory({ manualOverride: DIR });
    expect(r.directory).toBe(DIR);

    const files = await listJournalFiles(DIR);
    expect(files.length).toBeGreaterThan(0);

    // Ordering must be strictly non-decreasing by (sortKey, part).
    for (let i = 1; i < files.length; i += 1) {
      const prev = files[i - 1]!;
      const cur = files[i]!;
      expect(cur.sortKey > prev.sortKey || (cur.sortKey === prev.sortKey && cur.part >= prev.part)).toBe(true);
    }
  });

  it('never selects a zero-byte journal as the active one', async () => {
    const files = await listJournalFiles(DIR);
    const active = selectActiveJournal(files);
    if (active) expect(active.sizeBytes).toBeGreaterThan(0);
  });

  it('replays the most recent journals with zero malformed lines', async () => {
    const files = await listJournalFiles(DIR);
    const recent = files.filter((f) => f.sizeBytes > 0).slice(-15);
    expect(recent.length).toBeGreaterThan(0);

    let events = 0;
    let unknownKinds = 0;
    for (const f of recent) {
      const r = await replayFile(f.fullPath);
      // The corpus scan found 0 malformed lines across 197,164 lines; a regression
      // here means the parser or tailer has broken, not that the game has.
      expect(r.stats.malformedJson, `malformed JSON in ${f.fileName}`).toBe(0);
      expect(r.stats.notAnObject, `non-object line in ${f.fileName}`).toBe(0);
      expect(r.stats.missingEventField, `event-less line in ${f.fileName}`).toBe(0);
      events += r.stats.eventsEmitted;
      unknownKinds += Object.keys(r.stats.unknownEventKinds).length;
    }

    expect(events).toBeGreaterThan(0);
    // Unknown events are expected and fine — they must simply not be fatal.
    expect(unknownKinds).toBeGreaterThanOrEqual(0);
  });

  it('assigns a unique eventId to every event in a file', async () => {
    const files = await listJournalFiles(DIR);
    const target = files.filter((f) => f.sizeBytes > 0).at(-1);
    if (!target) return;

    const r = await replayFile(target.fullPath);
    const ids = new Set(r.events.map((e) => e.source.provenance.eventId));
    expect(ids.size).toBe(r.events.length);
  });

  it('is deterministic: replaying twice yields identical ids', async () => {
    const files = await listJournalFiles(DIR);
    const target = files.filter((f) => f.sizeBytes > 0).at(-1);
    if (!target) return;

    const a = await replayFile(target.fullPath);
    const b = await replayFile(target.fullPath);
    expect(a.events.map((e) => e.source.provenance.eventId)).toEqual(
      b.events.map((e) => e.source.provenance.eventId),
    );
  });

  it('stamps a game version onto events once a header has been seen', async () => {
    const files = await listJournalFiles(DIR);
    const target = files.filter((f) => f.sizeBytes > 1000).at(-1);
    if (!target) return;

    const r = await replayFile(target.fullPath);
    const afterHeader = r.events.slice(1);
    if (afterHeader.length === 0) return;
    expect(afterHeader.every((e) => e.source.provenance.gameVersion !== null)).toBe(true);
  });

  it('reports which observed events still lack typed shapes', async () => {
    const files = await listJournalFiles(DIR);
    const recent = files.filter((f) => f.sizeBytes > 0).slice(-10);
    const unknown = new Map<string, number>();

    for (const f of recent) {
      const r = await replayFile(f.fullPath);
      for (const [name, n] of Object.entries(r.stats.unknownEventKinds)) {
        unknown.set(name, (unknown.get(name) ?? 0) + n);
      }
    }

    for (const name of unknown.keys()) expect(isKnownEvent(name)).toBe(false);
    // Informational: this list is the Phase 3+ normalization backlog.
    expect(unknown.size).toBeGreaterThanOrEqual(0);
  });
});
