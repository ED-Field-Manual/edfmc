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

try {
  const config = loadConfig();

  if (config.discordWebhook === undefined) {
    console.error('No EDFM_DISCORD_WEBHOOK configured. Copy .env.example to .env and set it.');
    process.exit(2);
  }
  // Redacted: this output ends up in terminal scrollback and CI logs.
  console.log(`Webhook: ${redactUrl(config.discordWebhook)}`);
  console.log(`Enabled: ${config.discordEnabled}`);

  const tags = parseTagMap(config.discordTagsRaw, (m, d) => console.warn(m, d ?? {}));
  console.log(`Forum tags configured: ${Object.keys(tags).length}`);

  if (!config.discordEnabled) {
    console.error('Reporting is disabled. Set EDFM_DISCORD_ENABLED=true to send a test.');
    process.exit(2);
  }

  const client = createDiscordClient({
    webhookUrl: config.discordWebhook,
    enabled: true,
    log: (event, detail) => console.log(`  ${event}`, detail ?? {}),
  });

  const outcome = await client.testWebhookConnection();
  console.log(`Outcome: ${outcome.kind}`);

  if (outcome.kind === 'created') {
    console.log(`Forum post created. Thread id: ${outcome.threadId}`);
    console.log('Delete the test post in Discord when you are done with it.');
    process.exit(0);
  }
  if (outcome.kind === 'rejected') {
    console.error(`Discord rejected the request: ${outcome.detail}`);
    console.error(
      'If this says "thread_name", the webhook targets a text channel rather than a Forum.',
    );
    process.exit(1);
  }
  if (outcome.kind === 'invalid-webhook') {
    console.error(`Webhook rejected: ${outcome.detail}. It may have been deleted or revoked.`);
    process.exit(1);
  }
  console.error(`Failed: ${outcome.kind}`);
  process.exit(1);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
    process.exit(2);
  }
  throw error;
}
