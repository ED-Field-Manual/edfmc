/**
 * Server-side comparison.
 *
 * The client sends what its game reported. It does not send findings, because a
 * finding is a claim about what the reference says, and the client does not
 * hold the reference (§19: the client is untrusted). Everything below is
 * derived here from the submitted observation and the server's own data.
 */

import {
  baselineConfidence,
  type Confidence,
  type DiscrepancyKind,
  type EvidenceType,
  type VerificationObservation,
  type Visibility,
  type Volatility,
} from '@edfm/verification';
import type { StationReference } from './reference.js';

export interface StationObservationInput {
  readonly marketId: string;
  readonly stationName: string | null;
  readonly stationType: string | null;
  readonly systemName: string | null;
  readonly systemAddress: string | null;
  /** Frontier's raw tokens, exactly as the journal gave them. */
  readonly servicesRaw: readonly string[] | null;
  readonly observedAt: string;
  readonly sourceEvent: string;
  readonly sourceEventId: string;
  readonly gameVersion: string | null;
  readonly gameBuild: string | null;
  readonly companionVersion: string;
  readonly commander: string | null;
  readonly commanderFid: string | null;
  readonly sessionKey: string;
}

/**
 * A station is the commander's own current location, which their game has by
 * definition already shown them. Nothing here is gated -- see SPOILERS.md on
 * why gating self-evident state would be theatre and would dilute the gates
 * that matter.
 */
const STATION_VISIBILITY: Visibility = { kind: 'public' };

const fold = (token: string): string => token.toLowerCase();

/**
 * At what point does a set of service differences stop being a set of findings
 * and start being evidence that the observation itself was partial?
 *
 * Two independent triggers, because a single threshold is wrong either way:
 *
 * - A *proportion*, for small stations. Five differences at a six-service
 *   station is a partial reading, not five findings.
 * - An *absolute* count, for large ones. Twelve differences at a forty-service
 *   station is under half, and still not twelve independent facts.
 *
 * Floored at three so that one or two differences at a tiny station -- which is
 * a majority, but also just a couple of findings -- stays individual.
 */
const MIN_DIFFERENCES_TO_AGGREGATE = 3;
const ALWAYS_AGGREGATE_ABOVE = 10;

function isPartialObservation(differences: readonly string[], referenceSize: number): boolean {
  if (differences.length < MIN_DIFFERENCES_TO_AGGREGATE) return false;
  return differences.length > referenceSize / 2 || differences.length > ALWAYS_AGGREGATE_ABOVE;
}

function base(
  input: StationObservationInput,
  field: string,
  expected: string | null,
  observed: string | null,
  rawToken: string | null,
  volatility: Volatility,
  confidenceOverride?: Confidence,
): VerificationObservation {
  const evidence: EvidenceType = 'direct';
  return {
    entityType: 'station',
    entityId: input.marketId,
    field,
    expectedValue: expected,
    observedValue: observed,
    rawToken,
    evidence,
    confidence: confidenceOverride ?? baselineConfidence(evidence, volatility),
    volatility,
    visibility: STATION_VISIBILITY,
    observedAt: input.observedAt,
    commander: input.commander,
    commanderFid: input.commanderFid,
    gameVersion: input.gameVersion,
    gameBuild: input.gameBuild,
    companionVersion: input.companionVersion,
    sourceEventId: input.sourceEventId,
    sourceEvent: input.sourceEvent,
    sessionKey: input.sessionKey,
  };
}

export interface DerivedFinding {
  readonly observation: VerificationObservation;
  readonly kind: DiscrepancyKind;
}

export interface DeriveResult {
  readonly findings: readonly DerivedFinding[];
  /** Why nothing was derived, when nothing was. Recorded, not an error. */
  readonly skipped: string | null;
}

export function deriveStationFindings(
  input: StationObservationInput,
  reference: StationReference | null,
): DeriveResult {
  if (reference === null) {
    // The aggregate has never seen this station. That is an absence of data,
    // not a disagreement, and reporting it would produce exactly the flood of
    // confident-but-useless findings VERIFICATION.md warns about.
    return { findings: [], skipped: 'no-reference' };
  }

  // A carrier's services are its owner's current configuration, not a fact
  // about the galaxy. Comparing them reports the owner having changed their
  // mind as an error.
  if (reference.isFleetCarrier) return { findings: [], skipped: 'fleet-carrier' };

  const findings: DerivedFinding[] = [];

  if (
    input.stationType !== null &&
    reference.stationType !== null &&
    fold(input.stationType) !== fold(reference.stationType)
  ) {
    findings.push({
      kind: 'value_mismatch',
      observation: base(
        input,
        'stationType',
        reference.stationType,
        input.stationType,
        input.stationType,
        'static',
      ),
    });
  }

  // No services array means the game did not say, which is not the same as the
  // station having none. Comparing against it would assert the stronger claim.
  if (input.servicesRaw !== null && reference.serviceIds !== null) {
    const observed = new Map(input.servicesRaw.map((t) => [fold(t), t]));
    const expected = new Set(reference.serviceIds);

    const extra = [...observed.keys()].filter((id) => !expected.has(id)).sort();
    const missing = [...expected].filter((id) => !observed.has(id)).sort();

    if (isPartialObservation(missing, expected.size) || isPartialObservation(extra, expected.size)) {
      // One aggregate finding, not one per service.
      //
      // A submission that disagrees about most of a station's services is far
      // more likely to be a partial observation than a station that lost
      // twenty-nine services at once. The channels are measurably not
      // equivalent: ApproachSettlement (n=440) is a flyby carrying a smaller
      // set than Docked (n=1798).
      //
      // Emitting one finding per service here would produce the same flood of
      // confident, useless reports that pointing the comparison at an empty
      // reference would -- just by a different route -- and would fire one
      // Discord alert per service.
      findings.push({
        kind: 'normalization_conflict',
        observation: base(
          input,
          'services',
          [...expected].sort().join(','),
          [...observed.keys()].sort().join(','),
          input.servicesRaw.join(','),
          'semi-static',
          // Explicitly below the baseline for a direct semi-static observation.
          // The whole premise of aggregating is that this is probably a partial
          // reading, so it must not arrive at a reviewer with the same weight
          // as a finding we actually believe.
          'low',
        ),
      });
      return { findings, skipped: 'bulk-service-difference' };
    }

    for (const id of extra) {
      findings.push({
        kind: 'missing_in_edfm',
        observation: base(input, `service:${id}`, null, id, observed.get(id) ?? id, 'semi-static'),
      });
    }
    for (const id of missing) {
      findings.push({
        kind: 'missing_in_game',
        observation: base(input, `service:${id}`, id, null, null, 'semi-static'),
      });
    }
  }

  return { findings, skipped: findings.length === 0 ? 'agrees' : null };
}
