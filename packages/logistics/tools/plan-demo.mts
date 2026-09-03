/**
 * Build a real sourcing plan against a running API.
 *
 *   EDFM_API=http://127.0.0.1:8787 npx tsx packages/logistics/tools/plan-demo.mts
 *
 * Uses §16's own worked example, against the live market
 * database and through the real planner.
 */
import { buildPlan, type CandidateStation, type Requirement } from '../src/index.js';

const API = process.env.EDFM_API ?? 'http://127.0.0.1:8797';

// §16's input example.
const requirements: Requirement[] = [
  { commodity: 'ceramiccomposites', label: 'Ceramic Composites', amount: 8412 },
  { commodity: 'cmmcomposite', label: 'CMM Composite', amount: 6102 },
  { commodity: 'polymers', label: 'Polymers', amount: 3848 },
  { commodity: 'buildingfabricators', label: 'Building Fabricators', amount: 1923 },
  { commodity: 'powergenerators', label: 'Power Generators', amount: 882 },
];

const res = await fetch(`${API}/v1/market/search`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    commodities: requirements.map((r) => r.commodity),
    minStock: 1,
    limit: 120,
  }),
});
const { candidates, stations, offers } = (await res.json()) as {
  candidates: CandidateStation[]; stations: number; offers: number;
};
console.log(`market search: ${stations} stations, ${offers} offers\n`);

const plan = buildPlan(requirements, candidates, { minConfidence: 'moderate', safetyMargin: 0.1 });

console.log('RECOMMENDED PROCUREMENT PLAN');
plan.stops.forEach((stop, i) => {
  console.log(`\nSTOP ${i + 1}  ${stop.station.stationName}  (${stop.station.systemName})`);
  for (const p of stop.purchases) {
    console.log(`   ${p.label.padEnd(22)} ${p.amount.toLocaleString().padStart(8)}   ${p.confidence.level}  [${p.confidence.summary}]`);
  }
  console.log('   selected because:');
  for (const r of stop.reasons) console.log(`     - ${r}`);
});

console.log(`\nStations required: ${plan.totalStops}`);
if (plan.unfulfilled.length > 0) {
  console.log('Could not source:');
  for (const u of plan.unfulfilled) console.log(`   ${u.label}: ${u.amount.toLocaleString()} short`);
}
if (plan.rejected.length > 0) {
  console.log('\nRejected (sample):');
  for (const r of plan.rejected.slice(0, 4)) {
    console.log(`   ${r.stationName}: ${r.reason}`);
  }
}
console.log(`\nconfidence rules v${plan.confidenceRulesVersion}`);
