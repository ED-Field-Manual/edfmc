/**
 * Discord webhook client.
 *
 * A service, not a helper: discrepancy code calls `createForumPost` and
 * `sendThreadMessage`, and never composes an HTTP request itself. That keeps
 * every rate-limit, retry and failure-classification decision in one place
 * instead of scattered across whichever caller was written last.
 *
 * ## Forum channels are not text channels
 *
 * Executing a webhook against a Forum channel *must* carry `thread_name`, and
 * that call creates a new post. Adding to an existing post is a different
 * request: same webhook, `?thread_id=` on the query string, and no
 * `thread_name`. Getting this wrong does not error usefully -- it either 400s
 * or silently opens a duplicate post -- so the two are separate methods here
 * rather than one method with a flag.
 *
 * ## The URL is a credential
 *
 * Anyone holding it can post to the channel. It is never logged, never
 * returned, and never included in an error message: `redactUrl` exists because
 * the natural thing for an HTTP client to do -- put the URL in the exception --
 * would leak it into the log the first time Discord had an outage.
 */

export type DiscordOutcome =
  | { readonly kind: 'created'; readonly threadId: string; readonly messageId: string | null }
  | { readonly kind: 'sent'; readonly messageId: string | null }
  /** The thread is gone or unusable. The caller must stop targeting it. */
  | { readonly kind: 'thread-gone'; readonly detail: string }
  /** Webhook deleted or token revoked. Retrying will never help. */
  | { readonly kind: 'invalid-webhook'; readonly detail: string }
  /** We sent something Discord rejected. Retrying will never help. */
  | { readonly kind: 'rejected'; readonly detail: string }
  /** Transient: timeout, 5xx, network failure, or retries exhausted on 429. */
  | { readonly kind: 'unavailable'; readonly detail: string }
  /** Reporting is switched off. No request was made. */
  | { readonly kind: 'disabled' };

export interface ForumPost {
  readonly threadName: string;
  readonly content: string;
  readonly appliedTags?: readonly string[];
}

export interface ThreadMessage {
  readonly threadId: string;
  readonly content: string;
}

export interface DiscordClientOptions {
  /** Secret. Absent or reporting disabled means no request is ever made. */
  readonly webhookUrl: string | undefined;
  readonly enabled: boolean;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly fetchImpl?: typeof fetch;
  /** Injected so tests do not actually wait out a backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface DiscordClient {
  createForumPost(post: ForumPost): Promise<DiscordOutcome>;
  sendThreadMessage(message: ThreadMessage): Promise<DiscordOutcome>;
  testWebhookConnection(): Promise<DiscordOutcome>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 4;
/** Discord's own cap; a longer wait is a bug or an abuse response. */
const MAX_BACKOFF_MS = 30_000;
/** Discord rejects longer, and truncating beats a 400 that loses the report. */
const MAX_CONTENT = 1900;
const MAX_THREAD_NAME = 100;

/**
 * Strip the token from anything that might be logged.
 *
 * The path is `/api/webhooks/<id>/<token>`. The id is not secret and is useful
 * when several webhooks are configured; the token is the credential.
 */
export function redactUrl(url: string): string {
  return url.replace(/(\/api\/webhooks\/\d+\/)[\w-]+/, '$1<redacted>');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

interface DiscordErrorBody {
  code?: number;
  message?: string;
}

/**
 * Discord signals a missing thread with 404, and an archived or locked one with
 * 400 plus a specific code. Both mean the same thing to us: stop using this
 * thread id.
 */
const THREAD_GONE_CODES = new Set([
  10003, // Unknown Channel
  10008, // Unknown Message
  160005, // Thread is locked
]);

export function createDiscordClient(options: DiscordClientOptions): DiscordClient {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => {});

  function ready(): boolean {
    return options.enabled && typeof options.webhookUrl === 'string' && options.webhookUrl !== '';
  }

  async function parseBody(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async function execute(
    url: string,
    body: unknown,
    context: 'create' | 'send' | 'test',
  ): Promise<DiscordOutcome> {
    if (!ready()) return { kind: 'disabled' };

    let lastDetail = 'no attempt made';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // AbortSignal.timeout rather than an unbounded wait: a hung connection
      // would otherwise pin a queue worker indefinitely.
      const signal = AbortSignal.timeout(timeoutMs);

      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        // Never include the URL: it carries the token.
        lastDetail = `network: ${(error as Error).name}`;
        log('discord.network_error', { attempt, detail: lastDetail });
        if (attempt < maxAttempts) await sleep(backoff(attempt));
        continue;
      }

      if (response.status === 429) {
        const payload = (await parseBody(response)) as { retry_after?: number } | null;
        const headerWait = Number(response.headers.get('retry-after') ?? '0');
        const waitMs = Math.min(
          Math.max((payload?.retry_after ?? headerWait) * 1000, 1000),
          MAX_BACKOFF_MS,
        );
        lastDetail = `rate limited (${waitMs}ms)`;
        log('discord.rate_limited', { attempt, waitMs });
        // Rate limiting is not an error, but it is still bounded: an
        // unbounded honour-the-header loop is an infinite retry with extra
        // steps.
        if (attempt < maxAttempts) {
          await sleep(waitMs);
          continue;
        }
        return { kind: 'unavailable', detail: lastDetail };
      }

      if (response.status === 401 || response.status === 403 || response.status === 404) {
        const payload = (await parseBody(response)) as DiscordErrorBody | null;
        const code = payload?.code;

        if (context !== 'create' && (response.status === 404 || THREAD_GONE_CODES.has(code ?? 0))) {
          return { kind: 'thread-gone', detail: `http ${response.status} code ${code ?? 'none'}` };
        }
        // 401/403, or a 404 while creating: the webhook itself is gone.
        return {
          kind: 'invalid-webhook',
          detail: `http ${response.status} code ${code ?? 'none'}`,
        };
      }

      if (response.status >= 500) {
        lastDetail = `http ${response.status}`;
        log('discord.server_error', { attempt, status: response.status });
        if (attempt < maxAttempts) await sleep(backoff(attempt));
        continue;
      }

      if (!response.ok) {
        const payload = (await parseBody(response)) as DiscordErrorBody | null;
        const code = payload?.code;
        if (THREAD_GONE_CODES.has(code ?? 0)) {
          return { kind: 'thread-gone', detail: `http ${response.status} code ${code}` };
        }
        // 4xx is our mistake. Retrying an identical malformed request just
        // sends the same mistake again.
        return {
          kind: 'rejected',
          detail: `http ${response.status} code ${code ?? 'none'}: ${payload?.message ?? ''}`.trim(),
        };
      }

      const payload = (await parseBody(response)) as
        | { id?: string; channel_id?: string }
        | null;

      if (context === 'create') {
        // With ?wait=true Discord returns the created message; its channel_id
        // IS the new thread's id. Parsed from the response and never inferred
        // from the title, which is neither unique nor stable.
        const threadId = payload?.channel_id ?? null;
        if (threadId === null) {
          return { kind: 'rejected', detail: 'no channel_id in create response' };
        }
        return { kind: 'created', threadId, messageId: payload?.id ?? null };
      }

      return { kind: 'sent', messageId: payload?.id ?? null };
    }

    return { kind: 'unavailable', detail: lastDetail };
  }

  /** Exponential with jitter, so simultaneous workers do not retry in lockstep. */
  function backoff(attempt: number): number {
    const base = Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    return base + Math.floor(Math.random() * 250);
  }

  return {
    async createForumPost(post) {
      if (!ready()) return { kind: 'disabled' };
      // wait=true makes Discord return the created message, which is the only
      // way to learn the thread id.
      const url = `${options.webhookUrl!}?wait=true`;
      const body: Record<string, unknown> = {
        thread_name: truncate(post.threadName, MAX_THREAD_NAME),
        content: truncate(post.content, MAX_CONTENT),
        // Never let a report mention anyone, whatever ends up in the text.
        allowed_mentions: { parse: [] },
      };
      // Omitted entirely when empty: sending [] is not the same as not sending
      // the field, and a Forum with required tags rejects the empty array.
      if (post.appliedTags && post.appliedTags.length > 0) {
        body.applied_tags = post.appliedTags;
      }
      return execute(url, body, 'create');
    },

    async sendThreadMessage(message) {
      if (!ready()) return { kind: 'disabled' };
      const url = `${options.webhookUrl!}?wait=true&thread_id=${encodeURIComponent(message.threadId)}`;
      return execute(
        url,
        {
          content: truncate(message.content, MAX_CONTENT),
          allowed_mentions: { parse: [] },
        },
        'send',
      );
    },

    async testWebhookConnection() {
      if (!ready()) return { kind: 'disabled' };
      // Deliberately contains no game data at all — see DISCORD.md.
      return execute(
        `${options.webhookUrl!}?wait=true`,
        {
          thread_name: 'EDFM Companion — Webhook Test',
          content:
            'This is a test of the EDFM Companion Discord Forum reporting integration. ' +
            'No game data is included.',
          allowed_mentions: { parse: [] },
        },
        'test',
      );
    },
  };
}
