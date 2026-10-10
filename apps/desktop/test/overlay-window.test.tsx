/**
 * @vitest-environment jsdom
 *
 * The overlay window and its widget frame, mounted for real: dragging,
 * resizing, applying pushed layouts, sending changes back, and a failing
 * plugin widget not taking the overlay with it. Also the Overlay page's
 * preview, which uses the same components.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const listeners = new Map<string, (e: { payload: unknown }) => void>();
const emitted: Array<[string, unknown]> = [];
const invoked: Array<[string, unknown]> = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) => {
    invoked.push([cmd, args]);
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => {
    listeners.set(name, fn);
    return () => listeners.delete(name);
  }),
  emit: vi.fn(async (name: string, payload: unknown) => {
    emitted.push([name, payload]);
  }),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(), openPath: vi.fn(), revealItemInDir: vi.fn() }));

import { DEFAULT_LAYOUT, DEFAULT_WIDGET_OPTIONS, type OverlayLayout } from '../src/lib/overlayLayout';
import { DEFAULT_APPEARANCE, DEFAULT_WIDGETS, type OverlayPushState } from '../src/lib/overlay';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  listeners.clear();
  emitted.length = 0;
  invoked.length = 0;
  Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function pointer(target: Element, type: string, clientX: number, clientY: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY }));
}

function state(patch: Partial<OverlayPushState> = {}): OverlayPushState {
  return {
    commander: 'Sample',
    starSystem: 'Sol',
    station: null,
    body: null,
    docking: null,
    vehicle: null,
    jumpTarget: null,
    remainingJumps: null,
    context: null,
    alsoActive: [],
    carrierJumps: [],
    appearance: DEFAULT_APPEARANCE,
    guidance: 'standard',
    liveJournal: null,
    pluginRoute: null,
    pluginPanels: [],
    liveActivity: null,
    missions: { active: 0, cargo: 0, expiringSoon: 0, withoutDestination: 0, nextStop: null, rows: [], more: 0 },
    widgets: { ...DEFAULT_WIDGETS, missions: false },
    options: DEFAULT_WIDGET_OPTIONS,
    layout: DEFAULT_LAYOUT,
    layoutRevision: 1,
    ...patch,
  };
}

async function mountOverlay() {
  const { default: Overlay } = await import('../src/overlay/Overlay');
  root = createRoot(container);
  await act(async () => {
    root.render(<Overlay />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  const push = async (s: OverlayPushState) =>
    act(async () => {
      listeners.get('overlay://state')!({ payload: s });
    });
  const editMode = async (on: boolean) =>
    act(async () => {
      listeners.get('overlay://edit-mode')!({ payload: on });
    });
  const slot = (id: string) => container.querySelector(`[data-widget="${id}"]`) as HTMLElement | null;
  return { push, editMode, slot };
}

describe('the overlay window', () => {
  it('draws widgets where the pushed layout says, clamped on screen', async () => {
    const { push, slot } = await mountOverlay();
    const layout: OverlayLayout = {
      version: 3,
      viewport: null,
      widgets: { ...DEFAULT_LAYOUT.widgets, context: { x: 5000, y: 40, width: 300 } },
    };
    await push(state({ layout, layoutRevision: 2 }));
    expect(slot('context')!.style.left).toBe(`${1920 - 48}px`);
    expect(slot('context')!.style.width).toBe('300px');
  });

  it('ignores the mouse until Arrange mode, then drags and reports the result once', async () => {
    const { push, editMode, slot } = await mountOverlay();
    await push(state());
    const panel = () => slot('context')!.querySelector('.widget')!;

    // Normal play: a pointer does nothing.
    await act(async () => {
      pointer(panel(), 'pointerdown', 40, 40);
      pointer(panel(), 'pointermove', 400, 300);
      pointer(panel(), 'pointerup', 400, 300);
    });
    expect(slot('context')!.style.left).toBe('32px');
    expect(emitted).toEqual([]);
    expect(container.querySelector('.widget-resize')).toBeNull();

    await editMode(true);
    expect(container.textContent).toContain('Arranging');
    await act(async () => {
      pointer(panel(), 'pointerdown', 40, 40);
      pointer(panel(), 'pointermove', 140, 90);
    });
    expect(slot('context')!.style.left).toBe('132px');
    expect(emitted).toEqual([]); // nothing sent mid-drag
    await act(async () => {
      pointer(panel(), 'pointerup', 140, 90);
    });
    expect(emitted).toHaveLength(1);
    const [name, payload] = emitted[0]!;
    expect(name).toBe('overlay://layout');
    expect((payload as { layout: OverlayLayout }).layout.widgets['context']).toMatchObject({ x: 132, y: 82 });
  });

  it('resizes from the grip within limits', async () => {
    const { push, editMode, slot } = await mountOverlay();
    await push(state());
    await editMode(true);
    const grip = slot('context')!.querySelector('.widget-resize')!;
    // jsdom has no layout, so the starting width is the fallback.
    await act(async () => {
      pointer(grip, 'pointerdown', 300, 50);
      pointer(grip, 'pointermove', 5000, 50);
      pointer(grip, 'pointerup', 5000, 50);
    });
    expect(slot('context')!.style.width).toBe('720px');
    expect(slot('context')!.className).toContain('sized');
  });

  it('a push with the same revision does not undo what was just arranged', async () => {
    const { push, editMode, slot } = await mountOverlay();
    await push(state());
    await editMode(true);
    const panel = slot('context')!.querySelector('.widget')!;
    await act(async () => {
      pointer(panel, 'pointerdown', 40, 40);
      pointer(panel, 'pointermove', 240, 40);
      pointer(panel, 'pointerup', 240, 40);
    });
    await push(state()); // ordinary state push, old revision
    expect(slot('context')!.style.left).toBe('232px');
    await push(state({ layoutRevision: 9 })); // a reset from the main window
    expect(slot('context')!.style.left).toBe('32px');
  });

  it('Escape leaves Arrange mode through the backend, which restores click-through', async () => {
    const { push, editMode } = await mountOverlay();
    await push(state());
    await editMode(true);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(invoked).toContainEqual(['overlay_set_edit_mode', { editing: false }]);
  });

  it('a plugin widget that cannot be drawn blanks itself, not the overlay', async () => {
    const { push, slot } = await mountOverlay();
    await push(
      state({
        pluginPanels: [{ id: 'plugin:Broken', title: 'Broken', blocks: null as unknown as [] }],
      }),
    );
    expect(slot('plugin:Broken')!.textContent).toContain('This widget could not be shown.');
    expect(slot('context')).not.toBeNull();
  });

  it('applies scale and spacing from appearance', async () => {
    const { push } = await mountOverlay();
    await push(state({ appearance: { ...DEFAULT_APPEARANCE, scale: 1.25, spacing: 'compact' } }));
    const rootEl = container.querySelector('.overlay-root') as HTMLElement;
    expect(rootEl.style.getPropertyValue('--overlay-scale')).toBe('1.25');
    expect(rootEl.className).toContain('spacing-compact');
  });

  it('hides recorded entries when the commander only wants exobiology', async () => {
    const { push, slot } = await mountOverlay();
    const liveJournal = {
      title: 'Mission completed',
      detail: null,
      systemName: 'Sol',
      bodyName: null,
      occurredAt: new Date().toISOString(),
      hereCount: 1,
      sessionCount: 1,
    };
    await push(state({ widgets: { ...DEFAULT_WIDGETS, liveJournal: true }, liveJournal }));
    expect(slot('liveJournal')).not.toBeNull();
    await push(
      state({ widgets: { ...DEFAULT_WIDGETS, liveJournal: true }, liveJournal, options: { ...DEFAULT_WIDGET_OPTIONS, journalShowEntries: false } }),
    );
    expect(slot('liveJournal')).toBeNull();
  });
});

describe('the Overlay page preview', () => {
  it('shows the enabled widgets with sample data and the current appearance', async () => {
    const { OverlayPreview } = await import('../src/OverlayManager');
    const snap = {
      appearance: { backgroundOpacity: 0.3, textOpacity: 0.8, scale: 1.1, spacing: 'compact' },
      guidance: 'standard',
      overlay: { options: { ...DEFAULT_WIDGET_OPTIONS, routeDetail: 'compact' } },
      pythonPlugins: { overlays: {} },
    } as unknown as Parameters<typeof OverlayPreview>[0]['snap'];
    root = createRoot(container);
    await act(async () => {
      root.render(<OverlayPreview snap={snap} widgets={{ ...DEFAULT_WIDGETS, missions: false, route: true }} />);
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Sample data');
    expect(text).toContain('Current Context');
    expect(text).not.toContain('Missions'); // switched off
    // Compact route: next system and jumps, no waypoint count.
    expect(text).toContain('Sample Waypoint');
    expect(text).not.toContain('waypoint 3 of 9');
    const previewRoot = container.querySelector('.overlay-root') as HTMLElement;
    expect(previewRoot.style.getPropertyValue('--overlay-bg-opacity')).toBe('0.3');
    expect(previewRoot.style.getPropertyValue('--overlay-text-opacity')).toBe('0.8');
    expect(previewRoot.className).toContain('spacing-compact');
    // Nothing in the preview pretends to be the commander: the names say they are samples.
    expect(text).toContain('Sample Commander');
    expect(text).toContain('Sample System');
  });
});
