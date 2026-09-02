/**
 * Persistence for submissions and the discrepancies derived from them.
 *
 * All of it in one transaction per submission: a report that is recorded but
 * not counted, or counted but not recorded, is worse than a rejected one,
 * because it is invisible.
 */

import {
  discrepancyKey,
  isSpoilerSensitive,
  type DiscrepancyKind,
  type VerificationObservation,
} from '@edfm/verification';
import type { Db } from './db.js';
import { independentCount, type HashedIdentity } from './identity.js';
import type { DerivedFinding } from './derive.js';

export type NotifyReason = 'created' | 'confirmed' | 'conflicting';

export interface PendingNotification {
  readonly discrepancyId: string;
  readonly reason: NotifyReason;
  readonly key: string;
  readonly spoilerSensitive: boolean;
}

export interface RecordResult {
  readonly submissionId: string;
  readonly discrepancies: { id: string; key: string; independentCount: number }[];
  readonly notifications: readonly PendingNotification[];
}

export interface SubmissionRecord {
  readonly identity: HashedIdentity;
  readonly entityType: string;
  readonly entityId: string;
  readonly clientVersion: string | null;
  readonly gameVersion: string | null;
  readonly gameBuild: string | null;
  readonly observation: unknown;
  readonly claimed: unknown;
  readonly sourceHash: string | null;
}

export async function recordSubmission(
  db: Db,
  record: SubmissionRecord,
  findings: readonly DerivedFinding[],
): Promise<RecordResult> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: subRows } = await client.query<{ id: string }>(
      `INSERT INTO submissions
         (fid_hash, commander_hash, journal_hash, identity_mode, entity_type, entity_id,
          client_version, game_version, game_build, observation, claimed, source_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id::text`,
      [
        record.identity.fidHash,
        record.identity.commanderHash,
        record.identity.journalHash,
        record.identity.mode,
        record.entityType,
        record.entityId,
        record.clientVersion,
        record.gameVersion,
        record.gameBuild,
        JSON.stringify(record.observation),
        record.claimed === undefined ? null : JSON.stringify(record.claimed),
        record.sourceHash,
      ],
    );
    const submissionId = subRows[0]!.id;

    const discrepancies: RecordResult['discrepancies'] = [];
    const notifications: PendingNotification[] = [];

    for (const finding of findings) {
      const result = await applyFinding(client, submissionId, finding);
      discrepancies.push(result.summary);
      notifications.push(...result.notifications);
    }

    await client.query('COMMIT');
    return { submissionId, discrepancies, notifications };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function applyFinding(
  client: pgClient,
  submissionId: string,
  finding: DerivedFinding,
): Promise<{
  summary: { id: string; key: string; independentCount: number };
  notifications: PendingNotification[];
}> {
  const o: VerificationObservation = finding.observation;
  const key = discrepancyKey(o);
  const sensitive = isSpoilerSensitive({ visibility: o.visibility, entityType: o.entityType });

  const { rows } = await client.query<{ id: string; created: boolean }>(
    `INSERT INTO discrepancies
       (dedupe_key, entity_type, entity_id, field, kind, volatility, evidence_type,
        expected_value, observed_value, game_version, confidence, spoiler_sensitive,
        report_count, independent_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0)
     ON CONFLICT (dedupe_key) DO UPDATE
       SET last_reported_at = now(), updated_at = now()
     RETURNING id::text, (xmax = 0) AS created`,
    [
      key,
      o.entityType,
      o.entityId,
      o.field,
      finding.kind satisfies DiscrepancyKind,
      o.volatility,
      o.evidence,
      o.expectedValue === null ? null : JSON.stringify(o.expectedValue),
      o.observedValue === null ? null : JSON.stringify(o.observedValue),
      o.gameVersion,
      o.confidence,
      sensitive,
    ],
  );
  const { id, created } = rows[0]!;

  // A commander re-docking at the same station reports the same thing again.
  // That is one observation seen twice, so the report is recorded but must not
  // move any count.
  await client.query(
    `INSERT INTO discrepancy_reports
       (discrepancy_id, submission_id, fid_hash, commander_hash, journal_hash, observed_at)
     SELECT $1, $2, s.fid_hash, s.commander_hash, s.journal_hash, $3
       FROM submissions s WHERE s.id = $2
     ON CONFLICT DO NOTHING`,
    [id, submissionId, o.observedAt],
  );

  // Recomputed from the stored reports rather than incremented, so that
  // correcting the independence rule later can be replayed over data already
  // collected instead of only applying to new reports.
  const { rows: reportRows } = await client.query<{
    fid_hash: string | null;
    commander_hash: string | null;
    journal_hash: string | null;
  }>(
    `SELECT fid_hash, commander_hash, journal_hash FROM discrepancy_reports
      WHERE discrepancy_id = $1 ORDER BY recorded_at`,
    [id],
  );

  const independent = independentCount(
    reportRows.map((r) => ({
      mode: 'anonymous' as const,
      fidHash: r.fid_hash,
      commanderHash: r.commander_hash,
      journalHash: r.journal_hash,
    })),
  );

  await client.query(
    `UPDATE discrepancies
        SET report_count = $2, independent_count = $3,
            status = CASE WHEN status = 'new' AND $3 >= 2 THEN 'under_review' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [id, reportRows.length, independent],
  );

  const notifications: PendingNotification[] = [];
  const claim = async (reason: NotifyReason): Promise<void> => {
    // §9: notify on creation and on the first genuinely independent
    // confirmation, then stay silent. The primary key does the enforcing, so
    // two workers racing the same report cannot both post.
    const { rowCount } = await client.query(
      `INSERT INTO discrepancy_notifications (discrepancy_id, reason, redacted)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [id, reason, sensitive],
    );
    if (rowCount === 1) {
      notifications.push({ discrepancyId: id, reason, key, spoilerSensitive: sensitive });
    }
  };

  if (created) await claim('created');
  if (independent >= 2) await claim('confirmed');

  return { summary: { id, key, independentCount: independent }, notifications };
}

/** Narrow structural type so this module does not depend on pg's class shapes. */
interface pgClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}
