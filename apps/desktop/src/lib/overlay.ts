/**
 * Overlay control surface for the main window.
 *
 * The overlay is driven from here: the main window owns the journal engine and
 * pushes state across, so there is exactly one ingest pipeline.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface EliteWindowInfo {
  found: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  dpi: number;
  is_foreground: boolean;
  is_minimised: boolean;
  monitor_width: number;
  monitor_height: number;
  covers_monitor: boolean;
}

export interface DisplayModeInfo {
  /** Raw `<FullScreen>` value from Elite's own settings; null when unreadable. */
  raw: number | null;
  mode: 'windowed' | 'fullscreen' | 'borderless' | 'unknown';
  /**
   * Whether a non-injecting overlay can be expected to draw over this mode.
   * `null` means we genuinely do not know — not "probably fine".
   */
  overlay_supported: boolean | null;
  detail: string;
}

export interface OverlayContext {
  title: string;
  subtitle: string | null;
  resources: ReadonlyArray<{ label: string; url: string }>;
}

export interface OverlayPushState {
  commander: string | null;
  starSystem: string | null;
  station: string | null;
  body: string | null;
  docking: string | null;
  vehicle: string | null;
  /** Destination system while travelling; null when not on a route. */
  jumpTarget: string | null;
  /** Jumps left in the plotted route; null when no route is plotted. */
  remainingJumps: number | null;
  /** Highest-ranked context only; null when nothing is currently relevant. */
  context: OverlayContext | null;
}

export const overlayApi = {
  eliteWindow: () => invoke<EliteWindowInfo>('elite_window_info'),
  displayMode: () => invoke<DisplayModeInfo>('elite_display_mode'),
  start: (hideWhenInactive: boolean) =>
    invoke<void>('overlay_start', { hideWhenInactive }),
  stop: () => invoke<void>('overlay_stop'),
  setEditMode: (editing: boolean) => invoke<void>('overlay_set_edit_mode', { editing }),
  pushState: (payload: OverlayPushState) => invoke<void>('overlay_push_state', { payload }),
};

function subscribe<T>(event: string, fn: (payload: T) => void): () => void {
  let stop: (() => void) | null = null;
  let disposed = false;
  void listen<T>(event, (e) => fn(e.payload)).then((f) => {
    if (disposed) f();
    else stop = f;
  });
  return () => {
    disposed = true;
    stop?.();
  };
}

/** Subscribe to game-window updates emitted by the tracking thread. */
export function onEliteWindow(fn: (info: EliteWindowInfo) => void): () => void {
  return subscribe<EliteWindowInfo>('overlay://elite-window', fn);
}

/**
 * Subscribe to edit-mode changes.
 *
 * Edit mode can be ended from inside the overlay, so any UI showing it must
 * follow this rather than tracking its own copy.
 */
export function onEditMode(fn: (editing: boolean) => void): () => void {
  return subscribe<boolean>('overlay://edit-mode', fn);
}
