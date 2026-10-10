/**
 * The overlay's widgets, as presentation components.
 *
 * Used by the overlay window and by the preview on the Overlay page, so the
 * preview is the real widget with sample data rather than a second drawing
 * that slowly stops matching. Everything here renders what it is given: no
 * Tauri calls, no state of its own beyond a clock where one is needed.
 */

import { Component, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  countdownTo,
  type LiveJournalPanel,
  type LiveJournalState,
  type OverlayCarrierJump,
  type OverlayContext,
  type OverlayLiveExobiology,
  type OverlayMissions,
} from '../lib/overlay';
import type { OverlayWidgetOptions, WidgetPlacement } from '../lib/overlayLayout';
import type { UiBlock } from '../lib/pluginUi';
import type { PluginRoute } from '../lib/pythonPlugins';
import { PluginBlocks } from '../PluginUi';

/* ---------------------------------------------------------------- frame */

export interface FrameHandlers {
  /** While dragging or resizing: the placement to draw now. */
  readonly onChange: (id: string, placement: WidgetPlacement) => void;
  /** Pointer released: the placement to keep. */
  readonly onCommit: (id: string, placement: WidgetPlacement) => void;
}

/**
 * A positioned, titled widget. In Arrange mode it can be dragged by any part
 * and resized from the grip on its right edge; otherwise it ignores the
 * pointer entirely (the overlay is click-through in play).
 */
export function WidgetFrame({
  id,
  title,
  placement,
  editing = false,
  handlers,
  children,
}: {
  id: string;
  title: string;
  placement: WidgetPlacement | null;
  editing?: boolean;
  handlers?: FrameHandlers;
  children: ReactNode;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const gesture = useRef<
    | { kind: 'move'; dx: number; dy: number; last: WidgetPlacement }
    | { kind: 'resize'; startX: number; startWidth: number; last: WidgetPlacement }
    | null
  >(null);

  const active = editing && handlers !== undefined && placement !== null;

  function begin(e: React.PointerEvent, kind: 'move' | 'resize') {
    if (!active || !placement) return;
    e.stopPropagation();
    if (kind === 'move') {
      gesture.current = { kind, dx: e.clientX - placement.x, dy: e.clientY - placement.y, last: placement };
    } else {
      const width = slot.current?.getBoundingClientRect().width ?? placement.width ?? 260;
      gesture.current = { kind, startX: e.clientX, startWidth: width, last: placement };
    }
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function update(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g || !placement || !handlers) return;
    const next: WidgetPlacement =
      g.kind === 'move'
        ? { x: e.clientX - g.dx, y: e.clientY - g.dy, width: placement.width }
        : { ...placement, width: Math.round(g.startWidth + (e.clientX - g.startX)) };
    g.last = next;
    handlers.onChange(id, next);
  }

  function end(e: React.PointerEvent) {
    const g = gesture.current;
    gesture.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (g && handlers) handlers.onCommit(id, g.last);
  }

  const style: React.CSSProperties =
    placement === null
      ? {}
      : { left: placement.x, top: placement.y, ...(placement.width !== null ? { width: placement.width } : {}) };

  return (
    <div
      ref={slot}
      className={`widget-slot${placement?.width != null ? ' sized' : ''}`}
      style={placement === null ? { position: 'static' } : style}
      data-widget={id}
    >
      <div
        className="widget"
        onPointerDown={(e) => begin(e, 'move')}
        onPointerMove={update}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <div className="widget-title">
          <span className="dot" aria-hidden="true">
            ◆
          </span>
          {title}
        </div>
        {children}
      </div>
      {active && (
        <>
          <div
            className="widget-resize"
            role="separator"
            aria-label={`Resize ${title}`}
            onPointerDown={(e) => begin(e, 'resize')}
            onPointerMove={update}
            onPointerUp={end}
            onPointerCancel={end}
          />
          {placement?.width != null && <div className="widget-size">{placement.width} px</div>}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- context */

export interface ContextView {
  readonly commander: string | null;
  readonly starSystem: string | null;
  readonly station: string | null;
  readonly body: string | null;
  readonly jumpTarget: string | null;
  readonly remainingJumps: number | null;
  readonly context: OverlayContext | null;
  readonly alsoActive: ReadonlyArray<{ title: string; subtitle: string | null }>;
  readonly guidance: 'standard' | 'new-cmdr';
}

export function ContextWidget({ state }: { state: ContextView }) {
  return (
    <>
      <Row label="CMDR" value={state.commander} />
      <Row label="System" value={state.starSystem} />
      {/* Body is sent as null when it merely repeats the station. */}
      {state.body && <Row label="Body" value={state.body} />}
      <Row label="Station" value={state.station} />
      {state.jumpTarget && (
        <Row
          label="Next jump"
          value={state.jumpTarget}
          nav
          meta={state.remainingJumps !== null ? `${state.remainingJumps} left` : null}
        />
      )}

      {state.context && (
        <div className="context">
          <div className="context-title">{state.context.title}</div>
          {state.context.subtitle && <div className="context-sub">{state.context.subtitle}</div>}
          {/*
            Beginner explanation. Same facts as Standard mode, with a sentence
            saying what the mechanic is -- never an article; the depth stays on EDFM.
          */}
          {state.guidance === 'new-cmdr' && state.context.guidance && (
            <div className="context-guidance">{state.context.guidance}</div>
          )}
          {state.context.actions.length > 0 && (
            <ul className="context-actions">
              {state.context.actions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
          {state.context.resources.length > 0 && (
            <div className="context-links">
              {/*
                Labels only, not clickable. The overlay is click-through in normal
                play, so a link here could never be followed.
              */}
              {state.context.resources.map((r) => (
                <span key={r.url} className="context-link">
                  {r.label}
                </span>
              ))}
            </div>
          )}
          {state.alsoActive.length > 0 && (
            <ul className="context-also">
              {state.alsoActive.map((c) => (
                <li key={c.title}>
                  <span className="context-also-title">
                    <span className="context-also-mark" aria-hidden="true">
                      &#9670;
                    </span>
                    {c.title}
                  </span>
                  {c.subtitle && <span className="context-also-sub">{c.subtitle}</span>}
                </li>
              ))}
            </ul>
          )}
          {state.context.note && (
            <div className="context-note">
              <span className="note-label">EDFM</span>
              {state.context.note}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function Row({
  label,
  value,
  meta,
  nav,
}: {
  label: string;
  value: string | null;
  /** Subordinate detail after the value, e.g. "3 left". */
  meta?: string | null;
  /** Marks a row that describes where the commander is *going*, not where they are. */
  nav?: boolean;
}) {
  return (
    <div className={nav ? 'row row-nav' : 'row'}>
      <span className="row-label">{label}</span>
      {/* Unknown stays visibly Unknown here too — the overlay must not imply
          knowledge the journal did not provide. */}
      <span className={value ? 'row-value' : 'row-value unknown'}>
        {/* A glyph as well as a colour: the distinction must survive a display
            where the accent is hard to pick out. */}
        {nav && value && (
          <span className="row-nav-glyph" aria-hidden="true">
            &#9656;
          </span>
        )}
        {value ?? 'Unknown'}
        {meta && <span className="row-meta">{meta}</span>}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------- missions */

export function MissionsWidget({ missions }: { missions: OverlayMissions }) {
  if (missions.active === 0) {
    return <div className="row muted">No active missions</div>;
  }

  return (
    <>
      <div className="mission-summary">
        <span>
          <strong>{missions.active}</strong> active
        </span>
        {missions.cargo > 0 && (
          <span>
            <strong>{missions.cargo}</strong> t cargo
          </span>
        )}
        {missions.expiringSoon > 0 && (
          <span className="urgent">
            <strong>{missions.expiringSoon}</strong> expiring
          </span>
        )}
      </div>

      {missions.nextStop && (
        <div className="next-stop">
          <div className="next-stop-label">Most missions at</div>
          <div className="next-stop-where">
            {missions.nextStop.system}
            {missions.nextStop.station ? ` · ${missions.nextStop.station}` : ''}
          </div>
          <div className="next-stop-meta">
            {missions.nextStop.missions} missions
            {missions.nextStop.cargo > 0 &&
              ` · ${missions.nextStop.cargo} t${missions.nextStop.cargoIncomplete ? '+' : ''}`}
            {missions.nextStop.kills > 0 && ` · ${missions.nextStop.kills} kills`}
            {missions.nextStop.expiry && ` · ${missions.nextStop.expiry}`}
          </div>
        </div>
      )}

      <div className="mission-rows">
        {missions.rows.map((m) => (
          <div key={m.id} className={m.awaitingTurnIn ? 'mission-row done' : 'mission-row'}>
            <div className="mission-row-head">
              <span className="mission-row-name">{m.name}</span>
              {/*
                Replaces the expiry rather than sitting beside it. Once the work
                is done the clock is no longer the thing to act on -- the thing
                to act on is going and handing it in -- and two competing
                statuses on one line is how a commander reads neither.
              */}
              {m.awaitingTurnIn ? (
                <span className="mission-row-exp done">Completed</span>
              ) : (
                <span className={m.expiry === 'Expired' ? 'mission-row-exp urgent' : 'mission-row-exp'}>
                  {m.expiry ?? '—'}
                </span>
              )}
            </div>
            <div className="mission-row-meta">
              {m.destination ?? <span className="unknown">No destination given</span>}
              {m.cargo && ` · ${m.cargo}`}
            </div>
            {/* Labelled here for the same reason as in the main window: everything
                else on the row came from the journal, this did not. */}
            {m.note && (
              <div className="mission-row-note">
                <span className="note-label">EDFM</span>
                {m.note}
              </div>
            )}
          </div>
        ))}
      </div>

      {missions.more > 0 && <div className="mission-more">+{missions.more} more in the app</div>}
      {missions.withoutDestination > 0 && (
        <div className="mission-more">{missions.withoutDestination} with no destination given</div>
      )}
    </>
  );
}

/* ---------------------------------------------------------- carrier jump */

/**
 * Live countdown to a scheduled carrier jump.
 *
 * Ticks locally from the absolute departure instant, once a second: the one
 * widget that needs a clock. Given `now`, it draws that moment and does not
 * tick (the preview).
 */
export function CarrierJumpWidget({ jumps, now: fixedNow }: { jumps: readonly OverlayCarrierJump[]; now?: number }) {
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    if (fixedNow !== undefined) return;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [fixedNow]);

  const now = fixedNow ?? tick;
  return (
    <>
      {jumps.map((j) => {
        const remaining = countdownTo(j.departureTime, now);
        return (
          <div key={j.carrierId} className="cj">
            <div className="cj-name">{j.name}</div>
            <div className="cj-line">
              {remaining === null ? (
                // The clock has run out and no arrival has been confirmed yet. It is
                // leaving, or has left -- saying "arrived" would be inventing the
                // one thing we have not been told.
                <span className="cj-departing">Departing</span>
              ) : (
                <span className="cj-time">{remaining}</span>
              )}
              <span className="cj-dest">
                {' → '}
                {j.system}
                {j.body && <span className="cj-body"> {j.body}</span>}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ---------------------------------------------------------------- route */

/**
 * The next jump on a route a plugin is following. Compact is the next system
 * and the jumps left; detailed adds the waypoint count and destination, each
 * of which can be switched off.
 */
export function RouteWidget({
  route,
  options,
}: {
  route: PluginRoute;
  options: Pick<OverlayWidgetOptions, 'routeDetail' | 'routeShowDestination' | 'routeShowWaypoints'>;
}) {
  const carrier = route.carrier ?? null;
  const detailed = options.routeDetail === 'detailed';
  const jumps = `${route.jumpsLeft} ${route.jumpsLeft === 1 ? 'jump' : 'jumps'} left`;
  return (
    <>
      {route.noShipRoute ? null : route.finished || route.next === null ? (
        <div className="rt-done">Arrived{route.destination ? ` at ${route.destination}` : ''}</div>
      ) : (
        <>
          <div className="rt-next">
            {route.next}
            {route.nextIsNeutron && <span className="rt-neutron"> neutron</span>}
          </div>
          <div className="rt-line">
            {jumps}
            {detailed && options.routeShowWaypoints && route.waypoints > 0 && (
              <> · waypoint {route.waypoint} of {route.waypoints}</>
            )}
            {detailed && options.routeShowDestination && route.destination && <> · to {route.destination}</>}
          </div>
        </>
      )}
      {carrier && (
        // The fleet carrier's route, followed alongside the commander's own.
        <div className="rt-line rt-carrier">
          Carrier:{' '}
          {carrier.finished || carrier.next === null
            ? `arrived${carrier.destination ? ` at ${carrier.destination}` : ''}`
            : `${carrier.next} next · ${carrier.jumpsLeft} ${carrier.jumpsLeft === 1 ? 'jump' : 'jumps'} left`}
        </div>
      )}
    </>
  );
}

/* --------------------------------------------------- live journal / exo */

/**
 * Exobiology on the body underfoot: every genus, and how far through each.
 *
 * A stage number is **omitted** rather than guessed when the count is not
 * established: a wrong "1 / 3" would say two samples remain when one does.
 */
export function LiveExobiologyWidget({ live, showValues = true }: { live: OverlayLiveExobiology; showValues?: boolean }) {
  return (
    <>
      <ul className="lx-roster">
        {live.rows.map((row) => {
          const stage =
            row.status === 'complete'
              ? `${row.samplesRequired} / ${row.samplesRequired}`
              : row.samplesTaken === null || row.samplesTaken === 0
                ? null
                : `${row.samplesTaken} / ${row.samplesRequired}`;

          return [
            <li key={row.genus} className={`lx-genus lx-${row.status}`}>
              <span className="lx-genus-mark" aria-hidden="true">
                {row.status === 'complete' ? '✓' : row.status === 'sampling' ? '◆' : '·'}
              </span>
              <span className="lx-genus-name">
                {/* Species once known; the genus alone before that, because a
                    surface scan reports a genus and nothing finer. */}
                {row.species ?? row.genus}
                {row.colour && <span className="lx-colour"> {row.colour}</span>}
              </span>
              <span className="lx-genus-state">{row.status === 'complete' ? stage : (stage ?? 'Unscanned')}</span>
            </li>,
            /*
              Value and walking distance, once the species is known. Absent on an
              unscanned row -- a genus spans species worth 1M to 19M.
            */
            showValues && row.value !== null && (
              <li key={`${row.genus}-info`} className="lx-genus-info">
                <span>{row.value} Cr</span>
                {row.sampleDistance !== null && <span>{row.sampleDistance} m apart</span>}
              </li>
            ),
          ];
        })}
      </ul>

      {/* The answer to "am I done here?", stated rather than left to be counted. */}
      <div className="lx-summary">
        {live.unscannedCount === 0 && live.completedCount === live.total
          ? 'All species recorded here'
          : `${live.completedCount} of ${live.total} recorded`}
      </div>

      {live.bodyName && <div className="lj-body">{live.bodyName}</div>}
    </>
  );
}

/**
 * Recent activity shows in full; after five minutes it collapses to a single
 * summary line rather than disappearing or lingering.
 */
export const LIVE_JOURNAL_FRESH_MS = 5 * 60 * 1000;

export function LiveJournalWidget({ journal, now: fixedNow }: { journal: LiveJournalState; now?: number }) {
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    if (fixedNow !== undefined) return;
    // A minute is enough: the only decision is fresh versus collapsed.
    const id = setInterval(() => setTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [fixedNow]);

  const now = fixedNow ?? tick;
  const at = Date.parse(journal.occurredAt);
  const fresh = Number.isFinite(at) && now - at < LIVE_JOURNAL_FRESH_MS;

  if (!fresh) {
    return (
      <div className="lj-collapsed">
        {journal.sessionCount} {journal.sessionCount === 1 ? 'activity' : 'activities'} recorded
      </div>
    );
  }

  return (
    <>
      {journal.systemName && <div className="lj-place">{journal.systemName}</div>}
      {journal.bodyName && <div className="lj-body">{journal.bodyName}</div>}
      <div className="lj-title">{journal.title}</div>
      {journal.detail && <div className="lj-detail">{journal.detail}</div>}
      {journal.hereCount > 1 && <div className="lj-here">{journal.hereCount} recorded here</div>}
    </>
  );
}

export function LiveJournalPanelView({
  panel,
  showValues,
  now,
}: {
  panel: Exclude<LiveJournalPanel<LiveJournalState>, null>;
  showValues: boolean;
  now?: number;
}) {
  return panel.kind === 'exobiology' ? (
    <LiveExobiologyWidget live={panel.live} showValues={showValues} />
  ) : (
    <LiveJournalWidget journal={panel.journal} now={now} />
  );
}

/* --------------------------------------------------------- plugin widgets */

/**
 * A plugin's widget: blocks it published, already checked by the main window
 * (lib/pluginUi.ts), drawn display-only.
 *
 * Inside an error boundary: whatever a plugin sends, the worst it can do is
 * blank its own widget. The rest of the overlay keeps drawing.
 */
export function PluginWidgetBody({ blocks }: { blocks: readonly UiBlock[] }) {
  return (
    <PluginWidgetBoundary blocks={blocks}>
      <div className="plugin-panel">
        <PluginBlocks blocks={blocks} compact />
      </div>
    </PluginWidgetBoundary>
  );
}

interface BoundaryProps {
  /** New content gets a fresh attempt. */
  readonly blocks: readonly UiBlock[];
  readonly children: ReactNode;
}

class PluginWidgetBoundary extends Component<BoundaryProps, { failed: boolean; blocks: readonly UiBlock[] }> {
  override state = { failed: false, blocks: this.props.blocks };

  static getDerivedStateFromProps(props: BoundaryProps, state: { failed: boolean; blocks: readonly UiBlock[] }) {
    return props.blocks !== state.blocks ? { failed: false, blocks: props.blocks } : null;
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? <div className="plugin-failed">This widget could not be shown.</div> : this.props.children;
  }
}
