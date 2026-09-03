/**
 * Report rendering: what a moderator actually reads.
 *
 * Kept separate from both the HTTP client and the reporting policy so that the
 * question "what does this leak?" can be answered by reading one file. Every
 * string Discord will ever receive for a discrepancy is produced here.
 */

import type { ReportCategory } from './tags.js';

export interface ReportSubject {
  readonly category: ReportCategory;
  /** Names the disagreement in a moderator's language, not the schema's. */
  readonly summary: string;

  readonly system?: string | null;
  readonly body?: string | null;
  /** Station, settlement or facility. */
  readonly place?: string | null;

  readonly field?: string | null;
  readonly edfmValue?: string | null;
  readonly observedValue?: string | null;
  /** The journal event the observation came from, e.g. `Docked`. */
  readonly observedFrom?: string | null;
  readonly detectedAt: string;
  /** Only ever set when the commander chose attribution and config allows it. */
  readonly commander?: string | null;
  readonly companionVersion?: string | null;
  /** Opaque handle a reviewer can resolve; never the discrepancy key. */
  readonly reference: string;
}

/**
 * Forum post titles.
 *
 * Human-readable and specific enough to be searchable, with no raw JSON and no
 * internal identifiers -- a moderator scanning a Forum list gains nothing from
 * a MarketID, and the body carries it for anyone who needs it.
 */
export function buildThreadName(subject: ReportSubject): string {
  const place = subject.place ?? subject.body ?? subject.system;
  return place ? `${subject.summary} — ${place}` : subject.summary;
}

/** Only applicable fields appear; an empty label is noise, not information. */
function line(label: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : `**${label}:** ${text}`;
}

export function buildReportBody(subject: ReportSubject): string {
  const lines = [
    'EDFM Companion detected a possible data discrepancy.',
    '',
    line('Report Type', subject.category),
    line('System', subject.system),
    line('Body', subject.body),
    line('Station / Settlement / Facility', subject.place),
    line('Field', subject.field),
    line('EDFM Value', subject.edfmValue),
    line('Observed Game Value', subject.observedValue),
    line('Observed From', subject.observedFrom),
    line('Detected At', subject.detectedAt),
    line('Commander', subject.commander),
    line('Companion Version', subject.companionVersion),
    line('Reference', subject.reference),
  ].filter((l): l is string => l !== null);

  return lines.join('\n');
}

export type UpdateReason =
  | 'confirmed'
  | 'observed-value-changed'
  | 'edfm-value-changed'
  | 'independent-source';

/**
 * Follow-up messages.
 *
 * Deliberately terse. These land in a thread a moderator is already reading,
 * and the only thing that has changed is stated -- repeating the full report
 * would bury it.
 */
export function buildUpdateBody(
  reason: UpdateReason,
  subject: ReportSubject,
  confirmations: number,
): string {
  const lines: string[] = [];

  switch (reason) {
    case 'confirmed':
      lines.push(
        `Independently confirmed. Distinct reporters: ${confirmations}.`,
      );
      break;
    case 'observed-value-changed':
      lines.push('The value observed in game has changed since this was reported.');
      break;
    case 'edfm-value-changed':
      lines.push('The reference value has changed since this was reported.');
      break;
    case 'independent-source':
      lines.push('A materially different source reported the same discrepancy.');
      break;
  }

  const detail = [
    line('EDFM Value', subject.edfmValue),
    line('Observed Game Value', subject.observedValue),
    line('Observed From', subject.observedFrom),
    line('Detected At', subject.detectedAt),
  ].filter((l): l is string => l !== null);

  if (detail.length > 0) lines.push('', ...detail);
  return lines.join('\n');
}

export function buildResolutionBody(): string {
  return 'Resolved: EDFM now matches the value observed by the Companion.';
}
