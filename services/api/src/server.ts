/** Entry point. */

import { loadConfig, ConfigError } from './config.js';
import { createPool } from './lib/db.js';
import { createNotifier } from './lib/discord.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createPool(config.databaseUrl);

  const app = await buildApp({
    config,
    db,
    notifier: createNotifier(db, {
      webhook: config.discordWebhook,
      redactSpoilers: config.discordRedactSpoilers,
      log: (msg, extra) => app.log.info(extra ?? {}, msg),
    }),
  });

  if (!config.discordWebhook) {
    app.log.warn('No EDFM_DISCORD_WEBHOOK configured; notifications are recorded, not posted.');
  }

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
