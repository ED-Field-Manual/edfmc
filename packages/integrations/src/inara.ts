/**
 * Inara: the envelope, the constants, and reading the reply.
 *
 * The translation from journal lines to Inara events is in
 * `inara-translate.ts`, the queue and batch decisions in `inara-queue.ts`, and
 * the commander-facing state in `inara-state.ts`. docs/INARA.md has the whole
 * design and the implementation matrix, written against Inara's developer
 * guide and API documentation.
 *
 * ## The envelope
 *
 * ```
 * { "header": { appName, appVersion, isBeingDeveloped, APIkey, commanderName,
 *               commanderFrontierID },
 *   "events": [ { eventName, eventTimestamp, eventCustomID, eventData } ] }
 * ```
 *
 * The header is assembled in Rust (`inara.rs`), because `APIkey` is the
 * commander's personal key and is read from the Windows Credential Manager
 * there. It never exists in this process.
 *
 * ## The app white-list
 *
 * Inara's developer guide asks for the app name "as it needs to be white-listed
 * first", and an unlisted name is refused whatever the key:
 *
 * ```
 * eventStatus 400, "This application has no access allowed."
 * ```
 *
 * So `INARA_APP_NAME` is a constant, and nothing is sent until a release says
 * the name has been approved (`VITE_INARA_APP_AUTHORIZED`).
 */

/** Exactly as white-listed by Inara. Changing it means asking Inara again. */
export const INARA_APP_NAME = 'EDFM Companion';

export const INARA_URL = 'https://inara.cz/inapi/v1/';

/** Where a commander creates their own key. */
export const INARA_KEY_PAGE = 'https://inara.cz/elite/cmdr-settings-api/';

/**
 * Inara's documented status codes.
 *
 * 200 is success; 202 and 204 are warnings that still mean the event was
 * handled. 400 is the failure, and the documentation is explicit that at the
 * header level it may mean failed authorisation and cancel the whole batch.
 */
export const INARA_OK = 200;
export const INARA_WARNING = 202;
export const INARA_SOFT_ERROR = 204;
export const INARA_ERROR = 400;

/** The location event, also produced by `InaraTranslator` from `Location`. */
export const INARA_SET_LOCATION = 'setCommanderTravelLocation';

export interface InaraEvent {
  readonly eventName: string;
  /** Optional; Inara echoes it back so results can be paired with requests. */
  readonly eventCustomID?: number;
  /** ISO 8601, and the documentation asks for the real time of the event. */
  readonly eventTimestamp: string;
  readonly eventData: Readonly<Record<string, unknown>>;
}

export interface InaraHeader {
  readonly appName: string;
  readonly appVersion: string;
  /** True while developing, which tells Inara to skip global events. */
  readonly isBeingDeveloped: boolean;
  readonly APIkey: string;
  readonly commanderName: string;
  /** `F123456`. Omitted rather than guessed when the journal has not said. */
  readonly commanderFrontierID?: string;
}

export interface InaraBatch {
  readonly header: InaraHeader;
  readonly events: readonly InaraEvent[];
}

/** A location as this app knows it. Every field may be unknown. */
export interface InaraLocation {
  readonly systemName: string | null;
  /** `[x, y, z]` in light years, as the journal's `StarPos` gives it. */
  readonly systemCoords: readonly [number, number, number] | null;
  readonly stationName: string | null;
  readonly marketId: number | null;
  readonly bodyName: string | null;
  readonly occurredAt: string;
}

/**
 * Build the location event, or decline.
 *
 * Returns null without a system name, which Inara documents as required. The
 * alternative -- sending an empty or placeholder name -- is a known way to
 * corrupt a profile, and EDMarketConnector carries a bug report about exactly
 * that, so it is refused here rather than sent hopefully.
 */
export function toInaraLocation(at: InaraLocation): InaraEvent | null {
  if (at.systemName === null || at.systemName.trim().length === 0) return null;

  const eventData: Record<string, unknown> = { starsystemName: at.systemName };

  if (at.systemCoords !== null) eventData['starsystemCoords'] = at.systemCoords;
  if (at.stationName !== null) eventData['stationName'] = at.stationName;
  if (at.marketId !== null) eventData['marketID'] = at.marketId;
  if (at.bodyName !== null) eventData['starsystemBodyName'] = at.bodyName;

  /*
   * `starsystemBodyCoords` is deliberately never sent, although Inara accepts
   * it. It is the commander's latitude and longitude on a planet surface, and
   * this project's privacy guarantee lists "Where you are standing on a planet"
   * among the things no integration ever shares. The body name alone keeps the
   * profile accurate without putting a surface position on a public page.
   */

  return { eventName: INARA_SET_LOCATION, eventTimestamp: at.occurredAt, eventData };
}

export function buildInaraBatch(input: {
  readonly apiKey: string;
  readonly commanderName: string;
  readonly commanderFrontierID: string | null;
  readonly appName: string;
  readonly appVersion: string;
  readonly isBeingDeveloped: boolean;
  readonly events: readonly InaraEvent[];
}): InaraBatch {
  return {
    header: {
      appName: input.appName,
      appVersion: input.appVersion,
      isBeingDeveloped: input.isBeingDeveloped,
      APIkey: input.apiKey,
      commanderName: input.commanderName,
      ...(input.commanderFrontierID !== null
        ? { commanderFrontierID: input.commanderFrontierID }
        : {}),
    },
    events: input.events,
  };
}

/* ------------------------------------------------------------ responses */

export interface InaraEventResult {
  readonly index: number;
  /** Echoed back by Inara when the request set one. */
  readonly customId: number | null;
  readonly status: number;
  readonly text: string;
  readonly accepted: boolean;
  /** Whatever the event returned, such as `starsystemInaraURL`. Untrusted. */
  readonly data: Readonly<Record<string, unknown>> | null;
}

export type InaraOutcome =
  | {
      readonly kind: 'accepted';
      readonly perEvent: readonly InaraEventResult[];
      /** The header's eventData: Inara's user id and name for the key's owner. */
      readonly user: Readonly<Record<string, unknown>> | null;
    }
  | { readonly kind: 'credential'; readonly message: string }
  /** The key may be fine; Inara has not white-listed this app's name. */
  | { readonly kind: 'app-not-allowed'; readonly message: string }
  | { readonly kind: 'retry'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Whether a documented status means Inara handled the event. */
export function isInaraAccepted(status: number): boolean {
  return status === INARA_OK || status === INARA_WARNING || status === INARA_SOFT_ERROR;
}

/**
 * Read a response.
 *
 * Treated as untrusted input throughout. As with EDSM, the HTTP status is not
 * what decides the outcome -- `header.eventStatus` is -- and a body this cannot
 * read is never taken as success.
 */
/** Inara's wording when `appName` is not on its white-list. */
const APP_NOT_ALLOWED = /application has no access/i;

export function parseInaraResponse(body: unknown): InaraOutcome {
  if (!isRecord(body)) return { kind: 'malformed', reason: 'the reply was not an object' };

  const header = body['header'];
  if (!isRecord(header)) return { kind: 'malformed', reason: 'the reply carried no header' };

  const status = header['eventStatus'];
  if (typeof status !== 'number') {
    return { kind: 'malformed', reason: 'the reply carried no status' };
  }
  const text = typeof header['eventStatusText'] === 'string' ? header['eventStatusText'] : '';

  if (status === INARA_ERROR && APP_NOT_ALLOWED.test(text)) {
    // Same status as a bad key, so only the text tells them apart.
    return { kind: 'app-not-allowed', message: text };
  }
  if (status === INARA_ERROR) {
    /*
     * Documented as possibly meaning failed authorisation, with the whole batch
     * cancelled. Retrying a rejected key cannot succeed and hammers the server,
     * so this stops and asks the commander to look at it.
     */
    return { kind: 'credential', message: text || 'Inara rejected the request.' };
  }
  if (!isInaraAccepted(status)) {
    return { kind: 'retry', reason: text || `Inara replied with status ${status}` };
  }

  const rawEvents = body['events'];
  if (!Array.isArray(rawEvents)) {
    return { kind: 'malformed', reason: 'the reply carried no per-event results' };
  }

  const perEvent: InaraEventResult[] = [];
  rawEvents.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const code = typeof raw['eventStatus'] === 'number' ? raw['eventStatus'] : -1;
    const customId = raw['eventCustomID'];
    perEvent.push({
      index,
      customId: typeof customId === 'number' && Number.isInteger(customId) ? customId : null,
      status: code,
      text: typeof raw['eventStatusText'] === 'string' ? raw['eventStatusText'] : '',
      accepted: isInaraAccepted(code),
      data: isRecord(raw['eventData']) ? raw['eventData'] : null,
    });
  });

  return { kind: 'accepted', perEvent, user: isRecord(header['eventData']) ? header['eventData'] : null };
}
