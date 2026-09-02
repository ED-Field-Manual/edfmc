import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JournalEngine, replayFile } from '../src/engine.js';
import type { IngestFailure, JournalCheckpoint, NormalizedEvent } from '../src/types.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'edfm-engine-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const HEADER = (v = '4.4.0.3') =>
  `{ "timestamp":"2026-09-01T13:26:17Z", "event":"Fileheader", "part":1, "language":"English/UK", "Odyssey":true, "gameversion":"${v}", "build":"r330683/r0 " }\r\n`;
const CMDR = '{ "timestamp":"2026-09-01T13:27:33Z", "event":"Commander", "FID":"F0000000", "Name":"Sythan" }\r\n';
const JUMP = (sys: string) =>
  `{ "timestamp":"2026-09-01T13:30:00Z", "event":"FSDJump", "StarSystem":"${sys}", "SystemAddress":1, "StarPos":[1.0,2.0,3.0], "Body":"${sys} A", "BodyID":1, "BodyType":"Star", "JumpDist":10.0, "FuelUsed":1.0, "FuelLevel":30.0, "Population":0, "SystemAllegiance":"", "SystemEconomy":"$economy_None;", "SystemEconomy_Localised":"None", "SystemSecondEconomy":"$economy_None;", "SystemSecondEconomy_Localised":"None", "SystemGovernment":"$government_None;", "SystemGovernment_Localised":"None", "SystemSecurity":"$SYSTEM_SECURITY_low;", "SystemSecurity_Localised":"Low", "Taxi":false, "Multicrew":false }\r\n`;

interface Harness {
  engine: JournalEngine;
  events: NormalizedEvent[];
  failures: IngestFailure[];
  checkpoints: JournalCheckpoint[];
  rotations: Array<[string | null, string]>;
}

function makeEngine(checkpoint: JournalCheckpoint | null = null, startAtEnd = false): Harness {
  const events: NormalizedEvent[] = [];
  const failures: IngestFailure[] = [];
  const checkpoints: JournalCheckpoint[] = [];
  const rotations: Array<[string | null, string]> = [];
  const engine = new JournalEngine({
    directory: dir,
    checkpoint,
    startAtEndWhenFresh: startAtEnd,
    safetyPollMs: 3_600_000, // never fires during a test; we pump manually
    useWatcher: false, // deterministic ordering: only explicit pumps drive the engine
    onEvent: (e) => events.push(e),
    onFailure: (f) => failures.push(f),
    onCheckpoint: (c) => checkpoints.push(c),
    onRotate: (from, to) => rotations.push([from, to]),
  });
  return { engine, events, failures, checkpoints, rotations };
}

describe('JournalEngine', () => {
  it('starts cleanly against an empty directory', async () => {
    const h = makeEngine();
    await h.engine.start();
    h.engine.stop();
    expect(h.events).toEqual([]);
    expect(h.engine.currentFile).toBeNull();
  });

  it('reads a journal Elite wrote before the app launched', async () => {
    // §35: "application starts after Elite".
    await writeFile(join(dir, 'Journal.2026-09-01T100000.01.log'), HEADER() + CMDR + JUMP('Sol'));
    const h = makeEngine();
    await h.engine.start();
    h.engine.stop();

    expect(h.events.map((e) => e.source.event)).toEqual(['Fileheader', 'Commander', 'FSDJump']);
    expect(h.events[2]!.source.provenance.commander).toBe('Sythan');
    expect(h.events[2]!.source.provenance.gameVersion).toBe('4.4.0.3');
  });

  it('picks up a journal that appears after start', async () => {
    // §35: "application starts before Elite".
    const h = makeEngine();
    await h.engine.start();
    expect(h.events).toEqual([]);

    await writeFile(join(dir, 'Journal.2026-09-01T100000.01.log'), HEADER() + CMDR);
    await h.engine.pump();
    h.engine.stop();

    expect(h.events.map((e) => e.source.event)).toEqual(['Fileheader', 'Commander']);
  });

  it('follows appends without re-emitting earlier events', async () => {
    const f = join(dir, 'Journal.2026-09-01T100000.01.log');
    await writeFile(f, HEADER());
    const h = makeEngine();
    await h.engine.start();
    expect(h.events).toHaveLength(1);

    await appendFile(f, CMDR);
    await h.engine.pump();
    h.engine.stop();

    expect(h.events).toHaveLength(2);
    expect(new Set(h.events.map((e) => e.source.provenance.eventId)).size).toBe(2);
  });

  it('rotates to a new journal and drains the old one first', async () => {
    const older = join(dir, 'Journal.2026-09-01T100000.01.log');
    await writeFile(older, HEADER());
    const h = makeEngine();
    await h.engine.start();

    // Elite writes a final line to the old journal, then opens a new one.
    await appendFile(older, JUMP('Sol'));
    await writeFile(join(dir, 'Journal.2026-09-01T110000.01.log'), HEADER() + CMDR);
    await h.engine.pump();
    h.engine.stop();

    const names = h.events.map((e) => e.source.event);
    expect(names).toEqual(['Fileheader', 'FSDJump', 'Fileheader', 'Commander']);
    expect(h.rotations).toHaveLength(1);
    expect(h.engine.currentFile).toBe('Journal.2026-09-01T110000.01.log');
  });

  it('does not rotate onto a zero-byte journal', async () => {
    await writeFile(join(dir, 'Journal.2026-09-01T100000.01.log'), HEADER() + CMDR);
    const h = makeEngine();
    await h.engine.start();

    // Two of these genuinely exist in the validation corpus.
    await writeFile(join(dir, 'Journal.2026-09-01T110000.01.log'), '');
    await h.engine.pump();
    h.engine.stop();

    expect(h.engine.currentFile).toBe('Journal.2026-09-01T100000.01.log');
    expect(h.rotations).toHaveLength(0);
  });

  it('resumes from a checkpoint without duplicating events', async () => {
    // §35: "restart does not duplicate state".
    const f = join(dir, 'Journal.2026-09-01T100000.01.log');
    await writeFile(f, HEADER() + CMDR);

    const first = makeEngine();
    await first.engine.start();
    first.engine.stop();
    expect(first.events).toHaveLength(2);
    const saved = first.checkpoints.at(-1)!;

    // Game keeps running; app restarts.
    await appendFile(f, JUMP('Sol'));
    const second = makeEngine(saved);
    await second.engine.start();
    second.engine.stop();

    expect(second.events.map((e) => e.source.event)).toEqual(['FSDJump']);

    const firstIds = first.events.map((e) => e.source.provenance.eventId);
    const secondIds = second.events.map((e) => e.source.provenance.eventId);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
  });

  it('falls forward to the newest journal when the checkpointed file is gone', async () => {
    await writeFile(join(dir, 'Journal.2026-09-02T100000.01.log'), HEADER() + CMDR);
    const stale: JournalCheckpoint = {
      sourceFile: 'Journal.2026-01-01T000000.01.log',
      byteOffset: 999999,
      lastEventId: null,
      updatedAt: new Date().toISOString(),
    };
    const h = makeEngine(stale);
    await h.engine.start();
    h.engine.stop();

    expect(h.engine.currentFile).toBe('Journal.2026-09-02T100000.01.log');
    expect(h.events).toHaveLength(2);
  });

  it('ignores a checkpoint whose offset is beyond the current file size', async () => {
    const f = join(dir, 'Journal.2026-09-01T100000.01.log');
    await writeFile(f, HEADER());
    const bogus: JournalCheckpoint = {
      sourceFile: 'Journal.2026-09-01T100000.01.log',
      byteOffset: 10_000_000,
      lastEventId: null,
      updatedAt: new Date().toISOString(),
    };
    const h = makeEngine(bogus);
    await h.engine.start();
    h.engine.stop();
    expect(h.events).toHaveLength(1); // re-read from the start, not from garbage
  });

  it('can skip pre-existing history when starting fresh mid-session', async () => {
    const f = join(dir, 'Journal.2026-09-01T100000.01.log');
    await writeFile(f, HEADER() + CMDR);
    const h = makeEngine(null, true);
    await h.engine.start();
    expect(h.events).toHaveLength(0);

    await appendFile(f, JUMP('Sol'));
    await h.engine.pump();
    h.engine.stop();
    expect(h.events.map((e) => e.source.event)).toEqual(['FSDJump']);
  });

  it('counts a malformed line without stopping the pipeline', async () => {
    await writeFile(
      join(dir, 'Journal.2026-09-01T100000.01.log'),
      HEADER() + '{ "event": broken\r\n' + CMDR,
    );
    const h = makeEngine();
    await h.engine.start();
    h.engine.stop();

    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]!.reason).toBe('malformed-json');
    expect(h.events.map((e) => e.source.event)).toEqual(['Fileheader', 'Commander']);
    expect(h.engine.stats.malformedJson).toBe(1);
  });

  it('does not emit a half-written final line', async () => {
    const f = join(dir, 'Journal.2026-09-01T100000.01.log');
    await writeFile(f, HEADER() + '{ "timestamp":"2026-09-01T13:28:00Z", "eve');
    const h = makeEngine();
    await h.engine.start();
    expect(h.events).toHaveLength(1);
    expect(h.failures).toHaveLength(0); // not treated as malformed

    await appendFile(f, 'nt":"Shutdown" }\r\n');
    await h.engine.pump();
    h.engine.stop();
    expect(h.events.map((e) => e.source.event)).toEqual(['Fileheader', 'Shutdown']);
  });

  it('tracks unknown event kinds in stats without failing', async () => {
    await writeFile(
      join(dir, 'Journal.2026-09-01T100000.01.log'),
      HEADER() + '{ "timestamp":"2026-09-01T13:28:00Z", "event":"BrandNewThing" }\r\n',
    );
    const h = makeEngine();
    await h.engine.start();
    h.engine.stop();
    expect(h.engine.stats.unknownEventKinds['BrandNewThing']).toBe(1);
    expect(h.events).toHaveLength(2);
  });
});

describe('replayFile', () => {
  it('produces the same events and ids as live ingestion', async () => {
    const f = join(dir, 'Journal.2026-09-01T100000.01.log');
    await writeFile(f, HEADER() + CMDR + JUMP('Sol'));

    const live = makeEngine();
    await live.engine.start();
    live.engine.stop();

    const replayed = await replayFile(f);

    expect(replayed.events.map((e) => e.source.provenance.eventId)).toEqual(
      live.events.map((e) => e.source.provenance.eventId),
    );
    expect(replayed.stats.eventsEmitted).toBe(live.engine.stats.eventsEmitted);
  });

  it('reports failures separately from events', async () => {
    const f = join(dir, 'Journal.2026-09-01T100000.01.log');
    await writeFile(f, HEADER() + 'not json at all\r\n' + CMDR);
    const r = await replayFile(f);
    expect(r.events).toHaveLength(2);
    expect(r.failures).toHaveLength(1);
  });

  it('handles a zero-byte journal', async () => {
    const f = join(dir, 'Journal.2026-09-01T100000.01.log');
    await writeFile(f, '');
    const r = await replayFile(f);
    expect(r.events).toEqual([]);
    expect(r.failures).toEqual([]);
  });
});
