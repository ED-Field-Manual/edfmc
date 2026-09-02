/**
 * How strongly do we know something?
 *
 * The verification engine reports discrepancies against EDFM's reference data,
 * which means a wrong report costs a maintainer's time and, worse, can corrupt a
 * reference other people rely on. So the strength of the claim has to travel
 * with the claim.
 */

/**
 * DIRECT   - the game explicitly reported this value in a journal event.
 * DERIVED  - deterministically computed from directly observed values, by a
 *            documented rule. Reproducible from the same inputs.
 * INFERRED - the Companion believes it from context; Elite never said it.
 *
 * Only DIRECT (and DERIVED, where the derivation is documented) may raise an
 * automatic discrepancy. INFERRED must never be presented as game truth and
 * must never correct EDFM — it exists so that inference has somewhere to live
 * that is clearly *not* evidence.
 */
export type EvidenceType = 'direct' | 'derived' | 'inferred';

/** Whether this evidence class is allowed to raise a discrepancy at all. */
export function canRaiseDiscrepancy(evidence: EvidenceType): boolean {
  return evidence === 'direct' || evidence === 'derived';
}

/**
 * Confidence in a single observation, before independence is considered.
 *
 * Kept separate from `EvidenceType` because they answer different questions:
 * evidence is *how* we know, confidence is *how much* that is worth here. A
 * DIRECT reading of a value that changes hourly is still weak evidence that
 * EDFM is wrong.
 */
export type Confidence = 'high' | 'medium' | 'low';

/**
 * Does the underlying fact change on its own?
 *
 * A station's type is fixed; its controlling faction is not. A mismatch on the
 * first suggests EDFM is wrong, a mismatch on the second may only mean EDFM is
 * out of date — and saying "EDFM is wrong" about a faction that flipped last
 * Thursday is both untrue and corrosive to trust in the reports.
 */
export type Volatility = 'static' | 'semi-static' | 'dynamic';

/** Wording for a discrepancy, chosen by volatility rather than by severity. */
export function discrepancyPhrasing(volatility: Volatility): string {
  switch (volatility) {
    case 'static':
      return 'EDFM value appears incorrect';
    case 'semi-static':
      return 'EDFM value may need review';
    case 'dynamic':
      return 'EDFM value may be outdated';
  }
}

/**
 * Baseline confidence for a single observation.
 *
 * Deliberately conservative: a dynamic field never starts above low, however
 * directly it was observed, because the observation being accurate says nothing
 * about EDFM having been wrong when it was recorded.
 */
export function baselineConfidence(
  evidence: EvidenceType,
  volatility: Volatility,
): Confidence {
  if (evidence === 'inferred') return 'low';
  if (volatility === 'dynamic') return 'low';
  if (volatility === 'semi-static') return evidence === 'direct' ? 'medium' : 'low';
  return evidence === 'direct' ? 'high' : 'medium';
}
