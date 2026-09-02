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

  it('redacts spoilers unless explicitly disabled', () => {
    expect(loadConfig(base).discordRedactSpoilers).toBe(true);
    expect(loadConfig({ ...base, EDFM_DISCORD_REDACT_SPOILERS: 'no' }).discordRedactSpoilers).toBe(true);
    expect(loadConfig({ ...base, EDFM_DISCORD_REDACT_SPOILERS: 'false' }).discordRedactSpoilers).toBe(false);
  });
});
