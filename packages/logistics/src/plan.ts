/**
 * Sourcing plan (§16).
 *
 * "DO NOT merely find the nearest market for each commodity independently.
 * Optimize the entire procurement operation."
 *
 * The algorithm is a greedy set-cover: repeatedly take the station that best
 * advances what is still outstanding, then subtract what it supplies and go
 * again. Greedy rather than optimal on purpose. A true optimum over stations ×
 * commodities is a hard combinatorial problem whose answer would have to be
 * taken on trust, and §16 requires the opposite — that every choice be
 * explainable. Greedy produces a plan a commander can audit stop by stop, and
 * the cost is occasionally one more stop than strictly necessary.
 *
 * §16 also forbids collapsing the factors into an unexplained magic number.
 * There is a score, because something has to be ranked, but every component is
 * returned alongside it, and each selected stop carries the plain-language
 * reasons it won. Rejected candidates keep their reason too: "closer station
 * rejected because reported stock is only 103% of requirement and data is 7
 * hours old" is exactly the sentence §16 asks for.
 */

import {
  assessConfidence,
  atLeast,
  DEFAULT_CONFIDENCE_RULES,
  type ConfidenceLevel,
  type ConfidenceResult,
  type ConfidenceRules,
} from './confidence.js';

export type StationPreference =
  | 'orbital-only'
  | 'strongly-prefer-orbital'
  | 'no-preference'
  | 'planetary-if-better';

export interface Requirement {
  /** EDDN symbol, already folded. */
  readonly commodity: string;
  readonly label: string;
  readonly amount: number;
}

/** One commodity for sale at one station, as the market database reports it. */
export interface MarketOffer {
  readonly commodity: string;
  readonly stock: number;
  readonly buyPrice: number | null;
  readonly observedAt: string;
}

export interface CandidateStation {
  readonly marketId: string;
  readonly stationName: string;
  readonly systemName: string;
  readonly systemAddress: string;
  /** Light years from the commander. Null when the system has no coordinates. */
  readonly distanceLy: number | null;
  /** Supercruise distance from arrival. Null when the game never reported it. */
  readonly arrivalDistanceLs: number | null;
  readonly isPlanetary: boolean | null;
  readonly isFleetCarrier: boolean;
  readonly offers: readonly MarketOffer[];
}

export interface PlanOptions {
  readonly nowMs?: number;
  /** Per-trip hold size. Zero or absent means unlimited. */
  readonly capacity?: number;
  readonly maxDataAgeSeconds?: number;
  readonly minConfidence?: ConfidenceLevel;
  readonly allowFleetCarriers?: boolean;
  readonly allowPlanetary?: boolean;
  readonly stationPreference?: StationPreference;
  /** 0 = ignore price, 1 = weigh it as heavily as anything else. */
  readonly priceImportance?: number;
  readonly arrivalDistanceImportance?: number;
  readonly safetyMargin?: number;
  readonly maxStops?: number;
  readonly rules?: ConfidenceRules;
}

export interface PlannedPurchase {
  readonly commodity: string;
  readonly label: string;
  readonly amount: number;
  readonly buyPrice: number | null;
  readonly confidence: ConfidenceResult;
}

export interface ScoreComponent {
  readonly label: string;
  readonly value: number;
  readonly detail: string;
}

export interface Stop {
  readonly station: CandidateStation;
  readonly purchases: readonly PlannedPurchase[];
  /** Why this station was chosen, in the commander's language. */
  readonly reasons: readonly string[];
  /** The score's parts, never just the total (§16). */
  readonly components: readonly ScoreComponent[];
  readonly score: number;
  readonly estimatedCost: number | null;
}

export interface RejectedCandidate {
  readonly stationName: string;
  readonly systemName: string;
  readonly distanceLy: number | null;
  readonly reason: string;
}

export interface SourcingPlan {
  readonly stops: readonly Stop[];
  /** What no acceptable market could supply. */
  readonly unfulfilled: readonly Requirement[];
  /**
   * Near misses worth showing.
   *
   * §16 wants the closer station that lost to be explainable, so rejections are
   * part of the answer rather than something discarded during the search.
   */
  readonly rejected: readonly RejectedCandidate[];
  readonly totalStops: number;
  readonly estimatedCost: number | null;
  readonly confidenceRulesVersion: number;
}

const DEFAULTS = {
  minConfidence: 'moderate' as ConfidenceLevel,
  stationPreference: 'no-preference' as StationPreference,
  priceImportance: 0.3,
  arrivalDistanceImportance: 0.3,
  safetyMargin: 0.1,
  maxStops: 8,
};

function ageSeconds(observedAt: string, nowMs: number): number {
  const t = Date.parse(observedAt);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : Math.max(0, (nowMs - t) / 1000);
}

/**
 * Is this station allowed at all?
 *
 * Separate from scoring: a hard exclusion is not a low score. Returning the
 * reason means a commander who wonders where a station went can be told.
 */
function exclusionReason(
  station: CandidateStation,
  options: PlanOptions,
): string | null {
  if (station.isFleetCarrier && options.allowFleetCarriers !== true) {
    // Off unless asked for: a carrier's market is one owner's decision and can
    // vanish between the observation and arrival.
    return 'fleet carrier (not enabled)';
  }
  const preference = options.stationPreference ?? DEFAULTS.stationPreference;
  if (station.isPlanetary === true) {
    if (options.allowPlanetary === false) return 'planetary station (not enabled)';
    if (preference === 'orbital-only') return 'planetary station (orbital only)';
  }
  return null;
}

/** Preference expressed as a multiplier, so its strength is visible. */
function orbitalFactor(station: CandidateStation, preference: StationPreference): number {
  if (station.isPlanetary !== true) return 1;
  switch (preference) {
    case 'strongly-prefer-orbital':
      return 0.5;
    case 'planetary-if-better':
      return 0.9;
    default:
      return 1;
  }
}

/**
 * Normalise a distance to 0..1 where nearer is better.
 *
 * Unknown distance scores mid rather than best or worst: the system may simply
 * have no coordinates yet, and neither promoting nor burying it is honest.
 */
function nearness(value: number | null, scale: number): number {
  if (value === null) return 0.5;
  return 1 / (1 + value / scale);
}

export function buildPlan(
  requirements: readonly Requirement[],
  candidates: readonly CandidateStation[],
  options: PlanOptions = {},
): SourcingPlan {
  const nowMs = options.nowMs ?? Date.now();
  const rules = options.rules ?? DEFAULT_CONFIDENCE_RULES;
  const minConfidence = options.minConfidence ?? DEFAULTS.minConfidence;
  const preference = options.stationPreference ?? DEFAULTS.stationPreference;
  const priceWeight = options.priceImportance ?? DEFAULTS.priceImportance;
  const arrivalWeight = options.arrivalDistanceImportance ?? DEFAULTS.arrivalDistanceImportance;
  const safetyMargin = options.safetyMargin ?? DEFAULTS.safetyMargin;
  const maxStops = options.maxStops ?? DEFAULTS.maxStops;

  const outstanding = new Map<string, Requirement>();
  for (const r of requirements) {
    if (r.amount > 0) outstanding.set(r.commodity, { ...r });
  }

  const rejected: RejectedCandidate[] = [];
  const stops: Stop[] = [];
  const used = new Set<string>();

  const usable = candidates.filter((station) => {
    const reason = exclusionReason(station, options);
    if (reason !== null) {
      rejected.push({
        stationName: station.stationName,
        systemName: station.systemName,
        distanceLy: station.distanceLy,
        reason,
      });
      return false;
    }
    return true;
  });

  while (outstanding.size > 0 && stops.length < maxStops) {
    let best: Stop | null = null;
    const roundRejections: RejectedCandidate[] = [];

    for (const station of usable) {
      if (used.has(station.marketId)) continue;

      const purchases: PlannedPurchase[] = [];
      let thin: string | null = null;
      let stale: string | null = null;

      for (const offer of station.offers) {
        const need = outstanding.get(offer.commodity);
        if (need === undefined) continue;

        const age = ageSeconds(offer.observedAt, nowMs);
        if (options.maxDataAgeSeconds !== undefined && age > options.maxDataAgeSeconds) {
          stale = `${offer.commodity} data ${Math.round(age / 60)}m old`;
          continue;
        }

        // What we would actually take from here. Never more than is reported:
        // planning to buy stock nobody has seen is inventing it.
        const take = Math.min(need.amount, offer.stock);

        // Confidence is judged against the take, not against the whole
        // outstanding requirement. Judging against the requirement made any
        // market holding less than the full amount "unusable", which meant a
        // requirement could never be split across stops -- the entire point of
        // multi-stop sourcing.
        //
        // §15's worked examples are unchanged by this: with 7,500 needed and
        // 31,221 reported the take is still 7,500 and coverage still 416%. It
        // only changes the case where a market cannot cover everything, which
        // now rates as thin (coverage near 1.0) rather than unusable -- which
        // is the honest reading of "you would be taking all of it".
        //
        // The margin is deliberately dropped when the take *is* the entire
        // stock. A margin is headroom above what you buy, and there is none
        // when you are clearing the shelf: applying it there gives
        // stock / (stock x 1.1) = 91% coverage, which fails the minimum and
        // rates every partial fill unusable. That made large requirements
        // unsourceable -- caught against real data, where four live
        // construction sites needing 138,791 tonnes of Steel produced 42
        // candidate stations and zero stops.
        const clearingTheShelf = take >= offer.stock;
        const confidence = assessConfidence(
          {
            needed: take,
            reported: offer.stock,
            ageSeconds: age,
            safetyMargin: clearingTheShelf ? 0 : safetyMargin,
          },
          rules,
        );

        if (!atLeast(confidence.level, minConfidence)) {
          // Reported against the requirement, not against the take: "103% of
          // what is needed" is the sentence §16 asks for, and it is only
          // meaningful relative to what the commander actually wants.
          const ofRequirement = Math.round((offer.stock / Math.max(1, need.amount)) * 100);
          thin =
            age >= rules.ageStale
              ? `${need.label} data is ${Math.round(age / 3600)}h old and stock is ${ofRequirement}% of what is needed`
              : `${need.label} stock is only ${ofRequirement}% of what is needed`;
          continue;
        }

        purchases.push({
          commodity: offer.commodity,
          label: need.label,
          amount: take,
          buyPrice: offer.buyPrice,
          confidence,
        });
      }

      if (purchases.length === 0) {
        const why = thin ?? stale;
        if (why !== null) {
          roundRejections.push({
            stationName: station.stationName,
            systemName: station.systemName,
            distanceLy: station.distanceLy,
            reason: why,
          });
        }
        continue;
      }

      /* ------------------------------------------------ scoring, exposed */

      const covered = purchases.length;
      const systemNearness = nearness(station.distanceLy, 40);
      const arrivalNearness = nearness(station.arrivalDistanceLs, 2000);
      const avgConfidence =
        purchases.reduce((n, p) => n + Math.min(p.confidence.coverage, 3), 0) / purchases.length;
      const priced = purchases.filter((p) => p.buyPrice !== null);
      const avgPrice =
        priced.length === 0
          ? null
          : priced.reduce((n, p) => n + (p.buyPrice ?? 0), 0) / priced.length;
      const cheapness = avgPrice === null ? 0.5 : 1 / (1 + avgPrice / 2000);
      const orbital = orbitalFactor(station, preference);

      const components: ScoreComponent[] = [
        {
          label: 'Commodities fulfilled',
          value: covered,
          detail: `${covered} of ${outstanding.size} outstanding`,
        },
        { label: 'System distance', value: systemNearness, detail: station.distanceLy === null ? 'unknown' : `${station.distanceLy.toFixed(1)} ly` },
        { label: 'Arrival distance', value: arrivalNearness, detail: station.arrivalDistanceLs === null ? 'unknown' : `${Math.round(station.arrivalDistanceLs).toLocaleString()} ls` },
        { label: 'Stock headroom', value: avgConfidence, detail: `${Math.round(avgConfidence * 100)}% average coverage` },
        { label: 'Price', value: cheapness, detail: avgPrice === null ? 'unknown' : `${Math.round(avgPrice).toLocaleString()} cr average` },
        { label: 'Station type', value: orbital, detail: station.isPlanetary === true ? 'planetary' : station.isPlanetary === false ? 'orbital' : 'unknown' },
      ];

      // Coverage dominates deliberately: §16 asks the optimiser to favour
      // fewer stops, and one station supplying three commodities beats a
      // marginally closer one supplying a single commodity.
      const score =
        (covered * 2 + avgConfidence) *
        (1 + systemNearness) *
        (1 + arrivalWeight * arrivalNearness) *
        (1 + priceWeight * cheapness) *
        orbital;

      const reasons: string[] = [
        `fulfils ${covered} of ${outstanding.size} outstanding ${outstanding.size === 1 ? 'commodity' : 'commodities'}`,
        ...purchases.map(
          (p) => `${p.label}: ${p.confidence.summary}`,
        ),
        station.distanceLy === null
          ? 'distance from you is unknown'
          : `${station.distanceLy.toFixed(1)} ly from you`,
      ];
      if (station.isPlanetary === false) reasons.push('orbital station');
      if (station.isPlanetary === true) reasons.push('planetary station');
      if (station.arrivalDistanceLs !== null) {
        reasons.push(`${Math.round(station.arrivalDistanceLs).toLocaleString()} ls from arrival`);
      }

      const estimatedCost = priced.length === purchases.length
        ? purchases.reduce((n, p) => n + p.amount * (p.buyPrice ?? 0), 0)
        : null;

      const candidate: Stop = { station, purchases, reasons, components, score, estimatedCost };
      if (best === null || candidate.score > best.score) best = candidate;
    }

    if (best === null) {
      // Nothing acceptable is left; the remainder is reported unfulfilled
      // rather than filled with a station we already said was not good enough.
      rejected.push(...roundRejections.slice(0, 5));
      break;
    }

    // A capacity limit truncates what is bought here, and the remainder stays
    // outstanding for a later stop rather than being silently dropped.
    let remainingCapacity = options.capacity && options.capacity > 0 ? options.capacity : Infinity;
    const kept: PlannedPurchase[] = [];
    for (const purchase of best.purchases) {
      if (remainingCapacity <= 0) break;
      const amount = Math.min(purchase.amount, remainingCapacity);
      remainingCapacity -= amount;
      kept.push({ ...purchase, amount });
    }

    for (const purchase of kept) {
      const need = outstanding.get(purchase.commodity);
      if (need === undefined) continue;
      const left = need.amount - purchase.amount;
      if (left > 0) outstanding.set(purchase.commodity, { ...need, amount: left });
      else outstanding.delete(purchase.commodity);
    }

    used.add(best.station.marketId);
    stops.push({ ...best, purchases: kept });
    rejected.push(...roundRejections.slice(0, 3));
  }

  const cost = stops.every((s) => s.estimatedCost !== null)
    ? stops.reduce((n, s) => n + (s.estimatedCost ?? 0), 0)
    : null;

  return {
    stops,
    unfulfilled: [...outstanding.values()],
    // Deduplicated by station, keeping the first reason given.
    rejected: rejected.filter(
      (r, i, all) => all.findIndex((o) => o.stationName === r.stationName) === i,
    ),
    totalStops: stops.length,
    estimatedCost: cost,
    confidenceRulesVersion: rules.version,
  };
}
