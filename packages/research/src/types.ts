/**
 * Research project schema.
 *
 * §12 asks for "a general research framework capable of supporting multiple EDFM
 * research projects", not a settlement loot tracker. So nothing in this file
 * mentions settlements: a project is a declarative description of when a session
 * opens, when it closes, and what counts as an observation inside it.
 *
 * Project definitions are **server-driven and versioned**, exactly like context
 * rules, which means they arrive as untrusted data. Conditions therefore reuse
 * `@edfm/context`'s `Condition` schema rather than growing a second matcher:
 * declarative only, a fixed operator set, no `eval`, and deliberately no regular
 * expressions (a server-supplied regex is a denial-of-service vector against an
 * application whose whole job is running quietly beside a game).
 */

import type { Condition } from '@edfm/context';

/**
 * How complete the commander believes the session was.
 *
 * `unknown` is the default and, in the measured corpus, will be the overwhelming
 * majority. §12 is explicit that the app must not infer this: it cannot know
 * whether every container was searched, whether another commander had already
 * looted the site, or whether the player deliberately skipped areas. The user
 * may mark it, but is never required to, and the default workflow asks nothing.
 */
export type Completeness = 'unknown' | 'complete' | 'partial' | 'aborted';

/** Why a session stopped. Recorded because not every ending is a clean exit. */
export type SessionOutcome =
  /** A configured end event fired. */
  | 'ended'
  /** The commander died. Measured: 2 of 30 sessions in the real corpus. */
  | 'died'
  /** The journal stopped mid-session — game closed, or a crash. */
  | 'interrupted'
  /** Still open. */
  | 'active';

/**
 * One observed thing inside a session.
 *
 * Kept as the raw token plus a type, never as a curated enum: Frontier adds
 * items, and a project that only understood a fixed list would silently drop
 * whatever shipped last Thursday.
 */
export interface Observation {
  /** Frontier's internal name, lower-cased, e.g. `healthpack`. */
  readonly name: string;
  /** Frontier's own localised label when it gave one. */
  readonly label: string | null;
  /** e.g. `Component`, `Item`, `Consumable`, `Data`. */
  readonly category: string | null;
  readonly count: number;
  readonly at: string;
  /** `file:byteOffset` — ties the record back to the exact journal line (§27). */
  readonly sourceEventId: string;
  readonly sourceEvent: string;
}

/**
 * Facts about where a session happened, captured from an earlier event.
 *
 * A plain string map rather than a typed shape, because the framework does not
 * know what a project cares about. The settlement project puts economy and
 * government here; a mining project would put something else.
 */
export type SessionContext = Readonly<Record<string, string | null>>;

export interface ObservedSession {
  readonly id: string;
  readonly projectId: string;
  readonly projectVersion: number;

  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Null while active. Derived, not reported by the game. */
  readonly durationSeconds: number | null;

  readonly context: SessionContext;
  readonly observations: readonly Observation[];

  readonly outcome: SessionOutcome;
  /** The event name that closed it, for diagnosing boundary rules. */
  readonly endEvent: string | null;
  readonly completeness: Completeness;

  /* --------------------------------------------------------- provenance */
  readonly commander: string | null;
  readonly commanderFid: string | null;
  /** §12: builds must be recorded so materially different patches can be split. */
  readonly gameVersion: string | null;
  readonly gameBuild: string | null;
  readonly companionVersion: string;
  /** Which journal file, so one play session can be told from another. */
  readonly sessionKey: string;
}

/* ------------------------------------------------------------- project */

/**
 * Where a value comes from when building context or an observation.
 *
 * A dotted path into the raw journal payload. Deliberately not an expression:
 * these definitions are server-supplied.
 */
export interface FieldSource {
  readonly path: string;
  /** Used when the path is absent. Absent stays absent — never invented. */
  readonly fallbackPath?: string;
}

/** Captured from an event that happens *before* the session opens. */
export interface ContextRule {
  readonly on: string | readonly [string, ...string[]];
  /** Only capture when this holds. */
  readonly when?: Condition;
  /** Context key -> where to read it. */
  readonly capture: Readonly<Record<string, FieldSource>>;
  /**
   * How long captured context stays eligible to open a session, in seconds.
   *
   * Measured: a commander may approach a settlement and only disembark minutes
   * later, or may approach and fly away entirely. Without an expiry, a stale
   * approach from an hour ago would attach itself to an unrelated disembark.
   */
  readonly expiresAfterSeconds: number;
}

export interface StartRule {
  readonly on: string | readonly [string, ...string[]];
  readonly when?: Condition;
  /**
   * Context keys that must be present, and must match the same-named field on
   * the starting event, before a session opens.
   *
   * This is what stops a disembark at an unrelated station from being recorded
   * as a settlement visit: measured, `Disembark` names its station on only
   * 25.8% of events, so the body it happened on is the reliable link.
   */
  readonly requireContextMatch?: Readonly<Record<string, FieldSource>>;
}

export interface ObservationRule {
  readonly on: string | readonly [string, ...string[]];
  readonly when?: Condition;
  readonly name: FieldSource;
  readonly label?: FieldSource;
  readonly category?: FieldSource;
  readonly count?: FieldSource;
  /**
   * Collapse duplicates of the same item within this many seconds.
   *
   * Measured, and not optional: `CollectItems` and `BackpackChange.Added` both
   * fire for one pickup — 258 of 281 collections corpus-wide appear in both
   * within a second. Counting both inflates every material by nearly 90%.
   */
  readonly dedupeWindowSeconds?: number;
}

export interface ResearchProject {
  readonly id: string;
  /** §12: bumped when methodology changes, so data can be split by version. */
  readonly version: number;
  readonly title: string;
  readonly summary: string;

  readonly context: readonly ContextRule[];
  readonly start: StartRule;
  /** Event names that close an open session. */
  readonly end: readonly string[];
  /** End events that mean the run was cut short rather than completed. */
  readonly abortiveEnd?: readonly string[];
  readonly observe: readonly ObservationRule[];

  /**
   * Sessions shorter than this are still recorded, but flagged.
   *
   * Measured: 4 of 30 real sessions lasted under a minute (the shortest was
   * 17 seconds), which is an approach-and-leave rather than a visit. They are
   * kept — discarding data because it is inconvenient is how a corpus acquires
   * silent bias — but a consumer must be able to exclude them.
   */
  readonly minPlausibleSeconds?: number;
  /**
   * Beyond this, the session almost certainly missed its end event.
   *
   * No session in the measured corpus reaches this — the longest was 34
   * minutes — so the guard is precautionary rather than evidenced. It is kept
   * because a missed end event is possible and would otherwise produce a
   * session spanning hours of unrelated play.
   */
  readonly maxPlausibleSeconds?: number;

  /**
   * Fields the project would like but the game does not expose.
   *
   * Recorded in the definition itself so the gap is visible to anyone reading
   * it, rather than looking like an oversight. §12 asked for settlement
   * security, powered/unpowered and abandoned/active state; none of the three
   * appears in any journal event, so none is collected.
   */
  readonly unavailableFields?: readonly string[];
}
