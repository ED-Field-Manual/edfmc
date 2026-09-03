import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const base = {
  EDFM_DATABASE_URL: 'postgresql://localhost/edfm_dev',
  EDFM_IDENTITY_SALT: 'a'.repeat(64),
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('refuses to start without a database url', () => {
    expect(() => loadConfig({ ...base, EDFM_DATABASE_URL: undefined })).toThrow(ConfigError);
  });

  it('refuses to start without an identity salt', () => {
    expect(() => loadConfig({ ...base, EDFM_IDENTITY_SALT: undefined })).toThrow(/required/);
  });

  it('refuses a salt short enough to brute force', () => {
    // FIDs are short and structured. A weak key makes fid_hash reversible by
    // anyone holding the database, which would make the privacy claim false.
    expect(() => loadConfig({ ...base, EDFM_IDENTITY_SALT: 'short' })).toThrow(/at least/);
  });

  it('refuses a non-https webhook', () => {
    expect(() => loadConfig({ ...base, EDFM_DISCORD_WEBHOOK: 'http://x' })).toThrow(/https/);
  });

  it('refuses something that is not a Discord webhook URL', () => {
    // Caught at boot rather than as a 404 on the first real report.
    expect(() =>
      loadConfig({ ...base, EDFM_DISCORD_WEBHOOK: 'https://example.com/hook' }),
    ).toThrow(/does not look like a Discord webhook/);
  });

  it('suppresses spoiler-sensitive findings unless told otherwise', () => {
    // A Forum post is public and permanent -- weaker containment than the
    // admin channel redaction was designed for.
    expect(loadConfig(base).discordSpoilerPolicy).toBe('suppress');
    expect(
      loadConfig({ ...base, EDFM_DISCORD_SPOILER_POLICY: 'redact' }).discordSpoilerPolicy,
    ).toBe('redact');
  });

  it('refuses an unrecognised spoiler policy rather than guessing', () => {
    expect(() =>
      loadConfig({ ...base, EDFM_DISCORD_SPOILER_POLICY: 'off' }),
    ).toThrow(/suppress/);
  });

  it('stays off unless explicitly enabled and given a webhook', () => {
    const webhook = 'https://discord.com/api/webhooks/1/abc';
    // A half-configured deployment must post nothing, not post somewhere
    // unintended.
    expect(loadConfig(base).discordEnabled).toBe(false);
    expect(loadConfig({ ...base, EDFM_DISCORD_ENABLED: 'true' }).discordEnabled).toBe(false);
    expect(loadConfig({ ...base, EDFM_DISCORD_WEBHOOK: webhook }).discordEnabled).toBe(false);
    expect(
      loadConfig({ ...base, EDFM_DISCORD_ENABLED: 'true', EDFM_DISCORD_WEBHOOK: webhook })
        .discordEnabled,
    ).toBe(true);
  });

  it('does not name the commander unless asked to', () => {
    expect(loadConfig(base).discordIncludeCommander).toBe(false);
  });
});
