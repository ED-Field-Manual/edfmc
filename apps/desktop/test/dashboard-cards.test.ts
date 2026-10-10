/**
 * Cargo list, last screenshot and recent journal: the selectors, and the two
 * places the app touches files (Cargo.json and the screenshot preview).
 *
 * Files and the Rust commands are mocked through `invoke`: these tests prove the
 * app's decisions, not the game or the disk. The thumbnail maker itself has its
 * own Rust test against a real PNG.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, UNKNOWN, type CommanderState } from '@edfm/elite-journal';
import type { ActivityEntry, ActivityGroup } from '@edfm/activity';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(), openPath: vi.fn(), revealItemInDir: vi.fn() }));

import { describeCargo, friendlyTime, recentJournal } from '../src/lib/dashboard';
import { Companion } from '../src/lib/companion';

const state = (over: Partial<CommanderState>): CommanderState => ({ ...initialState(), ...over });
const item = (name: string, label: string, count: number, missionId: number | null = null) => ({
  name,
  label,
  count,
  stolen: false,
  missionId,
});

beforeEach(() => invoke.mockReset());

describe('cargo on the Dashboard', () => {
  it('total against capacity, then up to five commodities, largest first', () => {
    const v = describeCargo(
      state({
        cargoCount: 102,
        cargoCapacity: 256,
        cargoManifest: [
          item('gold', 'Gold', 20),
          item('bromellite', 'Bromellite', 72),
          item('silver', 'Silver', 6),
          item('silver', 'Silver', 4, 7),
        ],
      }),
    );
    expect(v).toEqual({
      total: '102 / 256 t',
      lines: [
        { label: 'Bromellite', tonnes: 72 },
        { label: 'Gold', tonnes: 20 },
        { label: 'Silver', tonnes: 10 },
      ],
      more: 0,
    });
  });

  it('more than five commodities: five shown, the rest counted for the Logistics link', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => item(n, n.toUpperCase(), 10 - i));
    const v = describeCargo(state({ cargoCount: 49, cargoManifest: many }));
    expect(v?.lines).toHaveLength(5);
    expect(v?.more).toBe(2);
    expect(v?.total).toBe('49 t');
  });

  it('a total without its list shows no list at all, never an old one', () => {
    expect(describeCargo(state({ cargoCount: 102, cargoCapacity: 256, cargoManifest: UNKNOWN }))).toEqual({
      total: '102 / 256 t',
      lines: null,
      more: 0,
    });
  });

  it('an empty hold is an empty list; nothing reported is nothing shown', () => {
    expect(describeCargo(state({ cargoCount: 0, cargoManifest: [] }))?.lines).toEqual([]);
    expect(describeCargo(initialState())).toBeNull();
  });
});

describe('recent journal', () => {
  const e = (id: string, occurredAt: string, subtype = 'mission-completed'): ActivityEntry =>
    ({ id, occurredAt, title: id, commanderFid: 'F1', category: 'missions', subtype, systemName: 'S', systemAddress: 1, bodyName: null, bodyId: null, locationName: null, detail: null, data: {}, sources: [] }) as ActivityEntry;
  const groups: ActivityGroup[] = [
    { systemName: 'A', bodyName: null, startedAt: '', entries: [e('old', '2026-10-01T10:00:00Z'), e('mid', '2026-10-05T10:00:00Z')] },
    { systemName: 'B', bodyName: null, startedAt: '', entries: [e('new', '2026-10-09T10:00:00Z')] },
  ];

  it('newest first across systems, limited', () => {
    expect(recentJournal(groups, 5).map((x) => x.id)).toEqual(['new', 'mid', 'old']);
    expect(recentJournal(groups, 2).map((x) => x.id)).toEqual(['new', 'mid']);
    expect(recentJournal([], 5)).toEqual([]);
  });

  it('every category, newest first, without the retired landings and footfalls', () => {
    const all: ActivityGroup[] = [
      {
        systemName: 'Wregoe FH-D d12-45',
        bodyName: null,
        startedAt: '',
        entries: [
          e('poll-data', '2026-10-10T15:00:00Z', 'mission-completed'),
          e('mined', '2026-10-10T16:00:00Z', 'mining-run'),
          e('fight', '2026-10-10T18:38:39Z', 'fight'),
          e('died', '2026-10-10T19:01:32Z', 'died'),
          e('signals', '2026-10-10T19:10:00Z', 'signals-detected'),
          e('landed', '2026-10-10T19:20:00Z', 'landed'),
        ],
      },
    ];
    expect(recentJournal(all, 5).map((x) => x.id)).toEqual(['signals', 'died', 'fight', 'mined', 'poll-data']);
  });

  it('only things finished: no landings or footfalls', () => {
    const mixed: ActivityGroup[] = [
      {
        systemName: 'Wregoe FH-D d12-45',
        bodyName: null,
        startedAt: '',
        entries: [
          e('signals', '2026-10-09T18:19:03Z', 'signals-detected'),
          e('landed', '2026-10-09T18:20:00Z', 'landed'),
          e('footfall', '2026-10-09T18:21:00Z', 'footfall'),
          e('poll-data', '2026-10-07T23:11:39Z', 'mission-completed'),
          e('specimen', '2026-10-06T10:00:00Z', 'sample-completed'),
          e('sold', '2026-10-05T10:00:00Z', 'data-sold'),
        ],
      },
    ];
    expect(recentJournal(mixed, 5).map((x) => x.id)).toEqual(['signals', 'poll-data', 'specimen', 'sold']);
    expect(recentJournal([{ ...mixed[0]!, entries: mixed[0]!.entries.slice(1, 3) }], 5)).toEqual([]);
  });

  it('times read as people say them, never as ISO strings', () => {
    const now = new Date(2026, 9, 9, 18, 0);
    expect(friendlyTime(new Date(2026, 9, 9, 14, 5).toISOString(), now)).toBe('Today 14:05');
    expect(friendlyTime(new Date(2026, 9, 8, 22, 10).toISOString(), now)).toBe('Yesterday 22:10');
    expect(friendlyTime(new Date(2026, 9, 3, 9, 41).toISOString(), now)).toBe('3 Oct 09:41');
    expect(friendlyTime(new Date(2025, 11, 31, 9, 41).toISOString(), now)).toBe('31 Dec 2025 09:41');
    expect(friendlyTime('nonsense', now)).toBe('');
  });
});

/* --------------------------------------------------------- the app's file reads */

type Internals = {
  directory: string | null;
  state: CommanderState;
  readCargoFile: (attempt: number) => Promise<void>;
  scheduleCargoFileRead: (attempt?: number) => void;
  screenshotList: Array<{ id: string; filePath: string }>;
  missingScreenshots: Set<string>;
  refreshLatestPreview: () => Promise<void>;
};

const cargoJson = (at: string, count: number) =>
  JSON.stringify({ timestamp: at, event: 'Cargo', Vessel: 'Ship', Count: count, Inventory: [{ Name: 'gold', Count: count, Stolen: 0 }] });

function fileInvoke(text: string) {
  const bytes = new TextEncoder().encode(text);
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'journal_file_size') return bytes.length;
    if (cmd === 'journal_read_range') return bytes.buffer;
    return undefined;
  });
}

describe('Cargo.json, as the app reads it', () => {
  it('fills in the list for the matching Cargo event', async () => {
    const c = new Companion() as unknown as Internals;
    c.directory = 'C:\\Journal';
    Object.assign(c.state, { cargoCount: 12, cargoAt: '2026-10-10T00:03:21Z', cargoManifest: UNKNOWN });
    fileInvoke(cargoJson('2026-10-10T00:03:21Z', 12));
    await c.readCargoFile(0);
    expect(c.state.cargoManifest).toEqual([{ name: 'gold', label: 'Gold', count: 12, stolen: false, missionId: null }]);
    expect(invoke).toHaveBeenCalledWith('journal_file_size', { path: 'C:\\Journal\\Cargo.json' });
  });

  it('a file from before the event is not used, and is asked for again', async () => {
    vi.useFakeTimers();
    const c = new Companion() as unknown as Internals;
    c.directory = 'C:\\Journal';
    Object.assign(c.state, { cargoCount: 12, cargoAt: '2026-10-10T00:03:21Z', cargoManifest: UNKNOWN });
    fileInvoke(cargoJson('2026-10-09T23:00:00Z', 5));
    await c.readCargoFile(0);
    expect(c.state.cargoManifest).toBe(UNKNOWN);
    // The game catches up and writes the file; the retry finds it.
    fileInvoke(cargoJson('2026-10-10T00:03:21Z', 12));
    await vi.advanceTimersByTimeAsync(500);
    expect(c.state.cargoManifest).not.toBe(UNKNOWN);
    vi.useRealTimers();
  });

  it('no journal folder, or a list already known: no read at all', async () => {
    const c = new Companion() as unknown as Internals;
    c.directory = null;
    await c.readCargoFile(0);
    c.directory = 'C:\\Journal';
    Object.assign(c.state, { cargoManifest: [] });
    await c.readCargoFile(0);
    expect(invoke.mock.calls.filter(([cmd]) => String(cmd).startsWith('journal_'))).toEqual([]);
  });
});

describe('the last screenshot preview', () => {
  const shot = (id: string) => ({ id, filePath: `C:\\Shots\\${id}.png` });

  it('made once for the newest image, by the Rust thumbnail command', async () => {
    const c = new Companion() as unknown as Internals;
    c.screenshotList = [shot('b'), shot('a')];
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'screenshot_thumbnail' ? new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer : undefined,
    );
    const thumbs = () => invoke.mock.calls.filter(([cmd]) => cmd === 'screenshot_thumbnail').length;
    await c.refreshLatestPreview();
    expect(thumbs()).toBe(1);
    expect(invoke).toHaveBeenCalledWith('screenshot_thumbnail', { path: 'C:\\Shots\\b.png' });
    const p = (c as unknown as Companion).snapshot().latestScreenshotPreview;
    expect(p).toMatchObject({ id: 'b', state: 'ready' });
    expect(p?.url?.startsWith('data:image/png;base64,')).toBe(true);
    // The same newest image again: nothing is read again.
    await c.refreshLatestPreview();
    expect(thumbs()).toBe(1);
  });

  it('a moved or deleted file says so; nothing is read when the catalog already knows', async () => {
    const c = new Companion() as unknown as Internals;
    c.screenshotList = [shot('gone')];
    c.missingScreenshots = new Set(['gone']);
    await c.refreshLatestPreview();
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'screenshot_thumbnail')).toEqual([]);
    expect((c as unknown as Companion).snapshot().latestScreenshotPreview?.state).toBe('missing');

    const d = new Companion() as unknown as Internals;
    d.screenshotList = [shot('vanished')];
    invoke.mockImplementation(async (cmd: string) => (cmd === 'screenshot_thumbnail' ? Promise.reject('not-found') : undefined));
    await d.refreshLatestPreview();
    expect((d as unknown as Companion).snapshot().latestScreenshotPreview?.state).toBe('missing');
  });

  it('an image that is not a PNG gets no preview rather than an error', async () => {
    const c = new Companion() as unknown as Internals;
    c.screenshotList = [shot('bitmap')];
    invoke.mockImplementation(async (cmd: string) => (cmd === 'screenshot_thumbnail' ? Promise.reject('not-png') : undefined));
    await c.refreshLatestPreview();
    expect((c as unknown as Companion).snapshot().latestScreenshotPreview?.state).toBe('unavailable');
  });

  it('no screenshots: no preview', async () => {
    const c = new Companion() as unknown as Internals;
    c.screenshotList = [];
    await c.refreshLatestPreview();
    expect((c as unknown as Companion).snapshot().latestScreenshotPreview).toBeNull();
  });
});
