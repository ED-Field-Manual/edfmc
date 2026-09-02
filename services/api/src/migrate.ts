/** Applies both the EDDN worker's schema and the API's, in filename order. */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { createPool, migrate } from './lib/db.js';

const here = dirname(fileURLToPath(import.meta.url));

const config = loadConfig();
const db = createPool(config.databaseUrl);

const ran = await migrate(db, [
  join(here, '..', '..', 'eddn-worker', 'migrations'),
  join(here, '..', 'migrations'),
]);

console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Already up to date.');
await db.end();
