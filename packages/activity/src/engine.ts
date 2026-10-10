/**
 * The Activity Journal engine.
 *
 * Feeds journal events through the processors and keeps the small amount of
 * context they need. Deliberately owns no storage: it returns entries, and the
 * caller decides what to do with them. That is what lets the whole thing be
 * tested against the real corpus without a database.
 *
 * ## Why it holds state at all
 *
 * One thing: BodyID to name. `ScanOrganic` reports `Body` as an integer, so an
 * entry that wants to say *which* body needs a name from somewhere else --
 * `Scan`, `SAASignalsFound` and `Touchdown` all carry both. Resolving it at write
 * time rather than at display time means the entry is self-contained and survives
 * the map being lost on restart.
 *
 * The map is bounded and cleared when the commander leaves a system, because a
 * BodyID is only unique within one.
 */

import type { NormalizedEvent } from '@edfm/elite-journal';

import {
  biologicalSignalEntries,
  exobiologyEntries,
} from './exobiology.js';
import { missionEntries } from './missions.js';
import { CombatFights, combatEntries } from './combat.js';
import { MiningRuns } from './mining.js';
import type { ActivityContext, ActivityEntry } from './types.js';

/** A system has a few dozen bodies; this is slack, not a target. */
const MAX_TRACKED_BODIES = 512;

export interface ActivityEngineOptions {
  /** Entries are scoped to a commander; nothing is recorded without one. */
  readonly commanderFid: string | null;
}

/**
 * Which body a biological-signals entry is about.
 *
 * `SAASignalsFound` is written again every time the commander returns to a
 * mapped body, not only when it is first mapped: one body in the corpus
 * produced 42 identical "2 biological signals detected" entries over a
 * fortnight of visits. Finding the signals is one event in a commander's
 * history, so it is recorded once per body.
 */
export function signalBodyKey(e: {
  readonly systemAddress: number | null;
  readonly bodyId: number | null;
  readonly bodyName: string | null;
}): string | null {
  if (e.systemAddress !== null && e.bodyId !== null) return `${e.systemAddress}:${e.bodyId}`;
  return e.bodyName !== null ? `name:${e.bodyName.toLowerCase()}` : null;
}

export class ActivityEngine {
  private commanderFid: string | null;
  private bodyNames = new Map<number, string>();
  /** Bodies whose signals this commander already has an entry for. */
  private signalBodies = new Set<string>();
  private systemName: string | null = null;
  private systemAddress: number | null = null;
  /** Mining runs span many events, and survive a jump (the jump ends them). */
  private mining = new MiningRuns();
  /** Fights too: kills added up until the commander moves on. */
  private fights = new CombatFights();

  constructor(options: ActivityEngineOptions) {
    this.commanderFid = options.commanderFid;
  }

  /**
   * BodyID to name, as learned so far.
   *
   * Exposed read-only so live activity can resolve a body without building a
   * second map. `ScanOrganic` reports `Body` as an integer, and there should be
   * exactly one implementation that knows how to turn that into a name.
   */
  get bodyNameMap(): ReadonlyMap<number, string> {
    return this.bodyNames;
  }

  /**
   * The commander changed.
   *
   * Everything learned about bodies belongs to the previous session's location,
   * and entries are scoped by FID, so this starts clean rather than risking one
   * commander's activity being attributed to another.
   */
  setCommander(fid: string | null): void {
    if (fid === this.commanderFid) return;
    this.commanderFid = fid;
    this.reset();
    this.mining.reset();
    this.fights.reset();
  }

  private reset(): void {
    this.bodyNames.clear();
    this.signalBodies.clear();
  }

  /**
   * Bodies already recorded for this commander, from stored entries, so a
   * revisit after a restart is not recorded again either.
   */
  rememberSignalBodies(keys: Iterable<string>): void {
    for (const k of keys) this.signalBodies.add(k);
  }

  /**
   * Observe one event and return whatever activity it represents.
   *
   * Returns an empty array for the overwhelming majority, which is the point:
   * the journal is noisy and the activity record should not be.
   */
  observe(event: NormalizedEvent): readonly ActivityEntry[] {
    const raw = event.source.raw as Record<string, unknown>;
    const name = event.source.event;

    // Before the location moves on: a jump ends a mining run or a fight in the
    // system it happened in.
    const here: ActivityContext | null =
      this.commanderFid === null
        ? null
        : {
            commanderFid: this.commanderFid,
            bodyNames: this.bodyNames,
            systemName: this.systemName,
            systemAddress: this.systemAddress,
          };
    const mined = here === null ? [] : this.mining.observe(event, here);
    const fought = here === null ? [] : this.fights.observe(event, here);

    this.trackLocation(name, raw);
    this.trackBodies(name, raw);

    // No commander yet means the session header has not been read. Recording
    // against an unknown FID would put entries somewhere no commander can see.
    if (this.commanderFid === null) return [];

    const ctx: ActivityContext = {
      commanderFid: this.commanderFid,
      bodyNames: this.bodyNames,
      systemName: this.systemName,
      systemAddress: this.systemAddress,
    };

    const signals = biologicalSignalEntries(event, ctx).filter((e) => {
      const key = signalBodyKey(e);
      if (key === null) return true;
      if (this.signalBodies.has(key)) return false;
      this.signalBodies.add(key);
      return true;
    });

    return [...exobiologyEntries(event, ctx), ...signals, ...missionEntries(event, ctx), ...mined, ...fought, ...combatEntries(event, ctx)];
  }

  private trackLocation(name: string, raw: Record<string, unknown>): void {
    if (name !== 'FSDJump' && name !== 'Location' && name !== 'CarrierJump') return;
    const system = typeof raw['StarSystem'] === 'string' ? raw['StarSystem'] : null;
    const address = typeof raw['SystemAddress'] === 'number' ? (raw['SystemAddress'] as number) : null;

    // A BodyID is only unique within a system, so carrying the map across a jump
    // would eventually attach the wrong name to an entry.
    if (address !== null && address !== this.systemAddress) this.reset();
    this.systemName = system ?? this.systemName;
    this.systemAddress = address ?? this.systemAddress;
  }

  /** Learn BodyID -> name. */
  private trackBodies(name: string, raw: Record<string, unknown>): void {
    const id = typeof raw['BodyID'] === 'number' ? (raw['BodyID'] as number) : null;
    if (id === null) return;

    // Scan and SAASignalsFound call it BodyName; Touchdown calls it Body.
    const bodyName =
      typeof raw['BodyName'] === 'string'
        ? raw['BodyName']
        : (name === 'Touchdown' || name === 'Disembark') && typeof raw['Body'] === 'string'
          ? raw['Body']
          : null;

    if (bodyName !== null && this.bodyNames.size < MAX_TRACKED_BODIES) {
      this.bodyNames.set(id, bodyName);
    }

  }
}

/**
 * Group entries the way a person reads them: system, then body, then activity.
 *
 * A flat list of "what fired" is the thing this feature exists not to be. The
 * grouping is computed rather than stored, so a later filter or sort does not
 * need a migration.
 */
export interface ActivityGroup {
  readonly systemName: string | null;
  readonly bodyName: string | null;
  readonly entries: readonly ActivityEntry[];
  /** Earliest entry in the group, for ordering. */
  readonly startedAt: string;
}

/**
 * A quiet spell this long starts a new group even in the same place: it is
 * another session, and the commander reads it as another visit.
 */
const VISIT_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * One group per **visit**: consecutive entries in the same system and body.
 *
 * Grouping every entry a place ever had into one card buried new activity:
 * a home system with a month of history (155 entries in one commander's
 * Wregoe FH-D d12-45) was ordered by its oldest entry and listed today's death
 * last of 155, far down the page. Going somewhere else, or a gap of more than
 * six hours, starts a new group, and groups are ordered by their newest entry.
 */
export function groupActivity(entries: readonly ActivityEntry[]): readonly ActivityGroup[] {
  const sorted = [...entries].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const visits: ActivityEntry[][] = [];
  let lastKey: string | null = null;
  let lastAt = Number.NaN;

  for (const entry of sorted) {
    const key = `${entry.systemName ?? ''}\u0000${entry.bodyName ?? ''}`;
    const at = Date.parse(entry.occurredAt);
    const quiet = Number.isFinite(at) && Number.isFinite(lastAt) && at - lastAt > VISIT_GAP_MS;
    if (key !== lastKey || quiet || visits.length === 0) visits.push([entry]);
    else visits[visits.length - 1]!.push(entry);
    lastKey = key;
    lastAt = at;
  }

  return (
    visits
      .map((list) => ({
        systemName: list[0]!.systemName,
        bodyName: list[0]!.bodyName,
        // Within a group, oldest first: it reads as a sequence of what happened.
        entries: list,
        startedAt: list[0]!.occurredAt,
      }))
      // Newest visit first: the journal is read backwards from what just happened.
      .reverse()
  );
}
