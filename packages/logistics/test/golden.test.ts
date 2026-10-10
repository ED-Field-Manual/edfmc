/**
 * The planner's behaviour, frozen as data the Python port must reproduce.
 *
 * The sourcing planner moves into the Construction Logistics plugin, which runs
 * in EDFMC's Python plugin host, so it is ported to Python. This file is the
 * proof that the port is faithful: every case below is run through THIS
 * TypeScript implementation and its complete output is stored in
 * `plugins/ConstructionLogistics/tests/golden/planner.json`. The plugin's own
 * tests run the same inputs through the Python planner and must produce the
 * same output, field for field.
 *
 * The cases are the existing unit tests' inputs plus a seeded batch of random
 * plans, so both the behaviour the tests describe and the arithmetic between
 * them are pinned.
 *
 * Regenerate with UPDATE_GOLDEN=1 (only when the TypeScript planner's behaviour
 * changes on purpose). Otherwise this test fails if the TypeScript planner and
 * the stored file disagree, so the file cannot silently drift from it.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assessConfidence, type ConfidenceInput } from '../src/confidence.js';
import { toMarketSymbol, displayName } from '../src/symbols.js';
import { buildPlan, type CandidateStation, type PlanOptions, type Requirement } from '../src/plan.js';
import { allocate, combinedRequirements, type ConstructionSite } from '../src/projects.js';

const FILE = join(__dirname, '..', '..', '..', 'plugins', 'ConstructionLogistics', 'tests', 'golden', 'planner.json');

const fresh = new Date('2026-09-03T12:00:00Z').getTime();
const at = (minutesAgo: number) => new Date(fresh - minutesAgo * 60_000).toISOString();
const need = (commodity: string, amount: number): Requirement => ({ commodity, label: commodity, amount });

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

interface PlanCase {
  readonly name: string;
  readonly requirements: readonly Requirement[];
  readonly candidates: readonly CandidateStation[];
  readonly options: PlanOptions;
}

const planetaryVsOrbital = (): CandidateStation[] => [
  station({ marketId: 'orbital', distanceLy: 20, offers: [{ commodity: 'a', stock: 2000, buyPrice: 100, observedAt: at(5) }] }),
  station({
    marketId: 'planetary', isPlanetary: true, distanceLy: 1,
    offers: [
      { commodity: 'a', stock: 90000, buyPrice: 10, observedAt: at(1) },
      { commodity: 'b', stock: 90000, buyPrice: 10, observedAt: at(1) },
    ],
  }),
];

const base = { nowMs: fresh, safetyMargin: 0 };

/** The existing unit tests' inputs. */
const unitCases: PlanCase[] = [
  {
    name: 'one stop covering three beats a closer single',
    requirements: [need('a', 100), need('b', 100), need('c', 100)],
    candidates: [
      station({ marketId: 'near', distanceLy: 1, offers: [{ commodity: 'a', stock: 5000, buyPrice: 100, observedAt: at(2) }] }),
      station({
        marketId: 'far', distanceLy: 30,
        offers: ['a', 'b', 'c'].map((c) => ({ commodity: c, stock: 5000, buyPrice: 100, observedAt: at(2) })),
      }),
    ],
    options: base,
  },
  {
    name: 'reasons in words',
    requirements: [need('a', 100), need('b', 100)],
    candidates: [station({ marketId: 's1', distanceLy: 38, offers: ['a', 'b'].map((c) => ({ commodity: c, stock: 5000, buyPrice: 100, observedAt: at(14) })) })],
    options: base,
  },
  {
    name: 'closer station lost',
    requirements: [need('a', 1000)],
    candidates: [
      station({ marketId: 'close', stationName: 'Close Dock', distanceLy: 2, offers: [{ commodity: 'a', stock: 1030, buyPrice: 100, observedAt: at(7 * 60) }] }),
      station({ marketId: 'good', distanceLy: 40, offers: [{ commodity: 'a', stock: 90000, buyPrice: 100, observedAt: at(3) }] }),
    ],
    options: base,
  },
  {
    name: 'unfulfilled reported',
    requirements: [need('a', 100), need('rare', 500)],
    candidates: [station({ marketId: 's1', offers: [{ commodity: 'a', stock: 900, buyPrice: 10, observedAt: at(1) }] })],
    options: base,
  },
  {
    name: 'split across stops',
    requirements: [need('a', 1000)],
    candidates: [
      station({ marketId: 's1', distanceLy: 1, offers: [{ commodity: 'a', stock: 600, buyPrice: 10, observedAt: at(1) }] }),
      station({ marketId: 's2', distanceLy: 2, offers: [{ commodity: 'a', stock: 600, buyPrice: 10, observedAt: at(1) }] }),
    ],
    options: base,
  },
  {
    name: 'never more than reported',
    requirements: [need('a', 5000)],
    candidates: [station({ marketId: 's1', offers: [{ commodity: 'a', stock: 900, buyPrice: 10, observedAt: at(1) }] })],
    options: { ...base, minConfidence: 'poor' },
  },
  {
    name: 'hold capacity',
    requirements: [need('a', 1000)],
    candidates: [station({ marketId: 's1', offers: [{ commodity: 'a', stock: 5000, buyPrice: 10, observedAt: at(1) }] })],
    options: { ...base, capacity: 400, maxStops: 1 },
  },
  {
    name: 'carriers off',
    requirements: [need('a', 100)],
    candidates: [station({ marketId: 'fc', stationName: 'Carrier', isFleetCarrier: true, offers: [{ commodity: 'a', stock: 9000, buyPrice: 10, observedAt: at(1) }] })],
    options: base,
  },
  {
    name: 'carriers on',
    requirements: [need('a', 100)],
    candidates: [station({ marketId: 'fc', stationName: 'Carrier', isFleetCarrier: true, offers: [{ commodity: 'a', stock: 9000, buyPrice: 10, observedAt: at(1) }] })],
    options: { ...base, allowFleetCarriers: true },
  },
  {
    name: 'orbital only excludes',
    requirements: [need('a', 100)],
    candidates: [station({ marketId: 'p', isPlanetary: true, offers: [{ commodity: 'a', stock: 9000, buyPrice: 10, observedAt: at(1) }] })],
    options: { ...base, stationPreference: 'orbital-only' },
  },
  { name: 'strongly prefer orbital', requirements: [need('a', 100), need('b', 100)], candidates: planetaryVsOrbital(), options: { ...base, stationPreference: 'strongly-prefer-orbital' } },
  { name: 'planetary if better', requirements: [need('a', 100), need('b', 100)], candidates: planetaryVsOrbital(), options: { ...base, stationPreference: 'planetary-if-better' } },
  {
    name: 'data too old',
    requirements: [need('a', 100)],
    candidates: [station({ marketId: 's1', offers: [{ commodity: 'a', stock: 9000, buyPrice: 10, observedAt: at(120) }] })],
    options: { ...base, maxDataAgeSeconds: 3600 },
  },
  {
    name: 'max stops',
    requirements: Array.from({ length: 10 }, (_, i) => need(`c${i}`, 100)),
    candidates: Array.from({ length: 10 }, (_, i) => station({ marketId: `s${i}`, offers: [{ commodity: `c${i}`, stock: 500, buyPrice: 10, observedAt: at(1) }] })),
    options: { ...base, maxStops: 3 },
  },
  { name: 'empty', requirements: [need('a', 100)], candidates: [], options: base },
  {
    name: 'steel partial fills with margin',
    requirements: [need('steel', 138791)],
    candidates: [
      station({ marketId: 'a', distanceLy: 5, offers: [{ commodity: 'steel', stock: 50000, buyPrice: 100, observedAt: at(3) }] }),
      station({ marketId: 'b', distanceLy: 8, offers: [{ commodity: 'steel', stock: 50000, buyPrice: 100, observedAt: at(3) }] }),
    ],
    options: { nowMs: fresh, safetyMargin: 0.1 },
  },
  {
    name: 'thin with margin',
    requirements: [need('a', 100)],
    candidates: [station({ marketId: 's', offers: [{ commodity: 'a', stock: 105, buyPrice: 10, observedAt: at(1) }] })],
    options: { nowMs: fresh, safetyMargin: 0.1 },
  },
  {
    name: 'unknown distances, prices and types',
    requirements: [need('a', 300), need('b', 50)],
    candidates: [
      station({ marketId: 'u', distanceLy: null, arrivalDistanceLs: null, isPlanetary: null, offers: [{ commodity: 'a', stock: 4000, buyPrice: null, observedAt: at(30) }] }),
      station({ marketId: 'k', distanceLy: 12.25, arrivalDistanceLs: 1250, offers: [{ commodity: 'b', stock: 70, buyPrice: 3000, observedAt: at(200) }] }),
    ],
    options: { nowMs: fresh, minConfidence: 'poor', priceImportance: 0.8, arrivalDistanceImportance: 0.1 },
  },
];

/** A small, seeded generator: the same random cases every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomCases(count: number): PlanCase[] {
  const r = rng(20261010);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const commodities = ['steel', 'aluminium', 'ceramiccomposites', 'cmmcomposite', 'liquidoxygen', 'polymers', 'semiconductors', 'titanium', 'water', 'foodcartridges'];
  const prefs = ['orbital-only', 'strongly-prefer-orbital', 'no-preference', 'planetary-if-better'] as const;
  const levels = ['poor', 'moderate', 'high'] as const;
  const out: PlanCase[] = [];
  for (let n = 0; n < count; n += 1) {
    const wanted = commodities.filter(() => r() < 0.5);
    if (wanted.length === 0) wanted.push(pick(commodities));
    const requirements = wanted.map((c) => need(c, 1 + Math.floor(r() * 20000)));
    const candidates = Array.from({ length: 2 + Math.floor(r() * 7) }, (_, i) =>
      station({
        marketId: `m${n}-${i}`,
        stationName: `Station ${n}-${i}`,
        systemName: `System ${i}`,
        distanceLy: r() < 0.15 ? null : Math.round(r() * 8000) / 100,
        arrivalDistanceLs: r() < 0.15 ? null : Math.round(r() * 400000) / 100,
        isPlanetary: r() < 0.1 ? null : r() < 0.3,
        isFleetCarrier: r() < 0.15,
        offers: commodities
          .filter(() => r() < 0.45)
          .map((c) => ({
            commodity: c,
            stock: Math.floor(r() * 40000),
            buyPrice: r() < 0.1 ? null : 50 + Math.floor(r() * 5000),
            observedAt: at(Math.floor(r() * 900)),
          })),
      }),
    );
    const options: PlanOptions = {
      nowMs: fresh,
      safetyMargin: pick([0, 0.05, 0.1, 0.25]),
      stationPreference: pick(prefs),
      allowFleetCarriers: r() < 0.5,
      minConfidence: pick(levels),
      ...(r() < 0.4 ? { capacity: 100 + Math.floor(r() * 1500) } : {}),
      ...(r() < 0.4 ? { maxDataAgeSeconds: 3600 * (1 + Math.floor(r() * 12)) } : {}),
      ...(r() < 0.3 ? { maxStops: 1 + Math.floor(r() * 5) } : {}),
      ...(r() < 0.3 ? { allowPlanetary: false } : {}),
    };
    out.push({ name: `random ${n}`, requirements, candidates, options });
  }
  return out;
}

const confidenceCases: ConfidenceInput[] = [
  { needed: 7500, reported: 31221, ageSeconds: 180 },
  { needed: 7500, reported: 8015, ageSeconds: 5 * 3600 + 17 * 60 },
  { needed: 100, reported: 99, ageSeconds: 10 },
  { needed: 100, reported: 9999, ageSeconds: 13 * 3600 },
  { needed: 100, reported: 500, ageSeconds: 1, safetyMargin: 0.1 },
  { needed: 8412, reported: 99999, ageSeconds: 1, safetyMargin: 0.1 },
  { needed: 101, reported: 500, ageSeconds: 1, safetyMargin: 0.1 },
  { needed: 100, reported: 150, ageSeconds: 1800 },
  { needed: 100, reported: 250, ageSeconds: 1800 },
  { needed: 100, reported: 250, ageSeconds: 4000 },
  { needed: 0, reported: 10, ageSeconds: 89 },
  { needed: 5, reported: 10, ageSeconds: 5399 },
];

const symbolCases = ['$ceramiccomposites_name;', '$Aluminium_name;', 'ceramiccomposites', ' $Steel_name; ', 'Two Words', '', '$odd-name_name;'];

const site = (marketId: string, priority: number, resources: Array<[string, number, number]>, extra: Partial<ConstructionSite> = {}): ConstructionSite => ({
  marketId, progress: 0.2, complete: false, failed: false, updatedAt: '2026-09-03T12:00:00Z', priority, name: null,
  resources: resources.map(([commodity, required, provided]) => ({
    commodity, label: commodity, journalName: `$${commodity}_name;`, required, provided, remaining: Math.max(0, required - provided), payment: null,
  })),
  ...extra,
});

const siteSets: ConstructionSite[][] = [
  [site('A', 1, [['ceramiccomposites', 4000, 0]]), site('B', 1, [['ceramiccomposites', 3200, 0]]), site('C', 1, [['ceramiccomposites', 3200, 0]])],
  [site('A', 1, [['aluminium', 1000, 400], ['steel', 50, 50]])],
  [site('A', 1, [['aluminium', 1000, 0]], { complete: true }), site('B', 1, [['aluminium', 1000, 0]], { failed: true })],
  [site('low', 2, [['aluminium', 5000, 0]]), site('high', 1, [['aluminium', 800, 0], ['small', 10, 0]])],
];

function build() {
  return {
    note: 'Generated from the TypeScript planner by packages/logistics/test/golden.test.ts. Do not edit by hand.',
    plans: [...unitCases, ...randomCases(40)].map((c) => ({
      name: c.name,
      input: { requirements: c.requirements, candidates: c.candidates, options: c.options },
      output: buildPlan(c.requirements, c.candidates, c.options),
    })),
    confidence: confidenceCases.map((input) => ({ input, output: assessConfidence(input) })),
    symbols: symbolCases.map((input) => ({ input, output: toMarketSymbol(input) })),
    displayNames: [
      { symbol: 'gold', localised: null, output: displayName('gold', null) },
      { symbol: 'drones', localised: 'Limpet', output: displayName('drones', 'Limpet') },
      { symbol: 'x', localised: '', output: displayName('x', '') },
    ],
    combined: siteSets.map((sites) => ({ sites, output: combinedRequirements(sites) })),
    allocate: siteSets.map((sites) => ({ sites, commodity: 'aluminium', amount: 1000, output: allocate('aluminium', 1000, sites) })),
  };
}

describe('golden planner cases for the Python port', () => {
  it('the stored file is exactly what the TypeScript planner produces', () => {
    const golden = JSON.parse(JSON.stringify(build()));
    if (process.env['UPDATE_GOLDEN'] === '1' || !existsSync(FILE)) {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE, JSON.stringify(golden, null, 1) + '\n');
    }
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(golden);
  });
});
