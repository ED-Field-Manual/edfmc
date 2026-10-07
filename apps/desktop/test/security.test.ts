/**
 * Guards on the desktop app's trust boundaries.
 *
 * These are configuration, which is exactly the sort of thing that rots without
 * anyone noticing: the packaged app shipped for weeks with a CSP that blocked
 * every request to the EDFM API, and nothing failed loudly because verification
 * is opt-in and off by default.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TAURI = join(__dirname, '..', 'src-tauri');

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const API_ORIGIN = 'https://api.edfieldmanual.com';

describe('WebView content security policy', () => {
  const conf = json(join(TAURI, 'tauri.conf.json'));
  const csp = String(
    ((conf['app'] as Record<string, unknown>)['security'] as Record<string, unknown>)['csp'],
  );

  it('declares connect-src explicitly', () => {
    // Tauri only ever appends script-src and style-src hashes of its own, so an
    // absent connect-src silently falls back to default-src 'self'. That is what
    // blocked the API in packaged builds.
    expect(csp).toContain('connect-src');
  });

  it('keeps the IPC origins reachable', () => {
    // Narrowing connect-src without these would break `invoke`, taking the
    // journal, the database and the overlay with it.
    expect(csp).toContain('ipc:');
    expect(csp).toContain('http://ipc.localhost');
  });

  it('does NOT name the EDFM API', () => {
    // Deliberate. API traffic goes through the HTTP plugin, so the web layer has
    // no business reaching the network directly. If this ever starts passing by
    // accident, the allowlist has silently moved from a native capability into a
    // CSP string, which is the weaker place for it.
    expect(csp).not.toContain(API_ORIGIN);
  });

  it('has no wildcard source anywhere', () => {
    expect(csp).not.toContain('*');
    expect(csp).not.toContain("'unsafe-eval'");
  });
});

describe('capabilities', () => {
  const dir = join(TAURI, 'capabilities');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  it('grants HTTP only to named destinations, and only to the main window', () => {
    const main = json(join(dir, 'default.json'));
    expect(main['windows']).toEqual(['main']);

    const http = (main['permissions'] as unknown[]).find(
      (p) => typeof p === 'object' && p !== null && (p as Record<string, unknown>)['identifier'] === 'http:default',
    ) as Record<string, unknown> | undefined;

    expect(http, 'the main window needs scoped http:default').toBeDefined();
    const allow = http!['allow'] as Array<{ url: string }>;
    // Exactly these destinations, all named. The EDDN one is the community relay
    // and is deliberately the full path rather than a wildcard, so the capability
    // cannot be used to reach anything else on that host. The two GitHub ones
    // are for plugin update checks: repository metadata, and raw files read to
    // find a plugin's stated version. Both are read-only GETs.
    expect(allow).toEqual([
      { url: `${API_ORIGIN}/*` },
      { url: 'https://eddn.edcd.io:4430/upload/' },
      { url: 'https://api.github.com/repos/*' },
      { url: 'https://raw.githubusercontent.com/*' },
    ]);
  });

  it('never grants a wildcard host', () => {
    const main = json(join(dir, 'default.json'));
    const http = (main['permissions'] as unknown[]).find(
      (p) =>
        typeof p === 'object' && p !== null && (p as Record<string, unknown>)['identifier'] === 'http:default',
    ) as Record<string, unknown>;
    for (const entry of http['allow'] as Array<{ url: string }>) {
      expect(entry.url.startsWith('https://'), entry.url).toBe(true);
      // A wildcard host would make the allowlist decorative.
      expect(entry.url).not.toMatch(/^https:\/\/\*/);
      expect(entry.url).not.toBe('https://*/*');
    }
  });

  it('never grants a bare http permission without a scope', () => {
    // `"http:default"` as a plain string would permit any URL.
    for (const f of files) {
      const perms = json(join(dir, f))['permissions'] as unknown[];
      for (const p of perms) {
        expect(
          typeof p === 'string' && p.startsWith('http:'),
          `${f} grants unscoped ${String(p)}`,
        ).toBe(false);
      }
    }
  });

  it('gives the overlay no network, filesystem, database or shell access', () => {
    // The overlay renders state pushed to it and must stay incapable of anything
    // else, so a future widget cannot quietly acquire reach.
    const overlay = json(join(dir, 'overlay.json'));
    expect(overlay['windows']).toEqual(['overlay']);
    const perms = (overlay['permissions'] as unknown[]).map((p) =>
      typeof p === 'string' ? p : String((p as Record<string, unknown>)['identifier']),
    );
    for (const p of perms) {
      expect(p.startsWith('core:'), `overlay should not hold ${p}`).toBe(true);
    }
    for (const forbidden of ['http:', 'sql:', 'fs:', 'shell:', 'opener:']) {
      expect(perms.some((p) => p.startsWith(forbidden))).toBe(false);
    }
  });
});

describe('Inara credentials and identity', () => {
  const SRC = join(__dirname, '..', 'src');
  const companion = readFileSync(join(SRC, 'lib', 'companion.ts'), 'utf8');
  const rust = readFileSync(join(TAURI, 'src', 'inara.rs'), 'utf8');
  const shared = readFileSync(
    join(__dirname, '..', '..', '..', 'packages', 'integrations', 'src', 'inara.ts'),
    'utf8',
  );

  it('the app name Rust sends is the one the TypeScript side names', () => {
    const rustName = /const APP_NAME: &str = "([^"]+)";/.exec(rust)?.[1];
    const tsName = /export const INARA_APP_NAME = '([^']+)';/.exec(shared)?.[1];
    expect(rustName).toBe('EDFM Companion');
    expect(tsName).toBe(rustName);
  });

  it('the frontend never passes a key, an app name or a hardcoded development flag', () => {
    const submissions = companion.match(/'inara_submit',\s*\{[\s\S]*?\n\s{6,8}\}/g) ?? [];
    expect(submissions.length).toBeGreaterThanOrEqual(2);
    for (const s of submissions) {
      expect(s).not.toMatch(/api_?key/i);
      expect(s).not.toMatch(/app_name/);
      expect(s).toContain('is_being_developed: this.inaraConfig.isBeingDeveloped');
    }
  });

  it('no key-shaped literal is embedded anywhere in the Inara code', () => {
    // A personal Inara key is a long run of letters and digits. None belongs in source.
    for (const src of [companion, rust, shared]) {
      expect(src).not.toMatch(/APIkey"?\s*[:=]\s*["'][A-Za-z0-9]{12,}/);
    }
  });

  it('Inara traffic is gated on the release setting, which defaults off', () => {
    expect(companion).toContain('resolveInaraConfig(import.meta.env)');
    expect(companion).toMatch(/if \(!inaraMayTransmit\(this\.inaraStateInput\(\)\)\) return;/);
  });
});
