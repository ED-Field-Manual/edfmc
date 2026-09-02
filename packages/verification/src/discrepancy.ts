/**
 * Generic discrepancy model.
 *
 * Not station-specific: an entity is identified by (type, id), a field is a
 * string, and providers supply both. Adding body or settlement verification
 * later means writing a provider, not reshaping this.
 */

import type { Confidence, EvidenceType, Volatility } from './evidence.js';
import type { Visibility } from './visibility.js';

export type EntityType =
  | 'station'
  | 'station-service'
  | 'system'
  | 'body'
  | 'settlement'
  | 'market'
  | 'engineer';

/**
 * What kind of disagreement this is.
 *
 * Deliberately not a single "wrong" bucket. A service EDFM lists that the game
 * does not report is a different problem, with a different fix and a different
 * likelihood of being EDFM's fault, than a token the game emitted that we have
 * never seen before.
 */
export type DiscrepancyKind =
  /** EDFM has it; the game did not report it. */
  | 'missing_in_game'
  /** The game reported it; EDFM does not have it. */
  | 'missing_in_edfm'
  /** Both have it, with different values. */
  | 'value_mismatch'
  /** The game reported an entity EDFM has never heard of. */
  | 'unknown_edfm_entity'
  /** The game emitted a token our normalization does not recognise. */
  | 'unknown_game_token'
  /** A dynamic value differs — likely staleness, not error. */
  | 'stale_dynamic_value'
  /** Our own normalization produced contradictory results. */
  | 'normalization_conflict';

/** §7 lifecycle. The client only ever creates `new`; the rest is the server's. */
export type DiscrepancyStatus =
  | 'new'
  | 'under_review'
  | 'confirmed'
  | 'rejected'
  | 'resolved'
  | 'superseded'
  /** Observations disagree with each other; neither side is overwritten. */
  | 'conflicting';

/**
 * One observation supporting or contradicting a discrepancy.
 *
 * Kept as evidence rather than folded into a counter, because §10 requires
 * conflicting observations to be retained rather than resolved away, and
 * because independence has to be judgeable after the fact.
 */
export interface VerificationObservation {
  readonly entityType: EntityType;
  /** Stable id: MarketID for stations, systemAddress:bodyId for bodies. */
  readonly entityId: string;
  readonly field: string;

  /** What EDFM believes. Never shown to a player — see `visibility`. */
  readonly expectedValue: string | null;
  /** What the game reported. */
  readonly observedValue: string | null;
  /** Frontier's untouched token, when the observed value was normalized. */
  readonly rawToken: string | null;

  readonly evidence: EvidenceType;
  readonly confidence: Confidence;
  readonly volatility: Volatility;

  /**
   * What it would take for a player to be allowed to see this.
   *
   * Carried on the observation itself so that redaction is decided by the data,
   * not by whichever code path happens to be rendering or notifying.
   */
  readonly visibility: Visibility;

  /* --------------------------------------------------------- provenance */
  readonly observedAt: string;
  readonly commander: string | null;
  readonly commanderFid: string | null;
  readonly gameVersion: string | null;
  readonly gameBuild: string | null;
  readonly companionVersion: string;
  /** `file:byteOffset` — ties back to the exact journal line. */
  readonly sourceEventId: string;
  readonly sourceEvent: string;
  /** Which journal file, used to tell one session from another. */
  readonly sessionKey: string;
}

export interface Discrepancy {
  readonly key: string;
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly field: string;
  readonly kind: DiscrepancyKind;
  readonly status: DiscrepancyStatus;
  readonly expectedValue: string | null;
  readonly observedValue: string | null;
  readonly volatility: Volatility;
  readonly visibility: Visibility;
  readonly observations: readonly VerificationObservation[];
  /** Distinct commanders/sessions supporting it, per §10. */
  readonly independentConfirmations: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
}

/**
 * Identity of an open discrepancy (§10).
 *
 * Two reports of the same disagreement must collapse onto one record, or thirty
 * Companion users hitting the same wrong station service produce thirty Discord
 * alerts. Game version is part of the key because the same field changing across
 * a game update is a genuinely different finding.
 */
export function discrepancyKey(o: VerificationObservation): string {
  return [
    o.entityType,
    o.entityId,
    o.field,
    o.expectedValue ?? '~',
    o.observedValue ?? '~',
    o.gameVersion ?? '~',
  ].join('|');
}

/**
 * Are two observations independent evidence?
 *
 * §9/§10: repeated reports from one commander or one session are the same
 * observation seen twice, not confirmation. Conservative by design — treating
 * genuinely independent reports as duplicates only slows confirmation down,
 * while the reverse manufactures confidence that was never earned.
 */
export function areIndependentObservations(
  a: VerificationObservation,
  b: VerificationObservation,
): boolean {
  if (a.commanderFid && a.commanderFid === b.commanderFid) return false;
  if (a.commander && a.commander === b.commander) return false;
  if (a.sessionKey && a.sessionKey === b.sessionKey) return false;
  return true;
}

/** How many mutually independent observations back this discrepancy. */
export function countIndependent(observations: readonly VerificationObservation[]): number {
  const chosen: VerificationObservation[] = [];
  for (const candidate of observations) {
    if (chosen.every((existing) => areIndependentObservations(existing, candidate))) {
      chosen.push(candidate);
    }
  }
  return chosen.length;
}

/**
 * Whether a discrepancy's details are too sensitive to broadcast.
 *
 * Exploration and exobiology findings name unexplored locations and undiscovered
 * species. Even on a staff channel that is worth withholding: a Discord message
 * is forwardable, searchable and permanent, and the reviewer can open the admin
 * page. Anything gated above `public` is treated as sensitive.
 */
export function isSpoilerSensitive(d: Pick<Discrepancy, 'visibility' | 'entityType'>): boolean {
  if (d.visibility.kind !== 'public') return true;
  return d.entityType === 'body';
}

/**
 * Merge an observation into an existing discrepancy, or start a new one.
 *
 * Never overwrites: observations accumulate, and a contradicting one flips the
 * status to `conflicting` rather than replacing what came before. §10 is
 * explicit that neither side is discarded.
 */
export function applyObservation(
  existing: Discrepancy | undefined,
  observation: VerificationObservation,
  kind: DiscrepancyKind,
): Discrepancy {
  if (!existing) {
    return {
      key: discrepancyKey(observation),
      entityType: observation.entityType,
      entityId: observation.entityId,
      field: observation.field,
      kind,
      status: 'new',
      expectedValue: observation.expectedValue,
      observedValue: observation.observedValue,
      volatility: observation.volatility,
      visibility: observation.visibility,
      observations: [observation],
      independentConfirmations: 1,
      firstObservedAt: observation.observedAt,
      lastObservedAt: observation.observedAt,
    };
  }

  // Same journal line seen twice, e.g. during a replay. Not new evidence.
  if (existing.observations.some((o) => o.sourceEventId === observation.sourceEventId)) {
    return existing;
  }

  const observations = [...existing.observations, observation];
  const conflicts = observation.observedValue !== existing.observedValue;

  return {
    ...existing,
    observations,
    independentConfirmations: countIndependent(observations),
    lastObservedAt: observation.observedAt,
    // A conflict is a finding in its own right: it means the field is changing,
    // or that one client is wrong. Resolving it here would destroy that signal.
    status: conflicts ? 'conflicting' : existing.status,
  };
}

/**
 * Should this discrepancy trigger a Discord alert right now? (§10)
 *
 * Exactly two moments are worth a notification: the first report, and the first
 * genuinely independent confirmation. Everything after that accumulates
 * silently — thirty users hitting the same wrong service is one finding.
 */
export function shouldNotify(
  before: Discrepancy | undefined,
  after: Discrepancy,
): 'created' | 'confirmed' | 'conflicting' | null {
  if (!before) return 'created';
  if (before.status !== 'conflicting' && after.status === 'conflicting') return 'conflicting';
  if (before.independentConfirmations < 2 && after.independentConfirmations >= 2) {
    return 'confirmed';
  }
  return null;
}
