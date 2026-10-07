/**
 * The Inara settings states, release configuration, Verify, links, and the
 * privacy manifest's claims about Inara.
 */

import { describe, expect, it } from 'vitest';

import {
  INARA_STATE_LABEL,
  inaraConnectionState,
  inaraLinks,
  inaraMayTransmit,
  inaraMayVerify,
  inaraVerifyEvent,
  readInaraProfile,
  readInaraVerify,
  resolveInaraConfig,
  type InaraStateInput,
} from '../src/inara-state.js';
import { INARA_APP_NAME, buildInaraBatch } from '../src/inara.js';
import {
  COMMUNITY_NEVER_SHARES,
  INTEGRATIONS,
  UNIVERSAL_NEVER_SHARES,
  universalNeverShares,
} from '../src/index.js';

const AUTHORIZED = { appAuthorized: true, isBeingDeveloped: true };

const base: InaraStateInput = {
  hasCredential: true,
  enabled: true,
  config: AUTHORIZED,
  condition: null,
  profile: null,
  lastSuccessAt: null,
};

describe('release configuration', () => {
  it('defaults to the safe answer: not authorised, in development', () => {
    expect(resolveInaraConfig({})).toEqual({ appAuthorized: false, isBeingDeveloped: true });
  });

  it('is changed only by the exact strings, so a typo cannot start traffic', () => {
    expect(resolveInaraConfig({ VITE_INARA_APP_AUTHORIZED: 'yes' }).appAuthorized).toBe(false);
    expect(resolveInaraConfig({ VITE_INARA_APP_AUTHORIZED: true }).appAuthorized).toBe(false);
    expect(resolveInaraConfig({ VITE_INARA_APP_AUTHORIZED: 'true' }).appAuthorized).toBe(true);
    expect(resolveInaraConfig({ VITE_INARA_DEVELOPMENT: '0' }).isBeingDeveloped).toBe(true);
    expect(resolveInaraConfig({ VITE_INARA_DEVELOPMENT: 'false' }).isBeingDeveloped).toBe(false);
  });

  it('uses the app name sent to Inara for white-listing, exactly', () => {
    expect(INARA_APP_NAME).toBe('EDFM Companion');
  });
});

describe('connection state', () => {
  it.each<[string, Partial<InaraStateInput>, string]>([
    ['no key', { hasCredential: false }, 'not-configured'],
    ['app not yet approved (release setting)', { config: { appAuthorized: false, isBeingDeveloped: true } }, 'awaiting-app-authorization'],
    ['app refused by Inara', { condition: 'app-not-allowed' }, 'awaiting-app-authorization'],
    ['key refused', { condition: 'credential' }, 'authentication-failed'],
    ['switched off', { enabled: false }, 'disabled'],
    ['Inara unreachable', { condition: 'transient' }, 'temporarily-unavailable'],
    ['key verified', { profile: { userName: 'u', commanderName: 'c', profileUrl: null, verifiedAt: 'x' } }, 'connected'],
    ['a batch accepted', { lastSuccessAt: '2026-10-06T00:00:00Z' }, 'connected'],
    ['ready but unconfirmed', {}, 'configured'],
  ])('%s', (_, over, expected) => {
    expect(inaraConnectionState({ ...base, ...over })).toBe(expected);
    expect(INARA_STATE_LABEL[expected as keyof typeof INARA_STATE_LABEL]).toBeTruthy();
  });

  it('nothing may be sent while the app is unapproved, even with a key and the switch on', () => {
    expect(inaraMayTransmit({ ...base, config: { appAuthorized: false, isBeingDeveloped: true } })).toBe(false);
    expect(inaraMayVerify({ ...base, config: { appAuthorized: false, isBeingDeveloped: true } })).toBe(false);
  });

  it('nothing may be sent after a refusal, until it is resolved', () => {
    expect(inaraMayTransmit({ ...base, condition: 'credential' })).toBe(false);
    expect(inaraMayTransmit({ ...base, condition: 'app-not-allowed' })).toBe(false);
    // Verify is how a refused key is re-checked, so it stays available.
    expect(inaraMayVerify({ ...base, condition: 'credential' })).toBe(true);
  });

  it('switching off stops sending at once; a transient failure does not', () => {
    expect(inaraMayTransmit({ ...base, enabled: false })).toBe(false);
    expect(inaraMayTransmit({ ...base, condition: 'transient' })).toBe(true);
    expect(inaraMayTransmit({ ...base, hasCredential: false })).toBe(false);
  });
});

describe('Verify', () => {
  const now = '2026-10-06T22:00:00Z';

  it('asks for the key owner’s own profile, by sending no search name', () => {
    expect(inaraVerifyEvent(now)).toEqual({
      eventName: 'getCommanderProfile',
      eventTimestamp: now,
      eventCustomID: 1,
      eventData: {},
    });
  });

  it('is verified only when Inara answers the event with success', () => {
    const http = {
      status: 200,
      transportError: null,
      body: JSON.stringify({
        header: { eventStatus: 200, eventData: { userID: 1, userName: 'Tester' } },
        events: [
          {
            eventCustomID: 1,
            eventStatus: 200,
            eventData: { userName: 'Tester', commanderName: 'Testpilot', inaraURL: 'https://inara.cz/cmdr/1/' },
          },
        ],
      }),
    };
    expect(readInaraVerify(http, now)).toEqual({
      kind: 'verified',
      profile: { userName: 'Tester', commanderName: 'Testpilot', profileUrl: 'https://inara.cz/cmdr/1/', verifiedAt: now },
    });
  });

  it.each([
    ['app not approved', { eventStatus: 400, eventStatusText: 'This application has no access allowed.' }, 'app-not-allowed'],
    ['key refused', { eventStatus: 400, eventStatusText: 'Invalid API key' }, 'credential'],
  ])('%s is reported, not called success', (_, header, kind) => {
    const r = readInaraVerify({ status: 200, transportError: null, body: JSON.stringify({ header, events: [] }) }, now);
    expect(r.kind).toBe(kind);
  });

  it('no answer, or a soft error on the event, is not success', () => {
    expect(readInaraVerify({ status: 0, body: '', transportError: 'timeout' }, now).kind).toBe('transient');
    const soft = JSON.stringify({ header: { eventStatus: 200 }, events: [{ eventStatus: 204 }] });
    expect(readInaraVerify({ status: 200, body: soft, transportError: null }, now).kind).toBe('transient');
  });

  it('a cached profile is read back, and a forged link is dropped', () => {
    const p = readInaraProfile(
      JSON.stringify({ userName: 'u', commanderName: 'c', profileUrl: 'https://evil.example/', verifiedAt: 'x' }),
    );
    expect(p).toEqual({ userName: 'u', commanderName: 'c', profileUrl: null, verifiedAt: 'x' });
    expect(readInaraProfile(null)).toBeNull();
    expect(readInaraProfile('{}')).toBeNull();
  });
});

describe('links back to Inara', () => {
  it('URL-encodes the documented search formats', () => {
    expect(inaraLinks.starsystem('Shinrarta Dezhra')).toBe(
      'https://inara.cz/elite/starsystem/?search=Shinrarta%20Dezhra',
    );
    expect(inaraLinks.starsystem(3932277478106)).toBe(
      'https://inara.cz/elite/starsystem/?search=3932277478106',
    );
    expect(inaraLinks.station('Newholm Station', 'Sothis')).toBe(
      'https://inara.cz/elite/station/?search=Newholm%20Station%20%5BSothis%5D',
    );
    expect(inaraLinks.carrier('W5W-3KZ')).toBe('https://inara.cz/elite/station/?search=W5W-3KZ');
    expect(inaraLinks.minorfaction('Inara Nexus')).toBe(
      'https://inara.cz/elite/minorfaction/?search=Inara%20Nexus',
    );
    expect(inaraLinks.starsystem('A&B?c=d')).toBe('https://inara.cz/elite/starsystem/?search=A%26B%3Fc%3Dd');
  });
});

describe('the key', () => {
  it('the envelope built in JavaScript never carries one', () => {
    // The real key is added in Rust. Anything built here gets an empty string.
    const batch = buildInaraBatch({
      apiKey: '',
      commanderName: 'Testpilot',
      commanderFrontierID: 'F1',
      appName: INARA_APP_NAME,
      appVersion: '0.1.0',
      isBeingDeveloped: true,
      events: [],
    });
    expect(batch.header.APIkey).toBe('');
  });
});

describe('privacy manifest', () => {
  it('every universal promise is one Inara keeps', () => {
    for (const promise of UNIVERSAL_NEVER_SHARES) {
      expect(INTEGRATIONS.inara.privacy.neverShares).toContain(promise);
    }
    // And the universal list no longer claims what Inara now sends, on request.
    expect(UNIVERSAL_NEVER_SHARES.join(' ')).not.toMatch(/credits|loadout|reputation/i);
  });

  it('keeps the community/universal split: Inara is a community service', () => {
    for (const promise of COMMUNITY_NEVER_SHARES) {
      expect(INTEGRATIONS.inara.privacy.neverShares).toContain(promise);
    }
    expect(universalNeverShares(Object.values(INTEGRATIONS))).toEqual([...UNIVERSAL_NEVER_SHARES]);
  });

  it('states the surface-position exclusion and the credits opt-in in words', () => {
    expect(INTEGRATIONS.inara.privacy.neverShares.join(' ')).toMatch(/latitude and longitude/i);
    expect(INTEGRATIONS.inara.privacy.shares.join(' ')).toMatch(/credits and loan, only if you switch that on/i);
    expect(INTEGRATIONS.inara.privacy.credentialHelp).toMatch(/approve this app/i);
  });
});
