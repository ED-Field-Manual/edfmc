/**
 * Reporting policy, against a real PostgreSQL and a fake Discord.
 *
 * The rules that matter here — one post per discrepancy, updates only when
 * something changed, one resolution ever — are enforced by unique indexes and
 * by rows that outlive the process. A mocked database would prove none of it.
 *
 * No real Discord request is made: the client is a stub recording calls.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, migrate, type Db } from '../src/lib/db.js';
import {
  createReporter,
  type Detection,
  type DiscordReporter,
  type ReporterConfig,
} from '../src/lib/discord/reporter.js';
import type { DiscordClient, DiscordOutcome, ForumPost, ThreadMessage } from '../src/lib/discord/client.js';
import type { ReportSubject } from '../src/lib/discord/format.js';
import { parseTagMap } from '../src/lib/discord/tags.js';

const DSN = process.env.EDFM_TEST_DSN;
const run = DSN ? describe : describe.skip;

if (DSN && !/(^|[_-])test($|[_-])/.test(new URL(DSN).pathname.slice(1))) {
  throw new Error('EDFM_TEST_DSN is not a test database; this suite TRUNCATEs.');
}

interface Recorded {
  posts: ForumPost[];
  messages: ThreadMessage[];
  tests: number;
}

function stubClient(
  outcomes: Partial<{ create: DiscordOutcome; send: DiscordOutcome }> = {},
): { client: DiscordClient; recorded: Recorded } {
  const recorded: Recorded = { posts: [], messages: [], tests: 0 };
  return {
    recorded,
    client: {
      async createForumPost(post) {
        recorded.posts.push(post);
        return outcomes.create ?? { kind: 'created', threadId: 'thread-1', messageId: 'msg-1' };
      },
      async sendThreadMessage(message) {
        recorded.messages.push(message);
        return outcomes.send ?? { kind: 'sent', messageId: 'msg-2' };
      },
      async testWebhookConnection() {
        recorded.tests += 1;
        return { kind: 'created', threadId: 't', messageId: 'm' };
      },
    },
  };
}

const subject: ReportSubject = {
  category: 'Service',
  summary: 'Incorrect Station Service',
  system: 'Shinrarta Dezhra',
  place: 'Jameson Memorial',
  field: 'Service: techbroker',
  edfmValue: 'techbroker',
  observedValue: null,
  observedFrom: 'Docked',
  detectedAt: '2026-09-02T19:00:00.000Z',
  companionVersion: '0.1.0',
  reference: 'EDFM-1XB7IM5',
};

const detection = (over: Partial<Detection> = {}): Detection => ({
  discrepancyKey: 'station|128|service:techbroker|techbroker|~|4.1.2',
  subject,
  spoilerSensitive: false,
  confirmations: 1,
  ...over,
});

const config: ReporterConfig = {
  enabled: true,
  postResolutions: true,
  includeCommander: false,
  spoilerPolicy: 'suppress',
};

let db: Db;
let logged: string[] = [];

function make(
  clientOutcomes: Parameters<typeof stubClient>[0] = {},
  configOver: Partial<ReporterConfig> = {},
): { reporter: DiscordReporter; recorded: Recorded } {
  const { client, recorded } = stubClient(clientOutcomes);
  const reporter = createReporter({
    db,
    client,
    tagMap: parseTagMap('Service=111,Needs Review=222,Confirmed=333'),
    config: { ...config, ...configOver },
    log: (event) => logged.push(event),
  });
  return { reporter, recorded };
}

run('Discord reporter', () => {
  beforeEach(async () => {
    db ??= createPool(DSN!);
    await migrate(db, ['../eddn-worker/migrations', './migrations']);
    await db.query('TRUNCATE discord_reports, discord_report_queue RESTART IDENTITY CASCADE');
    logged = [];
  });

  afterAll(async () => {
    await db?.end();
  });

  /* ------------------------------------------------------------- create */

  it('creates exactly one Forum post for a new discrepancy', async () => {
    const { reporter, recorded } = make();
    expect(await reporter.report(detection())).toBe('queued-create');
    await reporter.processQueue();

    expect(recorded.posts).toHaveLength(1);
    expect(recorded.posts[0]!.threadName).toBe('Incorrect Station Service — Jameson Memorial');
  });

  it('applies the configured category and status tags', async () => {
    const { reporter, recorded } = make();
    await reporter.report(detection());
    await reporter.processQueue();
    expect(recorded.posts[0]!.appliedTags).toEqual(['111', '222']);
  });

  it('still posts when no tag is configured for the category', async () => {
    const { client, recorded } = stubClient();
    const reporter = createReporter({
      db,
      client,
      tagMap: {},
      config,
      log: (e) => logged.push(e),
    });
    await reporter.report(detection());
    await reporter.processQueue();
    // §7: an optional tag must never fail the report.
    expect(recorded.posts).toHaveLength(1);
    expect(recorded.posts[0]!.appliedTags).toEqual([]);
  });

  it('persists the thread id Discord returned', async () => {
    const { reporter } = make();
    await reporter.report(detection());
    await reporter.processQueue();

    const { rows } = await db.query<{ discord_thread_id: string; discord_message_id: string }>(
      'SELECT discord_thread_id, discord_message_id FROM discord_reports',
    );
    expect(rows[0]).toEqual({ discord_thread_id: 'thread-1', discord_message_id: 'msg-1' });
  });

  /* ---------------------------------------------------------- duplicate */

  it('does not create a second post for the same discrepancy', async () => {
    const { reporter, recorded } = make();
    await reporter.report(detection());
    await reporter.processQueue();

    expect(await reporter.report(detection())).toBe('duplicate-suppressed');
    await reporter.processQueue();

    expect(recorded.posts).toHaveLength(1);
    expect(recorded.messages).toHaveLength(0);
  });

  it('collapses a burst of identical detections before any is sent', async () => {
    const { reporter, recorded } = make();
    // A commander re-docking repeatedly must not become a queue of posts.
    await reporter.report(detection());
    await reporter.report(detection());
    await reporter.report(detection());
    await reporter.processQueue();
    expect(recorded.posts).toHaveLength(1);
  });

  /* ------------------------------------------------------------- update */

  it('updates the existing thread when another reporter confirms', async () => {
    const { reporter, recorded } = make();
    await reporter.report(detection());
    await reporter.processQueue();

    expect(await reporter.report(detection({ confirmations: 2 }))).toBe('queued-update');
    await reporter.processQueue();

    expect(recorded.posts).toHaveLength(1);
    expect(recorded.messages).toHaveLength(1);
    expect(recorded.messages[0]!.threadId).toBe('thread-1');
    expect(recorded.messages[0]!.content).toContain('Distinct reporters: 2');
  });

  it('updates when the observed value changes', async () => {
    const { reporter, recorded } = make();
    await reporter.report(detection());
    await reporter.processQueue();

    await reporter.report(
      detection({ subject: { ...subject, observedValue: 'techbroker' } }),
    );
    await reporter.processQueue();
    expect(recorded.messages[0]!.content).toContain('observed in game has changed');
  });

  it('stays silent when nothing has changed', async () => {
    const { reporter, recorded } = make();
    await reporter.report(detection());
    await reporter.processQueue();

    // §5: not a message per game event.
    for (let i = 0; i < 5; i += 1) await reporter.report(detection());
    await reporter.processQueue();
    expect(recorded.messages).toHaveLength(0);
    expect(logged).toContain('discord.duplicate_suppressed');
  });

  /* --------------------------------------------------------- resolution */

  it('posts a resolution once and never again', async () => {
    const { reporter, recorded } = make();
    await reporter.report(detection());
    await reporter.processQueue();

    expect(await reporter.report(detection({ resolved: true }))).toBe('queued-resolve');
    await reporter.processQueue();
    expect(recorded.messages).toHaveLength(1);
    expect(recorded.messages[0]!.content).toContain('Resolved: EDFM now matches');

    expect(await reporter.report(detection({ resolved: true }))).toBe('duplicate-suppressed');
    await reporter.processQueue();
    expect(recorded.messages).toHaveLength(1);
  });

  it('marks resolved without posting when resolution updates are off', async () => {
    const { reporter, recorded } = make({}, { postResolutions: false });
    await reporter.report(detection());
    await reporter.processQueue();
    await reporter.report(detection({ resolved: true }));
    await reporter.processQueue();

    expect(recorded.messages).toHaveLength(0);
    const { rows } = await db.query<{ status: string }>('SELECT status FROM discord_reports');
    expect(rows[0]!.status).toBe('resolved');
  });

  /* ------------------------------------------------------------ spoiler */

  it('never lets spoiler-sensitive content reach the Discord client', async () => {
    const { reporter, recorded } = make();
    const result = await reporter.report(
      detection({
        spoilerSensitive: true,
        subject: {
          ...subject,
          system: 'Praea Euq NW-W b1-3',
          body: 'Praea Euq NW-W b1-3 A 5',
          observedValue: 'Stratum Tectonicas',
        },
      }),
    );
    await reporter.processQueue();

    expect(result).toBe('spoiler-suppressed');
    expect(recorded.posts).toHaveLength(0);
    expect(recorded.messages).toHaveLength(0);
    // Nothing was even queued, so there is no row a later worker could send.
    const { rows } = await db.query('SELECT * FROM discord_report_queue');
    expect(rows).toHaveLength(0);
  });

  it('does not name the location in the suppression log', async () => {
    const { reporter } = make();
    await reporter.report(
      detection({ spoilerSensitive: true, subject: { ...subject, system: 'Praea Euq NW-W b1-3' } }),
    );
    // The log must not become the leak the suppression prevented.
    expect(JSON.stringify(logged)).not.toContain('Praea Euq');
    expect(logged).toContain('discord.suppressed_by_spoiler_policy');
  });

  it('posts a locationless stub under the redact policy', async () => {
    const { reporter, recorded } = make({}, { spoilerPolicy: 'redact' });
    await reporter.report(
      detection({
        spoilerSensitive: true,
        subject: {
          ...subject,
          system: 'Praea Euq NW-W b1-3',
          observedValue: 'Stratum Tectonicas',
        },
      }),
    );
    await reporter.processQueue();

    expect(recorded.posts).toHaveLength(1);
    const posted = JSON.stringify(recorded.posts[0]);
    expect(posted).not.toContain('Praea Euq');
    expect(posted).not.toContain('Stratum Tectonicas');
    expect(posted).not.toContain('Jameson Memorial');
    // The reference still resolves for a reviewer.
    expect(posted).toContain('EDFM-1XB7IM5');
  });

  it('omits the commander unless configured to include one', async () => {
    const { reporter, recorded } = make();
    await reporter.report(detection({ subject: { ...subject, commander: 'Hadfield' } }));
    await reporter.processQueue();
    expect(JSON.stringify(recorded.posts[0])).not.toContain('Hadfield');

    await db.query('TRUNCATE discord_reports, discord_report_queue RESTART IDENTITY CASCADE');
    const withName = make({}, { includeCommander: true });
    await withName.reporter.report(detection({ subject: { ...subject, commander: 'Hadfield' } }));
    await withName.reporter.processQueue();
    expect(JSON.stringify(withName.recorded.posts[0])).toContain('Hadfield');
  });

  /* ------------------------------------------------------ deleted thread */

  it('marks the association invalid when the thread is gone', async () => {
    const { reporter } = make({ send: { kind: 'thread-gone', detail: 'http 404' } });
    await reporter.report(detection());
    await reporter.processQueue();
    await reporter.report(detection({ confirmations: 2 }));
    await reporter.processQueue();

    const { rows } = await db.query<{ thread_status: string }>(
      'SELECT thread_status FROM discord_reports',
    );
    expect(rows[0]!.thread_status).toBe('deleted');
    expect(logged).toContain('discord.thread_deleted');
  });

  it('does not retry into a deleted thread', async () => {
    const { reporter, recorded } = make({ send: { kind: 'thread-gone', detail: 'http 404' } });
    await reporter.report(detection());
    await reporter.processQueue();
    await reporter.report(detection({ confirmations: 2 }));
    await reporter.processQueue();
    const after = recorded.messages.length;

    await reporter.processQueue();
    await reporter.processQueue();
    expect(recorded.messages).toHaveLength(after);
  });

  it('creates a replacement post when the discrepancy is still open', async () => {
    const { client, recorded } = stubClient();
    let sendOutcome: DiscordOutcome = { kind: 'thread-gone', detail: 'http 404' };
    const reporter = createReporter({
      db,
      client: { ...client, async sendThreadMessage(m) { recorded.messages.push(m); return sendOutcome; } },
      tagMap: {},
      config,
      log: (e) => logged.push(e),
    });

    await reporter.report(detection());
    await reporter.processQueue();
    await reporter.report(detection({ confirmations: 2 }));
    await reporter.processQueue(); // discovers the thread is gone

    sendOutcome = { kind: 'sent', messageId: 'm' };
    // §10: a replacement is allowed, rather than the issue becoming invisible.
    expect(await reporter.report(detection({ confirmations: 3 }))).toBe('queued-create');
    await reporter.processQueue();
    expect(recorded.posts).toHaveLength(2);
  });

  /* -------------------------------------------------------------- queue */

  it('retries a transient failure with backoff, then abandons it', async () => {
    const { reporter, recorded } = make({ create: { kind: 'unavailable', detail: 'http 503' } });
    await reporter.report(detection());

    for (let i = 0; i < 8; i += 1) {
      await db.query("UPDATE discord_report_queue SET next_attempt_at = now() - interval '1 hour'");
      await reporter.processQueue();
    }

    const { rows } = await db.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM discord_report_queue',
    );
    expect(rows[0]!.status).toBe('failed');
    // Bounded: never an infinite retry loop.
    expect(recorded.posts.length).toBeLessThanOrEqual(5);
    expect(logged).toContain('discord.report_abandoned');
  });

  it('does not retry a rejected request', async () => {
    const { reporter, recorded } = make({ create: { kind: 'rejected', detail: 'bad body' } });
    await reporter.report(detection());
    await reporter.processQueue();
    await db.query("UPDATE discord_report_queue SET next_attempt_at = now() - interval '1 hour'");
    await reporter.processQueue();
    expect(recorded.posts).toHaveLength(1);
  });

  it('keeps a queued report across a restart', async () => {
    const first = make({ create: { kind: 'unavailable', detail: 'offline' } });
    await first.reporter.report(detection());
    await first.reporter.processQueue();

    // A new reporter, as after a process restart. The row is still there.
    await db.query("UPDATE discord_report_queue SET next_attempt_at = now() - interval '1 hour'");
    const second = make();
    await second.reporter.processQueue();
    expect(second.recorded.posts).toHaveLength(1);
  });

  /* ----------------------------------------------------------- disabled */

  it('makes no request and queues nothing when reporting is disabled', async () => {
    const { reporter, recorded } = make({}, { enabled: false });
    expect(await reporter.report(detection())).toBe('disabled');
    expect(await reporter.processQueue()).toEqual({ sent: 0, failed: 0, skipped: 0 });

    expect(recorded.posts).toHaveLength(0);
    const { rows } = await db.query('SELECT * FROM discord_report_queue');
    expect(rows).toHaveLength(0);
  });
});
