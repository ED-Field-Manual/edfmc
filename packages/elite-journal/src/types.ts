/**
 * Core journal abstractions.
 *
 * Design rule (see docs/ARCHITECTURE.md §6): normalization is *additive*. Nothing
 * here ever discards the raw payload, and no field is typed as required unless it
 * was observed at 100% presence across the 197,164-line validation corpus.
 */

/**
 * Everything needed to answer "where did this observation come from?" (§27).
 * Attached to every event, known or unknown.
 */
export interface EventProvenance {
  /**
   * Deterministic identity: `${sourceFile}:${byteOffset}`.
   *
   * Stable across restarts and across replay, which is what makes
   * "restart does not duplicate state" work without content hashing.
   * Timestamps are deliberately NOT used — the corpus contains many events
   * sharing a timestamp to the second.
   */
  readonly eventId: string;
  /** Journal file basename, e.g. `Journal.2026-09-01T082623.01.log`. */
  readonly sourceFile: string;
  /** Byte offset of the first byte of this line within the file. */
  readonly byteOffset: number;
  /** Raw timestamp string exactly as Frontier wrote it. Never reformatted. */
  readonly timestamp: string;
  /** Parsed epoch milliseconds, or null if the timestamp was unparseable. */
  readonly timestampMs: number | null;
  /** Game version in force, from the governing Fileheader/LoadGame. */
  readonly gameVersion: string | null;
  /** Build string, e.g. `r330683/r0 `. Trailing space is Frontier's, preserved. */
  readonly build: string | null;
  /** Odyssey flag from the header, when one was seen. */
  readonly odyssey: boolean | null;
  /** `Fileheader.part`. Always 1 across the corpus, but not assumed. */
  readonly part: number | null;
  /** Commander name once a Commander/LoadGame event has been seen this session. */
  readonly commander: string | null;
  /** Frontier ID once seen. */
  readonly fid: string | null;
}

/** A syntactically valid journal line carrying an `event` field. */
export interface RawJournalEvent {
  /** Raw event name exactly as Frontier wrote it, e.g. `ColonisationConstructionDepot`. */
  readonly event: string;
  /** The complete parsed object, verbatim. Unknown fields are never stripped. */
  readonly raw: Readonly<Record<string, unknown>>;
  readonly provenance: EventProvenance;
}

/**
 * Why a line did not become an event.
 *
 * `malformed` and `unusable` are deliberately distinct: §3 requires us to
 * distinguish broken JSON from valid-but-unsupported content. Broken JSON is a
 * genuine anomaly worth surfacing; a valid object without an `event` field is not.
 */
export type IngestFailureReason = 'malformed-json' | 'not-an-object' | 'missing-event-field';

export interface IngestFailure {
  readonly reason: IngestFailureReason;
  readonly sourceFile: string;
  readonly byteOffset: number;
  /** Truncated for logging; we never write full journal lines to disk logs (§21). */
  readonly excerpt: string;
  readonly error: string | null;
}

export type IngestResult =
  | { readonly ok: true; readonly event: RawJournalEvent }
  | { readonly ok: false; readonly failure: IngestFailure };

/**
 * A normalized event. `known: false` means we have no typed shape for it yet —
 * it is still delivered, still carries full provenance, and never throws (§28).
 */
export interface NormalizedEvent<TData = unknown> {
  /** Domain kind, e.g. `docked`. Equals `unknown` when `known` is false. */
  readonly kind: string;
  readonly known: boolean;
  /** Typed projection. `null` for unknown events — read `source.raw` instead. */
  readonly data: TData;
  readonly source: RawJournalEvent;
}

/** Where the tailer left off. Persisted to SQLite; the basis of resume-without-duplication. */
export interface JournalCheckpoint {
  readonly sourceFile: string;
  readonly byteOffset: number;
  /** Last emitted eventId, stored for diagnostics and consistency checking. */
  readonly lastEventId: string | null;
  readonly updatedAt: string;
}

/** Rolling counters exposed in diagnostics (§25). */
export interface IngestStats {
  linesRead: number;
  eventsEmitted: number;
  malformedJson: number;
  notAnObject: number;
  missingEventField: number;
  unknownEventKinds: Record<string, number>;
  filesOpened: number;
  rotations: number;
  emptyFilesSkipped: number;
  /**
   * Events re-read from before the checkpoint to rebuild session state. Already
   * delivered in an earlier run; counted so diagnostics can say how much of the
   * startup was catch-up rather than new.
   */
  eventsReplayed: number;
}

/**
 * How an event reached the app.
 *
 * `replayed` is true for a line an earlier run of the app already read: it sits
 * before the saved checkpoint and is read again only so the session's state
 * (commander, ship, location, game version) is rebuilt. Everything else -- the
 * live tail, a journal written while the app was closed, a first run -- is
 * false. Neither says the event is recent; its own timestamp does that.
 */
export interface DeliveryInfo {
  readonly replayed: boolean;
}

export function emptyStats(): IngestStats {
  return {
    linesRead: 0,
    eventsEmitted: 0,
    malformedJson: 0,
    notAnObject: 0,
    missingEventField: 0,
    unknownEventKinds: {},
    filesOpened: 0,
    rotations: 0,
    emptyFilesSkipped: 0,
    eventsReplayed: 0,
  };
}

/**
 * A value the game did not tell us.
 *
 * Used instead of `null`/`false` wherever §4 requires "never guess missing
 * information". The distinction matters most in verification (§9): an absent
 * `StationAllegiance` (present only 32% of the time) is UNKNOWN, not "none",
 * and must never generate a discrepancy report.
 */
export const UNKNOWN = Symbol('unknown');
export type Unknown = typeof UNKNOWN;
export type Known<T> = T | Unknown;

export function isKnown<T>(v: Known<T>): v is T {
  return v !== UNKNOWN;
}

/** Reads an optional field, returning UNKNOWN rather than undefined when absent. */
export function optional<T>(obj: Readonly<Record<string, unknown>>, key: string): Known<T> {
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj[key] as T) : UNKNOWN;
}
