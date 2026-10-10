/**
 * Overlay control surface for the main window.
 *
 * The overlay is driven from here: the main window owns the journal engine and
 * pushes state across, so there is exactly one ingest pipeline.
 */

import { invoke } from '@tauri-apps/api/core';
import type { GuidanceMode } from '@edfm/context';
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
  actions: readonly string[];
  note: string | null;
  /** Beginner explanation. Sent always; drawn only in New CMDR mode. */
  guidance: string | null;
  resources: ReadonlyArray<{ label: string; url: string }>;
}

/** Which widgets the overlay should render. Owned by the main window, pushed here. */
export interface OverlayWidgets {
  context: boolean;
  missions: boolean;
  /**
   * Whether mission rows carry EDFM's editorial guidance.
   *
   * A sub-option of Missions, not a panel of its own -- it has no position, no
   * frame and nothing to drag. The settings UI disables it when Missions is off,
   * because a toggle that cannot do anything is worse than no toggle.
   */
  edfmNotes: boolean;
  /** Countdown to a scheduled jump on one of the commander's own carriers. */
  carrierJump: boolean;
  /**
   * Recent activity from the field journal.
   *
   * Off by default. Every other widget answers "what is true now"; this one is
   * the newest thing recorded, which is useful to some commanders and clutter to
   * others -- so it is opt-in rather than something to discover and turn off.
   */
  liveJournal: boolean;
  /** The route a plugin is following (Router), next waypoint first. */
  route: boolean;
  /**
   * Plugin overlay panels switched off, by plugin folder.
   *
   * A list of what is OFF rather than what is on, so a newly installed plugin's
   * panel shows without a trip to settings -- but only while that plugin is
   * running: a switched-off plugin registers nothing, so it has no panel.
   */
  pluginPanelsOff?: readonly string[];
}

/** A plugin's overlay widget as the overlay receives it: checked and display-only. */
export interface OverlayPluginPanel {
  /** `plugin:<key>`: the widget's id in the layout. */
  readonly id: string;
  readonly title: string;
  readonly blocks: readonly import('./pluginUi.js').UiBlock[];
}

export const DEFAULT_WIDGETS: OverlayWidgets = {
  context: true,
  missions: true,
  edfmNotes: true,
  carrierJump: true,
  liveJournal: false,
  route: true,
};

/**
 * Overlay appearance, as fractions rather than percentages.
 *
 * Background and text are separate on purpose. One control that dims both is the
 * thing that makes an overlay unreadable: a commander who wants a fainter panel
 * almost never wants fainter text.
 */
export interface OverlayAppearance {
  /** Panel background alpha. */
  readonly backgroundOpacity: number;
  /** Text and icon alpha. */
  readonly textOpacity: number;
  /**
   * Widget size, text included, as a multiple of the shipped size. Applied to
   * each widget's contents, so positions do not move when it changes.
   */
  readonly scale: number;
  /** `compact` tightens padding and line spacing; the text size is unchanged. */
  readonly spacing: 'comfortable' | 'compact';
}

/**
 * Bounds.
 *
 * Background may go to fully transparent -- text on bare game imagery is a real
 * preference, and the text keeps its own shadow.
 *
 * Text may not. Below roughly a third it stops being legible over bright
 * scenery, and an overlay the commander cannot read but has not noticed is
 * worse than one they turned off deliberately.
 */
export const APPEARANCE_BOUNDS = {
  background: { min: 0, max: 1 },
  text: { min: 0.35, max: 1 },
  /*
   * Below 80% the smallest labels drop under 9px at 1080p, which is not
   * readable over a game; above 150% a single widget covers a quarter of a
   * 1080p screen.
   */
  scale: { min: 0.8, max: 1.5 },
} as const;

/** Matches the styling that shipped before this was configurable. */
export const DEFAULT_APPEARANCE: OverlayAppearance = {
  backgroundOpacity: 0.72,
  textOpacity: 1,
  scale: 1,
  spacing: 'comfortable',
};

/* ---------------------------------------------------------------- status */

/**
 * The one line at the top of the Overlay page.
 *
 * Built from what is actually observed: the game window (found, minimised,
 * focused), Elite's own display-mode setting, and whether the overlay window
 * is really showing (reported by the tracking thread, not assumed from the
 * switch). `tone` is also carried in words, never colour alone.
 */
export interface OverlayStatus {
  readonly tone: 'ok' | 'warn' | 'off' | 'idle';
  readonly text: string;
}

export interface OverlayRuntime {
  /** The tracking thread is running (the overlay is switched on and started). */
  readonly running: boolean;
  /** The overlay window is currently shown over the game. */
  readonly visible: boolean;
  readonly editing: boolean;
}

function modeWords(mode: DisplayModeInfo | null): { name: string; supported: boolean | null } {
  if (mode === null || mode.mode === 'unknown') return { name: 'display mode unknown', supported: null };
  const name = mode.mode === 'borderless' ? 'Borderless' : mode.mode === 'windowed' ? 'Windowed' : 'Fullscreen';
  return { name, supported: mode.overlay_supported };
}

export function overlayStatus(input: {
  readonly enabled: boolean;
  readonly runtime: OverlayRuntime | null;
  readonly window: EliteWindowInfo | null;
  readonly mode: DisplayModeInfo | null;
  readonly hideWhenInactive: boolean;
}): OverlayStatus {
  const { name, supported } = modeWords(input.mode);
  const found = input.window?.found === true;

  if (!found) {
    const support =
      supported === true
        ? `${name} mode supported`
        : supported === false
          ? `${name} mode: switch to Borderless to see the overlay`
          : 'display mode not known yet';
    return { tone: input.enabled ? 'idle' : 'off', text: `Elite Dangerous offline — ${support}.` };
  }

  if (supported === false) {
    return { tone: 'warn', text: `Elite Dangerous running in ${name} — switch to Borderless to see the overlay.` };
  }
  const running = `Elite Dangerous running${supported === true ? ` (${name})` : ''}`;
  if (!input.enabled) return { tone: 'off', text: `${running} — overlay is off.` };
  if (input.runtime !== null && !input.runtime.running) {
    return { tone: 'warn', text: `${running} — the overlay did not start. Switch it off and on again.` };
  }
  if (input.window?.is_minimised) return { tone: 'idle', text: `${running} — game minimised, overlay hidden.` };
  if (input.runtime?.visible) return { tone: 'ok', text: `${running} — overlay showing.` };
  if (input.hideWhenInactive && input.window?.is_foreground === false) {
    return { tone: 'idle', text: `${running} — overlay hidden until Elite is the active window.` };
  }
  return { tone: 'idle', text: `${running} — waiting for the overlay to appear.` };
}

export function clampNumber(value: number, bounds: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return bounds.max;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/** Parse a stored setting, falling back rather than letting a bad row blank the overlay. */
export function clampOpacity(
  stored: string | null,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (stored === null) return fallback;
  const n = Number(stored);
  return Number.isFinite(n) ? clampNumber(n, bounds) : fallback;
}

/**
 * What the Live Journal widget shows.
 *
 * Deliberately one entry plus a count, not a history. The overlay answers "what
 * did I just record"; the Journal screen is where a commander reads back.
 */
export interface LiveJournalState {
  readonly title: string;
  readonly detail: string | null;
  readonly systemName: string | null;
  readonly bodyName: string | null;
  /** ISO 8601. The overlay decides for itself when this has gone stale. */
  readonly occurredAt: string;
  /** How many entries were recorded at this same body. */
  readonly hereCount: number;
  /** Total recorded since the app started, for the collapsed state. */
  readonly sessionCount: number;
}

/**
 * Live exobiology progress, as the overlay needs it.
 *
 * A projection rather than the tracker's own state: what crosses to the overlay
 * window should be exactly what is drawn, so the widget has no logic to get
 * wrong and no reason to reach for anything else.
 */
/** One genus on the body, as the widget draws it. */
export interface OverlayExobiologyRow {
  /** Always known, from the surface scan. */
  readonly genus: string;
  /** Known only once sampling starts; a scan reports no species. */
  readonly species: string | null;
  readonly colour: string | null;
  readonly status: 'unscanned' | 'sampling' | 'complete';
  readonly samplesTaken: number | null;
  readonly samplesRequired: number;
  /**
   * Base Vista Genomics value, abbreviated, once the species is known.
   *
   * Null on an unscanned row and that is not an omission: a surface scan gives a
   * genus, and a genus spans species worth anywhere from 1M to 19M. Showing a
   * figure before the species is known would be a guess with a number attached.
   */
  readonly value: string | null;
  /** Minimum metres between accepted samples, once the species is known. */
  readonly sampleDistance: number | null;
}

/**
 * Exobiology on the body the commander is at.
 *
 * The whole roster, not just the specimen in hand: a commander called away
 * mid-run should return and see exactly where they stopped, and one who has
 * finished should see that nothing is left.
 */
export interface OverlayLiveExobiology {
  readonly kind: 'exobiology';
  readonly bodyName: string | null;
  readonly rows: readonly OverlayExobiologyRow[];
  readonly completedCount: number;
  readonly unscannedCount: number;
  readonly total: number;
  /** ISO 8601 of the most recent change. */
  readonly updatedAt: string;
}

/**
 * What the commander is doing right now.
 *
 * A tagged union with one member today. Mining, colonisation delivery and
 * carrier operations can be added as further members; the widget switches on
 * `kind` and renders nothing for one it does not know, so an older overlay
 * cannot be broken by a newer state.
 */
export type OverlayLiveActivity = OverlayLiveExobiology;

/**
 * What the Live Journal widget should draw.
 *
 * A function rather than a condition inside the markup, because this is the
 * decision the whole change turns on and it deserves to be asserted directly:
 * **live progress wins over the newest recorded entry.**
 *
 * They answer different questions. `liveJournal` is "what did I last finish",
 * which is history and largely a restatement of Current Context; live activity is
 * "what am I in the middle of", which nothing else on screen says. Rendering the
 * first while the second exists is what made the widget redundant.
 *
 * Generic over the entry payload so the overlay window can pass its own declared
 * shape without this module and that one having to agree on it.
 */
export type LiveJournalPanel<J> =
  | { readonly kind: 'exobiology'; readonly live: OverlayLiveExobiology }
  | { readonly kind: 'entry'; readonly journal: J }
  | null;

/**
 * How long a completed run stays on screen when nothing else is pending.
 *
 * Kept for the recorded-entry panel. The exobiology roster no longer uses it:
 * it describes the body the commander is standing on rather than an event that
 * happened, so it is current for as long as they are there and disappears when
 * they leave. Staleness was the wrong model for it.
 */
export const LIVE_COMPLETION_VISIBLE_MS = 5 * 60 * 1000;

export function liveJournalPanel<J>(input: {
  readonly liveActivity: OverlayLiveActivity | null;
  readonly liveJournal: J | null;
  /** Unused by the exobiology roster; kept for the entry lifecycle. */
  readonly now?: number;
}): LiveJournalPanel<J> {
  const live = input.liveActivity;
  /*
   * Switched on `kind` so an unrecognised activity from a newer build falls
   * through to the entry rather than rendering an empty panel. An empty roster
   * also falls through: with no surface scan there is nothing to list, and a
   * blank panel would be worse than the recorded entry.
   */
  if (live !== null && live.kind === 'exobiology' && live.rows.length > 0) {
    return { kind: 'exobiology', live };
  }
  if (input.liveJournal !== null) return { kind: 'entry', journal: input.liveJournal };
  return null;
}

/**
 * The widget's heading, following its content.
 *
 * A panel headed "Field Journal" showing a sample counter describes itself
 * wrongly, and the overlay's other widgets all title themselves after what they
 * contain.
 */
export function liveJournalTitle<J>(panel: LiveJournalPanel<J>): string {
  return panel?.kind === 'exobiology' ? 'Exobiology' : 'Field Journal';
}

/** A scheduled jump for one of the commander's own carriers. */
export interface OverlayCarrierJump {
  carrierId: number;
  /** Human-readable name when known; the callsign otherwise. */
  name: string;
  system: string;
  body: string | null;
  /**
   * ISO 8601, exactly as the game stated it.
   *
   * Sent as an absolute instant rather than a pre-formatted duration, unlike
   * mission expiry. A countdown has to tick, and pushing a new string every second
   * to keep it moving would be absurd -- so the instant is the data and the
   * countdown is presentation, computed where it is drawn.
   */
  departureTime: string;
}

/**
 * Render a countdown to an absolute instant.
 *
 * Returns null past the point where a countdown is meaningful. The caller decides
 * what to say instead, because "departing" and "we lost track" are different
 * statements and neither is a number.
 */
export function countdownTo(departureTime: string, now: number): string | null {
  const target = Date.parse(departureTime);
  if (!Number.isFinite(target)) return null;

  const remainingMs = target - now;
  if (remainingMs <= 0) return null;

  const total = Math.floor(remainingMs / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export interface OverlayMissionRow {
  id: number;
  name: string;
  destination: string | null;
  /** Relative expiry, pre-formatted: the overlay has no clock of its own. */
  expiry: string | null;
  cargo: string | null;
  /**
   * The objective is done and only handing it in remains.
   *
   * Distinct from the mission being gone: a handed-in mission leaves the active
   * list and stops being sent at all, so this is only ever true for one that is
   * still outstanding.
   */
  awaitingTurnIn: boolean;
  /** EDFM's editorial note, already filtered by the edfmNotes setting. */
  note: string | null;
}

export interface OverlayMissions {
  active: number;
  cargo: number;
  expiringSoon: number;
  withoutDestination: number;
  /** The destination with the most missions bound for it, if any. */
  nextStop: {
    system: string;
    station: string | null;
    missions: number;
    cargo: number;
    cargoIncomplete: boolean;
    kills: number;
    expiry: string | null;
  } | null;
  /** Capped: an overlay that lists forty missions is not readable in flight. */
  rows: readonly OverlayMissionRow[];
  /** How many active missions are not in `rows`. */
  more: number;
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
  /**
   * Other contexts that are also true right now, title and subtitle only.
   *
   * The primary context gets links, actions and a note; these do not. Space over a
   * game window is scarce, and the point of these lines is awareness -- "there is
   * also a Material Trader here" -- not a second set of things to read.
   */
  alsoActive: { title: string; subtitle: string | null }[];
  carrierJumps: OverlayCarrierJump[];
  appearance: OverlayAppearance;
  /** Explanation level. Never changes which facts the overlay shows. */
  guidance: GuidanceMode;
  /** Newest recorded activity, or null. See the Live Journal widget. */
  liveJournal: LiveJournalState | null;
  /** A route published by a plugin, or null. */
  pluginRoute: import('./pythonPlugins.js').PluginRoute | null;
  /** Panels from running plugins that have something to show and are switched on. */
  pluginPanels: readonly OverlayPluginPanel[];
  /**
   * Operational progress right now, which takes precedence over `liveJournal`.
   *
   * These are different questions. `liveJournal` is "what did I last record",
   * which is history; this is "what am I in the middle of". Showing the first
   * while the second exists is what made the widget read as a duplicate of
   * Current Context.
   */
  liveActivity: OverlayLiveActivity | null;
  missions: OverlayMissions;
  widgets: OverlayWidgets;
  /** Per-widget presentation options. */
  options: import('./overlayLayout.js').OverlayWidgetOptions;
  /** Where widgets sit. Owned by the main window; see lib/overlayLayout.ts. */
  layout: import('./overlayLayout.js').OverlayLayout;
  /**
   * Bumped whenever the main window changes the layout (a reset, a preset, a
   * saved layout, or storing what the overlay sent). The overlay applies a
   * pushed layout only when this changes, so an ordinary state push during a
   * drag cannot snap the widget back.
   */
  layoutRevision: number;
}

/** What the overlay sends back when the commander moves or resizes a widget. */
export const LAYOUT_EVENT = 'overlay://layout';

export const overlayApi = {
  runtime: () => invoke<OverlayRuntime>('overlay_runtime'),
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
  try {
    void listen<T>(event, (e) => fn(e.payload))
      .then((f) => {
        if (disposed) f();
        else stop = f;
      })
      .catch(() => undefined);
  } catch {
    // No Tauri runtime (a plain browser): nothing will be emitted, and the page still renders.
  }
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

/** Subscribe to the overlay window actually being shown or hidden over the game. */
export function onOverlayRuntime(fn: (runtime: OverlayRuntime) => void): () => void {
  return subscribe<OverlayRuntime>('overlay://runtime', fn);
}
