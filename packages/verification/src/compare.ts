/**
 * Comparing an observation against EDFM's reference data.
 *
 * **Nothing calls this yet, and that is the honest state of things.** EDFM has no
 * station dataset: its `Locations` category holds fifteen pages, all engineer
 * systems and workshops, and none carries structured service data. There is
 * currently nothing to compare against.
 *
 * The logic exists now because it is small, testable, and much easier to get right
 * before there is pressure to ship it — and because getting it wrong produces
 * confident false reports, which is worse for a reference project than producing
 * none. See docs/VERIFICATION.md.
 */

import { isKnown } from '@edfm/elite-journal';

import type { Discrepancy, StationObservation, StationReference } from './types.js';

/**
 * Service ids that must never generate a discrepancy.
 *
 * Fleet carrier owners add and remove services at will, so a carrier's service
 * list is a snapshot of one owner's current configuration rather than a fact about
 * the galaxy. Comparing them would generate endless noise.
 */
const VOLATILE_STATION_TYPES = new Set(['FleetCarrier']);

export interface CompareOptions {
  /**
   * Ignore services EDFM does not list at all.
   *
   * Default true. A reference that lists five services is far more likely to be
   * incomplete than the game is to be wrong, so "extra" findings are advisory
   * until EDFM's coverage is known to be complete.
   */
  readonly reportExtras?: boolean;
}

/**
 * Compare one observation against the reference.
 *
 * Returns an empty array when everything matches, which is the common case —
 * §9 requires the commander not be bothered when nothing is wrong.
 */
export function compareStation(
  observation: StationObservation,
  reference: StationReference,
  options: CompareOptions = {},
): readonly Discrepancy[] {
  // A carrier's services are its owner's business, not a fact to verify.
  if (isKnown(observation.stationType) && VOLATILE_STATION_TYPES.has(observation.stationType)) {
    return [];
  }
  // Identity must match, or we are comparing two different places.
  if (observation.marketId !== reference.marketId) return [];

  const out: Discrepancy[] = [];
  const observed = new Map(observation.services.map((s) => [s.id, s.raw]));
  const referenced = new Set(reference.serviceIds.map((id) => id.toLowerCase()));

  // EDFM lists it; the game did not report it.
  for (const id of referenced) {
    if (observed.has(id)) continue;
    out.push({
      kind: 'service-missing',
      marketId: observation.marketId,
      stationName: observation.stationName,
      field: id,
      referenceValue: 'present',
      observedValue: 'absent',
      rawToken: null,
      observation,
    });
  }

  if (options.reportExtras ?? true) {
    // The game reported it; EDFM does not list it.
    for (const [id, raw] of observed) {
      if (referenced.has(id)) continue;
      out.push({
        kind: 'service-extra',
        marketId: observation.marketId,
        stationName: observation.stationName,
        field: id,
        referenceValue: 'absent',
        observedValue: 'present',
        // The raw token is the evidence; §9 requires it travel with the report.
        rawToken: raw,
        observation,
      });
    }
  }

  if (reference.stationName && reference.stationName !== observation.stationName) {
    out.push({
      kind: 'name-differs',
      marketId: observation.marketId,
      stationName: observation.stationName,
      field: 'stationName',
      referenceValue: reference.stationName,
      observedValue: observation.stationName,
      rawToken: observation.stationName,
      observation,
    });
  }

  return out;
}

/**
 * Whether two observations count as independent evidence.
 *
 * §9 is explicit that two reports must not become truth if they could share an
 * origin. Same commander, or same session, is one observation repeated — not
 * confirmation. Deliberately conservative: treating genuinely independent reports
 * as duplicates only slows confirmation down, while the reverse manufactures
 * confidence that was never earned.
 */
export function areIndependent(a: StationObservation, b: StationObservation): boolean {
  if (a.commanderFid !== null && a.commanderFid === b.commanderFid) return false;
  if (a.commander !== null && a.commander === b.commander) return false;
  // Same journal file means the same session even if identity is unknown.
  const fileA = a.sourceEventId.split(':')[0];
  const fileB = b.sourceEventId.split(':')[0];
  if (fileA && fileA === fileB) return false;
  return true;
}
