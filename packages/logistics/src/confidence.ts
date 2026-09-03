/**
 * Market confidence (§15).
 *
 * "Do not simply show a reported stock number as if it is guaranteed to still
 * exist."
 *
 * §15 insists on separating two questions that are easy to conflate:
 *
 *   DATA CONFIDENCE   how much should we trust this observation for the
 *                     quantity actually being asked for?
 *   DESTINATION SCORE how attractive is this station for this task?
 *
 * They are separate types here, computed by separate functions, and the
 * confidence result never contains a preference. A market can be perfectly
 * trustworthy and a terrible place to go, and a plan that cannot express that
 * ends up justifying a bad stop with good data.
 *
 * Every factor is returned alongside the verdict. §15 requires the underlying
 * numbers not be hidden, and that is easier to guarantee when the explanation
 * *is* the return value rather than something a UI reconstructs.
 *
 * No machine learning, by instruction and by preference: a commander who is
 * told to fly 40 light years deserves to be able to check the reasoning.
 */

export type ConfidenceLevel = 'very-high' | 'high' | 'moderate' | 'poor' | 'unusable';

/** One reason, with the number behind it. Rendered verbatim. */
export interface ConfidenceFactor {
  readonly label: string;
  readonly detail: string;
  /** How this factor pushed the verdict. */
  readonly effect: 'supports' | 'neutral' | 'undermines';
}

export interface ConfidenceResult {
  readonly level: ConfidenceLevel;
  /** reported supply ÷ (needed × safety margin). 1.0 means exactly enough. */
  readonly coverage: number;
  readonly needed: number;
  readonly reported: number;
  readonly ageSeconds: number;
  readonly factors: readonly ConfidenceFactor[];
  /** One line a commander can read without expanding anything. */
  readonly summary: string;
}

/**
 * Thresholds, versioned so they can be served later (§15).
 *
 * Deliberately data rather than constants scattered through the logic: the
 * right numbers are an empirical question that will change as the market
 * database grows, and changing them must not mean shipping a desktop build.
 */
export interface ConfidenceRules {
  readonly version: number;
  /** Coverage at or above this is comfortable. */
  readonly coverageStrong: number;
  /** Below this there is not enough stock to bother. */
  readonly coverageMinimum: number;
  /** Seconds after which an observation starts to look stale. */
  readonly ageFresh: number;
  readonly ageStale: number;
  /** Beyond this the observation says nothing useful about now. */
  readonly ageUseless: number;
}

export const DEFAULT_CONFIDENCE_RULES: ConfidenceRules = {
  version: 1,
  // §15's own worked example treats 416% as very high and 107% as poor, so the
  // strong threshold sits well above "just enough": a market with 7% headroom
  // is one competing commander away from being empty.
  coverageStrong: 2.0,
  coverageMinimum: 1.0,
  // Elite's markets restock on a timescale of hours, and EDDN reports arrive
  // within seconds of a commander docking. Fifteen minutes is genuinely fresh;
  // §15's example calls 5h17m poor.
  ageFresh: 15 * 60,
  ageStale: 60 * 60,
  ageUseless: 12 * 60 * 60,
};

export interface ConfidenceInput {
  /** How much this task needs from this market. */
  readonly needed: number;
  /** Stock the observation reported. */
  readonly reported: number;
  /** Age of the observation in seconds. */
  readonly ageSeconds: number;
  /**
   * Buy this proportion more than strictly required.
   *
   * A commander's own hedge against the market having sold some since. Applied
   * to the requirement, not to the report, because inflating someone else's
   * measurement would be inventing stock.
   */
  readonly safetyMargin?: number;
}

function humanAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function assessConfidence(
  input: ConfidenceInput,
  rules: ConfidenceRules = DEFAULT_CONFIDENCE_RULES,
): ConfidenceResult {
  const margin = input.safetyMargin ?? 0;
  // Ceil with a tolerance, not a bare ceil: 100 * 1.1 is 110.00000000000001 in
  // IEEE 754, so a 10% margin on 100 tonnes would ask for 111. Small, but it
  // is visibly wrong to anyone who checks the arithmetic.
  const target = Math.max(1, Math.ceil(input.needed * (1 + margin) - 1e-9));
  const coverage = input.reported / target;
  const age = Math.max(0, input.ageSeconds);

  const factors: ConfidenceFactor[] = [
    {
      label: 'Coverage',
      detail:
        `${input.reported.toLocaleString()} reported against ` +
        `${target.toLocaleString()} needed (${Math.round(coverage * 100)}%)` +
        (margin > 0 ? `, including a ${Math.round(margin * 100)}% safety margin` : ''),
      effect:
        coverage >= rules.coverageStrong
          ? 'supports'
          : coverage < rules.coverageMinimum
            ? 'undermines'
            : 'neutral',
    },
    {
      label: 'Observation age',
      detail: `${humanAge(age)} old`,
      effect:
        age <= rules.ageFresh ? 'supports' : age >= rules.ageStale ? 'undermines' : 'neutral',
    },
  ];

  let level: ConfidenceLevel;
  if (coverage < rules.coverageMinimum) {
    // Not enough stock is disqualifying regardless of how fresh the reading is:
    // knowing precisely that there is too little does not help.
    level = 'unusable';
  } else if (age >= rules.ageUseless) {
    level = 'unusable';
  } else if (coverage >= rules.coverageStrong && age <= rules.ageFresh) {
    level = 'very-high';
  } else if (coverage >= rules.coverageStrong && age < rules.ageStale) {
    level = 'high';
  } else if (age >= rules.ageStale) {
    // §15's worked example: 107% coverage at 5h17m is poor. Thin stock and an
    // old reading is the combination most likely to waste a trip.
    level = coverage >= rules.coverageStrong ? 'moderate' : 'poor';
  } else {
    level = coverage >= rules.coverageStrong ? 'high' : 'moderate';
  }

  return {
    level,
    coverage,
    needed: target,
    reported: input.reported,
    ageSeconds: age,
    factors,
    summary:
      `${input.reported.toLocaleString()} of ${target.toLocaleString()} needed ` +
      `(${Math.round(coverage * 100)}%), ${humanAge(age)} old`,
  };
}

const ORDER: Record<ConfidenceLevel, number> = {
  unusable: 0,
  poor: 1,
  moderate: 2,
  high: 3,
  'very-high': 4,
};

export function atLeast(level: ConfidenceLevel, minimum: ConfidenceLevel): boolean {
  return ORDER[level] >= ORDER[minimum];
}

export function confidenceLabel(level: ConfidenceLevel): string {
  return {
    'very-high': 'Very High',
    high: 'High',
    moderate: 'Moderate',
    poor: 'Poor',
    unusable: 'Unusable',
  }[level];
}
