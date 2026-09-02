/**
 * Discord notification payloads, with redaction.
 *
 * The desktop client never holds a webhook secret and never talks to Discord.
 * It produces *payloads*; the backend decides whether and where to post them.
 * This module lives in shared code so the redaction rules are written once and
 * are testable, rather than being reimplemented in the notifier.
 *
 * Redaction default is spoiler-safe. An administrative channel is still a
 * forwardable, searchable, permanent log, and an exploration finding names an
 * unvisited system and an unscanned species. Reviewers open the admin page;
 * Discord only needs to tell them there is something to look at.
 */

import { discrepancyPhrasing } from './evidence.js';
import { isSpoilerSensitive, type Discrepancy } from './discrepancy.js';

export interface NotificationField {
  readonly name: string;
  readonly value: string;
}

export interface NotificationPayload {
  readonly title: string;
  readonly summary: string;
  readonly fields: readonly NotificationField[];
  /** True when detail was withheld and lives only in admin review. */
  readonly redacted: boolean;
  /**
   * Opaque reference the admin page resolves back to the discrepancy.
   *
   * Deliberately NOT the discrepancy key. That key is
   * `entityType|entityId|field|expected|observed|version`, so posting it would
   * put the system, the field and both values straight into the channel the
   * redaction exists to keep them out of.
   */
  readonly reference: string;
  readonly reviewHint: string;
}

/**
 * Short, stable, opaque reference for a discrepancy.
 *
 * FNV-1a over the key. Not a security primitive — it is a lookup handle, and
 * its only requirement is that it carries no readable content while resolving
 * to exactly one discrepancy for a reviewer.
 */
export function opaqueReference(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `EDFM-${hash.toString(36).toUpperCase().padStart(7, '0')}`;
}

export interface NotifyOptions {
  readonly reason: 'created' | 'confirmed' | 'conflicting';
  /**
   * Include the commander's name.
   *
   * Off unless the commander chose attribution (§14/§20). Anonymous
   * contribution must stay anonymous all the way to Discord.
   */
  readonly attributeCommander?: boolean;
  /**
   * Override redaction. Exists because §9 says "make this configurable later",
   * but the default stays safe and turning it off is an explicit act.
   */
  readonly forceFullDetail?: boolean;
}

const REASON_TITLE: Record<NotifyOptions['reason'], string> = {
  created: '⚠ EDFM Data Discrepancy',
  confirmed: '✓ EDFM Discrepancy Independently Confirmed',
  conflicting: '⚠ EDFM Discrepancy — Conflicting Observations',
};

/**
 * Build a Discord payload for a discrepancy.
 *
 * Spoiler-sensitive discrepancies get type, reporter and a review link, and
 * nothing that identifies a location or a discovery. Everything else — the
 * system, the body, the species, the counts — stays behind admin review.
 */
export function buildNotification(
  discrepancy: Discrepancy,
  options: NotifyOptions,
): NotificationPayload {
  const sensitive = isSpoilerSensitive(discrepancy) && !options.forceFullDetail;

  const fields: NotificationField[] = [
    { name: 'Type', value: humanEntity(discrepancy.entityType) },
  ];

  if (sensitive) {
    // Deliberately omits entityId as well as the values. An id is enough to
    // look a system up, so it is not a safe substitute for a name.
    fields.push({
      name: 'Detail',
      value: 'Location and discovery details available in EDFM Admin Review',
    });
  } else {
    fields.push({ name: 'Entity', value: discrepancy.entityId });
    fields.push({ name: 'Field', value: discrepancy.field });
    fields.push({ name: 'EDFM', value: discrepancy.expectedValue ?? 'not recorded' });
    fields.push({ name: 'Observed', value: discrepancy.observedValue ?? 'not reported' });
  }

  const latest = discrepancy.observations[discrepancy.observations.length - 1];

  if (options.attributeCommander && latest?.commander) {
    fields.push({ name: 'Observed by', value: `CMDR ${latest.commander}` });
  }
  if (latest?.gameVersion) {
    fields.push({ name: 'Game version', value: latest.gameVersion });
  }

  fields.push({
    name: 'Independent confirmations',
    value: String(discrepancy.independentConfirmations),
  });

  return {
    title: sensitive ? `${REASON_TITLE[options.reason]} (Exploration)` : REASON_TITLE[options.reason],
    // Wording follows volatility, not severity: telling a maintainer that EDFM
    // is "wrong" about a faction that flipped last week is untrue and erodes
    // trust in every other report.
    summary: discrepancyPhrasing(discrepancy.volatility),
    fields,
    redacted: sensitive,
    reference: opaqueReference(discrepancy.key),
    reviewHint: 'Open in EDFM Admin Review',
  };
}

function humanEntity(entityType: string): string {
  switch (entityType) {
    case 'station':
    case 'station-service':
      return 'Station Service';
    case 'body':
      return 'Body / Exploration data';
    case 'settlement':
      return 'Settlement';
    case 'system':
      return 'System';
    case 'market':
      return 'Market';
    case 'engineer':
      return 'Engineer';
    default:
      return entityType;
  }
}

/**
 * Every string a payload would put on Discord.
 *
 * Exists so tests can assert that no sensitive value appears anywhere in a
 * redacted payload, rather than checking the fields someone remembered to look
 * at. A future field added to the payload is covered automatically.
 */
export function notificationStrings(payload: NotificationPayload): string[] {
  return [
    payload.title,
    payload.summary,
    payload.reviewHint,
    payload.reference,
    ...payload.fields.flatMap((f) => [f.name, f.value]),
  ];
}
