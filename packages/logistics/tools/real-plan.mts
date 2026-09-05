/**
 * The whole Phase 8/9 chain on real data: real construction sites from the
 * journals, combined across sites, planned against the live market database.
 *
 *   EDFM_API=http://127.0.0.1:8787 npx tsx packages/logistics/tools/real-plan.mts
 */
import { join } from 'node:path';
import { listJournalFiles, replayFile } from '@edfm/elite-journal';
import '@edfm/elite-journal/node';
import {
  siteFromDepot, combinedRequirements, allocate, buildPlan,
  confidenceLabel, type ConstructionSite, type CandidateStation,
} from '../src/index.js';

const API = process.env.EDFM_API ?? 'http://127.0.0.1:8798';
const DIR = join(process.env.USERPROFILE ?? '', 'Saved Games', 'Frontier Developments', 'Elite Dangerous');

const sites = new Map<string, ConstructionSite>();
for (const file of await listJournalFiles(DIR)) {
  const { events } = await replayFile(file.fullPath);
  for (const e of events) {
    if (e.kind !== 'colonisation-depot') continue;
    const id = String((e.data as { marketId?: unknown }).marketId ?? '');
    const site = siteFromDepot(e, sites.get(id));
    if (site) sites.set(site.marketId, site);
  }
}

const all = [...sites.values()];
const requirements = combinedRequirements(all);
const active = all.filter((s) => !s.complete && !s.failed);
console.log(`${active.length} active sites, ${requirements.length} outstanding commodities\n`);

const res = await fetch(`${API}/v1/market/search`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ commodities: requirements.map((r) => r.commodity).slice(0, 64), minStock: 1, limit: 120 }),
});
const { candidates } = (await res.json()) as { candidates: CandidateStation[] };
console.log(`market search returned ${candidates.length} candidate stations\n`);

const plan = buildPlan(requirements, candidates, { minConfidence: 'moderate', safetyMargin: 0.1, maxStops: 6 });

console.log('RECOMMENDED PROCUREMENT PLAN');
plan.stops.forEach((stop, i) => {
  console.log(`\nSTOP ${i + 1}  ${stop.station.stationName}  (${stop.station.systemName})`);
  for (const p of stop.purchases.slice(0, 6)) {
    console.log(`   ${p.label.padEnd(22)} ${p.amount.toLocaleString().padStart(9)}  ${confidenceLabel(p.confidence.level)}`);
    // §17: show where each purchase would go.
    const split = allocate(p.commodity, p.amount, all);
    if (split.length > 1) {
      console.log(`      distributed: ${split.map((a) => `${a.marketId.slice(-4)}=${a.amount.toLocaleString()}`).join(', ')}`);
    }
  }
  if (stop.purchases.length > 6) console.log(`   ... and ${stop.purchases.length - 6} more`);
  console.log(`   reasons: ${stop.reasons[0]}`);
});

console.log(`\nStations required: ${plan.totalStops}`);
console.log(`Could not source: ${plan.unfulfilled.length} commodities`);
for (const u of plan.unfulfilled.slice(0, 6)) {
  console.log(`   ${u.label}: ${u.amount.toLocaleString()} short`);
}
