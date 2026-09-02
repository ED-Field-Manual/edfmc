/**
 * Replay a journal through the live pipeline and print the resulting state.
 *
 * The development counterpart to the corpus tests: same parser, same normalizer,
 * same state reducer the running application uses. Handy for reproducing a bug
 * report from a journal file without launching the desktop client.
 *
 *   node --experimental-strip-types scripts/replay.mts            # newest journal
 *   node --experimental-strip-types scripts/replay.mts <file.log>
 */

import '../packages/elite-journal/src/node.ts';
import { nodeFs } from '../packages/elite-journal/src/node.ts';
import { listJournalFiles, selectActiveJournal, resolveJournalDirectory } from '../packages/elite-journal/src/directory.ts';
import { replayFile } from '../packages/elite-journal/src/engine.ts';
import { applyEvent, initialState } from '../packages/elite-journal/src/state.ts';
import { isKnown } from '../packages/elite-journal/src/types.ts';

function show(v: unknown): string {
  if (!isKnown(v as never)) return 'Unknown';
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  return String(v);
}

const explicit = process.argv[2];
let target = explicit ?? null;

if (!target) {
  const resolved = await resolveJournalDirectory({});
  if (!resolved.directory) {
    console.error(`Could not locate a journal directory: ${resolved.detail}`);
    process.exit(1);
  }
  console.log(`Directory: ${resolved.directory}  (${resolved.strategy})`);
  const files = await listJournalFiles(resolved.directory, nodeFs);
  const active = selectActiveJournal(files);
  if (!active) {
    console.error('No non-empty journal files found.');
    process.exit(1);
  }
  console.log(`Files: ${files.length}  Empty: ${files.filter((f) => f.sizeBytes === 0).length}`);
  target = active.fullPath;
}

console.log(`Replaying: ${target}\n`);

const result = await replayFile(target, nodeFs);

const state = initialState();
for (const event of result.events) applyEvent(state, event);

console.log('--- INGEST ---');
console.log(`  lines read        ${result.stats.linesRead}`);
console.log(`  events emitted    ${result.stats.eventsEmitted}`);
console.log(`  malformed JSON    ${result.stats.malformedJson}`);
console.log(`  missing event     ${result.stats.missingEventField}`);
console.log(`  not an object     ${result.stats.notAnObject}`);

console.log('\n--- FINAL STATE ---');
for (const [k, v] of Object.entries(state)) {
  if (k === 'stationServices') {
    console.log(`  ${k.padEnd(16)} ${isKnown(v as never) ? `${(v as unknown[]).length} services` : 'Unknown'}`);
    continue;
  }
  console.log(`  ${k.padEnd(16)} ${show(v)}`);
}

const unknown = Object.entries(result.stats.unknownEventKinds).sort((a, b) => b[1] - a[1]);
console.log(`\n--- EVENTS WITHOUT A TYPED SHAPE (${unknown.length}) ---`);
for (const [name, n] of unknown.slice(0, 20)) console.log(`  ${name.padEnd(34)} ${n}`);
