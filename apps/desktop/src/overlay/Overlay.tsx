import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';

import {
  LAYOUT_EVENT,
  liveJournalPanel,
  liveJournalTitle,
  type OverlayPushState,
} from '../lib/overlay';
import {
  BUILT_IN_WIDGETS,
  DEFAULT_LAYOUT,
  DEFAULT_WIDGET_OPTIONS,
  placeWidget,
  pluginDefault,
  withPlacement,
  type OverlayLayout,
  type Viewport,
  type WidgetPlacement,
} from '../lib/overlayLayout';
import {
  CarrierJumpWidget,
  ContextWidget,
  LiveJournalPanelView,
  MissionsWidget,
  PluginWidgetBody,
  RouteWidget,
  WidgetFrame,
  type FrameHandlers,
} from './widgets';
import './widgets.css';
import './window.css';

/**
 * Overlay root.
 *
 * Each widget is independently positioned, sized and toggled. State arrives
 * by event from the main window, which owns the single journal engine and the
 * stored layout; running a second engine here would double every event.
 *
 * The layout is the main window's. The overlay draws it, and in Arrange mode
 * sends back what the commander moved; the main window stores it and pushes
 * it back with a new revision (see `layoutRevision` in lib/overlay.ts).
 */

/** Leave edit mode. The backend restores click-through and tells both windows. */
function exitEditMode(): void {
  void invoke('overlay_set_edit_mode', { editing: false }).catch(() => undefined);
}

function currentViewport(): Viewport {
  return { width: window.innerWidth || 1920, height: window.innerHeight || 1080 };
}

const BUILT_IN_DEFAULTS: Record<(typeof BUILT_IN_WIDGETS)[number], WidgetPlacement> = DEFAULT_LAYOUT.widgets as Record<
  (typeof BUILT_IN_WIDGETS)[number],
  WidgetPlacement
>;

export default function Overlay() {
  const [state, setState] = useState<OverlayPushState | null>(null);
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<OverlayLayout>(DEFAULT_LAYOUT);
  const [viewport, setViewport] = useState<Viewport>(currentViewport);
  const rootRef = useRef<HTMLDivElement>(null);
  const appliedRevision = useRef<number | null>(null);
  /** True while a widget is being dragged or resized: pushed layouts wait. */
  const gesturing = useRef(false);

  useEffect(() => {
    const subs = [
      listen<OverlayPushState>('overlay://state', (e) => setState(e.payload)),
      listen<boolean>('overlay://edit-mode', (e) => setEditing(e.payload)),
    ];
    return () => {
      void Promise.all(subs).then((fns) => fns.forEach((f) => f()));
    };
  }, []);

  // The window follows the game window, so its size is the game's: a change of
  // resolution or DPI arrives here as a resize, and positions are rescaled.
  useEffect(() => {
    const onResize = () => setViewport(currentViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // A layout the main window pushed: taken only when its revision is new.
  useEffect(() => {
    if (!state?.layout || gesturing.current) return;
    if (state.layoutRevision === appliedRevision.current) return;
    appliedRevision.current = state.layoutRevision;
    setLayout(state.layout);
  }, [state]);

  /*
   * Escape hatches from edit mode.
   *
   * Edit mode makes a fullscreen, always-on-top window interactive, which puts it
   * in front of the main window's own control. Without a way out from inside the
   * overlay the commander is locked out of the desktop, so there are two: Escape,
   * and the Done button in the banner.
   *
   * A blur handler was tried here and removed: entering edit mode calls set_focus
   * on the overlay, and the focus churn around that fired blur immediately, which
   * exited edit mode before the banner was ever usable.
   */
  useEffect(() => {
    if (!editing) return;
    rootRef.current?.focus(); // keydown needs the document to hold focus

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitEditMode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing]);

  const handlers: FrameHandlers = {
    onChange: useCallback(
      (id: string, placement: WidgetPlacement) => {
        gesturing.current = true;
        setLayout((prev) => withPlacement(prev, id, placement, currentViewport()));
      },
      [],
    ),
    onCommit: useCallback((id: string, placement: WidgetPlacement) => {
      gesturing.current = false;
      setLayout((prev) => {
        const next = withPlacement(prev, id, placement, currentViewport());
        void emit(LAYOUT_EVENT, { layout: next }).catch(() => undefined);
        return next;
      });
    }, []),
  };

  const widgets = state?.widgets;
  const options = state?.options ?? DEFAULT_WIDGET_OPTIONS;
  const panel = liveJournalPanel({
    liveActivity: state?.liveActivity ?? null,
    liveJournal: state?.liveJournal ?? null,
  });
  // Exobiology only, when the commander switched recorded entries off.
  const journalPanel = panel?.kind === 'entry' && !options.journalShowEntries ? null : panel;
  const appearance = state?.appearance;

  const place = (id: string, fallback: WidgetPlacement) => placeWidget(layout, id, viewport, fallback);
  const frame = { editing, handlers };

  return (
    <div
      ref={rootRef}
      className={`overlay-root${editing ? ' editing' : ''}${appearance?.spacing === 'compact' ? ' spacing-compact' : ''}`}
      /*
       * Appearance as custom properties, set once here. Every widget inherits
       * them, so a future widget is styled correctly by doing nothing.
       */
      style={
        {
          '--overlay-bg-opacity': String(appearance?.backgroundOpacity ?? 0.72),
          '--overlay-text-opacity': String(appearance?.textOpacity ?? 1),
          '--overlay-scale': String(appearance?.scale ?? 1),
        } as React.CSSProperties
      }
      // Focusable so Escape reaches the document while editing. -1 keeps it out of
      // the tab order, since the overlay is not a normal navigable surface.
      tabIndex={-1}
    >
      {editing && (
        <div className="edit-banner">
          <span>Arranging — drag to move, drag the right edge to resize.</span>
          <button type="button" className="edit-done" onClick={exitEditMode}>
            Done
          </button>
          <span className="edit-hint">or press Esc</span>
        </div>
      )}

      {(widgets?.context ?? true) && (
        <WidgetFrame id="context" title="Current Context" placement={place('context', BUILT_IN_DEFAULTS.context)} {...frame}>
          {state === null ? (
            <div className="row muted">Waiting for journal state…</div>
          ) : (
            <ContextWidget
              state={{ ...state, alsoActive: state.alsoActive ?? [], guidance: state.guidance }}
            />
          )}
        </WidgetFrame>
      )}

      {(widgets?.missions ?? true) && state !== null && (
        <WidgetFrame id="missions" title="Missions" placement={place('missions', BUILT_IN_DEFAULTS.missions)} {...frame}>
          <MissionsWidget missions={state.missions} />
        </WidgetFrame>
      )}

      {/*
        Live progress wins over the newest recorded entry, and the title follows
        the content: a panel headed "Field Journal" showing a sample counter
        describes itself wrongly. Opt-in, and only when there is something.
      */}
      {widgets?.liveJournal === true && journalPanel !== null && (
        <WidgetFrame
          id="liveJournal"
          title={liveJournalTitle(journalPanel)}
          placement={place('liveJournal', BUILT_IN_DEFAULTS.liveJournal)}
          {...frame}
        >
          <LiveJournalPanelView panel={journalPanel} showValues={options.exoShowValues} />
        </WidgetFrame>
      )}

      {/* Only while a jump is scheduled: an empty countdown is clutter over a game. */}
      {(widgets?.carrierJump ?? true) && state !== null && (state.carrierJumps?.length ?? 0) > 0 && (
        <WidgetFrame
          id="carrierJump"
          title="Carrier Jump"
          placement={place('carrierJump', BUILT_IN_DEFAULTS.carrierJump)}
          {...frame}
        >
          <CarrierJumpWidget jumps={state.carrierJumps} />
        </WidgetFrame>
      )}

      {(widgets?.route ?? true) && state?.pluginRoute && (
        <WidgetFrame id="route" title="Route" placement={place('route', BUILT_IN_DEFAULTS.route)} {...frame}>
          <RouteWidget route={state.pluginRoute} options={options} />
        </WidgetFrame>
      )}

      {/* Plugins' widgets. Display only: the overlay is click-through in play. */}
      {(state?.pluginPanels ?? []).map((p, i) => (
        <WidgetFrame key={p.id} id={p.id} title={p.title} placement={place(p.id, pluginDefault(i))} {...frame}>
          <PluginWidgetBody blocks={p.blocks} />
        </WidgetFrame>
      ))}
    </div>
  );
}
