/**
 * Context rule schema.
 *
 * Rules are **versioned and designed to be server-delivered** (§6). Today they come
 * from the bundled set and from plugins; the backend delivery path does not exist
 * yet. Either way they are treated as untrusted data, and two consequences shape
 * this schema:
 *
 *  1. Conditions are declarative. There is no expression string, no `eval`, no
 *     function body — a rule can only combine a fixed set of comparisons. A
 *     compromised or buggy rule feed cannot execute code in the client.
 *  2. There is deliberately **no regular-expression operator**. A server-supplied
 *     regex is a denial-of-service vector (catastrophic backtracking) against an
 *     application whose whole point is running quietly beside a game. `contains`,
 *     `startsWith` and `endsWith` cover the real matching needs.
 *
 * Resolution is entirely deterministic. §6 explicitly forbids using a model to guess
 * what the commander is doing.
 */

export type JsonPrimitive = string | number | boolean | null;

export type ComparisonOp =
  | 'exists'
  | 'eq'
  | 'neq'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export type Condition =
  /** The triggering journal event's raw name, e.g. `ProspectedAsteroid`. */
  | { readonly kind: 'event'; readonly name: string | readonly string[] }
  /**
   * A dotted path into the raw journal payload of the triggering event.
   *
   * Reading the event makes a rule event-scoped, exactly as an `event` node does:
   * a rule about what a journal line said is a rule about a moment.
   */
  | { readonly kind: 'field'; readonly path: string; readonly op: ComparisonOp; readonly value?: JsonPrimitive }
  /** A dotted path into the current commander state. */
  | { readonly kind: 'state'; readonly path: string; readonly op: ComparisonOp; readonly value?: JsonPrimitive }
  /**
   * A normalized station-service id is present in current state.
   *
   * Its own kind rather than a `state` path because service tokens are the single
   * most common trigger, and because matching must happen on the case-folded id:
   * Frontier's raw array mixes cases (`stationMenu`, `techBroker` among otherwise
   * lowercase tokens).
   */
  | { readonly kind: 'service'; readonly id: string }
  | { readonly kind: 'all'; readonly of: readonly Condition[] }
  | { readonly kind: 'any'; readonly of: readonly Condition[] }
  | { readonly kind: 'not'; readonly of: Condition };

/**
 * A link surfaced to the commander.
 *
 * `page` is an EDFM wiki page title, resolved to a canonical URL by the client from
 * the wiki's `articlepath`. Titles are stored rather than URLs so a change of domain
 * or path scheme does not invalidate every rule.
 */
export interface ContextResource {
  readonly label: string;
  readonly page?: string;
  /** Absolute URL, for resources that are not EDFM wiki pages. */
  readonly url?: string;
  readonly note?: string;
  /**
   * What the commander must have discovered before this resource may be shown.
   *
   * Omitted means public, which is right for guides and mechanics. It matters
   * for anything that names a specific discovery: offering a "Stratum
   * Tectonicas" link to a commander who has not identified the species tells
   * them what is on the planet, and the label alone is the spoiler — the link
   * need never be clicked.
   *
   * The *resolver* still matches these rules; only the projection to the UI
   * filters them. Verify aggressively, reveal conservatively.
   */
  readonly requires?: ResourceGate;
}

/**
 * Discovery requirement for a context resource.
 *
 * Deliberately declarative and serialisable: rules are server-driven, so a gate
 * has to survive JSON. The client resolves `genus`/`species` against the
 * current body from local discovery state.
 */
export type ResourceGate =
  | { readonly kind: 'genus'; readonly genus: string }
  | { readonly kind: 'species'; readonly species: string }
  | { readonly kind: 'body-scanned' }
  | { readonly kind: 'signals-known' };

export interface ContextRule {
  readonly id: string;
  readonly title: string;
  /**
   * One line saying why this is relevant, shown under the title. May carry
   * placeholders (see template.ts).
   */
  readonly subtitle?: string;
  /**
   * Used when `subtitle` has a placeholder the matching event cannot fill.
   *
   * One rule can match more than one event shape -- a planet's signals arrive in
   * both `FSSBodySignals` and `SAASignalsFound`, and only the second lists the
   * genera -- so the count it can state depends on which one matched. Without a
   * fallback the line would vanish exactly when the less detailed event matched.
   */
  readonly subtitleFallback?: string;
  readonly when: Condition;
  /**
   * Higher wins. §6 requires a priority system so the commander is not shown ten
   * links at once; the resolver ranks by this and surfaces only the top contexts.
   */
  readonly priority: number;
  /**
   * How long this context stays relevant after it last matched, in seconds.
   *
   * This is "how long the situation plausibly continues", NOT "how long to keep
   * talking about it". A commander knows what they just did; the TTL is a fallback
   * for when nothing tells us the activity ended, not a licence to keep a finished
   * one on screen.
   */
  readonly ttlSeconds: number;
  /**
   * Events that end this context outright, whatever its TTL says.
   *
   * An activity is over when the commander demonstrably moves on: undocking from
   * the Engineer, leaving the ring, jumping to another system. Without this the TTL
   * was the only thing that could end a context, so "Engineering" followed the
   * commander across three systems and covered up where they actually were.
   *
   * Names are raw journal event names, matched exactly.
   */
  readonly endsOn?: readonly string[];
  readonly resources: readonly ContextResource[];
  /**
   * Extra explanation, shown only in New CMDR mode.
   *
   * Declared on the rule rather than written into React, so it travels with the
   * thing it explains -- a server rule set and a plugin get it for free, and
   * nobody has to find the component that renders a context in order to explain
   * one.
   *
   * Deliberately NOT an article. EDFM is the reference; this is the sentence or
   * two that makes the context make sense to someone who has not met the
   * mechanic, with a link for the rest.
   */
  readonly guidance?: ContextGuidance;
  /**
   * Short imperative steps the commander can act on right now, e.g. "Follow the
   * blue circle to fight the interdiction." Most contexts are informational —
   * this is for the minority where there is something to actually do.
   */
  readonly actions?: readonly string[];
  /**
   * One editorial remark, rendered with the "EDFM Note:" prefix convention used
   * throughout the app for guidance that is not read directly off the journal.
   */
  readonly note?: string;
}

/**
 * Subject-tagged explanatory text.
 *
 * `topic` is carried now and not yet acted on. The first milestone has two
 * levels and no per-topic preference, but tagging from the start means adding
 * "explain exobiology but not mining" later is a settings change rather than a
 * migration of every rule that exists by then.
 */
export interface ContextGuidance {
  /** e.g. `exobiology`, `mining`, `engineering`. Free-form; not an enum yet. */
  readonly topic?: string;
  /**
   * Shown at the `new-cmdr` level. One or two sentences.
   *
   * Length-capped by the sanitiser: a rule set is untrusted input, and an
   * overlay is not where a wall of text belongs.
   */
  readonly beginner?: string;
}

/** How much explanation the commander asked for. Never changes which facts are shown. */
export type GuidanceMode = 'standard' | 'new-cmdr';

export const DEFAULT_GUIDANCE_MODE: GuidanceMode = 'standard';

export interface ContextRuleSet {
  /** Bumped by the server whenever rules change; used for cache validation (§23). */
  readonly version: number;
  readonly updatedAt: string;
  /** Where this set came from, so the UI can be honest about staleness. */
  readonly source: 'bundled' | 'cached' | 'remote';
  readonly rules: readonly ContextRule[];
}

/**
 * How a rule ends.
 *
 * - `event`: about something that happened (a journal line matched). Runs down a
 *   timer measured from the journal's own timestamp.
 * - `state`: about where the commander is (docked at a carrier). True exactly
 *   while that state holds, and never refreshed by unrelated journal lines.
 */
export type ContextScope = 'event' | 'state';

/** A rule currently considered relevant. */
export interface ActiveContext {
  readonly rule: ContextRule;
  readonly scope: ContextScope;
  /**
   * Rule text with placeholders resolved against the event that matched.
   *
   * Rendered here rather than at display time because the values come from the
   * triggering event, which is gone by the time the UI draws. Equal to the rule's
   * own strings when it contains no placeholders, which is almost all of them.
   */
  readonly title: string;
  readonly subtitle: string | null;
  /**
   * When it became relevant (epoch ms), by the journal's clock.
   *
   * For an event-scoped rule, the timestamp of the newest matching line. For a
   * state-scoped rule, the line at which the state started to hold; re-checking
   * the same state on later lines does not move it.
   */
  readonly matchedAt: number;
  /** When it stops being relevant (epoch ms). Infinite for state-scoped rules. */
  readonly expiresAt: number;
  /**
   * The journal event that started it, for diagnostics only (§27). Null when a
   * rule-set change found the state already true, with no line to point at.
   */
  readonly triggerEvent: string | null;
  readonly triggerEventId: string | null;
}

/**
 * How a context relates to the game right now, for display.
 *
 * - `current`: a state-scoped context while the game is running.
 * - `recent`: an event-scoped context still inside its time window.
 * - `last-session`: a state-scoped context after the game has closed. True when
 *   the commander last played, not now, and labelled as such.
 */
export type ContextTiming = 'current' | 'recent' | 'last-session';

/* ------------------------------------------------------------------ limits */

/**
 * Guards against a pathological or hostile rule set. These are cheap insurance:
 * the client is not in a position to audit what the server sends it.
 */
export const RULE_LIMITS = {
  maxRules: 500,
  maxConditionDepth: 12,
  maxResourcesPerRule: 8,
  maxStringLength: 512,
  /** Enough for a short numbered checklist; more than that is not readable mid-flight. */
  maxActions: 4,
  /**
   * Beginner guidance is a nudge, not an article.
   *
   * Shorter than a note on purpose: this can appear in the overlay, over the
   * game, where anything longer is unreadable and unwelcome.
   */
  maxGuidanceChars: 240,
  /** A handful of "you have moved on" events is plenty; more suggests a modelling error. */
  maxEndsOn: 8,
} as const;
