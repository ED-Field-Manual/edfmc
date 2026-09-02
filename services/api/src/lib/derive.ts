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

function base(
  input: StationObservationInput,
  field: string,
  expected: string | null,
  observed: string | null,
  rawToken: string | null,
  volatility: Volatility,
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
    confidence: baselineConfidence(evidence, volatility),
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

    for (const [id, raw] of observed) {
      if (!expected.has(id)) {
        findings.push({
          kind: 'missing_in_edfm',
          observation: base(input, `service:${id}`, null, id, raw, 'semi-static'),
        });
      }
    }
    for (const id of expected) {
      if (!observed.has(id)) {
        findings.push({
          kind: 'missing_in_game',
          observation: base(input, `service:${id}`, id, null, null, 'semi-static'),
        });
      }
    }
  }

  return { findings, skipped: findings.length === 0 ? 'agrees' : null };
}
