/**
 * Inara end to end inside the app: journal line → queue → request → answer.
 *
 * The database is a real SQLite, built from the migrations in `lib.rs`. Inara
 * is a mocked `invoke('inara_submit')`: no request leaves the machine, and no
 * key or account is involved. The Rust side, which adds the key, has its own
 * tests in `inara.rs`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

import { Companion } from '../src/lib/companion.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const src = readFileSync(join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const pattern = /version:\s*(\d+),\s*description:\s*"[^"]*",\s*sql:\s*r#"([\s\S]*?)"#,/g;
  const all: Array<[number, string]> = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(src)) !== null) all.push([Number(m[1]), m[2]!]);
  for (const [, sql] of all.sort((a, b) => a[0] - b[0])) db.exec(sql);
  return db;
}

/** The plugin-sql surface the companion uses, over node:sqlite. `$n` → `?n`. */
function adapter(db: DatabaseSync) {
  const prep = (sql: string) => db.prepare(sql.replace(/\$(\d+)/g, '?$1'));
  return {
    select: async (sql: string, params: unknown[] = []) => prep(sql).all(...(params as never[])),
    execute: async (sql: string, params: unknown[] = []) => prep(sql).run(...(params as never[])),
  };
}

type Internals = {
  db: unknown;
  discoveryFid: string | null;
  state: Record<string, unknown>;
  integrationState: Record<string, { enabled: boolean; hasCredential: boolean }>;
  inaraConfig: { appAuthorized: boolean; isBeingDeveloped: boolean };
  inaraWrites: Promise<void>;
  scheduleInaraDrain: (ms: number) => void;
  loadInaraState: () => Promise<void>;
  observeForInara: (e: unknown) => void;
  drainInara: (manual: boolean) => Promise<void>;
};

const NOW_ISO = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
let offset = 0;

function line(raw: Record<string, unknown>, fid = 'F1000001') {
  offset += 100;
  return {
    source: {
      event: raw['event'],
      raw,
      provenance: {
        eventId: `Journal.test.log:${offset}`,
        sourceFile: 'Journal.test.log',
        byteOffset: offset,
        timestamp: NOW_ISO,
        timestampMs: Date.parse(NOW_ISO),
        gameVersion: '4.4.1.1',
        build: 'r332841/r0 ',
        odyssey: true,
        part: 1,
        commander: 'Testpilot',
        fid,
      },
    },
  };
}

async function setup(opts: { authorized: boolean }) {
  const db = database();
  const c = new Companion();
  const i = c as unknown as Internals;
  i.db = adapter(db);
  i.discoveryFid = 'F1000001';
  i.state.commander = 'Testpilot';
  i.state.fid = 'F1000001';
  i.integrationState = { ...i.integrationState, inara: { enabled: true, hasCredential: true } };
  i.inaraConfig = { appAuthorized: opts.authorized, isBeingDeveloped: true };
  i.scheduleInaraDrain = () => {}; // drains are driven by the test, not timers
  await i.loadInaraState();
  return { c, i, db };
}

const queue = (db: DatabaseSync) =>
  db
    .prepare(`SELECT id, commander_fid, status, payload FROM integration_queue WHERE integration = 'inara' ORDER BY rowid`)
    .all() as Array<{ id: string; commander_fid: string; status: string; payload: string }>;

const reply = (events: unknown[], header: Record<string, unknown> = { eventStatus: 200 }) => ({
  status: 200,
  body: JSON.stringify({ header, events }),
  transport_error: null,
});

const JUMP = { event: 'FSDJump', Taxi: false, StarSystem: 'Alpha', StarPos: [1, 2, 3], JumpDist: 9.5 };
const RANK = { event: 'Rank', Combat: 4, Trade: 13, Explore: 6, Soldier: 3, Exobiologist: 4, Empire: 0, Federation: 6, CQC: 0 };
const PROGRESS = { event: 'Progress', Combat: 63, Trade: 100, Explore: 55, Soldier: 59, Exobiologist: 22, Empire: 82, Federation: 76, CQC: 0 };

beforeEach(() => {
  invoke.mockReset();
});

describe('awaiting application authorization', () => {
  it('queues nothing and sends nothing, however much is played', async () => {
    const { i, db } = await setup({ authorized: false });
    for (const raw of [RANK, PROGRESS, JUMP]) i.observeForInara(line(raw));
    await i.inaraWrites;
    await i.drainInara(true);
    expect(queue(db)).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('shows the state in words, and Verify is not offered', async () => {
    const { c } = await setup({ authorized: false });
    const view = c.snapshot().inara;
    expect(view.state).toBe('awaiting-app-authorization');
    expect(view.label).toBe('Awaiting application authorization');
    expect(view.mayVerify).toBe(false);
    expect(await view.verify()).toMatch(/not approved/);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('once authorised', () => {
  it('sends a batch with the release flag, the commander, and no key', async () => {
    const { i, db } = await setup({ authorized: true });
    for (const raw of [RANK, PROGRESS, JUMP]) i.observeForInara(line(raw));
    await i.inaraWrites;
    expect(queue(db).map((r) => JSON.parse(r.payload).event.eventName)).toEqual([
      'setCommanderRankPilot',
      'addCommanderTravelFSDJump',
    ]);

    invoke.mockResolvedValueOnce(reply([{ eventCustomID: 1, eventStatus: 200 }, { eventCustomID: 2, eventStatus: 200 }]));
    await i.drainInara(true);

    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0]!;
    expect(command).toBe('inara_submit');
    const submission = (args as { submission: Record<string, unknown> }).submission;
    expect(submission).toMatchObject({
      is_being_developed: true,
      commander_name: 'Testpilot',
      commander_frontier_id: 'F1000001',
    });
    expect(JSON.stringify(submission)).not.toMatch(/apikey|api_key/i);
    expect(queue(db).map((r) => r.status)).toEqual(['accepted', 'accepted']);
  });

  it('does not queue the same snapshot again once Inara has it, nor a re-read line', async () => {
    const { i, db } = await setup({ authorized: true });
    i.observeForInara(line(RANK));
    i.observeForInara(line(PROGRESS));
    await i.inaraWrites;
    invoke.mockResolvedValueOnce(reply([{ eventCustomID: 1, eventStatus: 200 }]));
    await i.drainInara(true);

    // Next login: identical ranks.
    i.observeForInara(line(RANK));
    i.observeForInara(line(PROGRESS));
    await i.inaraWrites;
    expect(queue(db).filter((r) => r.status === 'queued')).toEqual([]);

    // The same journal line read twice (same event id) is one row.
    const jump = line(JUMP);
    i.observeForInara(jump);
    i.observeForInara(jump);
    await i.inaraWrites;
    expect(queue(db).filter((r) => r.status === 'queued')).toHaveLength(1);
  });

  it('stops for good when Inara has not approved the app, and remembers it', async () => {
    const { i, c, db } = await setup({ authorized: true });
    i.observeForInara(line(JUMP));
    await i.inaraWrites;
    invoke.mockResolvedValueOnce(
      reply([], { eventStatus: 400, eventStatusText: 'This application has no access allowed.' }),
    );
    await i.drainInara(true);
    expect(c.snapshot().inara.state).toBe('awaiting-app-authorization');
    // Rows are kept, untouched: Inara cancelled the batch.
    expect(queue(db).map((r) => r.status)).toEqual(['queued']);

    await i.drainInara(true);
    expect(invoke).toHaveBeenCalledTimes(1);

    // And across a restart: the condition is read back from the database.
    const again = new Companion() as unknown as Internals;
    again.db = adapter(db);
    again.discoveryFid = 'F1000001';
    await again.loadInaraState();
    expect((again as unknown as { inaraCondition: string }).inaraCondition).toBe('app-not-allowed');
  });

  it('stops on a refused key, without counting it against the rows', async () => {
    const { i, c, db } = await setup({ authorized: true });
    i.observeForInara(line(JUMP));
    await i.inaraWrites;
    invoke.mockResolvedValueOnce(reply([], { eventStatus: 400, eventStatusText: 'Invalid API key.' }));
    await i.drainInara(true);
    expect(c.snapshot().inara.state).toBe('authentication-failed');
    expect(
      (db.prepare(`SELECT attempts FROM integration_queue`).get() as { attempts: number }).attempts,
    ).toBe(0);
    await i.drainInara(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('backs off when Inara cannot be reached', async () => {
    const { i, c, db } = await setup({ authorized: true });
    i.observeForInara(line(JUMP));
    await i.inaraWrites;
    invoke.mockResolvedValueOnce({ status: 0, body: '', transport_error: 'timeout' });
    await i.drainInara(true);
    const row = db.prepare(`SELECT status, attempts, next_attempt_at FROM integration_queue`).get() as {
      status: string;
      attempts: number;
      next_attempt_at: string;
    };
    expect(row).toMatchObject({ status: 'retryable', attempts: 1 });
    expect(Date.parse(row.next_attempt_at)).toBeGreaterThan(Date.now());
    expect(c.snapshot().inara.state).toBe('temporarily-unavailable');
  });

  it('switching off stops sending immediately', async () => {
    const { i, c } = await setup({ authorized: true });
    i.observeForInara(line(JUMP));
    await i.inaraWrites;
    await c.setIntegrationEnabled('inara', false);
    await i.drainInara(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('never sends one commander’s rows under another', async () => {
    const { i, db } = await setup({ authorized: true });
    // A row that belongs to someone else, as a commander switch could leave.
    db.prepare(
      `INSERT INTO integration_queue (id, integration, commander_fid, status, payload, attempts, created_at, updated_at)
       VALUES ('other', 'inara', 'F2000002', 'queued', ?, 0, '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z')`,
    ).run(
      JSON.stringify({
        v: 1,
        event: { eventName: 'addCommanderTravelFSDJump', eventTimestamp: NOW_ISO, eventData: { starsystemName: 'Theirs' } },
        category: 'travel',
        coalesceKey: null,
        fingerprint: 'x',
      }),
    );
    // A line attributed to the other commander is not queued under this one.
    i.observeForInara(line(JUMP, 'F2000002'));
    await i.inaraWrites;
    await i.drainInara(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(queue(db).map((r) => r.commander_fid)).toEqual(['F2000002']);
  });

  it('drops Legacy and beta lines before the queue', async () => {
    const { i, db } = await setup({ authorized: true });
    const legacy = line(JUMP);
    (legacy.source.provenance as { gameVersion: string }).gameVersion = '3.8.0.407';
    const beta = line(JUMP);
    (beta.source.provenance as { gameVersion: string }).gameVersion = '4.5.0.0 Beta';
    i.observeForInara(legacy);
    i.observeForInara(beta);
    await i.inaraWrites;
    expect(queue(db)).toEqual([]);
  });

  it('a kind switched off is not queued, and its waiting items are withdrawn', async () => {
    const { i, c, db } = await setup({ authorized: true });
    i.observeForInara(line(JUMP));
    await i.inaraWrites;
    expect(queue(db)).toHaveLength(1);
    await c.snapshot().inara.setCategory('travel', false);
    expect(queue(db)).toEqual([]);
    i.observeForInara(line(JUMP));
    await i.inaraWrites;
    expect(queue(db)).toEqual([]);
  });

  it('Verify is Connected only on Inara’s word, and caches the profile', async () => {
    const { c } = await setup({ authorized: true });
    invoke.mockResolvedValueOnce(
      reply([
        {
          eventCustomID: 1,
          eventStatus: 200,
          eventData: { userName: 'Tester', commanderName: 'Testpilot', inaraURL: 'https://inara.cz/cmdr/1/' },
        },
      ]),
    );
    expect(c.snapshot().inara.state).toBe('configured');
    expect(await c.snapshot().inara.verify()).toBeNull();
    const view = c.snapshot().inara;
    expect(view.state).toBe('connected');
    expect(view.profile).toMatchObject({ userName: 'Tester', profileUrl: 'https://inara.cz/cmdr/1/' });
    // Checking a key sends no journal data, so it is not "Last accepted".
    const row = (c.snapshot().sharing.rows as Array<{ id: string; lastSuccessAt: string | null }>).find(
      (r) => r.id === 'inara',
    );
    expect(row?.lastSuccessAt ?? null).toBeNull();
    const sent = JSON.parse(
      (invoke.mock.calls[0]![1] as { submission: { events_json: string } }).submission.events_json,
    );
    expect(sent).toEqual([expect.objectContaining({ eventName: 'getCommanderProfile', eventData: {} })]);
  });
});
