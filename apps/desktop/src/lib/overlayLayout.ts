/**
 * Where overlay widgets sit, how wide they are, and the named arrangements a
 * commander can switch between.
 *
 * Pure, so it can be tested without a window. The main window owns the layout
 * (stored in the settings table with every other overlay setting) and pushes
 * it to the overlay with the rest of its state; the overlay sends back what
 * the commander changes in Arrange mode.
 *
 * ## Coordinates
 *
 * CSS pixels inside the overlay window, which is sized to the game window. A
 * layout also remembers the size of the window it was arranged in
 * (`viewport`), so when the game moves to a different resolution or DPI the
 * positions are scaled to the new size rather than left where they no longer
 * fit. Width is not scaled: a widget stays as readable as it was.
 *
 * Whatever is stored, a widget is always drawn at least partly on screen
 * (`placeWidget`), so a corrupt or out-of-range layout cannot lose one.
 */

/** Where one widget sits. `width` null means "as wide as its content needs". */
export interface WidgetPlacement {
  readonly x: number;
  readonly y: number;
  readonly width: number | null;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface OverlayLayout {
  readonly version: 3;
  /** The overlay window size the positions were set in; null for a layout from before this was kept. */
  readonly viewport: Viewport | null;
  readonly widgets: Readonly<Record<string, WidgetPlacement>>;
}

export const LAYOUT_LIMITS = {
  /** Narrow enough for a corner, wide enough for a mission name. */
  minWidth: 200,
  maxWidth: 720,
  /** How much of a widget must stay on screen, in each direction. */
  minVisible: 48,
  /** Stored coordinates beyond this are corrupt, not a big monitor. */
  maxCoordinate: 20000,
} as const;

/** The widgets the overlay draws itself. Plugin widgets are `plugin:<key>`. */
export const BUILT_IN_WIDGETS = ['context', 'missions', 'carrierJump', 'route', 'liveJournal'] as const;
export type BuiltInWidget = (typeof BUILT_IN_WIDGETS)[number];

/** Layouts in presets are written for this window size and scaled from it. */
const REFERENCE: Viewport = { width: 1920, height: 1080 };

/**
 * The arrangement that shipped before layouts were configurable, in the same
 * pixels: what Reset Layout returns to.
 */
const STANDARD_POSITIONS: Readonly<Record<BuiltInWidget, WidgetPlacement>> = {
  context: { x: 32, y: 32, width: null },
  missions: { x: 32, y: 260, width: null },
  carrierJump: { x: 32, y: 520, width: null },
  liveJournal: { x: 360, y: 32, width: null },
  route: { x: 360, y: 260, width: null },
};

/** Where a plugin widget opens before it has been moved: a column to the right. */
export function pluginDefault(index: number): WidgetPlacement {
  return { x: 690, y: 32 + index * 240, width: null };
}

export const DEFAULT_LAYOUT: OverlayLayout = {
  version: 3,
  viewport: null,
  widgets: STANDARD_POSITIONS,
};

/* ------------------------------------------------------------- reading */

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function readPlacement(v: unknown): WidgetPlacement | null {
  if (v === null || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (!finite(p['x']) || !finite(p['y'])) return null;
  const lim = LAYOUT_LIMITS.maxCoordinate;
  if (Math.abs(p['x']) > lim || Math.abs(p['y']) > lim) return null;
  const width = finite(p['width'])
    ? Math.min(LAYOUT_LIMITS.maxWidth, Math.max(LAYOUT_LIMITS.minWidth, Math.round(p['width'])))
    : null;
  return { x: Math.round(p['x']), y: Math.round(p['y']), width };
}

function readViewport(v: unknown): Viewport | null {
  if (v === null || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  return finite(p['width']) && finite(p['height']) && p['width'] > 0 && p['height'] > 0
    ? { width: p['width'], height: p['height'] }
    : null;
}

/** Widget ids are built-in names or `plugin:<key>`; anything else is dropped. */
const WIDGET_ID = /^(context|missions|carrierJump|route|liveJournal|plugin:[A-Za-z0-9_.\-:]{1,120})$/;

/**
 * Read a stored layout, of either shape.
 *
 * Version 3 is `{ version, viewport, widgets }`. Before that the overlay kept a
 * flat `{ id: { x, y } }` in its own browser storage (`edfm.overlay.layout.v2`);
 * that is read too, so a commander's arrangement survives the move. Anything
 * unusable falls back to the standard positions, per widget: one bad entry
 * does not cost the others.
 */
export function parseLayout(raw: unknown): OverlayLayout {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return DEFAULT_LAYOUT;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_LAYOUT;
  const obj = value as Record<string, unknown>;
  const isV3 = obj['version'] === 3 && obj['widgets'] !== null && typeof obj['widgets'] === 'object';
  const source = (isV3 ? obj['widgets'] : obj) as Record<string, unknown>;

  const widgets: Record<string, WidgetPlacement> = { ...STANDARD_POSITIONS };
  for (const [id, placement] of Object.entries(source)) {
    if (!WIDGET_ID.test(id)) continue;
    const p = readPlacement(placement);
    if (p) widgets[id] = p;
  }
  return { version: 3, viewport: isV3 ? readViewport(obj['viewport']) : null, widgets };
}

/* ----------------------------------------------------------- placing */

/**
 * Where to draw a widget in a window of this size.
 *
 * Scaled from the size the layout was arranged in, then clamped so at least
 * `minVisible` pixels of it stay on screen. Never written back: a commander
 * who plays at two resolutions keeps one layout that fits both.
 */
export function placeWidget(
  layout: OverlayLayout,
  id: string,
  viewport: Viewport,
  fallback: WidgetPlacement,
): WidgetPlacement {
  const stored = layout.widgets[id] ?? fallback;
  const from = layout.viewport;
  const sx = from ? viewport.width / from.width : 1;
  const sy = from ? viewport.height / from.height : 1;
  return clampPlacement({ x: stored.x * sx, y: stored.y * sy, width: stored.width }, viewport);
}

export function clampPlacement(p: WidgetPlacement, viewport: Viewport): WidgetPlacement {
  const v = LAYOUT_LIMITS.minVisible;
  const width =
    p.width === null
      ? null
      : Math.round(Math.min(LAYOUT_LIMITS.maxWidth, Math.max(LAYOUT_LIMITS.minWidth, Math.min(p.width, viewport.width))));
  return {
    x: Math.round(Math.max(0, Math.min(viewport.width - v, p.x))),
    y: Math.round(Math.max(0, Math.min(viewport.height - v, p.y))),
    width,
  };
}

/**
 * A layout with one widget moved or resized, in the current window.
 *
 * Every stored position is first re-expressed in the current window's size,
 * so the layout keeps a single `viewport` that all its positions agree with.
 */
export function withPlacement(
  layout: OverlayLayout,
  id: string,
  placement: WidgetPlacement,
  viewport: Viewport,
): OverlayLayout {
  const from = layout.viewport;
  const sx = from ? viewport.width / from.width : 1;
  const sy = from ? viewport.height / from.height : 1;
  const widgets: Record<string, WidgetPlacement> = {};
  for (const [key, p] of Object.entries(layout.widgets)) {
    widgets[key] = { x: Math.round(p.x * sx), y: Math.round(p.y * sy), width: p.width };
  }
  widgets[id] = clampPlacement(placement, viewport);
  return { version: 3, viewport: { width: viewport.width, height: viewport.height }, widgets };
}

/** Same layout? Used to skip a save, and a re-render, that would change nothing. */
export function sameLayout(a: OverlayLayout, b: OverlayLayout): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The standard positions and natural widths, for every widget the layout
 * knows, plugin ones included. Visibility and every other setting are
 * untouched: Reset Layout is about where things are, nothing else.
 */
export function resetLayout(layout: OverlayLayout, pluginIds: readonly string[] = []): OverlayLayout {
  const widgets: Record<string, WidgetPlacement> = { ...STANDARD_POSITIONS };
  const plugins = [...new Set([...Object.keys(layout.widgets).filter((k) => k.startsWith('plugin:')), ...pluginIds])];
  plugins.forEach((id, i) => {
    widgets[id] = pluginDefault(i);
  });
  return { version: 3, viewport: null, widgets };
}

/** Whether a layout differs from what Reset would give, so Reset can ask first. */
export function isCustomised(layout: OverlayLayout): boolean {
  const reset = resetLayout(layout).widgets;
  const ids = new Set([...Object.keys(layout.widgets), ...Object.keys(reset)]);
  for (const id of ids) {
    const a = layout.widgets[id];
    const b = reset[id];
    if (!a || !b || a.x !== b.x || a.y !== b.y || a.width !== b.width) return true;
  }
  return false;
}

/* ------------------------------------------------------------- options */

/** Per-widget presentation options. Each one changes what the overlay draws. */
export interface OverlayWidgetOptions {
  /** Mission rows listed, soonest to expire first. */
  readonly missionRows: number;
  /** `compact`: the next system and jumps left, nothing else. */
  readonly routeDetail: 'detailed' | 'compact';
  readonly routeShowDestination: boolean;
  readonly routeShowWaypoints: boolean;
  /**
   * Which plugin's route to show when more than one publishes one, by plugin
   * folder. Null follows whichever changed most recently.
   */
  readonly routeSource: string | null;
  /** Show the newest recorded entry when not at a scanned body. Off: exobiology only. */
  readonly journalShowEntries: boolean;
  /** Base value and sample distance under each identified organism. */
  readonly exoShowValues: boolean;
}

export const MISSION_ROWS_BOUNDS = { min: 1, max: 10 } as const;

export const DEFAULT_WIDGET_OPTIONS: OverlayWidgetOptions = {
  missionRows: 5,
  routeDetail: 'detailed',
  routeShowDestination: true,
  routeShowWaypoints: true,
  routeSource: null,
  journalShowEntries: true,
  exoShowValues: true,
};

export function parseWidgetOptions(raw: unknown): OverlayWidgetOptions {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return DEFAULT_WIDGET_OPTIONS;
    }
  }
  if (value === null || typeof value !== 'object') return DEFAULT_WIDGET_OPTIONS;
  const o = value as Record<string, unknown>;
  const d = DEFAULT_WIDGET_OPTIONS;
  const bool = (k: keyof OverlayWidgetOptions, fallback: boolean) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : fallback);
  return {
    missionRows: finite(o['missionRows'])
      ? Math.min(MISSION_ROWS_BOUNDS.max, Math.max(MISSION_ROWS_BOUNDS.min, Math.round(o['missionRows'])))
      : d.missionRows,
    routeDetail: o['routeDetail'] === 'compact' ? 'compact' : 'detailed',
    routeShowDestination: bool('routeShowDestination', d.routeShowDestination),
    routeShowWaypoints: bool('routeShowWaypoints', d.routeShowWaypoints),
    routeSource: typeof o['routeSource'] === 'string' && o['routeSource'].length <= 200 ? o['routeSource'] : null,
    journalShowEntries: bool('journalShowEntries', d.journalShowEntries),
    exoShowValues: bool('exoShowValues', d.exoShowValues),
  };
}

/* ------------------------------------------------------------- presets */

/** Which built-in widgets are on. Mirrors `OverlayWidgets` without the plugin list. */
export interface WidgetVisibility {
  readonly context: boolean;
  readonly missions: boolean;
  readonly edfmNotes: boolean;
  readonly carrierJump: boolean;
  readonly liveJournal: boolean;
  readonly route: boolean;
}

export type PresetId = 'minimal' | 'standard' | 'detailed';

export interface LayoutPreset {
  readonly id: PresetId;
  readonly label: string;
  readonly description: string;
  readonly visibility: WidgetVisibility;
  readonly options: Partial<OverlayWidgetOptions>;
  /** At the 1920 x 1080 reference size; scaled to the real window. */
  readonly positions: Readonly<Record<BuiltInWidget, WidgetPlacement>>;
}

export const PRESETS: readonly LayoutPreset[] = [
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Where you are and what matters here, plus a carrier countdown.',
    visibility: { context: true, missions: false, edfmNotes: false, carrierJump: true, liveJournal: false, route: true },
    options: { routeDetail: 'compact', missionRows: 3 },
    positions: {
      context: { x: 24, y: 24, width: 260 },
      route: { x: 24, y: 300, width: 260 },
      carrierJump: { x: 24, y: 400, width: 260 },
      missions: { x: 24, y: 520, width: null },
      liveJournal: { x: 300, y: 24, width: null },
    },
  },
  {
    id: 'standard',
    label: 'Standard',
    description: 'Context, missions, route and carrier, in two columns on the left.',
    visibility: { context: true, missions: true, edfmNotes: true, carrierJump: true, liveJournal: false, route: true },
    options: { routeDetail: 'detailed', missionRows: 5 },
    positions: STANDARD_POSITIONS,
  },
  {
    id: 'detailed',
    label: 'Detailed',
    description: 'Everything, with wider panels and more missions listed.',
    visibility: { context: true, missions: true, edfmNotes: true, carrierJump: true, liveJournal: true, route: true },
    options: { routeDetail: 'detailed', missionRows: 8, journalShowEntries: true, exoShowValues: true },
    positions: {
      context: { x: 32, y: 32, width: 360 },
      missions: { x: 32, y: 330, width: 400 },
      carrierJump: { x: 1500, y: 32, width: 300 },
      route: { x: 1500, y: 150, width: 360 },
      liveJournal: { x: 1500, y: 320, width: 360 },
    },
  },
];

/**
 * A preset's layout. Plugin widgets keep the positions they had: a preset is
 * about the built-in panels, and has no opinion on a plugin it has never heard of.
 */
export function presetLayout(preset: LayoutPreset, current: OverlayLayout, viewport: Viewport | null): OverlayLayout {
  const to = viewport ?? REFERENCE;
  const sx = to.width / REFERENCE.width;
  const sy = to.height / REFERENCE.height;
  const from = current.viewport;
  const px = from ? to.width / from.width : 1;
  const py = from ? to.height / from.height : 1;
  const widgets: Record<string, WidgetPlacement> = {};
  for (const [id, p] of Object.entries(current.widgets)) {
    if (id.startsWith('plugin:')) widgets[id] = { x: Math.round(p.x * px), y: Math.round(p.y * py), width: p.width };
  }
  for (const id of BUILT_IN_WIDGETS) {
    const p = preset.positions[id];
    widgets[id] = { x: Math.round(p.x * sx), y: Math.round(p.y * sy), width: p.width };
  }
  return { version: 3, viewport: { width: to.width, height: to.height }, widgets };
}

/* ------------------------------------------------------------ profiles */

/** A commander's own saved arrangement: positions, which widgets are on, and their options. */
export interface OverlayProfile {
  readonly name: string;
  readonly layout: OverlayLayout;
  readonly visibility: WidgetVisibility;
  readonly options: OverlayWidgetOptions;
  readonly savedAt: string;
}

export const MAX_PROFILES = 10;
export const MAX_PROFILE_NAME = 40;

function readVisibility(v: unknown): WidgetVisibility | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const keys: (keyof WidgetVisibility)[] = ['context', 'missions', 'edfmNotes', 'carrierJump', 'liveJournal', 'route'];
  if (!keys.every((k) => typeof o[k] === 'boolean')) return null;
  return Object.fromEntries(keys.map((k) => [k, o[k]])) as unknown as WidgetVisibility;
}

export function parseProfiles(raw: unknown): OverlayProfile[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: OverlayProfile[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = typeof o['name'] === 'string' ? o['name'].trim().slice(0, MAX_PROFILE_NAME) : '';
    const visibility = readVisibility(o['visibility']);
    if (!name || !visibility || out.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({
      name,
      layout: parseLayout(o['layout']),
      visibility,
      options: parseWidgetOptions(o['options']),
      savedAt: typeof o['savedAt'] === 'string' ? o['savedAt'] : '',
    });
    if (out.length >= MAX_PROFILES) break;
  }
  return out;
}

/**
 * Save (or overwrite, by name, ignoring case) a profile.
 * Returns the new list, or a reason it could not be saved.
 */
export function saveProfile(
  profiles: readonly OverlayProfile[],
  profile: OverlayProfile,
): { ok: true; profiles: OverlayProfile[] } | { ok: false; reason: string } {
  const name = profile.name.trim();
  if (!name) return { ok: false, reason: 'Give the layout a name.' };
  if (name.length > MAX_PROFILE_NAME) return { ok: false, reason: `Names are up to ${MAX_PROFILE_NAME} characters.` };
  const rest = profiles.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
  if (rest.length >= MAX_PROFILES) return { ok: false, reason: `Up to ${MAX_PROFILES} saved layouts. Delete one first.` };
  return { ok: true, profiles: [...rest, { ...profile, name }].sort((a, b) => a.name.localeCompare(b.name)) };
}
