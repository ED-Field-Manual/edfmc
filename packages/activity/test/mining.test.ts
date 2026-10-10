/**
 * Mining in the Activity Journal: one entry per run, with what was refined.
 *
 * Lines are the shape of real ones (`MiningRefined` carries only Type and
 * Type_Localised). The corpus block replays the real journals where they exist.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JournalSessionContext, listJournalFiles, normalize, parseLine, replayFile } from '@edfm/elite-journal';
import '@edfm/elite-journal/node';

import { ActivityEngine, miningTotals, type ActivityEntry } from '../src/index.js';

const ctx = new JournalSessionContext();
let offset = 0;
function ev(line: string) {
  const parsed = parseLine(line, 'Journal.2026-10-10T150000.01.log', (offset += 100), ctx);
  if (!parsed?.ok) throw new Error('fixture failed to parse');
  return normalize(parsed.event);
}

const JUMP = (sys: string, at = '2026-10-10T15:00:00Z') =>
  `{ "timestamp":"${at}", "event":"FSDJump", "Taxi":false, "Multicrew":false, "StarSystem":"${sys}", "SystemAddress":${sys.length}, "StarPos":[1,2,3], "JumpDist":8.5, "FuelUsed":0.6, "FuelLevel":31.2 }`;
const DROP_RING = '{ "timestamp":"2026-10-10T15:05:00Z", "event":"SupercruiseExit", "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe FH-D d12-45", "SystemAddress":1, "Body":"Wregoe FH-D d12-45 9 B Ring", "BodyID":40, "BodyType":"PlanetaryRing" }';
const DROP_STATION = '{ "timestamp":"2026-10-10T16:00:00Z", "event":"SupercruiseExit", "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe FH-D d12-45", "SystemAddress":1, "Body":"Delsanti Hub", "BodyID":41, "BodyType":"Station" }';
const REFINED = (type: string, label: string, at = '2026-10-10T15:11:53Z') =>
  `{ "timestamp":"${at}", "event":"MiningRefined", "Type":"$${type}_name;", "Type_Localised":"${label}" }`;
const SC_ENTRY = (at = '2026-10-10T15:50:00Z') =>
  `{ "timestamp":"${at}", "event":"SupercruiseEntry", "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe FH-D d12-45", "SystemAddress":1 }`;

function feed(engine: ActivityEngine, lines: string[]): ActivityEntry[] {
  return lines.flatMap((l) => [...engine.observe(ev(l))]);
}

describe('a mining run', () => {
  it('is one entry, recorded when the commander leaves, with each material and the total', () => {
    const e = new ActivityEngine({ commanderFid: 'F0000001' });
    const out = feed(e, [
      JUMP('Wregoe FH-D d12-45'),
      DROP_RING,
      ...Array.from({ length: 3 }, () => REFINED('bromellite', 'Bromellite')),
      REFINED('tritium', 'Tritium', '2026-10-10T15:30:00Z'),
    ]);
    expect(out).toEqual([]); // nothing until the run is over
    const [run] = feed(e, [SC_ENTRY()]);
    expect(run).toMatchObject({
      category: 'mining',
      subtype: 'mining-run',
      title: 'Refined 4 t',
      detail: 'Bromellite 3 t · Tritium 1 t',
      systemName: 'Wregoe FH-D d12-45',
      bodyName: 'Wregoe FH-D d12-45 9 B Ring',
      occurredAt: '2026-10-10T15:30:00Z',
    });
    expect(run!.data['total']).toBe(4);
    expect(run!.data['refined']).toEqual([
      { commodity: 'bromellite', label: 'Bromellite', tonnes: 3 },
      { commodity: 'tritium', label: 'Tritium', tonnes: 1 },
    ]);
    expect(run!.sources).toHaveLength(4);
  });

  it('ended by a jump belongs to the system it was mined in', () => {
    const e = new ActivityEngine({ commanderFid: 'F0000001' });
    const [run] = feed(e, [JUMP('Wregoe FH-D d12-45'), DROP_RING, REFINED('platinum', 'Platinum'), JUMP('Somewhere Else', '2026-10-10T16:00:00Z')]);
    expect(run!.systemName).toBe('Wregoe FH-D d12-45');
  });

  it('near a station names the system, not the station as the mine', () => {
    const e = new ActivityEngine({ commanderFid: 'F0000001' });
    const [run] = feed(e, [JUMP('Wregoe FH-D d12-45'), DROP_STATION, REFINED('bromellite', 'Bromellite'), SC_ENTRY('2026-10-10T16:05:00Z')]);
    expect(run!.bodyName).toBeNull();
  });

  it('re-reading the journal gives the same entry, so it is stored once', () => {
    const lines = [JUMP('Wregoe FH-D d12-45'), DROP_RING, REFINED('bromellite', 'Bromellite'), SC_ENTRY()];
    const a = feed(new ActivityEngine({ commanderFid: 'F0000001' }), lines.map((l) => l));
    offset -= 400; // the same byte offsets again, as a re-read sees them
    const b = feed(new ActivityEngine({ commanderFid: 'F0000001' }), lines);
    expect(a[0]!.id).toBe(b[0]!.id);
  });

  it('a commander switch drops a run in progress rather than giving it to someone else', () => {
    const e = new ActivityEngine({ commanderFid: 'F0000001' });
    feed(e, [JUMP('Wregoe FH-D d12-45'), DROP_RING, REFINED('bromellite', 'Bromellite')]);
    e.setCommander('F0000002');
    expect(feed(e, [SC_ENTRY()])).toEqual([]);
  });
});

describe('the Mining total', () => {
  it('adds every run up by material', () => {
    const run = (refined: Array<[string, string, number]>) =>
      ({ subtype: 'mining-run', data: { refined: refined.map(([commodity, label, tonnes]) => ({ commodity, label, tonnes })) } }) as unknown as ActivityEntry;
    const t = miningTotals([
      run([['p', 'Platinum', 127], ['o', 'Osmium', 14]]),
      run([['p', 'Platinum', 28], ['b', 'Bromellite', 87]]),
      { subtype: 'mission-completed', data: {} } as unknown as ActivityEntry,
    ]);
    expect(t.total).toBe(256);
    expect(t.refined).toEqual([
      { label: 'Platinum', tonnes: 155 },
      { label: 'Bromellite', tonnes: 87 },
      { label: 'Osmium', tonnes: 14 },
    ]);
  });
});

const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
const DIR = process.env['EDFM_JOURNAL_DIR'] ?? join(home, 'Saved Games', 'Frontier Developments', 'Elite Dangerous');
(home !== '' && existsSync(DIR) ? describe : describe.skip)('mining runs in the real journals', () => {
  it('every refined tonne lands in exactly one run', async () => {
    const files = (await listJournalFiles(DIR)).filter((f) => f.sizeBytes > 0);
    const engine = new ActivityEngine({ commanderFid: 'F-TEST' });
    let refines = 0;
    const runs: ActivityEntry[] = [];
    for (const file of files) {
      for (const event of (await replayFile(file.fullPath)).events) {
        if (event.source.event === 'MiningRefined') refines += 1;
        runs.push(...engine.observe(event).filter((e) => e.subtype === 'mining-run'));
      }
    }
    // A run still open at the end of the newest journal is not recorded yet.
    const recorded = runs.reduce((n, r) => n + (r.data['total'] as number), 0);
    expect(recorded).toBeLessThanOrEqual(refines);
    expect(refines - recorded).toBeLessThan(400);
    expect(new Set(runs.map((r) => r.id)).size).toBe(runs.length);
  }, 120_000);
});
