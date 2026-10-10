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

import {
  constructionActivity,
  describeLocation,
  describeShip,
  exobiologyActivity,
  missionsActivity,
  navigationActivity,
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

export function Dashboard({ snap }: { snap: Snap }) {
  const s = snap.state;
  const live = isLive(snap.session);
  const commander = isKnown(s.commander) ? s.commander : null;
  const mode = gameModeLabel(isKnown(s.gameMode) ? s.gameMode : null, isKnown(s.gameGroup) ? s.gameGroup : null);
  const location = describeLocation(s);
  const ship = describeShip(s);

  const activity = [
    navigationActivity(s, live),
    exobiologyActivity(live ? snap.exobiology : null),
    missionsActivity(snap.missions.byExpiry, relativeExpiry),
    constructionActivity(snap.logistics.sites),
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
                <p className="dash-meta">
                  {ship.cargo && (
                    <span className="dash-tag" title="Cargo carried / cargo capacity">
                      Cargo {ship.cargo}
                    </span>
                  )}
                  {ship.ident && <span className="dash-tag">{ship.ident}</span>}
                  {ship.away && <span className="dash-tag">Not aboard</span>}
                </p>
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
