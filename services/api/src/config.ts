/**
 * Server configuration.
 *
 * Everything secret lives here and only here, read from the environment. §19:
 * the desktop client is untrusted and must never hold the Discord webhook, the
 * database credentials, or the identity salt. Nothing in this file is ever
 * serialised into a response.
 */

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  /** HMAC key for identity hashing. Secret, and rotating it re-anonymises. */
  readonly identitySalt: string;
  /** Server-side only. Absent means notifications are recorded but not posted. */
  readonly discordWebhook: string | undefined;
  /** Redact spoiler-sensitive findings before posting. Default on. */
  readonly discordRedactSpoilers: boolean;
  readonly rateLimitPerMinute: number;
  readonly env: 'development' | 'production' | 'test';
}

export class ConfigError extends Error {}

/**
 * A weak salt is worse than none, because it looks like protection.
 *
 * Commander FIDs are short and structured, so an unsalted or guessable hash is
 * reversible by anyone holding the database: enumerate the space, compare. The
 * salt is what makes `fid_hash` a distinguisher rather than a reversible
 * identifier, which is the whole basis for claiming in PRIVACY.md that FIDs are
 * not stored.
 */
const MIN_SALT_LENGTH = 32;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.NODE_ENV ?? 'development') as Config['env'];

  const databaseUrl = env.EDFM_DATABASE_URL;
  if (!databaseUrl) {
    throw new ConfigError('EDFM_DATABASE_URL is required.');
  }

  const identitySalt = env.EDFM_IDENTITY_SALT;
  if (!identitySalt) {
    throw new ConfigError(
      'EDFM_IDENTITY_SALT is required. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (identitySalt.length < MIN_SALT_LENGTH) {
    throw new ConfigError(
      `EDFM_IDENTITY_SALT must be at least ${MIN_SALT_LENGTH} characters. ` +
        'A guessable salt does not anonymise anything -- commander FIDs are ' +
        'short enough to enumerate against a known key.',
    );
  }

  const webhook = env.EDFM_DISCORD_WEBHOOK;
  if (webhook && !webhook.startsWith('https://')) {
    throw new ConfigError('EDFM_DISCORD_WEBHOOK must be an https URL.');
  }

  return {
    port: Number(env.EDFM_PORT ?? 8787),
    host: env.EDFM_HOST ?? '127.0.0.1',
    databaseUrl,
    identitySalt,
    discordWebhook: webhook,
    // Opt-out rather than opt-in: forgetting to configure redaction must not
    // be the thing that posts an unvisited system into a searchable channel.
    discordRedactSpoilers: env.EDFM_DISCORD_REDACT_SPOILERS !== 'false',
    rateLimitPerMinute: Number(env.EDFM_RATE_LIMIT_PER_MINUTE ?? 60),
    env: mode,
  };
}
