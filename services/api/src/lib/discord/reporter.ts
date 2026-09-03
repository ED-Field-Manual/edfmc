/**
 * Discrepancy reporting to a Discord Forum.
 *
 * The pipeline, in order, with the gate before the transport:
 *
 *   observation → normalize → compare → classify
 *     → spoiler/privacy eligibility → duplicate check → queue → Discord
 *
 * `report()` is the only entry point, and it applies the eligibility check
 * before anything is rendered, let alone enqueued. Nothing downstream re-reads
 * game state: the queue row holds finished text. So there is no second path by
 * which unfiltered data could reach Discord, and the question "can this leak?"
 * is answered by reading one function rather than auditing every caller.
 */

import type { Db } from '../db.js';
import type { DiscordClient, DiscordOutcome } from './client.js';
import {
  buildReportBody,
  buildResolutionBody,
  buildThreadName,
  buildUpdateBody,
  type ReportSubject,
  type UpdateReason,
} from './format.js';
import { resolveTags, type TagMap, type TagName } from './tags.js';

/**
 * What to do with a finding that names something the commander's own game may
 * not have revealed.
 *
 * `suppress` is the default. A Forum post is public, permanent, searchable and
 * indexed by anyone who can read the channel — a far weaker containment than
 * the admin channel the existing redaction was designed for. "Verify
 * aggressively, reveal conservatively" points at not posting at all.
 */
export type SpoilerPolicy = 'suppress' | 'redact';

export interface ReporterConfig {
  readonly enabled: boolean;
  readonly postResolutions: boolean;
  /** Even when true, a name is only used if the commander chose attribution. */
  readonly includeCommander: boolean;
  readonly spoilerPolicy: SpoilerPolicy;
}

export interface Detection {
  readonly discrepancyKey: string;
  readonly discrepancyId?: string | null;
  readonly subject: ReportSubject;
  /** Decided upstream from the visibility gate, never guessed here. */
  readonly spoilerSensitive: boolean;
  readonly confirmations: number;
  /** True once the observation and the reference agree again. */
  readonly resolved?: boolean;
  readonly statusTag?: TagName | null;
}

export type ReportResult =
  | 'queued-create'
  | 'queued-update'
  | 'queued-resolve'
  | 'duplicate-suppressed'
  | 'spoiler-suppressed'
  | 'disabled';

export interface QueueRun {
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
}

interface ReportRow {
  report_id: string;
  discord_thread_id: string | null;
  thread_status: string;
  status: string;
  confirmation_count: number;
  last_reported_value: string | null;
  last_reported_expected: string | null;
  resolution_posted_at: Date | null;
}

export interface ReporterOptions {
  readonly db: Db;
  readonly client: DiscordClient;
  readonly tagMap: TagMap;
  readonly config: ReporterConfig;
  readonly log?: (event: string, detail?: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

export interface DiscordReporter {
  report(detection: Detection): Promise<ReportResult>;
  processQueue(limit?: number): Promise<QueueRun>;
  test(): Promise<DiscordOutcome>;
}

/** Bounded, so a permanently failing row cannot be retried forever. */
const MAX_QUEUE_ATTEMPTS = 5;

export function createReporter(options: ReporterOptions): DiscordReporter {
  const { db, client, tagMap, config } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());

  /**
   * The eligibility gate.
   *
   * Fails closed by construction: it returns the subject to report, or null,
   * and every caller path treats null as "do not report".
   */
  function eligible(detection: Detection): ReportSubject | null {
    if (!detection.spoilerSensitive) {
      // Attribution is a per-report choice AND a server setting; either off
      // means no name.
      if (config.includeCommander) return detection.subject;
      const { commander: _dropped, ...rest } = detection.subject;
      return rest;
    }

    if (config.spoilerPolicy === 'suppress') return null;

    // 'redact': keep the shape of a report, drop everything that locates it.
    // An id is enough to look a system up, so it is not a safe substitute.
    return {
      category: detection.subject.category,
      summary: 'Data discrepancy (details withheld)',
      detectedAt: detection.subject.detectedAt,
      reference: detection.subject.reference,
      companionVersion: detection.subject.companionVersion ?? null,
      field: null,
      edfmValue: null,
      observedValue: null,
      system: null,
      body: null,
      place: null,
      observedFrom: null,
      commander: null,
    };
  }

  async function loadReport(key: string): Promise<ReportRow | null> {
    const { rows } = await db.query<ReportRow>(
      `SELECT report_id::text, discord_thread_id, thread_status, status, confirmation_count,
              last_reported_value, last_reported_expected, resolution_posted_at
         FROM discord_reports WHERE discrepancy_key = $1`,
      [key],
    );
    return rows[0] ?? null;
  }

  async function enqueue(
    key: string,
    action: 'create' | 'update' | 'resolve',
    payload: unknown,
  ): Promise<boolean> {
    // The partial unique index collapses a burst of identical detections into
    // one pending row, so a commander re-docking repeatedly does not become a
    // queue of identical posts.
    const { rowCount } = await db.query(
      `INSERT INTO discord_report_queue (discrepancy_key, action, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [key, action, JSON.stringify(payload)],
    );
    return rowCount === 1;
  }

  /**
   * Is there anything a moderator would want to be told about?
   *
   * §5: do not post on every game event. Only a change of substance earns a
   * message in a thread someone is subscribed to.
   */
  function updateReason(row: ReportRow, detection: Detection): UpdateReason | null {
    const observed = detection.subject.observedValue ?? null;
    const expected = detection.subject.edfmValue ?? null;

    if (row.last_reported_value !== observed) return 'observed-value-changed';
    if (row.last_reported_expected !== expected) return 'edfm-value-changed';
    if (detection.confirmations > row.confirmation_count) return 'confirmed';
    return null;
  }

  return {
    async report(detection) {
      if (!config.enabled) return 'disabled';

      const subject = eligible(detection);
      if (subject === null) {
        // Logged as a count, with no subject: the log itself must not become
        // the leak the suppression prevented.
        log('discord.suppressed_by_spoiler_policy', { category: detection.subject.category });
        return 'spoiler-suppressed';
      }

      const existing = await loadReport(detection.discrepancyKey);

      /* ------------------------------------------------------- resolution */

      if (detection.resolved) {
        if (!existing || existing.status === 'resolved' || existing.resolution_posted_at !== null) {
          return 'duplicate-suppressed';
        }
        if (!config.postResolutions) {
          await db.query(
            `UPDATE discord_reports SET status = 'resolved', updated_at = now()
              WHERE discrepancy_key = $1`,
            [detection.discrepancyKey],
          );
          return 'duplicate-suppressed';
        }
        // Marked resolved now rather than on delivery, so a retry storm cannot
        // produce a second resolution message.
        await db.query(
          `UPDATE discord_reports SET status = 'resolved', resolution_posted_at = now(),
                  updated_at = now()
            WHERE discrepancy_key = $1`,
          [detection.discrepancyKey],
        );
        await enqueue(detection.discrepancyKey, 'resolve', {
          threadId: existing.discord_thread_id,
          content: buildResolutionBody(),
        });
        log('discord.report_queued', { action: 'resolve' });
        return 'queued-resolve';
      }

      /* ----------------------------------------------------------- create */

      if (!existing || existing.discord_thread_id === null) {
        if (!existing) {
          await db.query(
            `INSERT INTO discord_reports
               (discrepancy_key, discrepancy_id, report_type, object_identifier,
                confirmation_count, last_reported_value, last_reported_expected)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (discrepancy_key) DO NOTHING`,
            [
              detection.discrepancyKey,
              detection.discrepancyId ?? null,
              subject.category,
              subject.place ?? subject.system ?? null,
              detection.confirmations,
              subject.observedValue ?? null,
              subject.edfmValue ?? null,
            ],
          );
        }

        const tags = resolveTags(tagMap, [
          subject.category,
          detection.statusTag ?? 'Needs Review',
        ]);

        const queued = await enqueue(detection.discrepancyKey, 'create', {
          threadName: buildThreadName(subject),
          content: buildReportBody(subject),
          appliedTags: tags,
        });
        if (!queued) return 'duplicate-suppressed';
        log('discord.report_queued', { action: 'create', tags: tags.length });
        return 'queued-create';
      }

      /* ----------------------------------------------------------- update */

      if (existing.thread_status !== 'active') {
        // The thread is gone. §10: allow a replacement rather than retrying
        // into a hole, but only for a discrepancy that is still open.
        log('discord.thread_association_invalid', { threadStatus: existing.thread_status });
        if (existing.status !== 'open') return 'duplicate-suppressed';
        await db.query(
          `UPDATE discord_reports
              SET discord_thread_id = NULL, thread_status = 'active', updated_at = now()
            WHERE discrepancy_key = $1`,
          [detection.discrepancyKey],
        );
        return this.report(detection);
      }

      const reason = updateReason(existing, detection);
      if (reason === null) {
        log('discord.duplicate_suppressed', { category: subject.category });
        return 'duplicate-suppressed';
      }

      await db.query(
        `UPDATE discord_reports
            SET confirmation_count = GREATEST(confirmation_count, $2),
                last_reported_value = $3, last_reported_expected = $4,
                last_detected_at = now(), updated_at = now()
          WHERE discrepancy_key = $1`,
        [
          detection.discrepancyKey,
          detection.confirmations,
          subject.observedValue ?? null,
          subject.edfmValue ?? null,
        ],
      );

      const queued = await enqueue(detection.discrepancyKey, 'update', {
        threadId: existing.discord_thread_id,
        content: buildUpdateBody(reason, subject, detection.confirmations),
      });
      if (!queued) return 'duplicate-suppressed';
      log('discord.report_queued', { action: 'update', reason });
      return 'queued-update';
    },

    async processQueue(limit = 10) {
      if (!config.enabled) return { sent: 0, failed: 0, skipped: 0 };

      const { rows } = await db.query<{
        id: string;
        discrepancy_key: string;
        action: string;
        payload: Record<string, unknown>;
        attempts: number;
      }>(
        `SELECT id::text, discrepancy_key, action, payload, attempts
           FROM discord_report_queue
          WHERE status = 'pending' AND next_attempt_at <= now()
          ORDER BY enqueued_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );

      let sent = 0;
      let failed = 0;
      let skipped = 0;

      for (const row of rows) {
        const payload = row.payload;
        let outcome: DiscordOutcome;

        if (row.action === 'create') {
          outcome = await client.createForumPost({
            threadName: String(payload.threadName ?? 'EDFM Companion Report'),
            content: String(payload.content ?? ''),
            appliedTags: (payload.appliedTags as string[] | undefined) ?? [],
          });
        } else {
          const threadId = payload.threadId;
          if (typeof threadId !== 'string' || threadId === '') {
            await finish(row.id, 'skipped', 'no thread id');
            skipped += 1;
            continue;
          }
          outcome = await client.sendThreadMessage({
            threadId,
            content: String(payload.content ?? ''),
          });
        }

        switch (outcome.kind) {
          case 'created':
            // Discord's own response is the authority for the thread id.
            await db.query(
              `UPDATE discord_reports
                  SET discord_thread_id = $2, discord_message_id = $3,
                      thread_status = 'active', updated_at = now()
                WHERE discrepancy_key = $1`,
              [row.discrepancy_key, outcome.threadId, outcome.messageId],
            );
            await finish(row.id, 'sent', null);
            log('discord.forum_post_created', { action: row.action });
            sent += 1;
            break;

          case 'sent':
            await finish(row.id, 'sent', null);
            log('discord.thread_updated', { action: row.action });
            sent += 1;
            break;

          case 'thread-gone':
            await db.query(
              `UPDATE discord_reports SET thread_status = 'deleted', updated_at = now()
                WHERE discrepancy_key = $1`,
              [row.discrepancy_key],
            );
            // Not retried: the target does not exist. A replacement is decided
            // by report(), which can weigh whether the issue is still open.
            await finish(row.id, 'skipped', `thread gone: ${outcome.detail}`);
            log('discord.thread_deleted', {});
            skipped += 1;
            break;

          case 'invalid-webhook':
            await finish(row.id, 'failed', `invalid webhook: ${outcome.detail}`);
            log('discord.invalid_webhook', { detail: outcome.detail });
            failed += 1;
            break;

          case 'rejected':
            // Our mistake. Sending it again sends the same mistake.
            await finish(row.id, 'failed', `rejected: ${outcome.detail}`);
            log('discord.report_rejected', { detail: outcome.detail });
            failed += 1;
            break;

          case 'disabled':
            await finish(row.id, 'skipped', 'reporting disabled');
            skipped += 1;
            break;

          case 'unavailable': {
            const attempts = row.attempts + 1;
            if (attempts >= MAX_QUEUE_ATTEMPTS) {
              await finish(row.id, 'failed', `giving up after ${attempts}: ${outcome.detail}`);
              log('discord.report_abandoned', { attempts });
              failed += 1;
              break;
            }
            // Backoff in the row, not in the process: an outage that outlives
            // this worker still resumes correctly.
            await db.query(
              // $2 is cast explicitly: used bare as both an integer and an
              // interval multiplier, Postgres cannot deduce one type for it
              // and rejects the statement.
              `UPDATE discord_report_queue
                  SET attempts = $2::int, last_error = $3,
                      next_attempt_at = now() + ($2::int * interval '30 seconds')
                WHERE id = $1`,
              [row.id, attempts, outcome.detail],
            );
            log('discord.report_retry_scheduled', { attempts });
            failed += 1;
            break;
          }
        }
      }

      return { sent, failed, skipped };
    },

    async test() {
      const outcome = await client.testWebhookConnection();
      log('discord.test', { outcome: outcome.kind });
      return outcome;
    },
  };

  async function finish(id: string, status: string, error: string | null): Promise<void> {
    await options.db.query(
      `UPDATE discord_report_queue
          SET status = $2, last_error = $3, completed_at = now(), attempts = attempts + 1
        WHERE id = $1`,
      [id, status, error],
    );
  }
}
