/**
 * Station observations and service comparison (§9).
 *
 * A station observation is *evidence*, not a fact about the galaxy. It records
 * what one commander's client reported at one moment, with everything needed to
 * judge it later: who saw it, when, on which game build, and through which
 * channel. §27 requires that provenance survive; nothing here overwrites it.
 *
 * The client never modifies reference data. It captures observations and, when a
 * backend exists, submits them. Deciding what is true is the server's job, and
 * ultimately a human's.
 */

import type { Known, StationService } from '@edfm/elite-journal';

/**
 * How the observation was made.
 *
 * Both channels carry `StationServices` at 100% presence, but they are not
 * equivalent evidence: docking implies the commander was physically there, while
 * an approach is a flyby reading. Recording which is which lets confidence
 * weighting distinguish them later rather than having to guess.
 */
export type ObservationChannel = 'docked' | 'approach' | 'location';

export interface StationEconomyObservation {
  readonly name: string;
  readonly localised: string | null;
  /** Frontier's value, never renormalised — observed sums exceed 1.0. */
  readonly proportion: number | null;
}

export interface StationObservation {
  /**
   * Primary identity. §19 prefers MarketID, which was present on 100% of the
   * 1,798 Docked and 440 ApproachSettlement events in the corpus.
   */
  readonly marketId: number;
  readonly stationName: string;
  readonly stationType: Known<string>;
  readonly starSystem: Known<string>;
  readonly systemAddress: Known<number>;

  /**
   * Services exactly as Frontier sent them, alongside case-folded ids.
   *
   * §9 requires the raw tokens be preserved, and that is a correctness measure
   * rather than an audit nicety: the array genuinely mixes cases (`stationMenu`,
   * `techBroker`), so comparison must use the folded id while any report must
   * quote the raw token as evidence.
   */
  readonly services: readonly StationService[];

  readonly economies: readonly StationEconomyObservation[];
  readonly stationFaction: Known<string>;
  readonly stationGovernment: Known<string>;
  /**
   * Present on only 32.0% of Docked events. UNKNOWN here means the game did not
   * report it — it must never be read as "no allegiance", and must never
   * generate a discrepancy.
   */
  readonly allegiance: Known<string>;
  readonly distFromStarLs: Known<number>;
  readonly landingPads: Known<Record<string, number>>;

  readonly channel: ObservationChannel;

  /* --------------------------------------------------------- provenance */
  readonly observedAt: string;
  readonly commander: string | null;
  readonly commanderFid: string | null;
  readonly gameVersion: string | null;
  readonly gameBuild: string | null;
  /** `file:byteOffset` — ties the observation back to the exact journal line. */
  readonly sourceEventId: string;
  readonly sourceEvent: string;
}

/* ------------------------------------------------------------ comparison */

/**
 * A station's known services according to EDFM.
 *
 * Not yet populated: EDFM has no station dataset (see docs/VERIFICATION.md), so
 * nothing is currently compared. The shape exists because the comparison logic is
 * worth having correct and tested before it is fed, and because the observations
 * being collected now are the only plausible seed for that dataset.
 */
export interface StationReference {
  readonly marketId: number;
  readonly stationName: string;
  /** Case-folded service ids EDFM believes this station has. */
  readonly serviceIds: readonly string[];
  /** Where this reference came from, and how current it is. */
  readonly source: string;
  readonly updatedAt: string | null;
}

/**
 * Legacy station-specific discrepancy shape.
 *
 * Superseded by the generic model in discrepancy.ts, which is what the engine
 * and providers use. Kept because compareStation() still returns it and is
 * still tested; new code should not reach for it.
 */
export type StationDiscrepancyKind = 'service-missing' | 'service-extra' | 'name-differs';

export interface StationDiscrepancy {
  readonly kind: StationDiscrepancyKind;
  readonly marketId: number;
  readonly stationName: string;
  /** Service id, or the field name for non-service discrepancies. */
  readonly field: string;
  /** What EDFM says. */
  readonly referenceValue: string;
  /** What the game reported. */
  readonly observedValue: string;
  /** Raw Frontier token backing the observation, when there is one. */
  readonly rawToken: string | null;
  readonly observation: StationObservation;
}
