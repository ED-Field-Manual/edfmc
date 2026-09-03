/**
 * Research data quality (§13).
 *
 * "This matters enormously. Do not build charts suggesting conclusions from
 * tiny datasets."
 *
 * The measured reality makes the point better than the rule does. One
 * commander's entire 224-journal history yields 48 settlement sessions, of
 * which 14 contain any collection at all, spread across five economies — with
 * Military represented by 2 sessions and 0 collections. A rate computed from
 * that is not a weak finding, it is noise with a percent sign.
 *
 * So this module reports counts, never conclusions. It deliberately provides no
 * significance test and no "X is better than Y" helper: §13 requires the
 * analysis to be transparent and reproducible, and forbids AI-generated
 * statistical conclusions. Presenting rates alongside the raw counts and the
 * sample size is the honest limit of what the client should do.
 */

import type { ObservedSession, ResearchProject } from './types.js';
import { isPlausible } from './session.js';

export interface GroupSummary {
  readonly group: string;
  /** Sessions in this group. The denominator, always shown. */
  readonly sessions: number;
  /** Sessions in which at least one observation was recorded. */
  readonly sessionsWithObservations: number;
  /** Distinct settlements, so 30 visits to one place are visibly not 30 places. */
  readonly distinctLocations: number;
  readonly distinctSystems: number;
  readonly totalObserved: number;
}

export interface ItemSummary {
  readonly name: string;
  readonly label: string | null;
  readonly category: string | null;
  /** How many sessions saw it at least once — the meaningful numerator. */
  readonly sessions: number;
  /** How many were seen in total. Reported alongside, never instead. */
  readonly total: number;
}

export interface QualitySummary {
  readonly projectId: string;
  readonly projectVersion: number;

  /* ------------------------------------------------------- §13 fields */
  readonly sampleSize: number;
  readonly uniqueCommanders: number;
  readonly distinctLocations: number;
  readonly distinctSystems: number;
  readonly gameVersions: readonly string[];
  /** Sessions excluded from rates, and why they were excluded. */
  readonly excluded: {
    readonly implausiblyShort: number;
    readonly implausiblyLong: number;
    readonly interrupted: number;
    readonly abortive: number;
  };
  readonly completeness: Readonly<Record<string, number>>;

  /**
   * Whether the sample is large enough for a rate to mean anything.
   *
   * Not a statistical claim, and deliberately not dressed up as one: a blunt
   * floor below which the UI must not draw a chart at all.
   */
  readonly sufficientForRates: boolean;
  /** Plain-language statement of what this sample cannot support. */
  readonly caveat: string | null;
}

/**
 * Below this, a percentage is theatre.
 *
 * Chosen to be obviously conservative rather than derived: with 14 productive
 * sessions in a real single-commander corpus, any threshold that admitted it
 * would be admitting noise.
 */
const MIN_SESSIONS_FOR_RATES = 30;
const MIN_SESSIONS_PER_GROUP = 10;

function fidOf(session: ObservedSession): string | null {
  return session.commanderFid ?? session.commander ?? null;
}

export function summarise(
  sessions: readonly ObservedSession[],
  project: ResearchProject,
): QualitySummary {
  const usable = sessions.filter((s) => isPlausible(s, project));

  const short = sessions.filter(
    (s) =>
      s.durationSeconds !== null &&
      project.minPlausibleSeconds !== undefined &&
      s.durationSeconds < project.minPlausibleSeconds,
  ).length;
  const long = sessions.filter(
    (s) =>
      s.durationSeconds !== null &&
      project.maxPlausibleSeconds !== undefined &&
      s.durationSeconds > project.maxPlausibleSeconds,
  ).length;

  const completeness: Record<string, number> = {};
  for (const s of sessions) {
    completeness[s.completeness] = (completeness[s.completeness] ?? 0) + 1;
  }

  const commanders = new Set(
    usable.map(fidOf).filter((v): v is string => v !== null),
  );
  const versions = [...new Set(usable.map((s) => s.gameVersion).filter((v): v is string => v !== null))].sort();

  const sufficient = usable.length >= MIN_SESSIONS_FOR_RATES;

  return {
    projectId: project.id,
    projectVersion: project.version,
    sampleSize: usable.length,
    uniqueCommanders: commanders.size,
    distinctLocations: new Set(
      usable.map((s) => s.context.settlementName ?? s.context.marketId).filter(Boolean),
    ).size,
    distinctSystems: new Set(usable.map((s) => s.context.systemAddress).filter(Boolean)).size,
    gameVersions: versions,
    excluded: {
      implausiblyShort: short,
      implausiblyLong: long,
      interrupted: sessions.filter((s) => s.outcome === 'interrupted').length,
      abortive: sessions.filter((s) => s.outcome === 'died').length,
    },
    completeness,
    sufficientForRates: sufficient,
    caveat: sufficient
      ? null
      : `Only ${usable.length} usable session${usable.length === 1 ? '' : 's'}. ` +
        'Counts are shown; rates are not, because a percentage from this many ' +
        'observations would suggest a confidence the data does not support.',
  };
}

/**
 * Group sessions by a context field — economy, government, faction state.
 *
 * Returns counts only. Rates are the caller's to compute, and
 * `QualitySummary.sufficientForRates` says whether they may.
 */
export function groupBy(
  sessions: readonly ObservedSession[],
  project: ResearchProject,
  contextKey: string,
): readonly GroupSummary[] {
  const usable = sessions.filter((s) => isPlausible(s, project));
  const groups = new Map<string, ObservedSession[]>();

  for (const session of usable) {
    // Unknown is its own group, never folded into another and never dropped:
    // silently discarding sessions whose economy the game did not report would
    // bias every rate computed from what remains.
    const key = session.context[contextKey] ?? 'Unknown';
    const bucket = groups.get(key);
    if (bucket) bucket.push(session);
    else groups.set(key, [session]);
  }

  return [...groups.entries()]
    .map(([group, members]) => ({
      group,
      sessions: members.length,
      sessionsWithObservations: members.filter((s) => s.observations.length > 0).length,
      distinctLocations: new Set(
        members.map((s) => s.context.settlementName ?? s.context.marketId).filter(Boolean),
      ).size,
      distinctSystems: new Set(members.map((s) => s.context.systemAddress).filter(Boolean)).size,
      totalObserved: members.reduce(
        (sum, s) => sum + s.observations.reduce((n, o) => n + o.count, 0),
        0,
      ),
    }))
    .sort((a, b) => b.sessions - a.sessions);
}

/** What was observed, by item. Session counts first, totals alongside. */
export function itemTally(
  sessions: readonly ObservedSession[],
  project: ResearchProject,
): readonly ItemSummary[] {
  const usable = sessions.filter((s) => isPlausible(s, project));
  const bySession = new Map<string, { label: string | null; category: string | null; sessions: number; total: number }>();

  for (const session of usable) {
    const seenHere = new Set<string>();
    for (const observation of session.observations) {
      const entry = bySession.get(observation.name) ?? {
        label: observation.label,
        category: observation.category,
        sessions: 0,
        total: 0,
      };
      entry.total += observation.count;
      if (!seenHere.has(observation.name)) {
        entry.sessions += 1;
        seenHere.add(observation.name);
      }
      // Keep the first non-null label we see; Frontier omits it ~16% of the time.
      if (entry.label === null) entry.label = observation.label;
      if (entry.category === null) entry.category = observation.category;
      bySession.set(observation.name, entry);
    }
  }

  return [...bySession.entries()]
    .map(([name, e]) => ({ name, label: e.label, category: e.category, sessions: e.sessions, total: e.total }))
    .sort((a, b) => b.sessions - a.sessions || b.total - a.total);
}

/**
 * Format a rate for display, or refuse to.
 *
 * Returns null when the group is too small, so a caller cannot accidentally
 * render "100%" from one session. §13's worked example — "Military: 142
 * sessions, 38 with Weapon Schematics, 26.8%" — is only meaningful because the
 * denominator is shown next to it, so the denominator is always in the string.
 */
export function formatRate(group: GroupSummary): string | null {
  if (group.sessions < MIN_SESSIONS_PER_GROUP) return null;
  const pct = (100 * group.sessionsWithObservations) / group.sessions;
  return `${group.sessionsWithObservations} of ${group.sessions} sessions (${pct.toFixed(1)}%)`;
}
