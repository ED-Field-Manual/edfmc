/**
 * Colonisation logistics (§16/§17).
 *
 * The screen is organised around §16's rule that a station's selection must be
 * explainable. Every stop shows its reasons in words, every purchase shows the
 * confidence numbers behind its verdict, and the stations that lost show why —
 * because "closer station rejected because its stock is 103% of requirement and
 * the data is 7 hours old" is more useful than a silently shorter list.
 *
 * Nothing here recomputes a plan on render. Building one costs a market search,
 * and §16's point is that a commander studies the reasoning rather than
 * watching it flicker.
 */

import { useState } from 'react';
import { confidenceLabel, type PlanOptions, type StationPreference } from '@edfm/logistics';
import { companion, type CompanionSnapshot } from './lib/companion';
import { describeCargo } from './lib/dashboard';
import { isLive } from './lib/session';

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function Logistics({ snap }: { snap: CompanionSnapshot }) {
  const l = snap.logistics;

  const [preference, setPreference] = useState<StationPreference>('no-preference');
  const [allowCarriers, setAllowCarriers] = useState(false);
  const [maxAgeHours, setMaxAgeHours] = useState(12);
  const [safetyMargin, setSafetyMargin] = useState(10);
  const [capacity, setCapacity] = useState(0);

  const options: PlanOptions = {
    stationPreference: preference,
    allowFleetCarriers: allowCarriers,
    maxDataAgeSeconds: maxAgeHours * 3600,
    safetyMargin: safetyMargin / 100,
    ...(capacity > 0 ? { capacity } : {}),
  };

  const active = l.sites.filter((s) => !s.complete && !s.failed);
  const cargo = describeCargo(snap.state, Number.POSITIVE_INFINITY);

  return (
    <>
      <header className="page-head">
        <h1>Logistics</h1>
        <p className="muted">
          {active.length === 0
            ? 'No active construction sites.'
            : `${active.length} active ${active.length === 1 ? 'site' : 'sites'}, ` +
              `${l.requirements.length} outstanding ${l.requirements.length === 1 ? 'commodity' : 'commodities'}`}
        </p>
      </header>

      {/* Everything in the hold; the Dashboard lists the largest few. */}
      {cargo && (
        <section className="card" id="ship-cargo">
          <h2>
            Ship cargo · {cargo.total}
            {!isLive(snap.session) && <span className="muted-inline"> · last known</span>}
          </h2>
          {cargo.lines === null ? (
            <p className="muted">The game has not reported what is in the hold yet.</p>
          ) : cargo.lines.length === 0 ? (
            <p className="muted">The hold is empty.</p>
          ) : (
            <ul className="cargo-list">
              {cargo.lines.map((c) => (
                <li key={c.label}>
                  <span>{c.label}</span>
                  <span>{c.tonnes.toLocaleString()} t</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ------------------------------------------------------------ sites */}

      <section className="card">
        <h2>Construction sites</h2>
        {l.sites.length === 0 ? (
          <p className="muted">
            Nothing yet. Dock at a colonisation construction depot and the Companion will pick it
            up automatically &mdash; the game reports what each site still needs, so nothing has to
            be entered by hand.
          </p>
        ) : (
          <table className="rows">
            <thead>
              <tr>
                <th>Site</th>
                <th>Progress</th>
                <th>Outstanding</th>
                <th>Priority</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {l.sites.map((site) => {
                const remaining = site.resources.reduce((n, r) => n + r.remaining, 0);
                return (
                  <tr key={site.marketId}>
                    <td>
                      <input
                        type="text"
                        value={site.name ?? ''}
                        placeholder={`Depot ${site.marketId}`}
                        onChange={(e) => void companion.setSiteName(site.marketId, e.target.value)}
                      />
                    </td>
                    <td>{site.progress === null ? 'Unknown' : pct(site.progress)}</td>
                    <td>{remaining.toLocaleString()} t</td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        value={site.priority}
                        style={{ width: '4rem' }}
                        onChange={(e) =>
                          void companion.setSitePriority(site.marketId, Number(e.target.value))
                        }
                      />
                    </td>
                    <td className="muted">
                      {site.failed ? 'failed' : site.complete ? 'complete' : 'active'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted">
          EDFM Note: the site name and priority are yours &mdash; Elite does not name depots.
          Priority decides which site gets filled first when a purchase cannot cover everything.
        </p>
      </section>

      {/* ---------------------------------------------------- requirements */}

      {l.requirements.length > 0 && (
        <section className="card">
          <h2>Combined requirements</h2>
          <table className="rows">
            <thead>
              <tr><th>Commodity</th><th>Outstanding</th><th>Split across sites</th></tr>
            </thead>
            <tbody>
              {l.requirements.map((r) => {
                const split = companion.allocationFor(r.commodity, r.amount);
                return (
                  <tr key={r.commodity}>
                    <td>{r.label}</td>
                    <td>{r.amount.toLocaleString()}</td>
                    <td className="muted">
                      {split.length <= 1
                        ? '—'
                        : split
                            .map((a) => `${a.siteName ?? a.marketId}: ${a.amount.toLocaleString()}`)
                            .join(', ')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* --------------------------------------------------------- options */}

      <section className="card">
        <h2>Plan options</h2>
        <div className="grid">
          <label className="stack" htmlFor="pref">
            <span>Station preference</span>
            <select
              id="pref"
              value={preference}
              onChange={(e) => setPreference(e.target.value as StationPreference)}
            >
              <option value="orbital-only">Orbital only</option>
              <option value="strongly-prefer-orbital">Strongly prefer orbital</option>
              <option value="no-preference">No preference</option>
              <option value="planetary-if-better">Planetary allowed if better</option>
            </select>
          </label>

          <label className="stack" htmlFor="age">
            <span>Maximum data age (hours)</span>
            <input id="age" type="number" min={1} max={168} value={maxAgeHours}
              onChange={(e) => setMaxAgeHours(Math.max(1, Number(e.target.value)))} />
          </label>

          <label className="stack" htmlFor="margin">
            <span>Safety margin (%)</span>
            <input id="margin" type="number" min={0} max={100} value={safetyMargin}
              onChange={(e) => setSafetyMargin(Math.max(0, Number(e.target.value)))} />
          </label>

          <label className="stack" htmlFor="cap">
            <span>Hold capacity (0 = unlimited)</span>
            <input id="cap" type="number" min={0} value={capacity}
              onChange={(e) => setCapacity(Math.max(0, Number(e.target.value)))} />
          </label>
        </div>

        <label className="stack" htmlFor="carriers">
          <span>
            <input id="carriers" type="checkbox" checked={allowCarriers}
              onChange={(e) => setAllowCarriers(e.target.checked)} />{' '}
            Include fleet carriers
          </span>
        </label>
        <p className="muted">
          Carriers are off by default: a carrier&rsquo;s market is one owner&rsquo;s decision and
          can be gone before you arrive.
        </p>

        <button
          type="button"
          className="primary"
          disabled={l.requirements.length === 0 || l.planningState === 'searching'}
          onClick={() => void companion.buildSourcingPlan(options)}
        >
          {l.planningState === 'searching' ? 'Searching markets…' : 'Build sourcing plan'}
        </button>
        {l.planError && <p className="note">{l.planError}</p>}
      </section>

      {/* ------------------------------------------------------------ plan */}

      {l.plan && (
        <section className="card">
          <h2>Recommended procurement plan</h2>
          <p className="muted">
            {l.plan.totalStops} {l.plan.totalStops === 1 ? 'stop' : 'stops'} from{' '}
            {l.candidatesConsidered} candidate stations
            {l.plan.estimatedCost !== null &&
              ` · estimated ${Math.round(l.plan.estimatedCost).toLocaleString()} cr`}
            {l.plannedAt && ` · built ${new Date(l.plannedAt).toLocaleTimeString()}`}
          </p>

          {l.plan.stops.map((stop, i) => (
            <div key={stop.station.marketId} className="card" style={{ marginTop: '0.75rem' }}>
              <h3>
                Stop {i + 1}: {stop.station.stationName}
                <span className="muted"> · {stop.station.systemName}</span>
              </h3>

              <table className="rows">
                <thead>
                  <tr><th>Commodity</th><th>Buy</th><th>Confidence</th><th>Why</th></tr>
                </thead>
                <tbody>
                  {stop.purchases.map((p) => (
                    <tr key={p.commodity}>
                      <td>{p.label}</td>
                      <td>{p.amount.toLocaleString()}</td>
                      <td>{confidenceLabel(p.confidence.level)}</td>
                      {/* The numbers, never just the verdict (§15). */}
                      <td className="muted">{p.confidence.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <p className="muted">Selected because:</p>
              <ul className="muted">
                {stop.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>

              <details>
                <summary className="muted">Score components</summary>
                <table className="rows">
                  <tbody>
                    {stop.components.map((c) => (
                      <tr key={c.label}>
                        <td>{c.label}</td>
                        <td className="muted">{c.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          ))}

          {l.plan.unfulfilled.length > 0 && (
            <>
              <h3>Could not source</h3>
              <ul className="muted">
                {l.plan.unfulfilled.map((u) => (
                  <li key={u.commodity}>
                    {u.label}: {u.amount.toLocaleString()} short
                  </li>
                ))}
              </ul>
              <p className="muted">
                No market met your confidence and age limits for these. Loosening the maximum data
                age, or allowing carriers, may find one.
              </p>
            </>
          )}

          {l.plan.rejected.length > 0 && (
            <details>
              <summary className="muted">
                Stations considered and rejected ({l.plan.rejected.length})
              </summary>
              <ul className="muted">
                {l.plan.rejected.slice(0, 12).map((r) => (
                  <li key={r.stationName}>
                    <strong>{r.stationName}</strong>
                    {r.distanceLy !== null && ` (${r.distanceLy.toFixed(1)} ly)`}: {r.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <p className="muted">
            EDFM Note: stock figures are the last thing a commander reported to EDDN, not a
            guarantee. Confidence weighs how much was reported against how much you need and how
            long ago it was seen &mdash; the numbers behind each verdict are shown so you can judge
            them yourself. Judged by confidence rules v{l.plan.confidenceRulesVersion}.
          </p>
        </section>
      )}
    </>
  );
}
