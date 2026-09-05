/**
 * Validate a plugin without installing it.
 *
 *   npx tsx packages/plugins/tools/check.mts examples/plugins/deep-core-mining
 *
 * Runs exactly the validation the application runs, so "it passes here" and
 * "it will load there" are the same statement.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { validatePlugin } from '../src/index.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: check.mts <plugin-directory>');
  process.exit(2);
}

let json: string;
try {
  json = readFileSync(join(dir, 'plugin.json'), 'utf8');
} catch {
  console.error(`No plugin.json in ${dir}`);
  process.exit(2);
}

const result = validatePlugin({ directory: basename(dir), json });

if ('problems' in result) {
  console.error(`REJECTED: ${result.id ?? basename(dir)}`);
  for (const p of result.problems) console.error(`  - ${p.message}`);
  process.exit(1);
}

console.log(`OK: ${result.manifest.name} ${result.manifest.version} (${result.manifest.id})`);
console.log(`   context rules:     ${result.contextRules.length}`);
console.log(`   research projects: ${result.researchProjects.length}`);
for (const rule of result.contextRules) {
  console.log(`     - ${rule.id}  "${rule.title}"  ttl ${rule.ttlSeconds}s`);
}
for (const w of result.warnings) console.log(`   warning: ${w}`);
