/**
 * Reference data, fetched from the EDFM API and cached for synchronous lookup.
 *
 * `ReferenceSource.lookup` is synchronous because it is called from the ingest
 * path, and stalling journal processing on a network round trip would make the
 * whole pipeline as reliable as the network. So a lookup only ever reads the
 * cache, and a miss schedules a fetch for next time.
 *
 * The consequence is stated rather than hidden: the first observation of a
 * station is compared against nothing. `onArrived` exists so the caller can
 * re-observe that event once the data lands, which is why a miss is not simply
 * a lost comparison.
 *
 * ## Privacy
 *
 * A lookup by MarketID tells the server which station this commander is at.
 * That is a location disclosure, so it is off unless the commander turned
 * verification on (§21: nothing is uploaded by default). `isEnabled` is
 * consulted at call time, not captured at construction, so revoking consent
 * takes effect immediately rather than at the next restart.
 */

import type { ReferenceSource } from './engine.js';

export interface ReferenceClientOptions {
  /** Origin of the EDFM API, e.g. `https://api.edfieldmanual.com`. */
  readonly baseUrl: string;
  /** Consulted before every network call. */
  readonly isEnabled: () => boolean;
  /** Called when a previously-missing entity becomes available. */
  readonly onArrived?: (entityType: string, entityId: string) => void;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Bounded so a long session cannot grow the cache without limit. */
  readonly maxEntries?: number;
  /** How long a "not observed" answer is trusted before asking again. */
  readonly negativeTtlMs?: number;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface ReferenceClientStats {
  readonly cached: number;
  readonly hits: number;
  readonly misses: number;
  readonly fetched: number;
  readonly absent: number;
  readonly failed: number;
  readonly inFlight: number;
}

export interface ReferenceClient extends ReferenceSource {
  /** Ask for an entity that is not cached. Never throws, never blocks. */
  prefetch(entityType: string, entityId: string): void;
  stats(): ReferenceClientStats;
  clear(): void;
}

/** Only entity types with a reference endpoint are ever requested. */
const ENDPOINTS: Record<string, string> = { station: 'stations' };

/** MarketIDs are numeric. Anything else is refused rather than put in a URL. */
const VALID_ID = /^\d{1,20}$/;

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;

interface Entry {
  /** `undefined` means the server has no record — a real answer, not a miss. */
  readonly value: unknown | undefined;
  readonly at: number;
}

export function createReferenceClient(options: ReferenceClientOptions): ReferenceClient {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const negativeTtl = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const log = options.log ?? (() => {});
  const base = options.baseUrl.replace(/\/+$/, '');

  // Map iterates in insertion order, so the first key is the least recently
  // used provided every hit re-inserts. `touch` is what makes this an LRU
  // rather than a FIFO, and matters because a commander returning to their
  // home station repeatedly should not have it evicted by places they passed
  // through once.
  const cache = new Map<string, Entry>();
  const inFlight = new Set<string>();

  let hits = 0;
  let misses = 0;
  let fetched = 0;
  let absent = 0;
  let failed = 0;

  const keyOf = (entityType: string, entityId: string): string => `${entityType}:${entityId}`;

  function remember(key: string, entry: Entry): void {
    // Refresh position so recently-used entries survive eviction.
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  async function load(entityType: string, entityId: string, key: string): Promise<void> {
    const endpoint = ENDPOINTS[entityType];
    if (endpoint === undefined) return;

    inFlight.add(key);
    try {
      const response = await doFetch(`${base}/v1/reference/${endpoint}/${entityId}`, {
        headers: { accept: 'application/json' },
      });

      if (response.status === 404) {
        // A real answer: nobody has reported this station. Cached so every
        // dock does not re-ask, but with a TTL, because "not observed yet" is
        // a statement about now and stops being true when someone reports it.
        absent += 1;
        remember(key, { value: undefined, at: now() });
        return;
      }
      if (!response.ok) {
        failed += 1;
        log('reference.http', { status: response.status });
        return;
      }

      const value: unknown = await response.json();
      fetched += 1;
      remember(key, { value, at: now() });
      options.onArrived?.(entityType, entityId);
    } catch (error) {
      // Offline is the normal case for a desktop app, not an exception. The
      // cache is left untouched so the next attempt is a clean retry.
      failed += 1;
      log('reference.error', { message: (error as Error).message });
    } finally {
      inFlight.delete(key);
    }
  }

  function prefetch(entityType: string, entityId: string): void {
    if (!options.isEnabled()) return;
    if (ENDPOINTS[entityType] === undefined) return;
    if (!VALID_ID.test(entityId)) return;

    const key = keyOf(entityType, entityId);
    if (inFlight.has(key)) return;

    const entry = cache.get(key);
    if (entry !== undefined) {
      // A cached value stands. A cached absence expires, so the station can
      // appear later without needing a restart.
      if (entry.value !== undefined) return;
      if (now() - entry.at < negativeTtl) return;
    }

    void load(entityType, entityId, key);
  }

  return {
    lookup(entityType, entityId) {
      const key = keyOf(entityType, entityId);
      const entry = cache.get(key);
      if (entry === undefined || entry.value === undefined) {
        misses += 1;
        // Ask, so the next observation of this station has something to
        // compare against even though this one does not.
        prefetch(entityType, entityId);
        return undefined;
      }
      hits += 1;
      remember(key, entry);
      return entry.value;
    },

    prefetch,

    stats() {
      return {
        cached: cache.size,
        hits,
        misses,
        fetched,
        absent,
        failed,
        inFlight: inFlight.size,
      };
    },

    clear() {
      cache.clear();
    },
  };
}
