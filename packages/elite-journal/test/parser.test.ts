import { describe, expect, it } from 'vitest';
import { JournalSessionContext, parseLine } from '../src/parser.js';

const HEADER =
  '{ "timestamp":"2026-09-01T13:26:17Z", "event":"Fileheader", "part":1, "language":"English/UK", "Odyssey":true, "gameversion":"4.4.0.3", "build":"r330683/r0 " }';
const COMMANDER =
  '{ "timestamp":"2026-09-01T13:27:33Z", "event":"Commander", "FID":"F0000000", "Name":"Sythan" }';

function ctx() {
  return new JournalSessionContext();
}

describe('parseLine', () => {
  it('parses a real Fileheader and captures version context', () => {
    const c = ctx();
    const r = parseLine(HEADER, 'J.log', 0, c);
    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    expect(r.event.event).toBe('Fileheader');
    expect(c.gameVersion).toBe('4.4.0.3');
    expect(c.build).toBe('r330683/r0 '); // trailing space preserved verbatim
    expect(c.odyssey).toBe(true);
  });

  it('propagates version and commander context onto later events', () => {
    const c = ctx();
    parseLine(HEADER, 'J.log', 0, c);
    parseLine(COMMANDER, 'J.log', 100, c);
    const r = parseLine('{ "timestamp":"2026-09-01T13:30:00Z", "event":"Music", "MusicTrack":"NoTrack" }', 'J.log', 200, c);

    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    const p = r.event.provenance;
    expect(p.commander).toBe('Sythan');
    expect(p.fid).toBe('F0000000');
    expect(p.gameVersion).toBe('4.4.0.3');
    expect(p.eventId).toBe('J.log:200');
  });

  it('builds eventId from file and byte offset, not timestamp', () => {
    const c = ctx();
    const a = parseLine(COMMANDER, 'J.log', 0, c);
    const b = parseLine(COMMANDER, 'J.log', 512, c);
    expect(a?.ok && b?.ok).toBe(true);
    if (!a?.ok || !b?.ok) return;
    // Identical content and timestamp, different identity.
    expect(a.event.provenance.eventId).not.toBe(b.event.provenance.eventId);
  });

  it('distinguishes malformed JSON from a valid object lacking an event field', () => {
    const c = ctx();
    const bad = parseLine('{ "event": "Docked" ', 'J.log', 0, c);
    expect(bad?.ok).toBe(false);
    if (bad && !bad.ok) expect(bad.failure.reason).toBe('malformed-json');

    const noEvent = parseLine('{ "timestamp":"2026-09-01T00:00:00Z" }', 'J.log', 0, c);
    expect(noEvent?.ok).toBe(false);
    if (noEvent && !noEvent.ok) expect(noEvent.failure.reason).toBe('missing-event-field');
  });

  it('rejects JSON that is not an object', () => {
    const r = parseLine('[1,2,3]', 'J.log', 0, ctx());
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.failure.reason).toBe('not-an-object');
  });

  it('ignores blank padding lines', () => {
    expect(parseLine('', 'J.log', 0, ctx())).toBeNull();
    expect(parseLine('   ', 'J.log', 0, ctx())).toBeNull();
  });

  it('accepts the real payload-less MarketID event emitted by build 4.4.0.3', () => {
    // Observed verbatim in Journal.2026-09-01T082623.01.log. An event whose name
    // collides with a field name used elsewhere, carrying no data at all.
    const r = parseLine('{ "timestamp":"2026-09-01T18:26:38Z", "event":"MarketID" }', 'J.log', 0, ctx());
    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    expect(r.event.event).toBe('MarketID');
    expect(r.event.raw['MarketID']).toBeUndefined();
  });

  it('retains unknown fields verbatim so future schema additions are not lost', () => {
    const r = parseLine(
      '{ "timestamp":"2026-09-01T00:00:00Z", "event":"Docked", "SomeFutureField":{"nested":[1,2]} }',
      'J.log',
      0,
      ctx(),
    );
    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    expect(r.event.raw['SomeFutureField']).toEqual({ nested: [1, 2] });
  });

  it('does not throw on a missing timestamp', () => {
    const r = parseLine('{ "event":"Shutdown" }', 'J.log', 0, ctx());
    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    expect(r.event.provenance.timestampMs).toBeNull();
  });

  it('restores context so a mid-file resume is not blind to version', () => {
    const c = JournalSessionContext.restore({ gameVersion: '4.4.0.3', commander: 'Sythan' });
    const r = parseLine('{ "timestamp":"2026-09-01T00:00:00Z", "event":"Music" }', 'J.log', 900, c);
    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    expect(r.event.provenance.gameVersion).toBe('4.4.0.3');
    expect(r.event.provenance.commander).toBe('Sythan');
  });
});
