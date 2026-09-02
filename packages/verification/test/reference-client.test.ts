import { describe, expect, it, vi } from 'vitest';
import { createReferenceClient } from '../src/reference-client.js';

const STATION = { marketId: '128', stationType: 'Orbis', serviceIds: ['dock'] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Harness {
  client: ReturnType<typeof createReferenceClient>;
  fetchImpl: ReturnType<typeof vi.fn>;
  arrived: string[];
  setTime: (ms: number) => void;
  setEnabled: (on: boolean) => void;
}

function harness(
  responder: (url: string) => Response | Promise<Response> = () => jsonResponse(STATION),
  options: { enabled?: boolean; maxEntries?: number; negativeTtlMs?: number } = {},
): Harness {
  let enabled = options.enabled ?? true;
  let time = 1_000_000;
  const arrived: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => responder(url));

  const client = createReferenceClient({
    baseUrl: 'https://api.example.com/',
    isEnabled: () => enabled,
    onArrived: (type, id) => arrived.push(`${type}:${id}`),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => time,
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    ...(options.negativeTtlMs === undefined ? {} : { negativeTtlMs: options.negativeTtlMs }),
  });

  return {
    client,
    fetchImpl,
    arrived,
    setTime: (ms) => { time = ms; },
    setEnabled: (on) => { enabled = on; },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createReferenceClient', () => {
  it('misses on a cold lookup rather than blocking the ingest path', () => {
    const { client } = harness();
    // Synchronous by necessity: lookup runs during journal ingest.
    expect(client.lookup('station', '128')).toBeUndefined();
  });

  it('serves the entity once it has arrived', async () => {
    const { client } = harness();
    client.prefetch('station', '128');
    await settle();
    expect(client.lookup('station', '128')).toEqual(STATION);
  });

  it('asks on a miss so the next observation has something to compare against', async () => {
    const { client, fetchImpl, arrived } = harness();
    client.lookup('station', '128');
    await settle();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/v1/reference/stations/128',
      expect.anything(),
    );
    // The caller is told, so it can re-observe the event it could not compare.
    expect(arrived).toEqual(['station:128']);
  });

  it('never touches the network while verification is off', async () => {
    // §21: nothing is uploaded by default, and a reference lookup discloses
    // which station this commander is docked at.
    const { client, fetchImpl } = harness(undefined, { enabled: false });
    client.prefetch('station', '128');
    client.lookup('station', '128');
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops immediately when consent is revoked mid-session', async () => {
    const { client, fetchImpl, setEnabled } = harness();
    client.prefetch('station', '128');
    await settle();
    setEnabled(false);
    client.prefetch('station', '999');
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent requests for the same entity', async () => {
    const { client, fetchImpl } = harness();
    client.prefetch('station', '128');
    client.prefetch('station', '128');
    client.lookup('station', '128');
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not re-request an entity it already holds', async () => {
    const { client, fetchImpl } = harness();
    client.prefetch('station', '128');
    await settle();
    client.lookup('station', '128');
    client.prefetch('station', '128');
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('remembers "not observed" so every dock does not re-ask', async () => {
    const { client, fetchImpl } = harness(() => jsonResponse({ error: 'not observed' }, 404));
    client.prefetch('station', '128');
    await settle();
    client.lookup('station', '128');
    client.lookup('station', '128');
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.stats().absent).toBe(1);
  });

  it('asks again once a cached absence expires', async () => {
    // "Not observed" is a statement about now: it stops being true as soon as
    // someone else reports the station.
    const { client, fetchImpl, setTime } = harness(
      () => jsonResponse({ error: 'not observed' }, 404),
      { negativeTtlMs: 1000 },
    );
    client.prefetch('station', '128');
    await settle();
    setTime(1_000_000 + 1001);
    client.prefetch('station', '128');
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('survives the server being unreachable', async () => {
    const { client } = harness(() => {
      throw new Error('ECONNREFUSED');
    });
    // Offline is the normal case for a desktop app, not an exception.
    expect(() => client.prefetch('station', '128')).not.toThrow();
    await settle();
    expect(client.lookup('station', '128')).toBeUndefined();
    expect(client.stats().failed).toBe(1);
  });

  it('retries cleanly after a failure rather than caching the error', async () => {
    let calls = 0;
    const { client } = harness(() => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return jsonResponse(STATION);
    });
    client.prefetch('station', '128');
    await settle();
    client.prefetch('station', '128');
    await settle();
    expect(client.lookup('station', '128')).toEqual(STATION);
  });

  it('does not treat a 500 as an answer', async () => {
    const { client, fetchImpl } = harness(() => jsonResponse({ error: 'boom' }, 500));
    client.prefetch('station', '128');
    await settle();
    client.prefetch('station', '128');
    await settle();
    // Nothing cached, so it is free to ask again.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.stats().failed).toBe(2);
  });

  it('refuses an id that is not a MarketID instead of putting it in a URL', async () => {
    const { client, fetchImpl } = harness();
    client.prefetch('station', '../../admin');
    client.prefetch('station', '');
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never requests an entity type with no reference endpoint', async () => {
    const { client, fetchImpl } = harness();
    client.prefetch('body', '128');
    client.lookup('body', '128');
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stays bounded over a long session', async () => {
    const { client } = harness(undefined, { maxEntries: 3 });
    for (const id of ['1', '2', '3', '4', '5']) {
      client.prefetch('station', id);
      await settle();
    }
    expect(client.stats().cached).toBe(3);
    // The oldest were evicted; the newest survive.
    expect(client.lookup('station', '5')).toEqual(STATION);
  });

  it('keeps recently used entries when evicting', async () => {
    const { client } = harness(undefined, { maxEntries: 2 });
    client.prefetch('station', '1');
    await settle();
    client.prefetch('station', '2');
    await settle();
    client.lookup('station', '1'); // touch
    client.prefetch('station', '3');
    await settle();
    expect(client.lookup('station', '1')).toEqual(STATION);
  });
});
