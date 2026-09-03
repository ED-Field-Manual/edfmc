/** Entry point. */

import { loadConfig, ConfigError, type Config } from './config.js';
import { createPool, type Db } from './lib/db.js';
import { createDiscordClient } from './lib/discord/client.js';
import { createReporter } from './lib/discord/reporter.js';
import { createNotifier } from './lib/discord/notifier.js';
import { parseTagMap } from './lib/discord/tags.js';
import { buildApp } from './app.js';

/** How often the outbound Discord queue is drained. */
const QUEUE_INTERVAL_MS = 15_000;

async function main(): Promise<void> {
  const config: Config = loadConfig();
  const db: Db = createPool(config.databaseUrl);

  // Deferred so the logger exists before anything logs through it.
  let log: (event: string, detail?: Record<string, unknown>) => void = () => {};

  const tagMap = parseTagMap(config.discordTagsRaw, (message, detail) =>
    log(message, detail),
  );

  const reporter = createReporter({
    db,
    client: createDiscordClient({
      webhookUrl: config.discordWebhook,
      enabled: config.discordEnabled,
      log: (event, detail) => log(event, detail),
    }),
    tagMap,
    config: {
      enabled: config.discordEnabled,
      postResolutions: config.discordPostResolutions,
      includeCommander: config.discordIncludeCommander,
      spoilerPolicy: config.discordSpoilerPolicy,
    },
    log: (event, detail) => log(event, detail),
  });

  const app = await buildApp({
    config,
    db,
    reporter,
    notifier: createNotifier(db, reporter, { log: (event, detail) => log(event, detail) }),
  });

  log = (event, detail) => app.log.info(detail ?? {}, event);

  if (!config.discordEnabled) {
    app.log.warn(
      config.discordWebhook === undefined
        ? 'Discord reporting is off: no EDFM_DISCORD_WEBHOOK configured.'
        : 'Discord reporting is off: set EDFM_DISCORD_ENABLED=true to enable it.',
    );
  } else {
    app.log.info(
      { tags: Object.keys(tagMap).length, spoilerPolicy: config.discordSpoilerPolicy },
      'Discord Forum reporting enabled',
    );
  }
  if (config.adminToken === undefined) {
    app.log.warn('No EDFM_ADMIN_TOKEN set; administrative endpoints are not registered.');
  }

  // Draining the queue on a timer rather than inline is the whole point of
  // having one: a Discord outage must not reach back into request handling,
  // and reports must outlive the process that queued them.
  const timer = setInterval(() => {
    void reporter.processQueue().catch((error: unknown) => {
      app.log.error({ error: String(error) }, 'discord.queue_error');
    });
  }, QUEUE_INTERVAL_MS);
  timer.unref();

  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
