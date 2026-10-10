/**
 * The overlay layout model, status line and hotkey conflicts: everything about
 * the Overlay Manager that can be checked without a window.
 */

import { describe, expect, it } from 'vitest';

import { hotkeyConflict } from '../src/lib/hotkeys';
import { overlayStatus, type DisplayModeInfo, type EliteWindowInfo } from '../src/lib/overlay';
import {
  DEFAULT_LAYOUT,
  DEFAULT_WIDGET_OPTIONS,
  LAYOUT_LIMITS,
  MAX_PROFILES,
  PRESETS,
  isCustomised,
  parseLayout,
  parseProfiles,
  parseWidgetOptions,
  placeWidget,
  presetLayout,
  resetLayout,
  saveProfile,
  withPlacement,
  type OverlayProfile,
} from '../src/lib/overlayLayout';

const FHD = { width: 1920, height: 1080 };
const fallback = { x: 0, y: 0, width: null };

describe('reading a stored layout', () => {
  it('migrates the old flat browser-storage shape, keeping every position', () => {
    // Verbatim shape of `edfm.overlay.layout.v2` as the overlay used to write it.
    const legacy = JSON.stringify({
      context: { x: 120, y: 48 },
      missions: { x: 40, y: 400 },
      'plugin:ConstructionLogistics': { x: 900, y: 60 },
    });
    const layout = parseLayout(legacy);
    expect(layout.version).toBe(3);
    expect(layout.viewport).toBeNull();
    expect(layout.widgets['context']).toEqual({ x: 120, y: 48, width: null });
    expect(layout.widgets['plugin:ConstructionLogistics']).toEqual({ x: 900, y: 60, width: null });
    // Widgets it never had keep the standard place.
    expect(layout.widgets['route']).toEqual(DEFAULT_LAYOUT.widgets['route']);
  });

  it('survives corrupt input, entry by entry', () => {
    expect(parseLayout('{not json')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout([1, 2])).toEqual(DEFAULT_LAYOUT);
    const layout = parseLayout({
      version: 3,
      viewport: { width: -5, height: 'x' },
      widgets: {
        context: { x: 'a', y: 1 },
        missions: { x: 10, y: 20, width: 99999 },
        route: { x: 1e9, y: 0 },
        '<script>': { x: 1, y: 1 },
      },
    });
    expect(layout.viewport).toBeNull();
    expect(layout.widgets['context']).toEqual(DEFAULT_LAYOUT.widgets['context']);
    expect(layout.widgets['missions']).toEqual({ x: 10, y: 20, width: LAYOUT_LIMITS.maxWidth });
    expect(layout.widgets['route']).toEqual(DEFAULT_LAYOUT.widgets['route']);
    expect(layout.widgets['<script>']).toBeUndefined();
  });
});

describe('placing widgets', () => {
  it('never puts a widget irretrievably off screen', () => {
    const layout = parseLayout({ version: 3, viewport: null, widgets: { context: { x: 5000, y: -300 } } });
    const p = placeWidget(layout, 'context', FHD, fallback);
    expect(p.x).toBe(FHD.width - LAYOUT_LIMITS.minVisible);
    expect(p.y).toBe(0);
  });

  it('rescales positions when the resolution or DPI changes', () => {
    const at4k = withPlacement(DEFAULT_LAYOUT, 'missions', { x: 3000, y: 1600, width: 320 }, { width: 3840, height: 2160 });
    const p = placeWidget(at4k, 'missions', FHD, fallback);
    expect(p).toEqual({ x: 1500, y: 800, width: 320 }); // width is kept, not scaled
    // 150% Windows scaling on a 1440p monitor: the CSS viewport is 1707 x 960.
    const scaled = placeWidget(at4k, 'missions', { width: 1707, height: 960 }, fallback);
    expect(scaled.x).toBeGreaterThan(0);
    expect(scaled.x).toBeLessThanOrEqual(1707 - LAYOUT_LIMITS.minVisible);
  });

  it('keeps one viewport for the whole layout when a widget moves', () => {
    const a = withPlacement(DEFAULT_LAYOUT, 'context', { x: 100, y: 100, width: null }, FHD);
    const b = withPlacement(a, 'route', { x: 200, y: 200, width: 400 }, { width: 3840, height: 2160 });
    expect(b.viewport).toEqual({ width: 3840, height: 2160 });
    // context was re-expressed at the new size, so it draws where it was.
    expect(placeWidget(b, 'context', FHD, fallback)).toEqual({ x: 100, y: 100, width: null });
  });

  it('resizing stays within sensible limits', () => {
    const narrow = withPlacement(DEFAULT_LAYOUT, 'missions', { x: 0, y: 0, width: 20 }, FHD);
    const wide = withPlacement(DEFAULT_LAYOUT, 'missions', { x: 0, y: 0, width: 5000 }, FHD);
    expect(narrow.widgets['missions']!.width).toBe(LAYOUT_LIMITS.minWidth);
    expect(wide.widgets['missions']!.width).toBe(LAYOUT_LIMITS.maxWidth);
  });
});

describe('Reset Layout', () => {
  it('restores standard positions and natural widths, plugin widgets included', () => {
    let layout = withPlacement(DEFAULT_LAYOUT, 'context', { x: 999, y: 999, width: 500 }, FHD);
    layout = withPlacement(layout, 'plugin:CL', { x: 10, y: 10, width: 300 }, FHD);
    expect(isCustomised(layout)).toBe(true);
    const reset = resetLayout(layout);
    expect(reset.widgets['context']).toEqual(DEFAULT_LAYOUT.widgets['context']);
    expect(reset.widgets['plugin:CL']).toEqual({ x: 690, y: 32, width: null });
    expect(isCustomised(reset)).toBe(false);
  });

  it('is not offered when nothing has been moved', () => {
    expect(isCustomised(DEFAULT_LAYOUT)).toBe(false);
  });
});

describe('presets', () => {
  it('has Minimal, Standard and Detailed', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['minimal', 'standard', 'detailed']);
  });

  it('Minimal shows less than Standard, which shows less than Detailed', () => {
    const count = (id: string) => Object.values(PRESETS.find((p) => p.id === id)!.visibility).filter(Boolean).length;
    expect(count('minimal')).toBeLessThan(count('standard'));
    expect(count('standard')).toBeLessThan(count('detailed'));
  });

  it('lay out for the real window and keep plugin widgets where they were', () => {
    const current = withPlacement(DEFAULT_LAYOUT, 'plugin:CL', { x: 700, y: 300, width: null }, FHD);
    const detailed = presetLayout(PRESETS[2]!, current, { width: 3840, height: 2160 });
    expect(detailed.viewport).toEqual({ width: 3840, height: 2160 });
    expect(detailed.widgets['carrierJump']!.x).toBe(3000); // 1500 at the 1920 reference
    expect(detailed.widgets['plugin:CL']).toEqual({ x: 1400, y: 600, width: null });
  });

  it('every preset position is on screen at 1080p', () => {
    for (const preset of PRESETS) {
      const layout = presetLayout(preset, DEFAULT_LAYOUT, FHD);
      for (const id of Object.keys(preset.positions)) {
        const p = placeWidget(layout, id, FHD, fallback);
        expect(p).toEqual(layout.widgets[id]);
      }
    }
  });
});

describe('widget options', () => {
  it('defaults, and clamps what it reads', () => {
    expect(parseWidgetOptions(null)).toEqual(DEFAULT_WIDGET_OPTIONS);
    const o = parseWidgetOptions({ missionRows: 99, routeDetail: 'weird', exoShowValues: 'yes' });
    expect(o.missionRows).toBe(10);
    expect(o.routeDetail).toBe('detailed');
    expect(o.exoShowValues).toBe(true);
    expect(parseWidgetOptions({ missionRows: 0 }).missionRows).toBe(1);
  });
});

describe('saved layouts', () => {
  const profile = (name: string): OverlayProfile => ({
    name,
    layout: DEFAULT_LAYOUT,
    visibility: { context: true, missions: true, edfmNotes: true, carrierJump: true, liveJournal: false, route: true },
    options: DEFAULT_WIDGET_OPTIONS,
    savedAt: '2026-10-10T00:00:00Z',
  });

  it('saves, replaces by name ignoring case, and refuses past the limit', () => {
    let list: OverlayProfile[] = [];
    for (let i = 0; i < MAX_PROFILES; i += 1) {
      const r = saveProfile(list, profile(`L${i}`));
      expect(r.ok).toBe(true);
      if (r.ok) list = r.profiles;
    }
    const replaced = saveProfile(list, { ...profile('l0'), savedAt: 'later' });
    expect(replaced.ok).toBe(true);
    if (replaced.ok) expect(replaced.profiles).toHaveLength(MAX_PROFILES);
    const over = saveProfile(list, profile('One too many'));
    expect(over.ok).toBe(false);
    expect(saveProfile([], profile('   ')).ok).toBe(false);
  });

  it('round-trips through storage, and skips broken entries', () => {
    const stored = JSON.stringify([profile('Exploring'), { name: 'Broken' }, profile('exploring'), 42]);
    const back = parseProfiles(stored);
    expect(back.map((p) => p.name)).toEqual(['Exploring']);
    expect(parseProfiles('nope')).toEqual([]);
  });
});

describe('the status line', () => {
  const borderless: DisplayModeInfo = { raw: 2, mode: 'borderless', overlay_supported: true, detail: '' };
  const fullscreen: DisplayModeInfo = { raw: 1, mode: 'fullscreen', overlay_supported: false, detail: '' };
  const win = (patch: Partial<EliteWindowInfo> = {}): EliteWindowInfo => ({
    found: true,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    dpi: 96,
    is_foreground: true,
    is_minimised: false,
    monitor_width: 1920,
    monitor_height: 1080,
    covers_monitor: true,
    ...patch,
  });
  const running = { running: true, visible: true, editing: false };

  it('says the game is offline, and whether the display mode will work', () => {
    expect(
      overlayStatus({ enabled: true, runtime: running, window: { ...win(), found: false }, mode: borderless, hideWhenInactive: true })
        .text,
    ).toBe('Elite Dangerous offline — Borderless mode supported.');
    expect(
      overlayStatus({ enabled: true, runtime: null, window: null, mode: fullscreen, hideWhenInactive: true }).text,
    ).toContain('switch to Borderless');
  });

  it('only says "showing" when the overlay window is really on screen', () => {
    const visible = overlayStatus({ enabled: true, runtime: running, window: win(), mode: borderless, hideWhenInactive: true });
    expect(visible).toEqual({ tone: 'ok', text: 'Elite Dangerous running (Borderless) — overlay showing.' });
    const notYet = overlayStatus({
      enabled: true,
      runtime: { ...running, visible: false },
      window: win({ is_foreground: false }),
      mode: borderless,
      hideWhenInactive: true,
    });
    expect(notYet.tone).not.toBe('ok');
    expect(notYet.text).toContain('until Elite is the active window');
  });

  it('distinguishes off, minimised, fullscreen and a failed start', () => {
    expect(overlayStatus({ enabled: false, runtime: null, window: win(), mode: borderless, hideWhenInactive: true }).text).toContain(
      'overlay is off',
    );
    expect(
      overlayStatus({ enabled: true, runtime: { ...running, visible: false }, window: win({ is_minimised: true }), mode: borderless, hideWhenInactive: true }).text,
    ).toContain('minimised');
    expect(overlayStatus({ enabled: true, runtime: running, window: win(), mode: fullscreen, hideWhenInactive: true }).tone).toBe('warn');
    expect(
      overlayStatus({ enabled: true, runtime: { running: false, visible: false, editing: false }, window: win(), mode: borderless, hideWhenInactive: true }).text,
    ).toContain('did not start');
  });
});

describe('hotkey conflicts', () => {
  const bindings = { screenshot: 'Control+Shift+S', routeCopy: 'Control+Shift+R', carrierCopy: null, overlayToggle: null };

  it('names the hotkey that already has the combination, ignoring case', () => {
    expect(hotkeyConflict(bindings, 'overlayToggle', 'control+shift+s')).toBe('That combination already captures screenshots.');
    expect(hotkeyConflict(bindings, 'overlayToggle', 'Control+Shift+R')).toBe('That combination already copies your next waypoint.');
    expect(hotkeyConflict(bindings, 'overlayToggle', 'Control+Shift+O')).toBeNull();
  });

  it('a hotkey does not conflict with itself', () => {
    expect(hotkeyConflict(bindings, 'screenshot', 'Control+Shift+S')).toBeNull();
  });
});
