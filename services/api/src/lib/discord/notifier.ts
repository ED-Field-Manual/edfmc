/**
 * Adapter between the existing discrepancy pipeline and the Forum reporter.
 *
 * `store.ts` already decides *when* something is worth announcing — creation,
 * first independent confirmation — using a primary key so a restart cannot
 * re-announce. That logic is not duplicated here. This turns the resulting
 * `PendingNotification` into a `Detection` a moderator can read, and hands it
 * to the reporter, which owns duplicate policy and delivery.
 */

import { isSpoilerSensitive, opaqueReference } from '@edfm/verification';
import type { Db } from '../db.js';
import type { PendingNotification } from '../store.js';
import type { ReportSubject } from './format.js';
import type { DiscordReporter } from './reporter.js';
import type { ReportCategory, TagName } from './tags.js';

export interface Notifier {
  send(pending: PendingNotification): Promise<void>;
}

interface Row {
  dedupe_key: string;
  entity_type: string;
  entity_id: string;
  field: string;
  kind: string;
  status: string;
  expected_value: string | null;
  observed_value: string | null;
  game_version: string | null;
  independent_count: number;
  spoiler_sensitive: boolean;
  last_reported_at: Date;
  station_name: string | null;
  system_name: string | null;
}

/**
 * Turn a schema field into something a moderator recognises.
 *
 * The Forum title is read by people who maintain a wiki, not by people who
 * have read our column names, so `service:techbroker` becomes "Incorrect
 * Station Service" and the token itself moves into the body.
 */
function classify(row: Row): { category: ReportCategory; summary: string; field: string } {
  if (row.entity_type === 'station') {
    if (row.field === 'stationType') {
      return { category: 'Station', summary: 'Incorrect Station Type', field: 'Station type' };
    }
    if (row.field === 'services') {
      return {
        category: 'Service',
        // Named for what it is rather than as a defect: a bulk difference is
        // usually a partial reading, and the title should not assert more
        // than the finding does.
        summary: 'Station Service Data Mismatch',
        field: 'Station services (bulk difference)',
      };
    }
    if (row.field.startsWith('service:')) {
      const token = row.field.slice('service:'.length);
      const summary =
        row.kind === 'missing_in_edfm'
          ? 'Missing Station Service'
          : row.kind === 'missing_in_game'
            ? 'Incorrect Station Service'
            : 'Station Service Discrepancy';
      return { category: 'Service', summary, field: `Service: ${token}` };
    }
    return { category: 'Station', summary: 'Incorrect Station Data', field: row.field };
  }

  if (row.entity_type === 'system') {
    return { category: 'System', summary: 'Incorrect System Data', field: row.field };
  }
  if (row.entity_type === 'settlement') {
    return { category: 'Settlement', summary: 'Incorrect Settlement Data', field: row.field };
  }
  if (row.entity_type === 'commodity') {
    return { category: 'Commodity', summary: 'Incorrect Commodity Data', field: row.field };
  }
  return { category: 'Station', summary: 'Data Discrepancy', field: row.field };
}

export function createNotifier(
  db: Db,
  reporter: DiscordReporter,
  options: { readonly log?: (event: string, detail?: Record<string, unknown>) => void } = {},
): Notifier {
  const log = options.log ?? (() => {});

  return {
    async send(pending) {
      // Station names come from the reference table rather than from a
      // submission: it is the same data every reporter sees, so nothing
      // commander-specific reaches the post.
      const { rows } = await db.query<Row>(
        `SELECT d.dedupe_key, d.entity_type, d.entity_id, d.field, d.kind, d.status,
                d.expected_value #>> '{}' AS expected_value,
                d.observed_value #>> '{}' AS observed_value,
                d.game_version, d.independent_count, d.spoiler_sensitive, d.last_reported_at,
                s.name AS station_name, s.system_name
           FROM discrepancies d
           LEFT JOIN stations s
             ON d.entity_type = 'station' AND s.market_id::text = d.entity_id
          WHERE d.id = $1`,
        [pending.discrepancyId],
      );
      const row = rows[0];
      if (!row) return;

      const { category, summary, field } = classify(row);

      const subject: ReportSubject = {
        category,
        summary,
        system: row.system_name,
        place: row.station_name,
        field,
        edfmValue: row.expected_value,
        observedValue: row.observed_value,
        observedFrom: row.game_version ? `Game ${row.game_version}` : null,
        detectedAt: row.last_reported_at.toISOString(),
        // Attribution never reaches the Forum from this path. §20 lets a
        // commander be credited on the EDFM contribution list; that is a
        // different decision from naming them in a public moderation thread.
        commander: null,
        companionVersion: null,
        // Never the dedupe key: it is
        // entityType|entityId|field|expected|observed|version, so posting it
        // would restore everything redaction removes.
        reference: opaqueReference(row.dedupe_key),
      };

      const statusTag: TagName =
        row.independent_count >= 2 ? 'Confirmed' : 'Needs Review';

      const result = await reporter.report({
        discrepancyKey: row.dedupe_key,
        discrepancyId: pending.discrepancyId,
        subject,
        // Recomputed from the stored gate rather than trusted from the caller.
        spoilerSensitive:
          row.spoiler_sensitive ||
          isSpoilerSensitive({
            visibility: row.spoiler_sensitive
              ? { kind: 'verification-only' }
              : { kind: 'public' },
            entityType: row.entity_type as 'station',
          }),
        confirmations: row.independent_count,
        statusTag,
      });

      log('discord.report_result', { result });
    },
  };
}
