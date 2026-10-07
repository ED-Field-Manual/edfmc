/**
 * Inara's queue decisions: dedup, batching and reading the answer.
 *
 * Every HTTP exchange here is a mocked `InaraHttpResult`. No request is made,
 * and no key or account is involved.
 */

import { describe, expect, it } from 'vitest';

import {
  INARA_MAX_BATCH,
  applyInaraResponse,
  inaraFingerprint,
  inaraQueueId,
  inaraRequestEvents,
  planInaraBatch,
  readInaraPayload,
  shouldQueueInara,
  toInaraPayload,
  trustedInaraUrl,
  type InaraHttpResult,
} from '../src/inara-queue.js';
import type { InaraOutgoing } from '../src/inara-translate.js';
import { QUEUE_LIMITS, jitteredBackoffFor, type QueueItem } from '../src/queue.js';

const NOW = new Date('2026-10-06T22:30:00Z');
const FID = 'F1000001';

function out(name: string, data: unknown, key: string | null = null, at = '2026-10-06T22:00:00Z'): InaraOutgoing {
  return { eventName: name, eventTimestamp: at, eventData: data, category: 'travel', coalesceKey: key };
}

let seq = 0;
function row(o: InaraOutgoing, over: Partial<QueueItem> = {}): QueueItem {
  seq += 1;
  return {
    id: inaraQueueId(`Journal.x.log:${seq}`, 0),
    integration: 'inara',
    commanderFid: FID,
    status: 'queued',
    payload: JSON.stringify(toInaraPayload(o)),
    attempts: 0,
    lastError: null,
    nextAttemptAt: null,
    createdAt: `2026-10-06T22:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    updatedAt: '2026-10-06T22:00:00.000Z',
    ...over,
  };
}

const ok = (events: unknown[], header: Record<string, unknown> = { eventStatus: 200 }): InaraHttpResult => ({
  status: 200,
  body: JSON.stringify({ header, events }),
  transportError: null,
});

const half = () => 0.5;

/* ---------------------------------------------------------------- dedup */

describe('deduplication', () => {
  it('a queue id is deterministic from the journal line, so a re-read is ignored', () => {
    expect(inaraQueueId('Journal.2026-10-06T170556.01.log:1234', 0)).toBe(
      inaraQueueId('Journal.2026-10-06T170556.01.log:1234', 0),
    );
    expect(inaraQueueId('a:1', 0)).not.toBe(inaraQueueId('a:1', 1));
  });

  it('a fingerprint ignores key order and the timestamp, but not the data', () => {
    expect(inaraFingerprint('x', { a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      inaraFingerprint('x', { b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(inaraFingerprint('x', { a: 1 })).not.toBe(inaraFingerprint('x', { a: 2 }));
    expect(inaraFingerprint('x', { a: 1 })).not.toBe(inaraFingerprint('y', { a: 1 }));
    const p1 = toInaraPayload(out('setCommanderRankPilot', [1], 'r', '2026-10-01T00:00:00Z'));
    const p2 = toInaraPayload(out('setCommanderRankPilot', [1], 'r', '2026-10-05T00:00:00Z'));
    expect(p1.fingerprint).toBe(p2.fingerprint);
  });

  it('a snapshot identical to the one Inara last accepted is not queued; log events always are', () => {
    const snap = toInaraPayload(out('setCommanderRankPilot', [{ rankName: 'combat', rankValue: 4 }], 'rank-pilot'));
    expect(shouldQueueInara(snap, snap.fingerprint)).toBe(false);
    expect(shouldQueueInara(snap, 'something-else')).toBe(true);
    expect(shouldQueueInara(snap, undefined)).toBe(true);
    const log = toInaraPayload(out('addCommanderTravelFSDJump', { starsystemName: 'A' }));
    expect(shouldQueueInara(log, log.fingerprint)).toBe(true);
  });

  it('round-trips a payload, and refuses one it cannot read', () => {
    const p = toInaraPayload(out('addCommanderTravelDock', { stationName: 'S' }));
    expect(readInaraPayload(JSON.stringify(p))).toEqual(p);
    expect(readInaraPayload('not json')).toBeNull();
    expect(readInaraPayload('{"v":2}')).toBeNull();
  });
});

/* ------------------------------------------------------------- batching */

describe('batch planning', () => {
  it('never mixes commanders: only the active commander’s rows are sent', () => {
    const mine = row(out('addCommanderTravelFSDJump', { starsystemName: 'A' }));
    const theirs = row(out('addCommanderTravelFSDJump', { starsystemName: 'B' }), { commanderFid: 'F2' });
    const orphan = row(out('addCommanderTravelFSDJump', { starsystemName: 'C' }), { commanderFid: null });
    const plan = planInaraBatch([mine, theirs, orphan], { fid: FID, nowMs: NOW.getTime() });
    expect(plan.send.map((p) => p.row.id)).toEqual([mine.id]);
  });

  it('caps a request and numbers each event for pairing', () => {
    const rows = Array.from({ length: INARA_MAX_BATCH + 7 }, (_, i) =>
      row(out('addCommanderTravelFSDJump', { starsystemName: `S${i}` })),
    );
    const plan = planInaraBatch(rows, { fid: FID, nowMs: NOW.getTime() });
    expect(plan.send).toHaveLength(INARA_MAX_BATCH);
    const events = inaraRequestEvents(plan);
    expect(events.map((e) => e.eventCustomID)).toEqual(Array.from({ length: INARA_MAX_BATCH }, (_, i) => i + 1));
    expect(events[0]).toEqual({
      eventName: 'addCommanderTravelFSDJump',
      eventTimestamp: '2026-10-06T22:00:00Z',
      eventCustomID: 1,
      eventData: { starsystemName: 'S0' },
    });
  });

  it('expires anything older than 30 days instead of sending it', () => {
    const old = row(out('addCommanderTravelFSDJump', { starsystemName: 'A' }, null, '2026-09-01T00:00:00Z'));
    const fresh = row(out('addCommanderTravelFSDJump', { starsystemName: 'B' }));
    const plan = planInaraBatch([old, fresh], { fid: FID, nowMs: NOW.getTime() });
    expect(plan.expired).toEqual([old.id]);
    expect(plan.send.map((p) => p.row.id)).toEqual([fresh.id]);
  });

  it('a newer snapshot supersedes an older one still waiting', () => {
    const a = row(out('setCommanderInventoryMaterials', [1], 'materials'));
    const log = row(out('addCommanderTravelDock', { stationName: 'S' }));
    const b = row(out('setCommanderInventoryMaterials', [2], 'materials'));
    const plan = planInaraBatch([a, log, b], { fid: FID, nowMs: NOW.getTime() });
    expect(plan.superseded).toEqual([a.id]);
    expect(plan.send.map((p) => p.row.id)).toEqual([log.id, b.id]);
  });

  it('waits for a row’s backoff, and never resends what is settled', () => {
    const later = row(out('a', {}), { status: 'retryable', nextAttemptAt: '2026-10-06T23:00:00Z' });
    const done = row(out('b', {}), { status: 'accepted' });
    const gone = row(out('c', {}), { status: 'rejected' });
    expect(planInaraBatch([later, done, gone], { fid: FID, nowMs: NOW.getTime() }).send).toEqual([]);
  });

  it('reports unreadable rows so they can be removed', () => {
    const bad = { ...row(out('a', {})), payload: '{oops' };
    expect(planInaraBatch([bad], { fid: FID, nowMs: NOW.getTime() }).unreadable).toEqual([bad.id]);
  });
});

/* ------------------------------------------------------------ responses */

describe('reading Inara’s answer', () => {
  const plan3 = () =>
    planInaraBatch(
      [
        row(out('setCommanderTravelLocation', { starsystemName: 'Alpha', stationName: 'Port' }, 'location')),
        row(out('addCommanderTravelFSDJump', { starsystemName: 'B' })),
        row(out('setCommanderRankPilot', [1], 'rank-pilot')),
      ],
      { fid: FID, nowMs: NOW.getTime() },
    );

  it('200, 202 and 204 per event are accepted; snapshot fingerprints are recorded', () => {
    const plan = plan3();
    const effect = applyInaraResponse(
      plan,
      ok([
        { eventCustomID: 1, eventStatus: 200, eventData: { starsystemInaraURL: 'https://inara.cz/galaxy-starsystem/9333/', stationInaraURL: 'https://inara.cz/galaxy-station/13299/' } },
        { eventCustomID: 2, eventStatus: 202, eventStatusText: 'Multiple results' },
        { eventCustomID: 3, eventStatus: 204, eventStatusText: 'No results' },
      ]),
      NOW,
      half,
    );
    expect(effect.condition).toBe('ok');
    expect(effect.rows.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(effect.acceptedFingerprints.map((f) => f.key)).toEqual(['location', 'rank-pilot']);
    expect(effect.links).toEqual({
      systemName: 'Alpha',
      stationName: 'Port',
      starsystem: 'https://inara.cz/galaxy-starsystem/9333/',
      station: 'https://inara.cz/galaxy-station/13299/',
    });
  });

  it('pairs results by eventCustomID even when the order differs', () => {
    const plan = plan3();
    const effect = applyInaraResponse(
      plan,
      ok([
        { eventCustomID: 3, eventStatus: 400, eventStatusText: 'Bad rank' },
        { eventCustomID: 1, eventStatus: 200 },
        { eventCustomID: 2, eventStatus: 200 },
      ]),
      NOW,
      half,
    );
    expect(effect.rows.map((r) => r.status)).toEqual(['accepted', 'accepted', 'rejected']);
    expect(effect.rows[2]!.lastError).toContain('Bad rank');
    expect(effect.acceptedFingerprints.map((f) => f.key)).toEqual(['location']);
  });

  it('a per-event 400 is rejected for good, not retried', () => {
    const plan = plan3();
    const effect = applyInaraResponse(
      plan,
      ok([{ eventStatus: 200 }, { eventStatus: 400, eventStatusText: 'Missing starsystemName' }, { eventStatus: 200 }]),
      NOW,
      half,
    );
    expect(effect.rows[1]).toMatchObject({ status: 'rejected', nextAttemptAt: null });
  });

  it('an event Inara did not answer for is retried, not assumed delivered', () => {
    const plan = plan3();
    const effect = applyInaraResponse(plan, ok([{ eventStatus: 200 }]), NOW, half);
    expect(effect.rows.map((r) => r.status)).toEqual(['accepted', 'retryable', 'retryable']);
  });

  it('"application has no access" stops everything and leaves the rows untouched', () => {
    const effect = applyInaraResponse(
      plan3(),
      ok([], { eventStatus: 400, eventStatusText: 'This application has no access allowed.' }),
      NOW,
      half,
    );
    expect(effect.condition).toBe('app-not-allowed');
    expect(effect.rows).toEqual([]);
  });

  it('any other header 400 is an authentication failure, and also leaves the rows alone', () => {
    const effect = applyInaraResponse(
      plan3(),
      ok([], { eventStatus: 400, eventStatusText: 'Invalid API key.' }),
      NOW,
      half,
    );
    expect(effect.condition).toBe('credential');
    expect(effect.rows).toEqual([]);
  });

  it.each([
    ['no connection', { status: 0, body: '', transportError: 'connection-failed' }],
    ['a timeout', { status: 0, body: '', transportError: 'timeout' }],
    ['HTTP 503', { status: 503, body: 'down', transportError: null }],
    ['HTTP 429', { status: 429, body: '', transportError: null }],
    ['an HTML page', { status: 200, body: '<html>ACCESS CHECK</html>', transportError: null }],
    ['JSON without a header', { status: 200, body: '{"events":[]}', transportError: null }],
  ])('%s is temporary: every row backs off', (_, http) => {
    const effect = applyInaraResponse(plan3(), http, NOW, half);
    expect(effect.condition).toBe('transient');
    expect(effect.rows.every((r) => r.status === 'retryable' && r.nextAttemptAt !== null)).toBe(true);
  });

  it('gives up after the shared attempt limit, so a broken server cannot be hammered forever', () => {
    const tired = planInaraBatch(
      [row(out('a', {}), { status: 'retryable', attempts: QUEUE_LIMITS.maxAttempts - 1 })],
      { fid: FID, nowMs: NOW.getTime() },
    );
    const effect = applyInaraResponse(tired, { status: 503, body: '', transportError: null }, NOW, half);
    expect(effect.rows[0]).toMatchObject({ status: 'rejected' });
    expect(effect.rows[0]!.lastError).toMatch(/gave up/);
  });

  it('keeps only links that point at inara.cz over https', () => {
    expect(trustedInaraUrl('https://inara.cz/galaxy-starsystem/1/')).toBe('https://inara.cz/galaxy-starsystem/1/');
    expect(trustedInaraUrl('http://inara.cz/x')).toBeNull();
    expect(trustedInaraUrl('https://inara.cz.evil.example/x')).toBeNull();
    expect(trustedInaraUrl('javascript:alert(1)')).toBeNull();
    expect(trustedInaraUrl(42)).toBeNull();
  });

  it('never stores anything that looks like a key in an error', () => {
    const effect = applyInaraResponse(
      plan3(),
      ok([], { eventStatus: 400, eventStatusText: 'bad APIkey=abc123secret?token=zzz' }),
      NOW,
      half,
    );
    expect(effect.message).not.toContain('zzz');
  });
});

describe('backoff', () => {
  it('jitter stays within ±20% of the schedule, and the schedule is bounded', () => {
    for (let attempts = 1; attempts <= 10; attempts += 1) {
      const lo = jitteredBackoffFor(attempts, () => 0);
      const hi = jitteredBackoffFor(attempts, () => 0.999999);
      expect(hi).toBeLessThanOrEqual(600 * 1.2);
      expect(lo).toBeGreaterThanOrEqual(5 * 0.8);
      expect(hi / lo).toBeLessThan(1.51);
    }
  });
});
