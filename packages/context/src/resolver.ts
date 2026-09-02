/**
 * Context resolution.
 *
 * Feeds every normalized journal event through the rule set and maintains the
 * currently-relevant contexts, ranked. §6 requires a priority system precisely so
 * the commander is not handed ten links at once.
 */

import type { CommanderState, NormalizedEvent } from '@edfm/elite-journal';

import { evaluate, usesEvent } from './evaluate.js';
import { RULE_LIMITS, type ActiveContext, type ContextRule, type ContextRuleSet } from './types.js';

export interface ResolverOptions {
  /** How many contexts the UI will show. Ranking happens over all matches. */
  readonly maxActive?: number;
  /** Injected for deterministic tests. */
  readonly now?: () => number;
}

export class ContextResolver {
  private ruleSet: ContextRuleSet;
  private readonly active = new Map<string, ActiveContext>();
  /** Rule ids whose conditions never reference the triggering event. */
  private stateScoped = new Set<string>();
  private readonly maxActive: number;
  private readonly now: () => number;

  constructor(ruleSet: ContextRuleSet, options: ResolverOptions = {}) {
    this.ruleSet = sanitise(ruleSet);
    this.stateScoped = scopedIds(this.ruleSet);
    this.maxActive = options.maxActive ?? 3;
    this.now = options.now ?? (() => Date.now());
  }

  get version(): number {
    return this.ruleSet.version;
  }

  get source(): ContextRuleSet['source'] {
    return this.ruleSet.source;
  }

  /**
   * Swap in a new rule set.
   *
   * Active contexts are dropped: they were derived from rules that may no longer
   * exist, and carrying them forward would show the commander guidance the current
   * rule set does not actually endorse.
   */
  setRuleSet(ruleSet: ContextRuleSet): void {
    this.ruleSet = sanitise(ruleSet);
    this.stateScoped = scopedIds(this.ruleSet);
    this.active.clear();
  }

  /**
   * Evaluate one event. Returns true when the active set changed, so the caller can
   * avoid re-rendering on the thousands of events that match nothing (§30).
   */
  observe(event: NormalizedEvent, state: CommanderState): boolean {
    const now = this.now();
    let changed = this.expire(now);

    for (const rule of this.ruleSet.rules) {
      const matches = evaluate(rule.when, { event, state });

      if (!matches) {
        // A state-scoped rule is true exactly while its situation holds. Letting
        // it ride out a TTL kept "Fleet Carrier services" on screen for half an
        // hour after the commander had docked somewhere else entirely.
        if (this.stateScoped.has(rule.id) && this.active.delete(rule.id)) changed = true;
        continue;
      }

      const previous = this.active.get(rule.id);
      this.active.set(rule.id, {
        rule,
        matchedAt: now,
        // State-scoped rules are held open by their condition, not by a clock.
        expiresAt: this.stateScoped.has(rule.id)
          ? Number.POSITIVE_INFINITY
          : now + rule.ttlSeconds * 1000,
        triggerEvent: event.source.event,
        triggerEventId: event.source.provenance.eventId,
      });
      // Re-matching an already-active rule only refreshes its expiry; that is not a
      // visible change and should not force a render.
      if (!previous) changed = true;
    }

    return changed;
  }

  /**
   * Currently relevant contexts, most relevant first.
   *
   * Ranked by priority, then by recency. Recency breaks ties because two rules of
   * equal priority are best ordered by what the commander just did.
   */
  current(): readonly ActiveContext[] {
    this.expire(this.now());
    return [...this.active.values()]
      .sort((a, b) => b.rule.priority - a.rule.priority || b.matchedAt - a.matchedAt)
      .slice(0, this.maxActive);
  }

  /** Everything active, unranked and untruncated — for diagnostics, not the UI. */
  all(): readonly ActiveContext[] {
    this.expire(this.now());
    return [...this.active.values()];
  }

  clear(): void {
    this.active.clear();
  }

  private expire(now: number): boolean {
    let changed = false;
    for (const [id, ctx] of this.active) {
      if (ctx.expiresAt <= now) {
        this.active.delete(id);
        changed = true;
      }
    }
    return changed;
  }
}

/**
 * Clamp an incoming rule set to sane bounds.
 *
 * Rule sets arrive over the network. This does not attempt to validate semantics —
 * a nonsensical rule simply never matches — but it does stop an oversized or
 * malformed payload from degrading the client.
 */
export function sanitise(ruleSet: ContextRuleSet): ContextRuleSet {
  const rules: ContextRule[] = [];
  const seen = new Set<string>();

  for (const rule of ruleSet.rules ?? []) {
    if (rules.length >= RULE_LIMITS.maxRules) break;
    if (!rule || typeof rule.id !== 'string' || rule.id.length === 0) continue;
    if (seen.has(rule.id)) continue; // duplicate ids would make expiry ambiguous
    if (typeof rule.title !== 'string' || !rule.when) continue;

    seen.add(rule.id);
    rules.push({
      ...rule,
      priority: Number.isFinite(rule.priority) ? rule.priority : 0,
      // A missing or absurd TTL must not pin a context on screen forever.
      ttlSeconds:
        Number.isFinite(rule.ttlSeconds) && rule.ttlSeconds > 0
          ? Math.min(rule.ttlSeconds, 24 * 60 * 60)
          : 300,
      resources: (rule.resources ?? []).slice(0, RULE_LIMITS.maxResourcesPerRule),
    });
  }

  return { ...ruleSet, rules };
}

/** Ids of rules whose conditions never reference the triggering event. */
function scopedIds(ruleSet: ContextRuleSet): Set<string> {
  const out = new Set<string>();
  for (const rule of ruleSet.rules) {
    if (!usesEvent(rule.when)) out.add(rule.id);
  }
  return out;
}
