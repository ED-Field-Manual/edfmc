/**
 * Discord notification, server-side only.
 *
 * §19/§20: the webhook lives in this process's environment and nowhere else.
 * It is never returned by an endpoint, never logged, and never shipped to the
 * desktop client. A client that could post to the channel could post anything
 * to the channel.
 */

import { buildNotification, type Discrepancy, type NotificationPayload } from '@edfm/verification';
import type { Db } from './db.js';
import type { PendingNotification } from './store.js';

export interface Notifier {
  send(pending: PendingNotification): Promise<void>;
}

interface Row {
  id: string;
  dedupe_key: string;
  entity_type: string;
  entity_id: string;
  field: string;
  kind: string;
  status: string;
  volatility: string;
  expected_value: string | null;
  observed_value: string | null;
  independent_count: number;
  first_reported_at: Date;
  last_reported_at: Date;
  spoiler_sensitive: boolean;
}

/** Rebuild just enough of a Discrepancy for the shared notification builder. */
function toDiscrepancy(row: Row): Discrepancy {
  return {
    key: row.dedupe_key,
    entityType: row.entity_type as Discrepancy['entityType'],
    entityId: row.entity_id,
    field: row.field,
    kind: row.kind as Discrepancy['kind'],
    status: row.status as Discrepancy['status'],
    expectedValue: row.expected_value,
    observedValue: row.observed_value,
    volatility: row.volatility as Discrepancy['volatility'],
    // Reconstructed from the stored flag rather than the original gate. A
    // discrepancy recorded as sensitive stays sensitive even if a future
    // version of the gate would classify it differently -- the safe direction.
    visibility: row.spoiler_sensitive ? { kind: 'verification-only' } : { kind: 'public' },
    observations: [],
    independentConfirmations: row.independent_count,
    firstObservedAt: row.first_reported_at.toISOString(),
    lastObservedAt: row.last_reported_at.toISOString(),
  };
}

export async function loadPayload(
  db: Db,
  pending: PendingNotification,
  forceFullDetail: boolean,
): Promise<NotificationPayload | null> {
  const { rows } = await db.query<Row>(
    `SELECT id::text, dedupe_key, entity_type, entity_id, field, kind, status, volatility,
            expected_value #>> '{}' AS expected_value,
            observed_value #>> '{}' AS observed_value,
            independent_count, first_reported_at, last_reported_at, spoiler_sensitive
       FROM discrepancies WHERE id = $1`,
    [pending.discrepancyId],
  );
  const row = rows[0];
  if (!row) return null;

  return buildNotification(toDiscrepancy(row), {
    reason: pending.reason,
    // Attribution never reaches Discord from here. §20 lets a commander choose
    // to be credited, but that is a decision about the EDFM contribution list,
    // not about an administrative channel.
    attributeCommander: false,
    forceFullDetail,
  });
}

/** Records the attempt and its outcome, so a silent webhook failure is visible. */
async function markDelivered(
  db: Db,
  pending: PendingNotification,
  delivered: boolean,
  detail: string | null,
): Promise<void> {
  await db.query(
    `UPDATE discrepancy_notifications SET delivered = $3, detail = $4
      WHERE discrepancy_id = $1 AND reason = $2`,
    [pending.discrepancyId, pending.reason, delivered, detail],
  );
}

export function createNotifier(
  db: Db,
  options: {
    webhook: string | undefined;
    redactSpoilers: boolean;
    log: (msg: string, extra?: Record<string, unknown>) => void;
    fetchImpl?: typeof fetch;
  },
): Notifier {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async send(pending) {
      const payload = await loadPayload(db, pending, !options.redactSpoilers);
      if (!payload) return;

      if (!options.webhook) {
        // Configured off. The row already exists, so the finding is not lost
        // and can be posted later; it is simply not delivered now.
        await markDelivered(db, pending, false, 'no webhook configured');
        options.log('discord.skipped', { reference: payload.reference });
        return;
      }

      const body = {
        embeds: [
          {
            title: payload.title,
            description: payload.summary,
            fields: payload.fields.map((f) => ({ name: f.name, value: f.value, inline: false })),
            footer: { text: `${payload.reference} — ${payload.reviewHint}` },
          },
        ],
      };

      try {
        const response = await doFetch(options.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          await markDelivered(db, pending, false, `http ${response.status}`);
          options.log('discord.failed', { status: response.status });
          return;
        }
        await markDelivered(db, pending, true, null);
      } catch (error) {
        // Never rethrow: a Discord outage must not fail a commander's
        // submission, which has already been stored.
        await markDelivered(db, pending, false, (error as Error).message);
        options.log('discord.error', { message: (error as Error).message });
      }
    },
  };
}
