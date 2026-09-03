/**
 * Webhook client behaviour. No real Discord request is ever made: `fetchImpl`
 * is injected, and `sleep` is stubbed so backoff does not make the suite slow.
 */

import { describe, expect, it, vi } from 'vitest';
import { createDiscordClient, redactUrl, truncate } from '../src/lib/discord/client.js';

const WEBHOOK = 'https://discord.com/api/webhooks/000000000000000000/TOKEN-VALUE-abc123';

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
  over: Partial<Parameters<typeof createDiscordClient>[0]> = {},
) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const logged: { event: string; detail?: Record<string, unknown> }[] = [];

  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return responder(url, init);
  });

  const c = createDiscordClient({
    webhookUrl: WEBHOOK,
    enabled: true,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async () => {},
    log: (event, detail) => logged.push({ event, ...(detail ? { detail } : {}) }),
    ...over,
  });
  return { c, calls, logged, fetchImpl };
}

const POST = { threadName: 'Incorrect Station Service — Jameson Memorial', content: 'body' };

describe('redactUrl', () => {
  it('removes the token but keeps the id', () => {
    // The id identifies which webhook without being a credential.
    expect(redactUrl(WEBHOOK)).toBe(
      'https://discord.com/api/webhooks/000000000000000000/<redacted>',
    );
    expect(redactUrl(WEBHOOK)).not.toContain('TOKEN-VALUE-abc123');
  });
});

describe('truncate', () => {
  it('leaves short text alone and shortens long text', () => {
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('abcdefghij', 5)).toHaveLength(5);
  });
});

describe('createForumPost', () => {
  it('creates a Forum post with thread_name and returns the thread id', async () => {
    const { c, calls } = client(() => res(200, { id: 'msg1', channel_id: 'thread1' }));
    const outcome = await c.createForumPost(POST);

    // A Forum webhook execution MUST carry thread_name; without it Discord
    // either 400s or posts to the wrong kind of channel.
    expect(calls[0]!.body.thread_name).toBe(POST.threadName);
    // wait=true is what makes Discord return the created message at all.
    expect(calls[0]!.url).toContain('wait=true');
    expect(outcome).toEqual({ kind: 'created', threadId: 'thread1', messageId: 'msg1' });
  });

  it('takes the thread id from Discord rather than inferring it', async () => {
    const { c } = client(() => res(200, { id: 'm', channel_id: '999' }));
    const outcome = await c.createForumPost(POST);
    expect(outcome).toMatchObject({ threadId: '999' });
  });

  it('treats a create response with no channel_id as a rejection', async () => {
    // Better to fail loudly than to store a thread id we invented.
    const { c } = client(() => res(200, { id: 'm' }));
    expect(await c.createForumPost(POST)).toMatchObject({ kind: 'rejected' });
  });

  it('applies forum tags when given, and omits the field when not', async () => {
    const { c, calls } = client(() => res(200, { id: 'm', channel_id: 't' }));
    await c.createForumPost({ ...POST, appliedTags: ['123', '456'] });
    expect(calls[0]!.body.applied_tags).toEqual(['123', '456']);

    await c.createForumPost({ ...POST, appliedTags: [] });
    // Sending [] is not the same as omitting: a Forum with required tags
    // rejects the empty array.
    expect(calls[1]!.body).not.toHaveProperty('applied_tags');
  });

  it('never lets a report mention anyone', async () => {
    const { c, calls } = client(() => res(200, { id: 'm', channel_id: 't' }));
    await c.createForumPost({ ...POST, content: '@everyone look' });
    expect(calls[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('truncates a title Discord would reject', async () => {
    const { c, calls } = client(() => res(200, { id: 'm', channel_id: 't' }));
    await c.createForumPost({ ...POST, threadName: 'x'.repeat(500) });
    expect(String(calls[0]!.body.thread_name).length).toBeLessThanOrEqual(100);
  });
});

describe('sendThreadMessage', () => {
  it('targets the thread by id and sends no thread_name', async () => {
    const { c, calls } = client(() => res(200, { id: 'msg2' }));
    const outcome = await c.sendThreadMessage({ threadId: 'thread1', content: 'update' });

    expect(calls[0]!.url).toContain('thread_id=thread1');
    // thread_name on an existing thread would open a duplicate post.
    expect(calls[0]!.body).not.toHaveProperty('thread_name');
    expect(outcome).toEqual({ kind: 'sent', messageId: 'msg2' });
  });
});

describe('failure handling', () => {
  it('retries a 429 honouring retry_after, then succeeds', async () => {
    let n = 0;
    const { c, logged } = client(() => {
      n += 1;
      return n === 1 ? res(429, { retry_after: 0.2 }) : res(200, { id: 'm', channel_id: 't' });
    });
    expect(await c.createForumPost(POST)).toMatchObject({ kind: 'created' });
    expect(logged.some((l) => l.event === 'discord.rate_limited')).toBe(true);
  });

  it('gives up on a persistent 429 rather than looping forever', async () => {
    const { c, fetchImpl } = client(() => res(429, { retry_after: 0.1 }), { maxAttempts: 3 });
    expect(await c.createForumPost(POST)).toMatchObject({ kind: 'unavailable' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries a 5xx and succeeds', async () => {
    let n = 0;
    const { c } = client(() => {
      n += 1;
      return n < 3 ? res(503) : res(200, { id: 'm', channel_id: 't' });
    });
    expect(await c.createForumPost(POST)).toMatchObject({ kind: 'created' });
  });

  it('reports unavailable when 5xx never clears', async () => {
    const { c, fetchImpl } = client(() => res(500), { maxAttempts: 2 });
    expect(await c.createForumPost(POST)).toMatchObject({ kind: 'unavailable' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry an invalid webhook', async () => {
    const { c, fetchImpl } = client(() => res(401, { code: 50027 }));
    expect(await c.createForumPost(POST)).toMatchObject({ kind: 'invalid-webhook' });
    // Retrying a revoked credential will never start working.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a 404 while creating as a dead webhook, not a dead thread', async () => {
    const { c } = client(() => res(404, { code: 10015 }));
    expect(await c.createForumPost(POST)).toMatchObject({ kind: 'invalid-webhook' });
  });

  it('treats a 404 on an existing thread as the thread being gone', async () => {
    const { c } = client(() => res(404, { code: 10003 }));
    expect(await c.sendThreadMessage({ threadId: 't', content: 'x' })).toMatchObject({
      kind: 'thread-gone',
    });
  });

  it('detects a locked or archived thread', async () => {
    const { c } = client(() => res(400, { code: 160005, message: 'Thread is locked' }));
    expect(await c.sendThreadMessage({ threadId: 't', content: 'x' })).toMatchObject({
      kind: 'thread-gone',
    });
  });

  it('does not retry a malformed request', async () => {
    const { c, fetchImpl } = client(() => res(400, { code: 50035, message: 'Invalid Form Body' }));
    expect(await c.createForumPost(POST)).toMatchObject({ kind: 'rejected' });
    // Sending the same mistake again produces the same mistake.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('survives a network failure', async () => {
    const { c } = client(() => {
      throw new TypeError('fetch failed');
    }, { maxAttempts: 2 });
    expect(await c.createForumPost(POST)).toMatchObject({ kind: 'unavailable' });
  });

  it('never puts the webhook or token in a log entry', async () => {
    const { c, logged } = client(() => {
      throw new TypeError('fetch failed');
    }, { maxAttempts: 2 });
    await c.createForumPost(POST);

    const dump = JSON.stringify(logged);
    expect(dump).not.toContain('TOKEN-VALUE-abc123');
    expect(dump).not.toContain(WEBHOOK);
  });

  it('never puts the token in a returned failure detail', async () => {
    const { c } = client(() => res(400, { code: 50035, message: 'bad' }));
    const outcome = await c.createForumPost(POST);
    expect(JSON.stringify(outcome)).not.toContain('TOKEN-VALUE-abc123');
  });
});

describe('when disabled', () => {
  it('makes no request at all', async () => {
    const { c, fetchImpl } = client(() => res(200), { enabled: false });
    expect(await c.createForumPost(POST)).toEqual({ kind: 'disabled' });
    expect(await c.sendThreadMessage({ threadId: 't', content: 'x' })).toEqual({ kind: 'disabled' });
    expect(await c.testWebhookConnection()).toEqual({ kind: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('makes no request when no webhook is configured', async () => {
    const { c, fetchImpl } = client(() => res(200), { webhookUrl: undefined });
    expect(await c.createForumPost(POST)).toEqual({ kind: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('testWebhookConnection', () => {
  it('posts a clearly marked test containing no game data', async () => {
    const { c, calls } = client(() => res(200, { id: 'm', channel_id: 't' }));
    await c.testWebhookConnection();

    expect(calls[0]!.body.thread_name).toBe('EDFM Companion — Webhook Test');
    expect(String(calls[0]!.body.content)).toContain('No game data is included');
  });
});
