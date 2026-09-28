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
import { applyEvent, initialState } from '../src/state.js';
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

  /* ------------------------------------------------- material trader kinds */

  it('learns material trader kinds, and they stay stable per station', async () => {
    // The design rests on two measured claims. This test is what stops either
    // silently becoming false after a game update.
    const files = await listJournalFiles(DIR);
    const all = files.filter((f) => f.sizeBytes > 0);

    const typesByMarket = new Map<number, Set<string>>();
    for (const f of all) {
      const r = await replayFile(f.fullPath);
      for (const e of r.events) {
        if (e.kind !== 'trader-identity') continue;
        const d = e.data as { marketId: unknown; traderType: unknown };
        if (typeof d.marketId !== 'number' || typeof d.traderType !== 'string') continue;
        const set = typesByMarket.get(d.marketId) ?? new Set<string>();
        set.add(d.traderType);
        typesByMarket.set(d.marketId, set);
      }
    }

    // A commander who has never traded has nothing to assert about.
    if (typesByMarket.size === 0) return;

    for (const [marketId, types] of typesByMarket) {
      // Claim 1: only the three known kinds are ever reported. A fourth would mean
      // learnTrader is silently dropping a real trader kind.
      for (const t of types) expect(['encoded', 'raw', 'manufactured']).toContain(t);
      // Claim 2: a station's kind is stable. Remembering it across restarts is only
      // sound if it does not change, so this asserts it rather than assuming it.
      expect(types.size, `MarketID ${marketId} reported ${[...types].join(', ')}`).toBe(1);
    }
  });

  it('cannot determine a trader kind from StationServices alone', async () => {
    // The premise of the whole feature: the docking event never names the kind. If
    // a game update ever starts reporting it, this test fails and the much simpler
    // approach becomes available.
    const files = await listJournalFiles(DIR);
    const recent = files.filter((f) => f.sizeBytes > 0).slice(-40);

    let traderStations = 0;
    for (const f of recent) {
      const r = await replayFile(f.fullPath);
      for (const e of r.events) {
        if (e.kind !== 'docked' && e.kind !== 'location') continue;
        const raw = e.source.raw as Record<string, unknown>;
        const services = raw['StationServices'];
        if (!Array.isArray(services) || !services.includes('materialtrader')) continue;
        traderStations += 1;

        // No service token distinguishes a kind: the list carries the bare token
        // and nothing more specific alongside it.
        const traderTokens = services.filter((t) => /materialtrader/i.test(String(t)));
        expect(traderTokens).toEqual(['materialtrader']);
        // And no sibling field names one either.
        expect(
          Object.keys(raw).some((k) => /tradertype/i.test(k)),
          'a docking event now names the trader kind',
        ).toBe(false);
      }
    }

    expect(traderStations).toBeGreaterThanOrEqual(0);
  });

  /* ---------------------------------------------------- exobiology holdings */

  it('keeps the confirmed-unsold exobiology count coherent across all history', async () => {
    // Replays the whole corpus through the real reducer. The count is documented as
    // a lower bound, so the properties that must hold are that it never goes
    // negative and never exceeds the number of completed scans that could produce
    // it -- either would mean the gating is arithmetically unsound.
    const files = await listJournalFiles(DIR);
    const all = files.filter((f) => f.sizeBytes > 0);

    const state = initialState();
    let analysed = 0;
    let sold = 0;
    let peak = 0;

    for (const f of all) {
      const r = await replayFile(f.fullPath);
      for (const e of r.events) {
        if (e.kind === 'organic-scan') {
          const d = e.data as { scanType: unknown };
          if (d.scanType === 'Analyse') analysed += 1;
        } else if (e.kind === 'organic-sold') {
          const d = e.data as { sold: unknown };
          if (typeof d.sold === 'number') sold += d.sold;
        }
        applyEvent(state, e);
        expect(state.exobiologyToSell).toBeGreaterThanOrEqual(0);
        peak = Math.max(peak, state.exobiologyToSell);
      }
    }

    // A commander who has never completed a scan has nothing to assert about.
    if (analysed === 0) return;

    // The count can only ever have come from completed scans.
    expect(peak).toBeLessThanOrEqual(analysed);
    expect(state.exobiologyToSell).toBeLessThanOrEqual(Math.max(0, analysed - sold));
  });

  it('finds no event that states exobiology holdings outright', async () => {
    // The premise of deriving the count. Backpack is suit inventory and Materials is
    // engineering stock; if either ever grows an organic section, the derivation
    // should be replaced by reading it directly.
    const files = await listJournalFiles(DIR);
    const recent = files.filter((f) => f.sizeBytes > 0).slice(-40);

    for (const f of recent) {
      const r = await replayFile(f.fullPath);
      for (const e of r.events) {
        const name = e.source.event;
        if (name !== 'Backpack' && name !== 'Materials') continue;
        const raw = e.source.raw as Record<string, unknown>;
        const keys = Object.keys(raw).filter((k) => k !== 'event' && k !== 'timestamp');
        for (const k of keys) {
          expect(/organic|bio|exobio/i.test(k), `${name} now reports ${k}`).toBe(false);
        }
      }
    }
  });
});
