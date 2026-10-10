/**
 * The Overlay Manager's settings in the app: where layouts are stored, the
 * move from the overlay's old browser storage, reset, presets, saved layouts,
 * widget options reaching the overlay, and the show/hide hotkey.
 *
 * Runs the real Companion against an in-memory settings table. The native
 * layer is mocked: these check the app's side of each contract, not the game.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoked: Array<[string, Record<string, unknown> | undefined]> = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    invoked.push([cmd, args]);
    if (cmd === 'elite_window_info') return { found: false };
    return undefined;
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(), openPath: vi.fn(), revealItemInDir: vi.fn() }));

const registered = new Map<string, (e: { state?: string }) => void>();
let refuse: string | null = null;
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({
  unregisterAll: vi.fn(async () => registered.clear()),
  register: vi.fn(async (binding: string, fn: (e: { state?: string }) => void) => {
    if (binding === refuse) throw new Error('already registered by another application');
    registered.set(binding, fn);
  }),
}));

import { Companion } from '../src/lib/companion';
import { DEFAULT_LAYOUT, PRESETS, withPlacement, type OverlayLayout } from '../src/lib/overlayLayout';
import type { OverlayPushState } from '../src/lib/overlay';

type Internals = {
  db: unknown;
  loadOverlayLayout(): Promise<void>;
  storeLayout(l: OverlayLayout): Promise<void>;
  overlayLayout: OverlayLayout;
  layoutRevision: number;
  screenshotHotkey: string | null;
  overlayEnabled: boolean;
  pushOverlayState(): void;
};

function fakeDb(settings: Map<string, string>) {
  return {
    select: async (sql: string, params: unknown[]) =>
      sql.includes('FROM settings WHERE key') && settings.has(params[0] as string)
        ? [{ value: settings.get(params[0] as string) }]
        : [],
    execute: async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO settings')) settings.set(params[0] as string, params[1] as string);
    },
  };
}

function setup(stored: Record<string, string> = {}) {
  const settings = new Map(Object.entries(stored));
  const c = new Companion();
  const i = c as unknown as Internals;
  i.db = fakeDb(settings);
  return { c, i, settings };
}

/** The last state pushed to the overlay. */
function lastPush(): OverlayPushState | undefined {
  const pushes = invoked.filter(([cmd]) => cmd === 'overlay_push_state');
  return pushes.at(-1)?.[1]?.['payload'] as OverlayPushState | undefined;
}

const storage = new Map<string, string>();
beforeEach(() => {
  invoked.length = 0;
  registered.clear();
  refuse = null;
  storage.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  };
});

describe('where the layout lives', () => {
  it('copies the overlay’s old browser-storage layout into settings, once', async () => {
    storage.set('edfm.overlay.layout.v2', JSON.stringify({ context: { x: 111, y: 222 } }));
    const { i, settings } = setup();
    await i.loadOverlayLayout();
    expect(i.overlayLayout.widgets['context']).toEqual({ x: 111, y: 222, width: null });
    expect(JSON.parse(settings.get('overlayLayout')!).widgets.context).toEqual({ x: 111, y: 222, width: null });
    // The old key is left alone; the settings row now wins.
    storage.set('edfm.overlay.layout.v2', JSON.stringify({ context: { x: 1, y: 1 } }));
    const again = setup(Object.fromEntries(settings));
    await again.i.loadOverlayLayout();
    expect(again.i.overlayLayout.widgets['context']).toEqual({ x: 111, y: 222, width: null });
  });

  it('falls back to the standard layout when the stored one is corrupt', async () => {
    const { i } = setup({ overlayLayout: '{oops' });
    await i.loadOverlayLayout();
    expect(i.overlayLayout).toEqual(DEFAULT_LAYOUT);
  });

  it('stores what the overlay sends, bumps the revision, and pushes it back', async () => {
    const { i, settings } = setup();
    await i.loadOverlayLayout();
    i.overlayEnabled = true;
    const before = i.layoutRevision;
    const moved = withPlacement(DEFAULT_LAYOUT, 'missions', { x: 500, y: 400, width: 380 }, { width: 1920, height: 1080 });
    await i.storeLayout(moved);
    expect(i.layoutRevision).toBe(before + 1);
    expect(JSON.parse(settings.get('overlayLayout')!).widgets.missions).toEqual({ x: 500, y: 400, width: 380 });
    expect(lastPush()?.layout.widgets['missions']).toEqual({ x: 500, y: 400, width: 380 });
    expect(lastPush()?.layoutRevision).toBe(before + 1);
    // The same layout again changes nothing.
    await i.storeLayout(moved);
    expect(i.layoutRevision).toBe(before + 1);
  });
});

describe('reset, presets and saved layouts', () => {
  it('Reset Layout moves widgets back and leaves visibility and options alone', async () => {
    const { c, i } = setup();
    await i.loadOverlayLayout();
    await c.setOverlayWidgets({ ...c.overlayWidgets, liveJournal: true });
    await c.setWidgetOptions({ ...c.snapshot().overlay.options, missionRows: 8 });
    await i.storeLayout(withPlacement(DEFAULT_LAYOUT, 'context', { x: 900, y: 900, width: 500 }, { width: 1920, height: 1080 }));
    expect(c.snapshot().overlay.layoutCustomised).toBe(true);
    await c.resetOverlayLayout();
    expect(i.overlayLayout.widgets['context']).toEqual(DEFAULT_LAYOUT.widgets['context']);
    expect(c.snapshot().overlay.layoutCustomised).toBe(false);
    expect(c.overlayWidgets.liveJournal).toBe(true);
    expect(c.snapshot().overlay.options.missionRows).toBe(8);
  });

  it('a preset sets which widgets are on, their options and positions', async () => {
    const { c, i } = setup();
    await i.loadOverlayLayout();
    await c.applyOverlayPreset('minimal');
    const minimal = PRESETS[0]!;
    expect(c.overlayWidgets.missions).toBe(minimal.visibility.missions);
    expect(c.snapshot().overlay.options.routeDetail).toBe('compact');
    // Customisable afterwards, like anything else.
    await c.setOverlayWidgets({ ...c.overlayWidgets, missions: true });
    expect(c.overlayWidgets.missions).toBe(true);
  });

  it('saves, applies and deletes a named layout, keeping plugin switches', async () => {
    const { c, i } = setup();
    await i.loadOverlayLayout();
    await c.setOverlayWidgets({ ...c.overlayWidgets, route: false, pluginPanelsOff: ['CL'] });
    expect(await c.saveOverlayProfile('Exploring')).toBeNull();
    await c.setOverlayWidgets({ ...c.overlayWidgets, route: true, pluginPanelsOff: [] });
    await c.applyOverlayProfile('Exploring');
    expect(c.overlayWidgets.route).toBe(false);
    expect(c.overlayWidgets.pluginPanelsOff).toEqual([]); // a profile is about built-in widgets
    await c.deleteOverlayProfile('Exploring');
    expect(c.snapshot().overlay.profiles).toEqual([]);
  });

  it('the Missions widget lists as many rows as its option says', async () => {
    const { c, i } = setup();
    await i.loadOverlayLayout();
    await c.setWidgetOptions({ ...c.snapshot().overlay.options, missionRows: 2 });
    i.pushOverlayState();
    expect(lastPush()?.options.missionRows).toBe(2);
  });
});

describe('the show/hide hotkey', () => {
  it('is unset by default and binds nothing', async () => {
    const { c } = setup();
    expect(c.snapshot().overlay.toggleHotkey).toBeNull();
    expect(registered.size).toBe(0);
  });

  it('refuses a combination another EDFMC hotkey has', async () => {
    const { c, i } = setup();
    i.screenshotHotkey = 'Control+Shift+S';
    expect(await c.setOverlayToggleHotkey('Control+Shift+S')).toBe('That combination already captures screenshots.');
    expect(c.snapshot().overlay.toggleHotkey).toBeNull();
  });

  it('binds alongside the others, saves, and toggles only the overlay window', async () => {
    const { c, i, settings } = setup();
    i.screenshotHotkey = 'Control+Shift+S';
    expect(await c.setOverlayToggleHotkey('Control+Shift+O')).toBeNull();
    expect([...registered.keys()].sort()).toEqual(['Control+Shift+O', 'Control+Shift+S']);
    expect(settings.get('overlay.toggleHotkey')).toBe('Control+Shift+O');

    invoked.length = 0;
    await registered.get('Control+Shift+O')!({ state: 'Pressed' });
    await vi.waitFor(() => expect(invoked.map(([cmd]) => cmd)).toContain('overlay_start'));
    // Release is ignored, and nothing but the overlay's own commands is called.
    invoked.length = 0;
    await registered.get('Control+Shift+O')!({ state: 'Released' });
    expect(invoked).toEqual([]);
  });

  it('puts the old binding back when the OS refuses the new one', async () => {
    const { c } = setup();
    expect(await c.setOverlayToggleHotkey('Control+Shift+O')).toBeNull();
    refuse = 'Control+Alt+O';
    const reason = await c.setOverlayToggleHotkey('Control+Alt+O');
    expect(reason).toMatch(/could not be registered/);
    expect(c.snapshot().overlay.toggleHotkey).toBe('Control+Shift+O');
    expect(registered.has('Control+Shift+O')).toBe(true);
  });

  it('clearing it unbinds it', async () => {
    const { c } = setup();
    await c.setOverlayToggleHotkey('Control+Shift+O');
    await c.setOverlayToggleHotkey(null);
    expect(registered.has('Control+Shift+O')).toBe(false);
  });
});

describe('switching the overlay off', () => {
  it('leaves Arrange mode first, so the window is never left interactive', async () => {
    const { c } = setup();
    await c.setOverlayOn(true);
    invoked.length = 0;
    await c.setOverlayOn(false);
    const cmds = invoked.map(([cmd]) => cmd);
    expect(cmds.indexOf('overlay_set_edit_mode')).toBeLessThan(cmds.indexOf('overlay_stop'));
    expect(c.overlayOn).toBe(false);
  });
});
