/**
 * Context resolution.
 *
 * Feeds every normalized journal event through the rule set and maintains the
 * currently-relevant contexts, ranked. §6 requires a priority system precisely so
 * the commander is not handed ten links at once.
 *
 * ## Time
 *
 * Event-scoped contexts are timed by the journal line's own timestamp, not by
 * when the app happened to read it. The app re-reads the current session at
 * startup to rebuild state, and a first run reads a whole journal: measured by
 * the reading clock, a prospecting run from three hours ago would come back as
 * if it had just happened. Measured by the journal's clock it is simply expired,
 * while the last few minutes of a session the commander is still playing come
 * back exactly as relevant as they were.
 *
 * ## Sessions and commanders
 *
 * A context belongs to one commander and one game session:
 *
 *  - a different commander's line clears everything, before it is evaluated;
 *  - `Fileheader`, `LoadGame` and `Shutdown` end every event-scoped context, so a
 *    finished session's activity never leaks into the next one, even after a
 *    crash that wrote no `Shutdown`;
 *  - state-scoped contexts follow the commander's state. Whether that state is
 *    current or only "when you last played" is decided by the app, which knows
 *    whether the game is running (see `contextTiming`).
 */

import { isKnown, type CommanderState, type NormalizedEvent } from '@edfm/elite-journal';

import { evaluate, usesEvent } from './evaluate.js';
import { renderTemplate } from './template.js';
import { safeExternalUrl } from './wiki.js';
import {
  RULE_LIMITS,
  type ActiveContext,
  type ContextResource,
  type ContextRule,
  type ContextRuleSet,
  type ContextScope,
  type ContextTiming,
  type ResourceGate,
} from './types.js';

export interface ResolverOptions {
  /** How many contexts the UI will show. Ranking happens over all matches. */
  readonly maxActive?: number;
  /** Injected for deterministic tests. */
  readonly now?: () => number;
}

/**
 * Lines that start or end a game session. Every event-scoped context ends on
 * them: what the commander was doing belongs to the session they did it in.
 */
export const SESSION_BOUNDARY_EVENTS: readonly string[] = ['Fileheader', 'LoadGame', 'Shutdown'];

export class ContextResolver {
  private ruleSet: ContextRuleSet;
  private readonly active = new Map<string, ActiveContext>();
  /** Rule ids whose conditions never reference the triggering event. */
  private stateScoped = new Set<string>();
  private readonly maxActive: number;
  private readonly now: () => number;
  /** The commander the active contexts belong to, once known. */
  private commander: string | null = null;
  /**
   * The state last observed, by reference: the app mutates one state object in
   * place, so this is always the current one. Lets a rule-set change re-check
   * state-scoped rules without inventing a journal line to do it.
   */
  private lastState: CommanderState | null = null;

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

  /** Rules loaded after sanitising, for diagnostics. */
  get ruleCount(): number {
    return this.ruleSet.rules.length;
  }

  /**
   * Swap in a new rule set without losing what is still true.
   *
   * Enabling or disabling a plugin replaces the whole set, and clearing every
   * active context here blanked the page until the next matching journal line --
   * for a commander parked at a station, possibly for the rest of the session.
   * Instead:
   *
   *  - a context whose rule is gone is dropped: the current set no longer
   *    endorses it;
   *  - a context whose rule survives keeps its time and takes the new
   *    definition (an event-scoped one re-timed against the new TTL);
   *  - state-scoped rules are re-checked against the current state, which is
   *    real information already held, rather than a made-up event.
   */
  setRuleSet(ruleSet: ContextRuleSet): void {
    this.ruleSet = sanitise(ruleSet);
    this.stateScoped = scopedIds(this.ruleSet);

    const byId = new Map(this.ruleSet.rules.map((r) => [r.id, r]));
    const now = this.now();
    for (const [id, ctx] of [...this.active]) {
      const rule = byId.get(id);
      const scope: ContextScope = this.stateScoped.has(id) ? 'state' : 'event';
      if (!rule || scope !== ctx.scope) {
        this.active.delete(id);
        continue;
      }
      if (scope === 'event') {
        const expiresAt = ctx.matchedAt + rule.ttlSeconds * 1000;
        if (expiresAt <= now) {
          this.active.delete(id);
          continue;
        }
        this.active.set(id, { ...ctx, rule, expiresAt });
      } else {
        this.active.set(id, { ...ctx, rule });
      }
    }

    if (this.lastState !== null) this.checkState(this.lastState, null, now);
  }

  /**
   * Evaluate one event. Returns true when the active set changed, so the caller can
   * avoid re-rendering on the thousands of events that match nothing (§30).
   */
  observe(event: NormalizedEvent, state: CommanderState): boolean {
    const now = this.now();
    this.lastState = state;
    let changed = this.expire(now);

    // Another commander's line: nothing shown so far is theirs. Cleared before
    // the line is evaluated, so what it matches belongs to the new commander.
    const fid = isKnown(state.fid) ? state.fid : null;
    if (fid !== null) {
      if (this.commander !== null && fid !== this.commander && this.active.size > 0) {
        this.active.clear();
        changed = true;
      }
      this.commander = fid;
    }

    // The journal's own clock. A line stamped in the future (clock skew between
    // the game and this machine) is treated as now rather than trusted to pin a
    // context beyond its TTL; an unparseable stamp is also treated as now.
    const stamped = event.source.provenance.timestampMs;
    const at = stamped !== null && Number.isFinite(stamped) ? Math.min(stamped, now) : now;

    const eventName = event.source.event;
    const boundary = SESSION_BOUNDARY_EVENTS.includes(eventName);

    // End contexts the commander has demonstrably moved on from, before anything
    // is matched. A finished activity is not competing for attention with where
    // they are now: they already know what they did, and the TTL is only a
    // fallback for when nothing says the activity ended.
    //
    // Deleting the current entry while iterating a Map is well defined.
    for (const [id, ctx] of this.active) {
      if (ctx.scope !== 'event') continue;
      if ((boundary || ctx.rule.endsOn?.includes(eventName)) && this.active.delete(id)) changed = true;
    }

    for (const rule of this.ruleSet.rules) {
      if (this.stateScoped.has(rule.id)) continue;
      if (!evaluate(rule.when, { event, state })) continue;

      // Too old to be relevant by the time it is read: a re-read session's
      // early hours, or a first run's whole journal. Not a new trigger.
      const expiresAt = at + rule.ttlSeconds * 1000;
      if (expiresAt <= now) continue;

      const previous = this.active.get(rule.id);
      // Lines arrive in journal order; an older line never replaces a newer one.
      if (previous && previous.matchedAt > at) continue;

      // Rendered against the event that matched, because that event carries the
      // values and will not be available later.
      const { title, subtitle } = renderText(rule, { event, state });
      this.active.set(rule.id, {
        rule,
        scope: 'event',
        title,
        subtitle,
        matchedAt: at,
        expiresAt,
        triggerEvent: eventName,
        triggerEventId: event.source.provenance.eventId,
      });
      // Re-matching an already-active rule normally only refreshes its expiry, which
      // is not a visible change. Rendered text is the exception: a count that has
      // moved is exactly the sort of thing the commander is watching for.
      if (!previous || previous.title !== title || previous.subtitle !== subtitle) changed = true;
    }

    if (this.checkState(state, event, at)) changed = true;
    return changed;
  }

  /**
   * State-scoped rules, checked against state alone.
   *
   * They describe where the commander is, so the journal line that happened to
   * prompt the check is irrelevant to them -- evaluating them with it is what
   * once made "Fleet Carrier services" report "Triggered by Shutdown". The line
   * is recorded only when the state first starts to hold.
   */
  private checkState(state: CommanderState, event: NormalizedEvent | null, at: number): boolean {
    let changed = false;
    for (const rule of this.ruleSet.rules) {
      if (!this.stateScoped.has(rule.id)) continue;

      if (!evaluate(rule.when, { event: null, state })) {
        // True exactly while its situation holds. Letting it ride out a TTL kept
        // "Fleet Carrier services" on screen for half an hour after the commander
        // had docked somewhere else entirely.
        if (this.active.delete(rule.id)) changed = true;
        continue;
      }

      const previous = this.active.get(rule.id);
      const { title, subtitle } = renderText(rule, { event: null, state });
      if (previous && previous.title === title && previous.subtitle === subtitle) continue;

      this.active.set(rule.id, {
        rule,
        scope: 'state',
        title,
        subtitle,
        matchedAt: previous?.matchedAt ?? at,
        expiresAt: Number.POSITIVE_INFINITY,
        triggerEvent: previous ? previous.triggerEvent : (event?.source.event ?? null),
        triggerEventId: previous ? previous.triggerEventId : (event?.source.provenance.eventId ?? null),
      });
      changed = true;
    }
    return changed;
  }

  /**
   * Currently relevant contexts, most relevant first.
   *
   * Ranked by *decayed* priority, then by recency. Recency still breaks ties,
   * because two equally relevant rules are best ordered by what happened last.
   */
  current(): readonly ActiveContext[] {
    const now = this.now();
    this.expire(now);
    return [...this.active.values()]
      .sort((a, b) => this.relevance(b, now) - this.relevance(a, now) || b.matchedAt - a.matchedAt)
      .slice(0, this.maxActive);
  }

  /**
   * How relevant an active context is *right now*.
   *
   * The two kinds of rule make different claims and cannot share one static number:
   *
   *  - **Event-scoped** rules describe something that *happened*. "Recent
   *    engineering activity" is by definition in the past, and gets less worth
   *    saying every minute. Their priority decays linearly across their own TTL, so
   *    a rule states how long its subject stays interesting by choosing that TTL.
   *  - **State-scoped** rules describe where the commander *is*. They are held open
   *    by their condition rather than a clock, so they do not decay -- being
   *    docked at a Material Trader is exactly as true after twenty minutes as it
   *    was on arrival.
   *
   * Without this, static priority let a past activity hide a present fact:
   * `engineering-activity` (75, 15-minute TTL) outranked a Material Trader (58) for
   * a full quarter of an hour after the commander had flown to another system and
   * docked -- and since the overlay shows only the top context, the trader was
   * invisible the whole time.
   *
   * Actively doing the thing keeps it on top regardless: each new EngineerCraft
   * refreshes `matchedAt`, restoring full priority.
   */
  private relevance(ctx: ActiveContext, now: number): number {
    if (ctx.scope === 'state') return ctx.rule.priority;

    const ttlMs = ctx.rule.ttlSeconds * 1000;
    if (ttlMs <= 0) return 0;
    const elapsed = Math.max(0, now - ctx.matchedAt);
    // Reaches zero exactly at expiry, which is when the context disappears anyway.
    return ctx.rule.priority * Math.max(0, 1 - elapsed / ttlMs);
  }

  /** Everything active, unranked and untruncated — for diagnostics, not the UI. */
  all(): readonly ActiveContext[] {
    this.expire(this.now());
    return [...this.active.values()];
  }

  /**
   * Drop whatever has run out of time. Returns true when something did.
   *
   * Contexts otherwise expire only when a journal line arrives, and a commander
   * sitting still writes none -- so the app calls this on a timer to stop a
   * finished activity lingering on screen.
   */
  prune(): boolean {
    return this.expire(this.now());
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
 * How a context relates to the game right now.
 *
 * `gameRunning` is the app's judgement, from the game window and the journal
 * (see session.ts): the resolver cannot know whether Elite is still open, only
 * what the journal last said. A state-scoped context from a closed game is still
 * true of when the commander last played, and still useful, but it is not
 * current and must not be presented as if it were.
 */
export function contextTiming(ctx: Pick<ActiveContext, 'scope'>, gameRunning: boolean): ContextTiming {
  if (ctx.scope === 'event') return 'recent';
  return gameRunning ? 'current' : 'last-session';
}

function renderText(
  rule: ContextRule,
  input: { event: NormalizedEvent | null; state: CommanderState },
): { title: string; subtitle: string | null } {
  const title = renderTemplate(rule.title, input) ?? stripPlaceholders(rule.title);
  let subtitle: string | null = null;
  if (rule.subtitle !== undefined) subtitle = renderTemplate(rule.subtitle, input);
  if (subtitle === null && rule.subtitleFallback !== undefined) {
    subtitle = renderTemplate(rule.subtitleFallback, input);
  }
  return { title, subtitle };
}

/**
 * Fallback when a placeholder cannot be resolved.
 *
 * A title must render as something, so the literal parts are kept and the
 * unresolvable placeholder is dropped rather than printed raw. A subtitle is
 * optional and is simply omitted instead — see `renderTemplate`.
 */
function stripPlaceholders(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    const close = text.indexOf('}', open + 1);
    if (close === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    i = close + 1;
  }
  const collapsed = out.split(' ').filter((w) => w.length > 0).join(' ').trim();
  // If a title was nothing but placeholders there is no honest shorter form, so
  // the raw template is better than an empty heading.
  return collapsed.length > 0 ? collapsed : text;
}

const GATE_KINDS = new Set(['genus', 'species', 'body-scanned', 'signals-known']);

/**
 * A spoiler gate, copied field by field, or `undefined` for "no gate".
 *
 * Returns `false` for a gate that is present but malformed. The caller drops
 * that resource: a gate it cannot read may be guarding a spoiler, and failing
 * open would show it.
 */
function cleanGate(raw: unknown): ResourceGate | undefined | false {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return false;
  const g = raw as Record<string, unknown>;
  const kind = g['kind'];
  if (typeof kind !== 'string' || !GATE_KINDS.has(kind)) return false;
  if (kind === 'genus') {
    return typeof g['genus'] === 'string' && g['genus'].length > 0 ? { kind, genus: g['genus'] } : false;
  }
  if (kind === 'species') {
    return typeof g['species'] === 'string' && g['species'].length > 0
      ? { kind, species: g['species'] }
      : false;
  }
  return { kind: kind as 'body-scanned' | 'signals-known' };
}

/**
 * One link, rebuilt from known fields only.
 *
 * Dropped unless it has a label and resolves to a URL the app may open: a wiki
 * page, or an `https:` address (see `safeExternalUrl`). Checked here, when the
 * rule set is loaded, so nothing downstream ever holds a link that would be
 * refused when clicked -- and again when the URL is built, in case a resource
 * reaches the UI some other way.
 */
function cleanResource(raw: unknown): ContextResource | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const label = typeof r['label'] === 'string' ? r['label'].trim() : '';
  if (label.length === 0) return null;

  const gate = cleanGate(r['requires']);
  if (gate === false) return null;

  let target: { page: string } | { url: string } | null = null;
  if (r['url'] !== undefined) {
    const url = safeExternalUrl(r['url']);
    if (url !== null) target = { url };
  } else if (typeof r['page'] === 'string' && r['page'].trim().length > 0) {
    target = { page: r['page'].slice(0, RULE_LIMITS.maxStringLength) };
  }
  if (target === null) return null;

  return {
    label: label.slice(0, RULE_LIMITS.maxStringLength),
    ...target,
    ...(typeof r['note'] === 'string' ? { note: r['note'].slice(0, RULE_LIMITS.maxStringLength) } : {}),
    ...(gate ? { requires: gate } : {}),
  };
}

function cappedText(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw.slice(0, RULE_LIMITS.maxStringLength) : undefined;
}

/**
 * Clamp an incoming rule set to sane bounds.
 *
 * Rule sets come from plugins today and are designed to come from a server
 * later. This does not attempt to validate semantics — a nonsensical rule simply
 * never matches — but it does stop an oversized or malformed payload from
 * degrading the client, and rebuilds each rule from known fields only, so
 * nothing unexpected rides along into the UI.
 */
export function sanitise(ruleSet: ContextRuleSet): ContextRuleSet {
  const rules: ContextRule[] = [];
  const seen = new Set<string>();

  for (const rule of Array.isArray(ruleSet.rules) ? ruleSet.rules : []) {
    if (rules.length >= RULE_LIMITS.maxRules) break;
    if (!rule || typeof rule.id !== 'string' || rule.id.length === 0) continue;
    if (rule.id.length > RULE_LIMITS.maxStringLength) continue;
    if (seen.has(rule.id)) continue; // duplicate ids would make expiry ambiguous
    if (typeof rule.title !== 'string' || rule.title.trim().length === 0) continue;
    if (!rule.when || typeof rule.when !== 'object') continue;

    seen.add(rule.id);
    const { actions: rawActions, note: rawNote, endsOn: rawEndsOn, guidance: rawGuidance } = rule;

    // Present only when there is something to show — exactOptionalPropertyTypes
    // forbids `actions: undefined`, and an absent field is the correct signal
    // to the UI anyway (nothing to render), not an empty list.
    const actions = Array.isArray(rawActions)
      ? rawActions
          .filter((a): a is string => typeof a === 'string' && a.length > 0)
          .slice(0, RULE_LIMITS.maxActions)
          .map((a) => a.slice(0, RULE_LIMITS.maxStringLength))
      : undefined;
    const note = cappedText(rawNote);
    const subtitle = cappedText(rule.subtitle);
    const subtitleFallback = cappedText(rule.subtitleFallback);

    // Guidance is untrusted text drawn over a game. Bounded like everything else
    // a rule set supplies, and dropped entirely if it carries nothing usable.
    let guidance: { topic?: string; beginner?: string } | undefined;
    if (rawGuidance !== null && typeof rawGuidance === 'object' && !Array.isArray(rawGuidance)) {
      const g = rawGuidance as Record<string, unknown>;
      const beginner =
        typeof g['beginner'] === 'string'
          ? g['beginner'].slice(0, RULE_LIMITS.maxGuidanceChars)
          : undefined;
      const topic =
        typeof g['topic'] === 'string' ? g['topic'].slice(0, RULE_LIMITS.maxStringLength) : undefined;
      if (beginner || topic) {
        guidance = { ...(topic ? { topic } : {}), ...(beginner ? { beginner } : {}) };
      }
    }

    const endsOn = Array.isArray(rawEndsOn)
      ? rawEndsOn
          .filter((e): e is string => typeof e === 'string' && e.length > 0)
          .slice(0, RULE_LIMITS.maxEndsOn)
          .map((e) => e.slice(0, RULE_LIMITS.maxStringLength))
      : undefined;

    const resources = (Array.isArray(rule.resources) ? rule.resources : [])
      .map(cleanResource)
      .filter((r: ContextResource | null): r is ContextResource => r !== null)
      .slice(0, RULE_LIMITS.maxResourcesPerRule);

    rules.push({
      id: rule.id,
      title: rule.title.slice(0, RULE_LIMITS.maxStringLength),
      when: rule.when,
      priority: Number.isFinite(rule.priority) ? rule.priority : 0,
      // A missing or absurd TTL must not pin a context on screen forever.
      ttlSeconds:
        Number.isFinite(rule.ttlSeconds) && rule.ttlSeconds > 0
          ? Math.min(rule.ttlSeconds, 24 * 60 * 60)
          : 300,
      resources,
      ...(subtitle !== undefined ? { subtitle } : {}),
      ...(subtitleFallback !== undefined ? { subtitleFallback } : {}),
      ...(actions && actions.length > 0 ? { actions } : {}),
      ...(note ? { note } : {}),
      ...(endsOn && endsOn.length > 0 ? { endsOn } : {}),
      ...(guidance ? { guidance } : {}),
    });
  }

  return {
    version: Number.isFinite(ruleSet.version) ? ruleSet.version : 0,
    updatedAt: typeof ruleSet.updatedAt === 'string' ? ruleSet.updatedAt : new Date(0).toISOString(),
    source: ruleSet.source,
    rules,
  };
}

/** Ids of rules whose conditions never reference the triggering event. */
function scopedIds(ruleSet: ContextRuleSet): Set<string> {
  const out = new Set<string>();
  for (const rule of ruleSet.rules) {
    if (!usesEvent(rule.when)) out.add(rule.id);
  }
  return out;
}
