/** Print the real research summary for this machine's corpus. */
import { join } from 'node:path';
import { listJournalFiles, replayFile } from '@edfm/elite-journal';
import '@edfm/elite-journal/node';
import type { CommanderState } from '@edfm/elite-journal';
import { SessionTracker, isPlausible } from './src/session.js';
import { groupBy, itemTally, summarise } from './src/quality.js';
import { SETTLEMENT_MATERIALS } from './src/projects/settlement-materials.js';

const DIR = join(
  process.env.USERPROFILE ?? '',
  'Saved Games', 'Frontier Developments', 'Elite Dangerous',
);

const tracker = new SessionTracker({ project: SETTLEMENT_MATERIALS, companionVersion: 'report' });
for (const file of await listJournalFiles(DIR)) {
  const { events } = await replayFile(file.fullPath);
  for (const e of events) tracker.observe(e, {} as CommanderState);
}
tracker.finish();

const sessions = tracker.sessions();
const summary = summarise(sessions, SETTLEMENT_MATERIALS);

console.log(`sessions: ${sessions.length}`);
console.log('end events:');
const ends = new Map<string, number>();
for (const s of sessions) ends.set(s.endEvent ?? 'none', (ends.get(s.endEvent ?? 'none') ?? 0) + 1);
for (const [k, v] of [...ends].sort((a, b) => b[1] - a[1])) console.log(`   ${v}  ${k}`);

const durations = sessions.map((s) => s.durationSeconds ?? 0).sort((a, b) => a - b);
console.log(`durations: min ${durations[0]}s  median ${durations[durations.length >> 1]}s  max ${durations.at(-1)}s`);
console.log(`under 60s: ${durations.filter((d) => d < 60).length}`);
console.log(`over 3600s: ${durations.filter((d) => d > 3600).length}`);
console.log(`with observations: ${sessions.filter((s) => s.observations.length > 0).length}`);
console.log(`usable (plausible): ${sessions.filter((s) => isPlausible(s, SETTLEMENT_MATERIALS)).length}`);
console.log();
console.log('summary:', JSON.stringify(summary, null, 1));
console.log();
console.log('by economy:');
for (const g of groupBy(sessions, SETTLEMENT_MATERIALS, 'economy')) {
  console.log(`   ${g.sessions} sessions, ${g.sessionsWithObservations} with items, ${g.distinctLocations} settlements  ${g.group}`);
}
console.log();
console.log('top items:');
for (const i of itemTally(sessions, SETTLEMENT_MATERIALS).slice(0, 10)) {
  console.log(`   ${i.sessions} sessions / ${i.total} total  ${i.name} (${i.category})`);
}
