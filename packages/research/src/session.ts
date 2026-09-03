/**
 * The generic session tracker.
 *
 * Nothing here knows what a settlement is. It opens a session when a project's
 * start rule matches, accumulates observations, and closes it when an end event
 * arrives — driven entirely by the declarative definition.
 *
 * Two behaviours are deliberate and both come from measurement rather than
 * taste, so they are documented where they are implemented:
 *
 *  - duplicate collapse, because one pickup emits two journal events;
 *  - honest endings, because 2 of 30 real sessions ended in death rather
 *    than in a clean departure.
 */

import { evaluate, type Condition } from '@edfm/context';
import type { CommanderState, NormalizedEvent } from '@edfm/elite-journal';
import type {
  Completeness,
  FieldSource,
  Observation,
  ObservationRule,
  ObservedSession,
  ResearchProject,
  SessionContext,
  SessionOutcome,
} from './types.js';

export interface TrackerOptions {
  readonly project: ResearchProject;
  readonly companionVersion: string;
  /** Injected so tests are not at the mercy of the clock. */
  readonly now?: () => Date;
  readonly onSessionClosed?: (session: ObservedSession) => void;
}

interface PendingContext {
  readonly context: SessionContext;
  readonly capturedAt: number;
  readonly expiresAt: number;
  /** The raw event, so a start rule can compare fields against it. */
  readonly event: NormalizedEvent;
}

/** Reads a dotted path out of a raw journal payload. Never throws. */
export function readPath(payload: unknown, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    // Refuse prototype traversal: these paths come from a server.
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function readSource(payload: unknown, source: FieldSource): unknown {
  const value = readPath(payload, source.path);
  if (value !== undefined && value !== null) return value;
  return source.fallbackPath === undefined ? undefined : readPath(payload, source.fallbackPath);
}

/** Absent stays absent: a missing field becomes null, never a guess. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function matchesEvent(rule: { on: string | readonly string[] }, name: string): boolean {
  return typeof rule.on === 'string' ? rule.on === name : rule.on.includes(name);
}

function holds(when: Condition | undefined, event: NormalizedEvent, state: CommanderState): boolean {
  if (when === undefined) return true;
  try {
    return evaluate(when, { event, state });
  } catch {
    // A malformed server-supplied rule must not stop ingest, and must not
    // silently open sessions either. Fail closed.
    return false;
  }
}

const seconds = (a: string, b: string): number =>
  (Date.parse(b) - Date.parse(a)) / 1000;

export class SessionTracker {
  private readonly project: ResearchProject;
  private readonly companionVersion: string;
  private readonly now: () => Date;
  private readonly onClosed: ((session: ObservedSession) => void) | undefined;

  /** Context captured but not yet used, newest last. */
  private pending: PendingContext[] = [];
  private active: {
    session: ObservedSession;
    observations: Observation[];
    /** Dedupe ledger: item name -> timestamps already counted. */
    seen: Map<string, number[]>;
  } | null = null;

  private closed: ObservedSession[] = [];
  private counter = 0;

  constructor(options: TrackerOptions) {
    this.project = options.project;
    this.companionVersion = options.companionVersion;
    this.now = options.now ?? (() => new Date());
    this.onClosed = options.onSessionClosed;
  }

  get openSession(): ObservedSession | null {
    return this.active?.session ?? null;
  }

  sessions(): readonly ObservedSession[] {
    return this.closed;
  }

  /** Feed one journal event. Returns true when something changed. */
  observe(event: NormalizedEvent, state: CommanderState): boolean {
    const name = event.source.event;
    let changed = false;

    if (this.captureContext(event, state)) changed = true;

    if (this.active === null) {
      if (this.tryStart(event, state)) changed = true;
      return changed;
    }

    // End before observe: an event that closes the session is not also an
    // observation inside it.
    if (this.project.end.includes(name)) {
      this.close(name, event.source.provenance.timestamp);
      return true;
    }

    if (this.record(event, state)) changed = true;
    return changed;
  }

  /**
   * The journal stopped while a session was open.
   *
   * Recorded as `interrupted` rather than quietly discarded or silently closed:
   * a session whose end was never observed is different evidence from one that
   * ended cleanly, and §13 wants incomplete sessions counted.
   */
  finish(): void {
    if (this.active === null) return;
    this.close(null, undefined, 'interrupted');
  }

  private captureContext(event: NormalizedEvent, state: CommanderState): boolean {
    const name = event.source.event;
    let captured = false;

    for (const rule of this.project.context) {
      if (!matchesEvent(rule, name)) continue;
      if (!holds(rule.when, event, state)) continue;

      const context: Record<string, string | null> = {};
      for (const [key, source] of Object.entries(rule.capture)) {
        context[key] = asText(readSource(event.source.raw, source));
      }

      const at = Date.parse(event.source.provenance.timestamp);
      this.pending.push({
        context,
        capturedAt: at,
        expiresAt: at + rule.expiresAfterSeconds * 1000,
        event,
      });
      captured = true;
    }

    if (captured) this.prunePending(Date.parse(event.source.provenance.timestamp));
    return captured;
  }

  private prunePending(nowMs: number): void {
    // Bounded as well as expiring: a long session of approaches with no
    // disembarks must not grow this without limit.
    this.pending = this.pending.filter((p) => p.expiresAt >= nowMs).slice(-8);
  }

  private tryStart(event: NormalizedEvent, state: CommanderState): boolean {
    const rule = this.project.start;
    if (!matchesEvent(rule, event.source.event)) return false;
    if (!holds(rule.when, event, state)) return false;

    const at = Date.parse(event.source.provenance.timestamp);
    this.prunePending(at);

    let context: SessionContext | null = null;

    if (rule.requireContextMatch === undefined) {
      context = this.pending.length > 0 ? this.pending[this.pending.length - 1]!.context : {};
    } else {
      // Newest first: if two settlements were approached, the most recent one
      // is the one being walked into.
      for (let i = this.pending.length - 1; i >= 0; i -= 1) {
        const candidate = this.pending[i]!;
        const allMatch = Object.entries(rule.requireContextMatch).every(([key, source]) => {
          const fromStart = asText(readSource(event.source.raw, source));
          const fromContext = candidate.context[key] ?? null;
          // Both must be present AND equal. A missing value on either side
          // cannot establish that this is the same place, and guessing here is
          // how an unrelated station walk becomes a settlement observation.
          return fromStart !== null && fromContext !== null && fromStart === fromContext;
        });
        if (allMatch) {
          // Deliberately NOT consumed. A commander who embarks to reposition
          // the ship and then disembarks again at the same settlement is on a
          // second observed session there, and consuming the approach would
          // silently discard everything collected on it. Measured: 28 of 48
          // approach/disembark pairs in the real corpus are a repeat use of an
          // approach that was already matched once.
          //
          // Staleness is handled by the expiry window instead, which is the
          // control that actually belongs here: the widest real gap between an
          // approach and a disembark on the same body is 3.9 days.
          context = candidate.context;
          break;
        }
      }
    }

    if (context === null) return false;

    this.counter += 1;
    this.active = {
      observations: [],
      seen: new Map(),
      session: {
        id: `${this.project.id}:${event.source.provenance.eventId}:${this.counter}`,
        projectId: this.project.id,
        projectVersion: this.project.version,
        startedAt: event.source.provenance.timestamp,
        endedAt: null,
        durationSeconds: null,
        context,
        observations: [],
        outcome: 'active',
        endEvent: null,
        completeness: 'unknown',
        // From the event source, not from CommanderState: that field is a
        // Known<T> whose "unknown" is a symbol, and `?? null` would let the
        // symbol through into a record that claims to hold a name or null.
        commander: event.source.provenance.commander,
        commanderFid: event.source.provenance.fid,
        gameVersion: event.source.provenance.gameVersion,
        gameBuild: event.source.provenance.build,
        companionVersion: this.companionVersion,
        sessionKey: event.source.provenance.sourceFile,
      },
    };
    return true;
  }

  private record(event: NormalizedEvent, state: CommanderState): boolean {
    const active = this.active;
    if (active === null) return false;

    const name = event.source.event;
    let added = false;

    for (const rule of this.project.observe) {
      if (!matchesEvent(rule, name)) continue;
      if (!holds(rule.when, event, state)) continue;

      for (const item of this.extract(rule, event)) {
        if (this.isDuplicate(active.seen, rule, item)) continue;
        active.observations.push(item);
        added = true;
      }
    }

    if (added) {
      this.active = {
        ...active,
        session: { ...active.session, observations: [...active.observations] },
      };
    }
    return added;
  }

  /**
   * One event may describe several items.
   *
   * `CollectItems` names a single item at the top level, while
   * `BackpackChange.Added` is an array. Both shapes are handled so a project can
   * draw on either without the framework caring which.
   */
  private extract(rule: ObservationRule, event: NormalizedEvent): Observation[] {
    const raw = event.source.raw as Record<string, unknown>;
    const out: Observation[] = [];

    const build = (payload: unknown): Observation | null => {
      const name = asText(readSource(payload, rule.name));
      if (name === null || name === '') return null;
      const rawCount = rule.count ? readSource(payload, rule.count) : 1;
      const count = typeof rawCount === 'number' && Number.isFinite(rawCount) ? rawCount : 1;
      return {
        name: name.toLowerCase(),
        label: rule.label ? asText(readSource(payload, rule.label)) : null,
        category: rule.category ? asText(readSource(payload, rule.category)) : null,
        count,
        at: event.source.provenance.timestamp,
        sourceEventId: event.source.provenance.eventId,
        sourceEvent: event.source.event,
      };
    };

    // An array at the head of the name path means the event carries a list.
    const head = rule.name.path.split('.')[0]!;
    const container = raw[head];
    if (Array.isArray(container)) {
      const tail = rule.name.path.slice(head.length + 1);
      for (const entry of container) {
        const item = build(tail === '' ? entry : { [head]: entry });
        if (item !== null) out.push(item);
      }
      return out;
    }

    const single = build(raw);
    return single === null ? [] : [single];
  }

  /**
   * Has this exact item already been counted a moment ago?
   *
   * Not an optimisation. Measured across 224 real journals: one pickup emits
   * both `CollectItems` and `BackpackChange.Added`, and 258 of 281 collections
   * appear in both within a second. Without this, every material is counted
   * roughly twice.
   */
  private isDuplicate(
    seen: Map<string, number[]>,
    rule: ObservationRule,
    item: Observation,
  ): boolean {
    const window = rule.dedupeWindowSeconds;
    if (window === undefined || window <= 0) return false;

    const at = Date.parse(item.at);
    const key = `${item.name}|${item.count}`;
    const times = seen.get(key) ?? [];

    if (times.some((t) => Math.abs(at - t) <= window * 1000)) return true;

    times.push(at);
    seen.set(key, times.filter((t) => at - t <= window * 4000));
    return false;
  }

  private close(endEvent: string | null, at?: string, forced?: SessionOutcome): void {
    const active = this.active;
    if (active === null) return;

    // The closing event's own timestamp, not the last observation's. Taking it
    // from the last observation makes a session that collected early and then
    // kept searching look ten times shorter than it was, which would then be
    // discarded as implausibly short.
    const closingTime = at ?? this.now().toISOString();

    let outcome: SessionOutcome = forced ?? 'ended';
    if (forced === undefined && endEvent !== null) {
      outcome = (this.project.abortiveEnd ?? []).includes(endEvent) ? 'died' : 'ended';
    }

    const session: ObservedSession = {
      ...active.session,
      endedAt: closingTime,
      durationSeconds: Math.max(0, Math.round(seconds(active.session.startedAt, closingTime))),
      observations: [...active.observations],
      outcome,
      endEvent,
    };

    this.active = null;
    this.closed.push(session);
    this.onClosed?.(session);
  }

  /** §12: the commander may mark completeness, but is never asked to. */
  markCompleteness(sessionId: string, completeness: Completeness): boolean {
    const index = this.closed.findIndex((s) => s.id === sessionId);
    if (index === -1) return false;
    this.closed[index] = { ...this.closed[index]!, completeness };
    return true;
  }

  /** For restoring across a restart. */
  load(sessions: readonly ObservedSession[]): void {
    this.closed = [...sessions];
  }
}

/**
 * Is this session long enough and short enough to be a plausible visit?
 *
 * Not a filter — implausible sessions are still recorded, because discarding
 * inconvenient data is how a corpus acquires silent bias. It is a label, so a
 * consumer can exclude them explicitly and say that it did.
 */
export function isPlausible(session: ObservedSession, project: ResearchProject): boolean {
  const duration = session.durationSeconds;
  if (duration === null) return false;
  if (project.minPlausibleSeconds !== undefined && duration < project.minPlausibleSeconds) {
    return false;
  }
  if (project.maxPlausibleSeconds !== undefined && duration > project.maxPlausibleSeconds) {
    return false;
  }
  return session.outcome !== 'interrupted';
}
