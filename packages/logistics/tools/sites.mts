/**
 * Replay the real journals through the construction-site tracker.
 *
 * Phase 9 is gated on the basic optimiser being demonstrably correct, and unit
 * tests only demonstrate that it does what it was told. This shows what it does
 * to a commander's actual colonisation history.
 *
 *   npx tsx packages/logistics/tools/sites.mts
 */
import { join } from 'node:path';
import { listJournalFiles, replayFile } from '@edfm/elite-journal';
import '@edfm/elite-journal/node';
import { siteFromDepot, combinedRequirements, allocate, type ConstructionSite } from '../src/index.js';

const DIR = join(
  process.env.USERPROFILE ?? '',
  'Saved Games', 'Frontier Developments', 'Elite Dangerous',
);

const sites = new Map<string, ConstructionSite>();
let depotEvents = 0;

for (const file of await listJournalFiles(DIR)) {
  const { events } = await replayFile(file.fullPath);
  for (const event of events) {
    if (event.kind !== 'colonisation-depot') continue;
    depotEvents += 1;
    const marketId = String((event.data as { marketId?: unknown }).marketId ?? '');
    const site = siteFromDepot(event, sites.get(marketId));
    if (site !== null) sites.set(site.marketId, site);
  }
}

console.log(`${depotEvents.toLocaleString()} depot events -> ${sites.size} distinct sites\n`);

const all = [...sites.values()];
for (const site of all) {
  const remaining = site.resources.reduce((n, r) => n + r.remaining, 0);
  const required = site.resources.reduce((n, r) => n + r.required, 0);
  const state = site.failed ? 'FAILED' : site.complete ? 'COMPLETE' : 'active';
  console.log(
    `site ${site.marketId}  ${state.padEnd(8)}  progress ${
      site.progress === null ? '?' : (site.progress * 100).toFixed(1) + '%'
    }  ${site.resources.length} commodities  ${remaining.toLocaleString()}/${required.toLocaleString()} t outstanding`,
  );
}

const active = all.filter((s) => !s.complete && !s.failed);
console.log(`\nactive sites: ${active.length}`);

const combined = combinedRequirements(all);
console.log(`combined outstanding commodities: ${combined.length}`);
for (const r of combined.slice(0, 8)) {
  console.log(`   ${r.label.padEnd(24)} ${r.amount.toLocaleString().padStart(9)}`);
}

// §17's multi-site question: how would one purchase be distributed?
if (combined.length > 0 && active.length > 0) {
  const top = combined[0]!;
  console.log(`\nallocating a purchase of ${top.amount.toLocaleString()} ${top.label}:`);
  for (const a of allocate(top.commodity, top.amount, all)) {
    console.log(`   ${a.siteName ?? a.marketId}: ${a.amount.toLocaleString()}`);
  }
}

// Every commodity must have folded to a market symbol, or the join to market
// data silently loses it.
const unmapped = all.flatMap((s) => s.resources).filter((r) => !/^[a-z0-9_]+$/.test(r.commodity));
console.log(`\nresources whose symbol did not fold cleanly: ${unmapped.length}`);
