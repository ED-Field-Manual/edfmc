/**
 * Post a webhook test to the configured Forum channel.
 *
 *   npm run discord:test --workspace @edfm/api
 *
 * Deliberately a server-side script rather than a button in the desktop app.
 * The webhook is a credential that can write to a public channel, and §19 puts
 * it server-side only — a desktop button would need either the webhook or an
 * admin token in the client, and neither may be there. Administrators can also
 * use `POST /v1/admin/discord/test` with the admin token.
 *
 * Contains no game data, by construction: the body is a fixed string.
 */

import { loadConfig, ConfigError } from '../config.js';
import { createDiscordClient, redactUrl } from '../lib/discord/client.js';
import { parseTagMap } from '../lib/discord/tags.js';

async function main(): Promise<number> {
  const config = loadConfig();

  if (config.discordWebhook === undefined) {
    console.error('No EDFM_DISCORD_WEBHOOK configured. Copy .env.example to .env and set it.');
    return 2;
  }
  // Redacted: this output ends up in terminal scrollback and CI logs.
  console.log(`Webhook: ${redactUrl(config.discordWebhook)}`);
  console.log(`Enabled: ${config.discordEnabled}`);

  const tags = parseTagMap(config.discordTagsRaw, (m, d) => console.warn(m, d ?? {}));
  console.log(`Forum tags configured: ${Object.keys(tags).length}`);

  if (!config.discordEnabled) {
    console.error('Reporting is disabled. Set EDFM_DISCORD_ENABLED=true to send a test.');
    return 2;
  }

  const client = createDiscordClient({
    webhookUrl: config.discordWebhook,
    enabled: true,
    log: (event, detail) => console.log(`  ${event}`, detail ?? {}),
  });

  const outcome = await client.testWebhookConnection();
  console.log(`Outcome: ${outcome.kind}`);

  switch (outcome.kind) {
    case 'created':
      console.log(`Forum post created. Thread id: ${outcome.threadId}`);
      console.log('Delete the test post in Discord when you are done with it.');
      return 0;
    case 'rejected':
      console.error(`Discord rejected the request: ${outcome.detail}`);
      console.error(
        'If this mentions thread_name, the webhook targets a text channel rather than a Forum.',
      );
      return 1;
    case 'invalid-webhook':
      console.error(`Webhook rejected: ${outcome.detail}. It may have been deleted or revoked.`);
      return 1;
    default:
      console.error(`Failed: ${outcome.kind}`);
      return 1;
  }
}

try {
  // Assigning exitCode rather than calling process.exit(): exiting while the
  // fetch handle is still closing trips a libuv assertion on Windows, which
  // turns a successful run into a crash report.
  process.exitCode = await main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
    process.exitCode = 2;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
