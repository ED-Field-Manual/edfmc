import { describe, expect, it } from 'vitest';
import {
  assessConfidence,
  atLeast,
  DEFAULT_CONFIDENCE_RULES,
} from '../src/confidence.js';
import { toMarketSymbol, displayName } from '../src/symbols.js';
import { buildPlan, type CandidateStation, type Requirement } from '../src/plan.js';
import { allocate, combinedRequirements, type ConstructionSite } from '../src/projects.js';

/* ------------------------------------------------------------- symbols */

describe('toMarketSymbol', () => {
  it('unwraps the journal form', () => {
    expect(toMarketSymbol('$ceramiccomposites_name;')).toBe('ceramiccomposites');
  });

  it('folds case, because Frontier emits both', () => {
    // Measured: 84 distinct names for 42 commodities, because every one appears
    // as both `$aluminium_name;` and `$Aluminium_name;`. Without folding, each
    // requirement splits in two and half of them match no market row.
    expect(toMarketSymbol('$Aluminium_name;')).toBe('aluminium');
    expect(toMarketSymbol('$aluminium_name;')).toBe('aluminium');
    expect(toMarketSymbol('$CMMComposite_name;')).toBe('cmmcomposite');
  });

  it('accepts an already-bare symbol', () => {
    expect(toMarketSymbol('ceramiccomposites')).toBe('ceramiccomposites');
  });

  it('refuses a shape it does not recognise rather than guessing', () => {
    // A commodity whose name Frontier changes must surface as unmatched, not
    // silently become a different commodity.
    expect(toMarketSymbol('$weird name with spaces;')).toBeNull();
    expect(toMarketSymbol('')).toBeNull();
  });
});

describe('displayName', () => {
  it("prefers Frontier's own localisation", () => {
    expect(displayName('cmmcomposite', 'CMM Composite')).toBe('CMM Composite');
  });

  it('falls back without inventing a curated name', () => {
    expect(displayName('cmmcomposite', null)).toBe('Cmmcomposite');
  });
});

/* ---------------------------------------------------------- confidence */

describe('assessConfidence', () => {
  it("matches §15's very-high example", () => {
    // Needed 7,500, reported 31,221, 3 minutes old, coverage 416%.
    const r = assessConfidence({ needed: 7500, reported: 31221, ageSeconds: 180, safetyMargin: 0 });
    expect(r.level).toBe('very-high');
    expect(Math.round(r.coverage * 100)).toBe(416);
  });

  it("matches §15's poor example", () => {
    // Needed 7,500, reported 8,015, 5h17m old, coverage 107%.
    const r = assessConfidence({
      needed: 7500, reported: 8015, ageSeconds: 5 * 3600 + 17 * 60, safetyMargin: 0,
    });
    expect(r.level).toBe('poor');
    expect(Math.round(r.coverage * 100)).toBe(107);
  });

  it('never hides the numbers behind the verdict', () => {
    const r = assessConfidence({ needed: 100, reported: 250, ageSeconds: 60, safetyMargin: 0.1 });
    expect(r.summary).toContain('250');
    expect(r.summary).toContain('110'); // 100 needed plus the 10% margin asked for
    expect(r.factors.map((f) => f.label)).toEqual(['Coverage', 'Observation age']);
    expect(r.factors[0]!.detail).toContain('safety margin');
  });

  it('treats too little stock as unusable however fresh the reading is', () => {
    // Knowing precisely that there is not enough does not help.
    const r = assessConfidence({ needed: 1000, reported: 10, ageSeconds: 1, safetyMargin: 0 });
    expect(r.level).toBe('unusable');
  });

  it('treats a very old reading as unusable however much stock it claimed', () => {
    const r = assessConfidence({ needed: 10, reported: 999999, ageSeconds: 13 * 3600 });
    expect(r.level).toBe('unusable');
  });

  it('applies the safety margin to the requirement, not to the report', () => {
    // Inflating someone else's measurement would be inventing stock.
    const plain = assessConfidence({ needed: 1000, reported: 1050, ageSeconds: 60, safetyMargin: 0 });
    const hedged = assessConfidence({ needed: 1000, reported: 1050, ageSeconds: 60, safetyMargin: 0.2 });
    expect(plain.reported).toBe(hedged.reported);
    expect(hedged.needed).toBe(1200);
    expect(hedged.coverage).toBeLessThan(plain.coverage);
  });

  it('carries the rules version so a plan can say what it was judged by', () => {
    expect(DEFAULT_CONFIDENCE_RULES.version).toBe(1);
  });
});

describe('atLeast', () => {
  it('orders the levels', () => {
    expect(atLeast('very-high', 'moderate')).toBe(true);
    expect(atLeast('poor', 'moderate')).toBe(false);
    expect(atLeast('moderate', 'moderate')).toBe(true);
  });
});

/* ---------------------------------------------------------------- plan */

const need = (commodity: string, amount: number): Requirement => ({
  commodity, label: commodity, amount,
});

const fresh = new Date('2026-09-03T12:00:00Z').getTime();
const at = (minutesAgo: number) => new Date(fresh - minutesAgo * 60_000).toISOString();

function station(over: Partial<CandidateStation> & { marketId: string }): CandidateStation {
  return {
    stationName: `Station ${over.marketId}`,
    systemName: 'Somewhere',
    systemAddress: '1',
    distanceLy: 10,
    arrivalDistanceLs: 500,
    isPlanetary: false,
    isFleetCarrier: false,
    offers: [],
    ...over,
  };
}

const plan = (r: Requirement[], c: CandidateStation[], o = {}) =>
  buildPlan(r, c, { nowMs: fresh, safetyMargin: 0, ...o });

/** One planetary station that is better on every axis except being planetary. */
const planetaryVsOrbital = (): CandidateStation[] => [
  station({
    marketId: 'orbital', distanceLy: 20,
    offers: [{ commodity: 'a', stock: 2000, buyPrice: 100, observedAt: at(5) }],
  }),
  station({
    marketId: 'planetary', isPlanetary: true, distanceLy: 1,
    offers: [
      { commodity: 'a', stock: 90000, buyPrice: 10, observedAt: at(1) },
      { commodity: 'b', stock: 90000, buyPrice: 10, observedAt: at(1) },
    ],
  }),
];

describe('buildPlan', () => {
  it('prefers one stop that covers three commodities over a closer single-commodity stop', () => {
    // §16: optimise the whole operation, not each commodity independently.
    const result = plan(
      [need('a', 100), need('b', 100), need('c', 100)],
      [
        station({
          marketId: 'near', distanceLy: 1,
          offers: [{ commodity: 'a', stock: 5000, buyPrice: 100, observedAt: at(2) }],
        }),
        station({
          marketId: 'far', distanceLy: 30,
          offers: [
            { commodity: 'a', stock: 5000, buyPrice: 100, observedAt: at(2) },
            { commodity: 'b', stock: 5000, buyPrice: 100, observedAt: at(2) },
            { commodity: 'c', stock: 5000, buyPrice: 100, observedAt: at(2) },
          ],
        }),
      ],
    );
    expect(result.stops[0]!.station.marketId).toBe('far');
    expect(result.totalStops).toBe(1);
  });

  it('explains why a station was selected, in words', () => {
    const result = plan(
      [need('a', 100), need('b', 100)],
      [station({
        marketId: 's1', distanceLy: 38,
        offers: [
          { commodity: 'a', stock: 5000, buyPrice: 100, observedAt: at(14) },
          { commodity: 'b', stock: 5000, buyPrice: 100, observedAt: at(14) },
        ],
      })],
    );
    const reasons = result.stops[0]!.reasons.join(' | ');
    expect(reasons).toContain('fulfils 2 of 2');
    expect(reasons).toContain('38.0 ly from you');
    expect(reasons).toContain('orbital station');
    expect(reasons).toContain('14m old');
  });

  it('never reduces the reasoning to a single number', () => {
    // §16: do not collapse the factors into an unexplained magic number.
    const result = plan(
      [need('a', 100)],
      [station({ marketId: 's1', offers: [{ commodity: 'a', stock: 900, buyPrice: 50, observedAt: at(1) }] })],
    );
    const labels = result.stops[0]!.components.map((c) => c.label);
    expect(labels).toContain('Commodities fulfilled');
    expect(labels).toContain('System distance');
    expect(labels).toContain('Stock headroom');
    expect(labels).toContain('Price');
    expect(labels).toContain('Station type');
    for (const c of result.stops[0]!.components) expect(c.detail).not.toBe('');
  });

  it("records why a closer station lost, in §16's own terms", () => {
    const result = plan(
      [need('a', 1000)],
      [
        station({
          marketId: 'close', stationName: 'Close Dock', distanceLy: 2,
          offers: [{ commodity: 'a', stock: 1030, buyPrice: 100, observedAt: at(7 * 60) }],
        }),
        station({
          marketId: 'good', distanceLy: 40,
          offers: [{ commodity: 'a', stock: 90000, buyPrice: 100, observedAt: at(3) }],
        }),
      ],
    );
    expect(result.stops[0]!.station.marketId).toBe('good');
    const close = result.rejected.find((r) => r.stationName === 'Close Dock');
    expect(close).toBeDefined();
    expect(close!.reason).toMatch(/103% of what is needed|7h old/);
  });

  it('reports what it could not source rather than inventing a stop', () => {
    const result = plan([need('a', 100), need('rare', 500)], [
      station({ marketId: 's1', offers: [{ commodity: 'a', stock: 900, buyPrice: 10, observedAt: at(1) }] }),
    ]);
    expect(result.unfulfilled.map((r) => r.commodity)).toEqual(['rare']);
  });

  it('splits a requirement across stops when one market cannot cover it', () => {
    const result = plan([need('a', 1000)], [
      station({ marketId: 's1', distanceLy: 1, offers: [{ commodity: 'a', stock: 600, buyPrice: 10, observedAt: at(1) }] }),
      station({ marketId: 's2', distanceLy: 2, offers: [{ commodity: 'a', stock: 600, buyPrice: 10, observedAt: at(1) }] }),
    ]);
    const bought = result.stops.reduce((n, s) => n + s.purchases[0]!.amount, 0);
    expect(bought).toBe(1000);
    expect(result.totalStops).toBe(2);
  });

  it('never plans to buy more than a market reported', () => {
    const result = plan([need('a', 5000)], [
      station({ marketId: 's1', offers: [{ commodity: 'a', stock: 900, buyPrice: 10, observedAt: at(1) }] }),
    ], { minConfidence: 'poor' });
    expect(result.stops[0]!.purchases[0]!.amount).toBe(900);
  });

  it('respects hold capacity and leaves the rest outstanding', () => {
    const result = plan([need('a', 1000)], [
      station({ marketId: 's1', offers: [{ commodity: 'a', stock: 5000, buyPrice: 10, observedAt: at(1) }] }),
    ], { capacity: 400, maxStops: 1 });
    expect(result.stops[0]!.purchases[0]!.amount).toBe(400);
    expect(result.unfulfilled[0]!.amount).toBe(600);
  });

  it('excludes fleet carriers unless enabled, and says so', () => {
    const carrier = station({
      marketId: 'fc', stationName: 'Carrier', isFleetCarrier: true,
      offers: [{ commodity: 'a', stock: 9000, buyPrice: 10, observedAt: at(1) }],
    });
    const off = plan([need('a', 100)], [carrier]);
    expect(off.stops).toHaveLength(0);
    expect(off.rejected[0]!.reason).toContain('fleet carrier');

    const on = plan([need('a', 100)], [carrier], { allowFleetCarriers: true });
    expect(on.stops).toHaveLength(1);
  });

  it('honours orbital-only as an exclusion, not a preference', () => {
    const planetary = station({
      marketId: 'p', isPlanetary: true,
      offers: [{ commodity: 'a', stock: 9000, buyPrice: 10, observedAt: at(1) }],
    });
    const result = plan([need('a', 100)], [planetary], { stationPreference: 'orbital-only' });
    expect(result.stops).toHaveLength(0);
    expect(result.rejected[0]!.reason).toContain('orbital only');
  });

  it('keeps the orbital station when orbital is strongly preferred', () => {
    // "Strongly prefer" has to actually mean something: the planetary option
    // below covers twice as much and is nineteen light years closer, and still
    // loses. The mode for "let it win when better" is planetary-if-better.
    const result = plan([need('a', 100), need('b', 100)], planetaryVsOrbital(), {
      stationPreference: 'strongly-prefer-orbital',
    });
    expect(result.stops[0]!.station.marketId).toBe('orbital');
  });

  it('lets a planetary station win when it is clearly better', () => {
    const result = plan([need('a', 100), need('b', 100)], planetaryVsOrbital(), {
      stationPreference: 'planetary-if-better',
    });
    expect(result.stops[0]!.station.marketId).toBe('planetary');
  });

  it('rejects data older than the commander allows', () => {
    const result = plan([need('a', 100)], [
      station({ marketId: 's1', offers: [{ commodity: 'a', stock: 9000, buyPrice: 10, observedAt: at(120) }] }),
    ], { maxDataAgeSeconds: 3600 });
    expect(result.stops).toHaveLength(0);
    expect(result.rejected[0]!.reason).toContain('120m old');
  });

  it('stops at the maximum number of stops rather than sprawling', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      station({ marketId: `s${i}`, offers: [{ commodity: `c${i}`, stock: 500, buyPrice: 10, observedAt: at(1) }] }),
    );
    const result = plan(
      Array.from({ length: 10 }, (_, i) => need(`c${i}`, 100)),
      candidates,
      { maxStops: 3 },
    );
    expect(result.totalStops).toBe(3);
    expect(result.unfulfilled).toHaveLength(7);
  });

  it('says which confidence rules produced the plan', () => {
    const result = plan([need('a', 100)], []);
    expect(result.confidenceRulesVersion).toBe(1);
  });
});

/* ------------------------------------------------------------ projects */

const site = (over: Partial<ConstructionSite> & { marketId: string }): ConstructionSite => ({
  progress: 0.2, complete: false, failed: false, resources: [],
  updatedAt: '2026-09-03T12:00:00Z', priority: 1, name: null, ...over,
});

const resource = (commodity: string, required: number, provided: number) => ({
  commodity, label: commodity, journalName: `$${commodity}_name;`,
  required, provided, remaining: Math.max(0, required - provided), payment: null,
});

describe('combinedRequirements', () => {
  it("adds the same commodity across sites, as §17's example does", () => {
    // Ceramic Composites: 4,000 + 3,200 + 3,200 = 10,400.
    const total = combinedRequirements([
      site({ marketId: 'A', resources: [resource('ceramiccomposites', 4000, 0)] }),
      site({ marketId: 'B', resources: [resource('ceramiccomposites', 3200, 0)] }),
      site({ marketId: 'C', resources: [resource('ceramiccomposites', 3200, 0)] }),
    ]);
    expect(total).toEqual([{ commodity: 'ceramiccomposites', label: 'ceramiccomposites', amount: 10400 }]);
  });

  it('counts only what is still outstanding', () => {
    const total = combinedRequirements([
      site({ marketId: 'A', resources: [resource('aluminium', 1000, 400)] }),
    ]);
    expect(total[0]!.amount).toBe(600);
  });

  it('ignores completed and failed sites', () => {
    // Continuing to shop for a finished site would be actively misleading.
    const total = combinedRequirements([
      site({ marketId: 'A', complete: true, resources: [resource('aluminium', 1000, 0)] }),
      site({ marketId: 'B', failed: true, resources: [resource('aluminium', 1000, 0)] }),
    ]);
    expect(total).toEqual([]);
  });

  it('orders by the largest outstanding requirement', () => {
    const total = combinedRequirements([
      site({ marketId: 'A', resources: [resource('small', 10, 0), resource('big', 9000, 0)] }),
    ]);
    expect(total.map((r) => r.commodity)).toEqual(['big', 'small']);
  });
});

describe('allocate', () => {
  it('fills higher-priority sites first rather than trickling everywhere', () => {
    const out = allocate('aluminium', 1000, [
      site({ marketId: 'low', priority: 2, resources: [resource('aluminium', 5000, 0)] }),
      site({ marketId: 'high', priority: 1, resources: [resource('aluminium', 800, 0)] }),
    ]);
    expect(out[0]).toMatchObject({ marketId: 'high', amount: 800 });
    expect(out[1]).toMatchObject({ marketId: 'low', amount: 200 });
  });

  it('gives nothing to a site that needs nothing', () => {
    const out = allocate('aluminium', 500, [
      site({ marketId: 'done', resources: [resource('aluminium', 100, 100)] }),
    ]);
    expect(out).toEqual([]);
  });
});

describe('safety margin arithmetic', () => {
  it('does not ask for a tonne more than the margin implies', () => {
    // 100 * 1.1 is 110.00000000000001 in IEEE 754; a bare ceil turns a 10%
    // margin on 100 tonnes into 111.
    expect(assessConfidence({ needed: 100, reported: 500, ageSeconds: 1, safetyMargin: 0.1 }).needed).toBe(110);
    expect(assessConfidence({ needed: 8412, reported: 99999, ageSeconds: 1, safetyMargin: 0.1 }).needed).toBe(9254);
    // A fractional requirement still rounds up: you cannot buy 0.5 tonnes.
    expect(assessConfidence({ needed: 101, reported: 500, ageSeconds: 1, safetyMargin: 0.1 }).needed).toBe(112);
  });
});

describe('partial fills with a safety margin', () => {
  it('sources a large requirement across stops rather than refusing entirely', () => {
    // Found against real data: four construction sites needing 138,791 tonnes
    // of Steel matched 42 candidate stations and produced zero stops, because
    // the margin was applied to a take that was already capped at stock --
    // stock / (stock * 1.1) never reaches the coverage minimum.
    const result = buildPlan(
      [need('steel', 138791)],
      [
        station({ marketId: 'a', distanceLy: 5, offers: [{ commodity: 'steel', stock: 50000, buyPrice: 100, observedAt: at(3) }] }),
        station({ marketId: 'b', distanceLy: 8, offers: [{ commodity: 'steel', stock: 50000, buyPrice: 100, observedAt: at(3) }] }),
      ],
      { nowMs: fresh, safetyMargin: 0.1 },
    );
    expect(result.totalStops).toBe(2);
    expect(result.stops.reduce((n, s) => n + s.purchases[0]!.amount, 0)).toBe(100000);
    expect(result.unfulfilled[0]!.amount).toBe(38791);
  });

  it('still applies the margin when the market can cover it', () => {
    // Taking 100 from a market holding 105 leaves no headroom, and the
    // commander asked for 10%.
    const thin = buildPlan([need('a', 100)],
      [station({ marketId: 's', offers: [{ commodity: 'a', stock: 105, buyPrice: 10, observedAt: at(1) }] })],
      { nowMs: fresh, safetyMargin: 0.1 });
    expect(thin.stops).toHaveLength(0);

    const ample = buildPlan([need('a', 100)],
      [station({ marketId: 's', offers: [{ commodity: 'a', stock: 500, buyPrice: 10, observedAt: at(1) }] })],
      { nowMs: fresh, safetyMargin: 0.1 });
    expect(ample.stops).toHaveLength(1);
  });
});
