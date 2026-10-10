/**
 * The home screen: who, where, in what, doing what.
 *
 * Everything shown comes from `lib/dashboard.ts`, which only ever describes
 * what the game reported. Technical detail (system address, coordinates,
 * market id, build, event ids, the journal file) lives on Diagnostics.
 *
 * When the game is not running, the same facts are labelled "Last known" so
 * nothing on this screen implies it is live when it is not.
 */

import { isKnown } from '@edfm/elite-journal';
import { useEffect, useState } from 'react';

import { openScreenshot } from './Screenshots';
import {
  describeCargo,
  describeLocation,
  describeShip,
  DONE_SUBTYPES,
  exobiologyActivity,
  friendlyTime,
  missionsActivity,
  navigationActivity,
  recentJournal,
  type ActivityItem,
} from './lib/dashboard';
import { relativeExpiry, type CompanionSnapshot } from './lib/companion';
import { countdownTo } from './lib/overlay';
import { SESSION_LABEL, gameModeLabel, isLive, type SessionStatus } from './lib/session';

type Snap = CompanionSnapshot;

const SESSION_GLYPH: Record<SessionStatus, string> = {
  'game-active': '●',
  'game-offline': '○',
  'game-unknown': '◌',
  'waiting-for-journal': '◐',
  'journal-error': '✕',
};

export function SessionPill({ status }: { status: SessionStatus }) {
  return (
    <span className={`session-pill session-${status}`} role="status">
      <span aria-hidden="true">{SESSION_GLYPH[status]}</span> {SESSION_LABEL[status]}
    </span>
  );
}

type Go = (to: 'Screenshots' | 'Journal', focus?: string) => void;

export function Dashboard({ snap, go }: { snap: Snap; go: Go }) {
  const s = snap.state;
  const live = isLive(snap.session);
  const commander = isKnown(s.commander) ? s.commander : null;
  const mode = gameModeLabel(isKnown(s.gameMode) ? s.gameMode : null, isKnown(s.gameGroup) ? s.gameGroup : null);
  const location = describeLocation(s);
  const ship = describeShip(s);
  const cargo = describeCargo(s, Number.POSITIVE_INFINITY);

  const activity = [
    navigationActivity(s, live),
    exobiologyActivity(live ? snap.exobiology : null),
    missionsActivity(snap.missions.byExpiry, relativeExpiry),
  ].filter((a): a is ActivityItem => a !== null);

  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <h1 className="dash-cmdr">{commander ? `CMDR ${commander}` : 'No commander yet'}</h1>
          <p className="dash-sub">
            {commander
              ? mode ?? 'Game mode not reported yet'
              : 'Start Elite Dangerous and load into the game, and your commander appears here.'}
          </p>
        </div>
        <SessionPill status={snap.session} />
      </header>

      {!live && commander && (
        <p className="dash-stale">
          {snap.session === 'game-offline'
            ? 'Elite Dangerous is not running. Showing your last known state.'
            : 'Showing the last state your journal recorded.'}
        </p>
      )}

      {commander && (
        <div className="dash-grid">
          <section className="dash-card" aria-labelledby="dash-loc">
            <h2 id="dash-loc" className="dash-label">
              {live ? 'Location' : 'Last known location'}
            </h2>
            {location.system ? (
              <>
                <p className="dash-primary">{location.system}</p>
                {location.where && <p className="dash-line">{location.where}</p>}
                {(location.status || location.vehicle) && (
                  <p className="dash-meta">
                    {location.status && (
                      <span className="dash-tag">
                        <span aria-hidden="true">{location.status.glyph}</span> {location.status.label}
                      </span>
                    )}
                    {location.vehicle && <span className="dash-tag">{location.vehicle}</span>}
                  </p>
                )}
              </>
            ) : (
              <p className="dash-line muted-inline">Not reported yet. It appears once the game says where you are.</p>
            )}
          </section>

          <section className="dash-card" aria-labelledby="dash-ship">
            <h2 id="dash-ship" className="dash-label">
              {live ? (ship?.away ? 'Your ship' : 'Ship') : 'Last known ship'}
            </h2>
            {ship ? (
              <>
                <p className="dash-primary">{ship.name ?? ship.model}</p>
                {ship.name && <p className="dash-line">{ship.model}</p>}
                {(ship.ident || ship.away) && (
                  <p className="dash-meta">
                    {ship.ident && <span className="dash-tag">{ship.ident}</span>}
                    {ship.away && <span className="dash-tag">Not aboard</span>}
                  </p>
                )}
                {cargo && <CargoList cargo={cargo} />}
              </>
            ) : (
              <p className="dash-line muted-inline">Not reported yet. It appears once you board a ship.</p>
            )}
          </section>
        </div>
      )}

      {commander && <CarrierJumps snap={snap} />}

      {commander && activity.length > 0 && (
        <section className="dash-card dash-activity" aria-labelledby="dash-act">
          <h2 id="dash-act" className="dash-label">
            Current activity
          </h2>
          <ul className="dash-activity-list">
            {activity.map((a) => (
              <li key={a.key} className="dash-activity-item">
                <p className="dash-activity-title">{a.title}</p>
                {a.lines.map((l, i) => (
                  <p key={i} className="dash-line">
                    {l}
                  </p>
                ))}
                {a.progress !== undefined && (
                  <div
                    className="dash-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(a.progress * 100)}
                    aria-label={`${a.title} progress`}
                  >
                    <div style={{ width: `${a.progress * 100}%` }} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {commander && (
        <div className="dash-grid dash-pair">
          <LastScreenshot snap={snap} go={go} />
          <RecentJournal snap={snap} go={go} />
        </div>
      )}
    </div>
  );
}

/**
 * Scheduled jumps for the commander's own carriers, from `CarrierJumpRequest`.
 * Only their own: the journal says nothing before another carrier jumps.
 */
function CarrierJumps({ snap }: { snap: Snap }) {
  const jumps = snap.carrierJumps;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (jumps.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [jumps.length]);
  if (jumps.length === 0) return null;

  return (
    <section className="dash-card" aria-labelledby="dash-fc">
      <h2 id="dash-fc" className="dash-label">
        Carrier jump
      </h2>
      {jumps.map((j) => {
        const remaining = countdownTo(j.departureTime, now);
        return (
          <p key={j.carrierId} className="dash-line">
            <strong>{j.name}</strong> → {j.system}
            {j.body ? `, ${j.body}` : ''} · {remaining === null ? 'departing' : `jumps in ${remaining}`}
          </p>
        );
      })}
    </section>
  );
}

/** Cargo lines shown before "Show all". */
const CARGO_SHOWN = 5;

/**
 * The hold, largest first; textual only. The five largest, and the rest on
 * request, here: the whole hold belongs on the Ship card, not on another page.
 */
function CargoList({ cargo }: { cargo: NonNullable<ReturnType<typeof describeCargo>> }) {
  const [all, setAll] = useState(false);
  const lines = cargo.lines === null ? null : all ? cargo.lines : cargo.lines.slice(0, CARGO_SHOWN);
  const more = cargo.lines === null ? 0 : cargo.lines.length - CARGO_SHOWN;
  return (
    <div className="dash-cargo">
      <p className="dash-sublabel">Cargo · {cargo.total}</p>
      {lines === null ? (
        <p className="dash-line muted-inline">Contents not reported yet.</p>
      ) : lines.length === 0 ? (
        <p className="dash-line muted-inline">Empty hold.</p>
      ) : (
        <ul className="dash-cargo-list">
          {lines.map((c) => (
            <li key={c.label}>
              <span className="dash-cargo-name">{c.label}</span>
              <span className="dash-cargo-t">{c.tonnes.toLocaleString()} t</span>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && (
        <button type="button" className="link dash-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${cargo.lines!.length}`}
        </button>
      )}
    </div>
  );
}

/** The newest catalogued screenshot, from the existing catalog and a preview made once. */
function LastScreenshot({ snap, go }: { snap: Snap; go: Go }) {
  const latest = snap.screenshots.recent[0] ?? null;
  const preview = snap.latestScreenshotPreview;
  const ready = latest && preview && preview.id === latest.id ? preview : null;
  const title = latest ? (latest.subject ?? latest.systemName ?? latest.category) : null;

  return (
    <section className="dash-card dash-tile" aria-labelledby="dash-shot">
      <div className="dash-tile-head">
        <h2 id="dash-shot" className="dash-label">
          Last screenshot
        </h2>
        <button type="button" className="link dash-small" onClick={() => go('Screenshots')}>
          Screenshots
        </button>
      </div>
      {latest === null ? (
        <p className="dash-line muted-inline dash-empty">No screenshots yet. Set a capture hotkey on the Screenshots page.</p>
      ) : (
        <>
          <button
            type="button"
            className="dash-shot"
            onClick={() => void openScreenshot(latest.filePath)}
            disabled={ready?.state !== 'ready'}
            title={ready?.state === 'ready' ? 'Open the image' : undefined}
          >
            {ready?.state === 'ready' && ready.url ? (
              <img src={ready.url} alt={title ?? 'Latest screenshot'} />
            ) : (
              <span className="dash-shot-note">
                {ready?.state === 'missing'
                  ? 'Image not found. It may have been moved or deleted.'
                  : ready?.state === 'unavailable'
                    ? 'No preview for this image.'
                    : 'Loading preview…'}
              </span>
            )}
          </button>
          <p className="dash-line dash-ellipsis" title={title ?? undefined}>
            {title}
          </p>
          <p className="dash-line muted-inline">{friendlyTime(latest.capturedAt)}</p>
        </>
      )}
    </section>
  );
}

/** The newest Field Journal entries, from the Journal's own data. */
function RecentJournal({ snap, go }: { snap: Snap; go: Go }) {
  const entries = recentJournal(snap.activity, 5);
  return (
    <section className="dash-card dash-tile" aria-labelledby="dash-journal">
      <div className="dash-tile-head">
        <h2 id="dash-journal" className="dash-label">
          Recent journal
        </h2>
        <button type="button" className="link dash-small" onClick={() => go('Journal')}>
          Journal
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="dash-line muted-inline dash-empty">
          Nothing finished yet. Completed missions, specimens and exobiology sales appear here.
        </p>
      ) : (
        <ul className="dash-journal">
          {entries.map((e) => (
            <li key={e.id}>
              <button type="button" className="dash-journal-entry" onClick={() => go('Journal', e.id)}>
                <span className="dash-ellipsis dash-journal-title" title={e.title}>
                  {e.title}
                </span>
                <span className="dash-ellipsis dash-journal-where">
                  {[DONE_SUBTYPES[e.subtype], e.locationName ?? e.bodyName ?? e.systemName, friendlyTime(e.occurredAt)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
