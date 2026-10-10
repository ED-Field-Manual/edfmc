/**
 * Context as the app presents it: the startup checkpoint, the spoiler-filtered
 * projection both surfaces read, and "now" versus "last session".
 *
 * The checkpoint test runs the app's real migrations against an in-memory
 * SQLite database, so the query is checked against the real table.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JournalSessionContext,
  applyEvent,
  normalize,
  parseLine,
  type CommanderState,
} from '@edfm/elite-journal';
import { BUNDLED_RULES, type ContextRuleSet } from '@edfm/context';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(), openPath: vi.fn(), revealItemInDir: vi.fn() }));

import { Companion } from '../src/lib/companion';
import { guideWhen } from '../src/Guides';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

type Internals = {
  db: unknown;
  state: CommanderState;
  connection: string;
  gameWindow: boolean | null;
  overlayEnabled: boolean;
  resolver: { observe: (e: unknown, s: CommanderState) => boolean };
  loadCheckpoint: () => Promise<{ sourceFile: string; byteOffset: number } | null>;
  pushOverlayState: () => void;
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

/* ------------------------------------------------------------ checkpoint */

function migratedDb() {
  const db = new DatabaseSync(':memory:');
  const source = readFileSync(join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const pattern = /version:\s*(\d+),\s*description:\s*"[^"]*",\s*sql:\s*r#"([\s\S]*?)"#,/g;
  const all: Array<{ v: number; sql: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) all.push({ v: Number(m[1]), sql: m[2]! });
  for (const x of all.sort((a, b) => a.v - b.v)) db.exec(x.sql);
  // The plugin-sql surface the companion uses: `$1` placeholders.
  const adapter = {
    select: async (sql: string, params: unknown[] = []) =>
      db.prepare(sql.replace(/\$\d+/g, '?')).all(...(params as never[])),
    execute: async (sql: string, params: unknown[] = []) =>
      db.prepare(sql.replace(/\$\d+/g, '?')).run(...(params as never[])),
  };
  return { db, adapter };
}

describe('startup checkpoint', () => {
  it('resumes from where the reader last was, not from the stale default row', async () => {
    const { db, adapter } = migratedDb();
    const put = db.prepare(
      `INSERT INTO journal_checkpoint (scope, source_file, byte_offset, last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // The shapes found in a real install: a `default` row written once, before
    // any commander was known, and per-commander rows kept current since.
    put.run('default', 'Journal.2026-09-02T215100.01.log', 161, null, '2026-09-03T02:52:03.994Z');
    put.run('fid:F0000002', 'Journal.2026-09-02T000359.01.log', 44624, null, '2026-09-02T18:54:05.041Z');
    put.run('fid:F0000001', 'Journal.2026-10-09T183417.01.log', 258283, null, '2026-10-10T01:42:11.849Z');

    const c = new Companion() as unknown as Internals;
    c.db = adapter;
    const cp = await c.loadCheckpoint();
    expect(cp).toMatchObject({ sourceFile: 'Journal.2026-10-09T183417.01.log', byteOffset: 258283 });
  });

  it('a fresh install has no checkpoint', async () => {
    const { adapter } = migratedDb();
    const c = new Companion() as unknown as Internals;
    c.db = adapter;
    expect(await c.loadCheckpoint()).toBeNull();
  });
});

/* ------------------------------------------------------- the projection */

const DOCKED_FC = (at: string) =>
  `{ "timestamp":"${at}", "event":"Docked", "StationName":"HBN-TXN", "StationType":"FleetCarrier", "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe KO-G c24-7", "SystemAddress":2008870359762, "MarketID":3703420416, "StationServices":[ "dock", "carriermanagement", "carrierfuel" ], "StationEconomies":[] }`;
const SHUTDOWN = (at: string) => `{ "timestamp":"${at}", "event":"Shutdown" }`;

function feed(c: Internals, line: string): void {
  const r = parseLine(line, 'Journal.2026-10-09T180000.01.log', 1, new JournalSessionContext());
  if (!r?.ok) throw new Error('fixture failed to parse');
  const e = normalize(r.event);
  applyEvent(c.state, e);
  c.resolver.observe(e, c.state);
}

/** A plugin-style rule whose second link is gated on a body scan nobody has made. */
const GATED: ContextRuleSet = {
  ...BUNDLED_RULES,
  rules: [
    {
      id: 'example/carrier-secret',
      title: 'Carrier secrets',
      when: { kind: 'state', path: 'stationType', op: 'eq', value: 'FleetCarrier' },
      priority: 99,
      ttlSeconds: 300,
      resources: [
        { label: 'Fleet Carriers', page: 'Fleet Carriers' },
        { label: 'Hidden Species', page: 'Exobiology', requires: { kind: 'species', species: 'Secretus' } },
      ],
    },
  ],
};

function overlayPayload(): { context: { resources: Array<{ label: string }> } | null; alsoActive: unknown[] } {
  const call = invoke.mock.calls.findLast(([cmd]) => cmd === 'overlay_push_state');
  return (call![1] as { payload: never }).payload;
}

describe('one spoiler policy for every surface', () => {
  it('a gated link is missing from the main window and from the overlay alike', () => {
    const c = new Companion() as unknown as Internals & Companion;
    c.setContextRules(GATED);
    c.connection = 'watching';
    c.gameWindow = true;
    feed(c, DOCKED_FC(new Date().toISOString()));

    const main = c.snapshot().contexts.find((x) => x.rule.id === 'example/carrier-secret')!;
    expect(main.rule.resources.map((r) => r.label)).toEqual(['Fleet Carriers']);

    c.pushOverlayState();
    expect(overlayPayload().context?.resources.map((r) => r.label)).toEqual(['Fleet Carriers']);
  });
});

describe('now versus last session', () => {
  it('while the game runs, a station guide is current and reaches the overlay', () => {
    const c = new Companion() as unknown as Internals & Companion;
    c.connection = 'watching';
    c.gameWindow = true;
    feed(c, DOCKED_FC(new Date().toISOString()));

    expect(c.snapshot().contexts.map((x) => [x.rule.id, x.timing])).toEqual([['fleet-carrier', 'current']]);
    c.pushOverlayState();
    expect(overlayPayload().context).not.toBeNull();
  });

  it('after Shutdown it is last session, and the overlay shows nothing from it', () => {
    const c = new Companion() as unknown as Internals & Companion;
    c.connection = 'watching';
    c.gameWindow = true; // even with a window back, until the next LoadGame
    feed(c, DOCKED_FC(new Date(Date.now() - 60_000).toISOString()));
    feed(c, SHUTDOWN(new Date().toISOString()));

    expect(c.snapshot().contexts.map((x) => [x.rule.id, x.timing])).toEqual([['fleet-carrier', 'last-session']]);
    c.pushOverlayState();
    expect(overlayPayload().context).toBeNull();
  });

  it('a crash (window gone, no Shutdown) is last session too', () => {
    const c = new Companion() as unknown as Internals & Companion;
    c.connection = 'watching';
    c.gameWindow = false;
    feed(c, DOCKED_FC(new Date().toISOString()));
    expect(c.snapshot().contexts[0]?.timing).toBe('last-session');
  });

  it('the Diagnostics page carries the engine details the guides page leaves out', () => {
    const c = new Companion() as unknown as Internals & Companion;
    c.connection = 'watching';
    c.gameWindow = true;
    feed(c, DOCKED_FC(new Date().toISOString()));
    const d = c.snapshot().diagnostics.context;
    expect(d.ruleSetSource).toBe('bundled');
    expect(d.active).toEqual([
      expect.objectContaining({ ruleId: 'fleet-carrier', scope: 'state', triggerEvent: 'Docked', expiresAt: null }),
    ]);
  });
});

describe('when a guide is labelled', () => {
  const now = Date.parse('2026-10-09T18:30:00Z');
  it('in words', () => {
    expect(guideWhen({ timing: 'current', matchedAt: now }, now)).toBe('Now');
    expect(guideWhen({ timing: 'last-session', matchedAt: now }, now)).toBe('Last session');
    expect(guideWhen({ timing: 'recent', matchedAt: now - 20_000 }, now)).toBe('Just now');
    expect(guideWhen({ timing: 'recent', matchedAt: now - 4 * 60_000 }, now)).toBe('4 min ago');
    expect(guideWhen({ timing: 'recent', matchedAt: now - 90 * 60_000 }, now)).toBe('1 h ago');
  });
});
