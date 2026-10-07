/**
 * Inara, as the commander sees it: release configuration, connection state,
 * the cached profile, and links back to Inara.
 *
 * Pure, so every state the settings card can show is tested without a window.
 */

import { trustedInaraUrl, type InaraCondition } from './inara-queue.js';
import { parseInaraResponse } from './inara.js';

/* ---------------------------------------------------------------- config */

export interface InaraReleaseConfig {
  /**
   * Inara has white-listed `INARA_APP_NAME`. Until then nothing is queued or
   * sent, the Verify button included.
   */
  readonly appAuthorized: boolean;
  /** Sent as `isBeingDeveloped`. */
  readonly isBeingDeveloped: boolean;
}

/**
 * Read the release configuration from build-time variables.
 *
 * Both default to the safe answer: not authorised, in development. Only the
 * exact string `true` / `false` changes a default, so a typo cannot switch
 * development mode off or start traffic.
 */
export function resolveInaraConfig(env: Readonly<Record<string, unknown>>): InaraReleaseConfig {
  return {
    appAuthorized: env['VITE_INARA_APP_AUTHORIZED'] === 'true',
    isBeingDeveloped: env['VITE_INARA_DEVELOPMENT'] !== 'false',
  };
}

/* --------------------------------------------------------------- profile */

/** What Verify stores, per commander. Nothing here is secret. */
export interface InaraProfile {
  readonly userName: string | null;
  readonly commanderName: string | null;
  readonly profileUrl: string | null;
  /** ISO 8601, when Inara confirmed the key. */
  readonly verifiedAt: string;
}

export type InaraVerifyResult =
  | { readonly kind: 'verified'; readonly profile: InaraProfile }
  | { readonly kind: InaraCondition; readonly message: string };

/** The one event Verify sends: no `searchName`, so Inara answers for the key's owner. */
export function inaraVerifyEvent(at: string): {
  eventName: string;
  eventTimestamp: string;
  eventCustomID: number;
  eventData: Record<string, never>;
} {
  return { eventName: 'getCommanderProfile', eventTimestamp: at, eventCustomID: 1, eventData: {} };
}

/**
 * Read Verify's answer.
 *
 * Only a 200/202 on the event itself counts as verified: "never claim success
 * unless Inara confirmed it".
 */
export function readInaraVerify(
  http: { readonly status: number; readonly body: string; readonly transportError: string | null },
  now: string,
): InaraVerifyResult {
  if (http.transportError !== null || http.status === 0) {
    return { kind: 'transient', message: 'Inara could not be reached. Try again later.' };
  }
  if (http.status < 200 || http.status >= 300) {
    return { kind: 'transient', message: `Inara answered HTTP ${http.status}. Try again later.` };
  }
  let body: unknown;
  try {
    body = JSON.parse(http.body);
  } catch {
    return { kind: 'transient', message: 'Inara sent a reply that could not be read.' };
  }
  const outcome = parseInaraResponse(body);
  if (outcome.kind === 'app-not-allowed') {
    return { kind: 'app-not-allowed', message: 'Inara has not approved this app yet.' };
  }
  if (outcome.kind === 'credential') {
    return { kind: 'credential', message: 'Inara did not accept this API key.' };
  }
  if (outcome.kind !== 'accepted') {
    return { kind: 'transient', message: 'Inara did not confirm the key. Try again later.' };
  }
  const event = outcome.perEvent[0];
  if (!event || (event.status !== 200 && event.status !== 202)) {
    return { kind: 'transient', message: 'Inara did not confirm the key. Try again later.' };
  }
  const d = event.data ?? {};
  return {
    kind: 'verified',
    profile: {
      userName: typeof d['userName'] === 'string' ? d['userName'] : null,
      commanderName: typeof d['commanderName'] === 'string' ? d['commanderName'] : null,
      profileUrl: trustedInaraUrl(d['inaraURL']),
      verifiedAt: now,
    },
  };
}

export function readInaraProfile(text: string | null): InaraProfile | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as Partial<InaraProfile>;
    if (typeof p.verifiedAt !== 'string') return null;
    return {
      userName: typeof p.userName === 'string' ? p.userName : null,
      commanderName: typeof p.commanderName === 'string' ? p.commanderName : null,
      profileUrl: trustedInaraUrl(p.profileUrl),
      verifiedAt: p.verifiedAt,
    };
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- state */

/**
 * Where the Inara connection stands, in the words the settings card uses.
 *
 * Fits beside the shared `IntegrationStatus` rather than replacing it: the
 * shared audit still says off / needs a key / on / error, and this adds what
 * only Inara has -- the app white-list, and a key Inara has actually confirmed.
 */
export type InaraConnectionState =
  | 'not-configured'
  | 'disabled'
  | 'awaiting-app-authorization'
  | 'authentication-failed'
  | 'temporarily-unavailable'
  | 'connected'
  | 'configured';

export const INARA_STATE_LABEL: Readonly<Record<InaraConnectionState, string>> = {
  'not-configured': 'Not configured',
  disabled: 'Disabled',
  'awaiting-app-authorization': 'Awaiting application authorization',
  'authentication-failed': 'Authentication failed',
  'temporarily-unavailable': 'Temporarily unavailable',
  connected: 'Connected',
  configured: 'Configured',
};

export interface InaraStateInput {
  readonly hasCredential: boolean;
  readonly enabled: boolean;
  readonly config: InaraReleaseConfig;
  /** The last integration-wide condition, persisted per commander. */
  readonly condition: InaraCondition | null;
  readonly profile: InaraProfile | null;
  readonly lastSuccessAt: string | null;
}

export function inaraConnectionState(s: InaraStateInput): InaraConnectionState {
  if (!s.hasCredential) return 'not-configured';
  if (!s.config.appAuthorized || s.condition === 'app-not-allowed') {
    return 'awaiting-app-authorization';
  }
  if (s.condition === 'credential') return 'authentication-failed';
  if (!s.enabled) return 'disabled';
  if (s.condition === 'transient') return 'temporarily-unavailable';
  // Connected only on Inara's word: a verified key or an accepted batch.
  if (s.profile !== null || s.lastSuccessAt !== null) return 'connected';
  return 'configured';
}

/** Whether anything may be queued or sent right now. One answer for both. */
export function inaraMayTransmit(s: InaraStateInput): boolean {
  return (
    s.hasCredential &&
    s.enabled &&
    s.config.appAuthorized &&
    s.condition !== 'app-not-allowed' &&
    s.condition !== 'credential'
  );
}

/** Whether Verify may be pressed. It is a request, so the same gate, minus the switch. */
export function inaraMayVerify(s: InaraStateInput): boolean {
  return s.hasCredential && s.config.appAuthorized && s.condition !== 'app-not-allowed';
}

/* ----------------------------------------------------------------- links */

/**
 * Links back to Inara, in the formats its developer guide documents, with the
 * search string URL-encoded as it asks.
 */
export const inaraLinks = {
  starsystem: (nameOrAddress: string | number): string =>
    `https://inara.cz/elite/starsystem/?search=${encodeURIComponent(String(nameOrAddress))}`,
  station: (station: string, system: string): string =>
    `https://inara.cz/elite/station/?search=${encodeURIComponent(`${station} [${system}]`)}`,
  carrier: (callsign: string): string =>
    `https://inara.cz/elite/station/?search=${encodeURIComponent(callsign)}`,
  minorfaction: (name: string): string =>
    `https://inara.cz/elite/minorfaction/?search=${encodeURIComponent(name)}`,
} as const;
