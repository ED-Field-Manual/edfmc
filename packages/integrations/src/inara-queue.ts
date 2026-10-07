/**
 * Inara on the shared durable queue.
 *
 * Rows live in `integration_queue` beside EDDN's and EDSM's, under
 * `integration = 'inara'`. What is specific to Inara is decided here, as pure
 * functions over plain rows, so the database code in the app only reads and
 * writes what these return:
 *
 * - what a queued row holds (`InaraPayload`), and its deterministic id;
 * - whether a snapshot is worth queueing at all (fingerprints);
 * - which rows make up the next request (`planInaraBatch`);
 * - what each row becomes after Inara answers (`applyInaraResponse`).
 *
 * See docs/INARA.md for the reasoning behind each rule.
 */

import { INARA_MAX_AGE_MS, type InaraCategory, type InaraOutgoing } from './inara-translate.js';
import { parseInaraResponse, type InaraEvent } from './inara.js';
import { applyAttempt, sanitiseError, type QueueItem } from './queue.js';

/** At most this many events in one request. */
export const INARA_MAX_BATCH = 50;
/** Pending this many, and a send is due without waiting for a journal trigger. */
export const INARA_SIZE_TRIGGER = 50;
/** Automatic sends are at least this far apart. Manual sync is not limited. */
export const INARA_MIN_INTERVAL_MS = 30_000;
/** Login writes ranks, materials and loadout over several seconds; wait for them. */
export const INARA_SESSION_START_DELAY_MS = 20_000;
/** While anything waits, look again this often even without a trigger. */
export const INARA_FALLBACK_INTERVAL_MS = 5 * 60_000;
/** Accepted rows are kept this long so a re-read of a sent line stays a no-op. */
export const INARA_ACCEPTED_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;

/** What one queued row holds. Versioned so a later shape can be told apart. */
export interface InaraPayload {
  readonly v: 1;
  readonly event: InaraEvent;
  readonly category: InaraCategory;
  readonly coalesceKey: string | null;
  /** Hash of name + data, for snapshot dedup. Never of anything secret. */
  readonly fingerprint: string;
}

/**
 * Queue id for the n-th Inara event produced by one journal line.
 *
 * The journal event id is `file:offset`, stable across restart and re-read, so
 * `INSERT OR IGNORE` on this id is what makes re-reading a file harmless.
 */
export function inaraQueueId(journalEventId: string, n: number): string {
  return `inara:${journalEventId}#${n}`;
}

/** Key order independent JSON, so the same data always hashes the same. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** cyrb53: a small, well-distributed 53-bit string hash. Not cryptographic, and need not be. */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The fingerprint of an event's content, ignoring when it happened. */
export function inaraFingerprint(eventName: string, eventData: unknown): string {
  return hash(`${eventName}|${stableJson(eventData)}`);
}

export function toInaraPayload(out: InaraOutgoing): InaraPayload {
  return {
    v: 1,
    event: {
      eventName: out.eventName,
      eventTimestamp: out.eventTimestamp,
      eventData: out.eventData as InaraEvent['eventData'],
    },
    category: out.category,
    coalesceKey: out.coalesceKey,
    fingerprint: inaraFingerprint(out.eventName, out.eventData),
  };
}

export function readInaraPayload(text: string): InaraPayload | null {
  try {
    const p = JSON.parse(text) as Partial<InaraPayload>;
    if (p?.v !== 1 || typeof p.event?.eventName !== 'string') return null;
    if (typeof p.event.eventTimestamp !== 'string') return null;
    return p as InaraPayload;
  } catch {
    return null;
  }
}

/**
 * Whether a snapshot is worth queueing.
 *
 * Inara: "Do NOT send the same events and things over and over, send just the
 * actual/new events." A snapshot identical to the last one Inara accepted for
 * this commander is dropped. Log events (no coalesce key) always go.
 */
export function shouldQueueInara(
  payload: InaraPayload,
  lastAccepted: string | undefined,
): boolean {
  if (payload.coalesceKey === null) return true;
  return payload.fingerprint !== lastAccepted;
}

/* ------------------------------------------------------------- batching */

export interface InaraPlannedEvent {
  readonly row: QueueItem;
  readonly payload: InaraPayload;
  /** 1..n within the request; Inara echoes it back. */
  readonly customId: number;
}

export interface InaraBatchPlan {
  readonly send: readonly InaraPlannedEvent[];
  /** Older than Inara accepts. Recorded as rejected with the reason. */
  readonly expired: readonly string[];
  /** A newer snapshot with the same key is also waiting. Deleted unsent. */
  readonly superseded: readonly string[];
  /** Unreadable payloads. Deleted: they can never be sent. */
  readonly unreadable: readonly string[];
}

/**
 * Choose the next request.
 *
 * Only rows of `fid` -- one commander per request, always -- that are due, in
 * the order they were queued (`rows` must arrive in that order). Expired and
 * superseded rows are reported rather than sent.
 */
export function planInaraBatch(
  rows: readonly QueueItem[],
  opts: { readonly fid: string; readonly nowMs: number; readonly max?: number },
): InaraBatchPlan {
  const max = opts.max ?? INARA_MAX_BATCH;
  const expired: string[] = [];
  const superseded: string[] = [];
  const unreadable: string[] = [];

  const live: Array<{ row: QueueItem; payload: InaraPayload }> = [];
  for (const row of rows) {
    if (row.integration !== 'inara' || row.commanderFid !== opts.fid) continue;
    if (row.status !== 'queued' && row.status !== 'retryable') continue;
    const payload = readInaraPayload(row.payload);
    if (payload === null) {
      unreadable.push(row.id);
      continue;
    }
    const at = Date.parse(payload.event.eventTimestamp);
    if (!Number.isFinite(at) || opts.nowMs - at > INARA_MAX_AGE_MS) {
      expired.push(row.id);
      continue;
    }
    live.push({ row, payload });
  }

  // A newer snapshot with the same key makes an older waiting one pointless.
  const newest = new Map<string, string>();
  for (const { row, payload } of live) {
    if (payload.coalesceKey !== null) newest.set(payload.coalesceKey, row.id);
  }
  const kept = live.filter(({ row, payload }) => {
    if (payload.coalesceKey === null || newest.get(payload.coalesceKey) === row.id) return true;
    superseded.push(row.id);
    return false;
  });

  const due = kept.filter(({ row }) => {
    if (row.nextAttemptAt === null) return true;
    const t = Date.parse(row.nextAttemptAt);
    return !Number.isFinite(t) || t <= opts.nowMs;
  });

  return {
    send: due.slice(0, max).map(({ row, payload }, i) => ({ row, payload, customId: i + 1 })),
    expired,
    superseded,
    unreadable,
  };
}

/** The request's `events` array, with `eventCustomID` set for pairing. */
export function inaraRequestEvents(plan: InaraBatchPlan): InaraEvent[] {
  return plan.send.map(({ payload, customId }) => ({
    eventName: payload.event.eventName,
    eventTimestamp: payload.event.eventTimestamp,
    eventCustomID: customId,
    eventData: payload.event.eventData,
  }));
}

/* ------------------------------------------------------------- responses */

/** What the Rust command returns. Carries no secret. */
export interface InaraHttpResult {
  readonly status: number;
  readonly body: string;
  readonly transportError: string | null;
}

/**
 * The integration-wide consequence of an answer.
 *
 * - `ok`: Inara read the request; per-row results apply.
 * - `transient`: Inara could not be reached or did not answer usefully. Rows
 *   back off and are retried, a bounded number of times.
 * - `credential`: the key was refused. Everything stops until the commander
 *   replaces it; rows stay queued, untouched, because Inara cancelled the batch.
 * - `app-not-allowed`: Inara has not white-listed this app's name. Everything
 *   stops; rows stay queued.
 */
export type InaraCondition = 'ok' | 'transient' | 'credential' | 'app-not-allowed';

export interface InaraLinks {
  /** Which system and station these are for, so a stale link is never shown for a new place. */
  readonly systemName: string | null;
  readonly stationName: string | null;
  readonly starsystem: string | null;
  readonly station: string | null;
}

export interface InaraResponseEffect {
  readonly condition: InaraCondition;
  /** Safe to show and store: sanitised, never a body, never a key. */
  readonly message: string | null;
  /** Each sent row's next state. Empty when nothing should change. */
  readonly rows: readonly QueueItem[];
  /** Snapshots Inara accepted, to record as the last accepted fingerprint. */
  readonly acceptedFingerprints: ReadonlyArray<{ readonly key: string; readonly fingerprint: string }>;
  /** Links Inara returned for the newest location in the batch, if any. */
  readonly links: InaraLinks | null;
  /** The key owner's Inara identity from the header, when Inara sent it. */
  readonly user: { readonly userId: number | null; readonly userName: string | null } | null;
}

/** Only links to Inara itself are kept from a reply; anything else is ignored. */
export function trustedInaraUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname === 'inara.cz' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Apply Inara's answer to the rows that were sent.
 *
 * The HTTP status is not what decides: Inara reports in `header.eventStatus`
 * and in each event's `eventStatus`. A reply this cannot read is never success.
 */
export function applyInaraResponse(
  plan: InaraBatchPlan,
  http: InaraHttpResult,
  now: Date,
  random: () => number,
): InaraResponseEffect {
  const none = { acceptedFingerprints: [], links: null, user: null } as const;
  const retryAll = (detail: string): InaraResponseEffect => ({
    condition: 'transient',
    message: sanitiseError(detail),
    rows: plan.send.map(({ row }) =>
      applyAttempt(row, { kind: 'retryable', detail }, now, random),
    ),
    ...none,
  });

  if (http.transportError !== null || http.status === 0) {
    return retryAll(`Inara could not be reached (${http.transportError ?? 'no response'}).`);
  }
  if (http.status < 200 || http.status >= 300) {
    // Inara answers 200 with its own status inside. Anything else is the
    // server, a proxy or a maintenance page, and is worth another try later.
    return retryAll(`Inara answered HTTP ${http.status}.`);
  }

  let body: unknown;
  try {
    body = JSON.parse(http.body);
  } catch {
    return retryAll('Inara sent a reply that could not be read.');
  }

  const outcome = parseInaraResponse(body);
  if (outcome.kind === 'app-not-allowed') {
    return {
      condition: 'app-not-allowed',
      message: sanitiseError(outcome.message),
      rows: [],
      ...none,
    };
  }
  if (outcome.kind === 'credential') {
    return { condition: 'credential', message: sanitiseError(outcome.message), rows: [], ...none };
  }
  if (outcome.kind === 'retry' || outcome.kind === 'malformed') {
    return retryAll(outcome.kind === 'retry' ? outcome.reason : outcome.reason);
  }

  const byCustom = new Map<number, (typeof outcome.perEvent)[number]>();
  for (const r of outcome.perEvent) if (r.customId !== null) byCustom.set(r.customId, r);

  const rows: QueueItem[] = [];
  const acceptedFingerprints: Array<{ key: string; fingerprint: string }> = [];
  let links: InaraLinks | null = null;

  plan.send.forEach(({ row, payload, customId }, index) => {
    // Paired by eventCustomID, falling back to order, which Inara documents
    // as preserved ("returned always in the order as they were sent").
    const result = byCustom.get(customId) ?? outcome.perEvent[index];
    if (result === undefined) {
      rows.push(applyAttempt(row, { kind: 'retryable', detail: 'Inara did not answer for this event.' }, now, random));
      return;
    }
    if (result.accepted) {
      rows.push(applyAttempt(row, { kind: 'accepted' }, now, random));
      if (payload.coalesceKey !== null) {
        acceptedFingerprints.push({ key: payload.coalesceKey, fingerprint: payload.fingerprint });
      }
      const system = trustedInaraUrl(result.data?.['starsystemInaraURL']);
      if (system !== null) {
        const d = (payload.event.eventData ?? {}) as Record<string, unknown>;
        links = {
          systemName: typeof d['starsystemName'] === 'string' ? d['starsystemName'] : null,
          stationName: typeof d['stationName'] === 'string' ? d['stationName'] : null,
          starsystem: system,
          station: trustedInaraUrl(result.data?.['stationInaraURL']),
        };
      }
      return;
    }
    if (result.status === 400) {
      rows.push(
        applyAttempt(
          row,
          { kind: 'permanent', detail: `${payload.event.eventName}: ${result.text || 'rejected by Inara'}` },
          now,
          random,
        ),
      );
      return;
    }
    rows.push(
      applyAttempt(
        row,
        { kind: 'retryable', detail: result.text || `Inara status ${result.status}` },
        now,
        random,
      ),
    );
  });

  const u = outcome.user;
  return {
    condition: 'ok',
    message: null,
    rows,
    acceptedFingerprints,
    links,
    user: u
      ? {
          userId: typeof u['userID'] === 'number' ? u['userID'] : null,
          userName: typeof u['userName'] === 'string' ? u['userName'] : null,
        }
      : null,
  };
}
