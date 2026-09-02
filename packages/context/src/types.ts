/**
 * Context rule schema.
 *
 * Rules are **server-driven and versioned** (§6), which means they arrive from the
 * network and must be treated as untrusted data. Two consequences shape this schema:
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
  /** A dotted path into the raw journal payload of the triggering event. */
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
}

export interface ContextRule {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly when: Condition;
  /**
   * Higher wins. §6 requires a priority system so the commander is not shown ten
   * links at once; the resolver ranks by this and surfaces only the top contexts.
   */
  readonly priority: number;
  /**
   * How long this context stays relevant after it last matched, in seconds.
   * Without decay, a context triggered once would linger for the whole session.
   */
  readonly ttlSeconds: number;
  readonly resources: readonly ContextResource[];
}

export interface ContextRuleSet {
  /** Bumped by the server whenever rules change; used for cache validation (§23). */
  readonly version: number;
  readonly updatedAt: string;
  /** Where this set came from, so the UI can be honest about staleness. */
  readonly source: 'bundled' | 'cached' | 'remote';
  readonly rules: readonly ContextRule[];
}

/** A rule currently considered relevant. */
export interface ActiveContext {
  readonly rule: ContextRule;
  /** When it last matched (epoch ms). */
  readonly matchedAt: number;
  /** When it stops being relevant (epoch ms). */
  readonly expiresAt: number;
  /** The event that triggered it, for provenance and diagnostics (§27). */
  readonly triggerEvent: string;
  readonly triggerEventId: string;
}

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
} as const;
