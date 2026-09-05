/**
 * Field research (§12/§13).
 *
 * The rule this screen exists to honour: show counts, and show a rate only
 * where the sample supports one. `formatRate` returns null below ten sessions
 * in a group, so no code path here can render "100%" from a single visit.
 *
 * Every table puts the denominator next to the numerator, and the settlement
 * count next to both — a high rate across two settlements is a fact about where
 * the commander went, not about the economy.
 */

import { formatRate, type Completeness } from '@edfm/research';
import { companion, type CompanionSnapshot } from './lib/companion';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="field-value">{value}</div>
    </div>
  );
}

export function Research({ snap }: { snap: CompanionSnapshot }) {
  const r = snap.research;
  const q = r.quality;

  return (
    <>
      <header className="page-head">
        <h1>Field Research</h1>
        <p className="muted">
          {r.projectTitle} &middot; methodology v{r.projectVersion}
        </p>
      </header>

      {r.active && (
        <section className="card">
          <h2>Session in progress</h2>
          <div className="grid">
            <Field label="Settlement" value={r.active.context.settlementName ?? 'Unknown'} />
            <Field label="Economy" value={r.active.context.economy ?? 'Unknown'} />
            <Field label="Collected so far" value={String(r.active.observations.length)} />
          </div>
        </section>
      )}

      <section className="card">
        <h2>Sample</h2>
        <div className="grid">
          <Field label="Usable sessions" value={String(q.sampleSize)} />
          <Field label="Settlements" value={String(q.distinctLocations)} />
          <Field label="Systems" value={String(q.distinctSystems)} />
          <Field label="Commanders" value={String(q.uniqueCommanders)} />
        </div>
        <p className="muted">
          Excluded: {q.excluded.implausiblyShort} too short, {q.excluded.implausiblyLong} too
          long, {q.excluded.abortive} ended in death, {q.excluded.interrupted} interrupted.
          Excluded sessions are still recorded &mdash; they are left out of rates, not deleted.
        </p>
        {q.gameVersions.length > 0 && (
          <p className="muted">Game versions: {q.gameVersions.join(', ')}</p>
        )}
        {q.caveat && <p className="note">{q.caveat}</p>}
      </section>

      <section className="card">
        <h2>By settlement economy</h2>
        {r.byEconomy.length === 0 ? (
          <p className="muted">No observed sessions yet.</p>
        ) : (
          <table className="rows">
            <thead>
              <tr>
                <th>Economy</th>
                <th>Sessions</th>
                <th>With items</th>
                <th>Settlements</th>
                <th>Rate</th>
              </tr>
            </thead>
            <tbody>
              {r.byEconomy.map((g) => (
                <tr key={g.group}>
                  <td>{g.group}</td>
                  <td>{g.sessions}</td>
                  <td>{g.sessionsWithObservations}</td>
                  <td>{g.distinctLocations}</td>
                  <td className="muted">{formatRate(g) ?? 'too few to rate'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          EDFM Note: these are counts from your own sessions, not a conclusion. A difference
          between economies here can easily be a difference between the handful of settlements
          you happened to visit.
        </p>
      </section>

      {r.items.length > 0 && (
        <section className="card">
          <h2>What you have found</h2>
          <table className="rows">
            <thead>
              <tr>
                <th>Item</th>
                <th>Type</th>
                <th>Sessions</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {r.items.map((i) => (
                <tr key={i.name}>
                  <td>{i.label ?? i.name}</td>
                  <td className="muted">{i.category ?? 'Unknown'}</td>
                  <td>{i.sessions}</td>
                  <td>{i.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2>Recent sessions</h2>
        {r.sessions.length === 0 ? (
          <p className="muted">
            Nothing yet. A session is recorded automatically when you disembark at a settlement
            you have approached, and ends when you embark, lift off or leave.
          </p>
        ) : (
          <table className="rows">
            <thead>
              <tr>
                <th>Settlement</th>
                <th>Economy</th>
                <th>Duration</th>
                <th>Found</th>
                <th>Ended</th>
                <th>Completeness</th>
              </tr>
            </thead>
            <tbody>
              {r.sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.context.settlementName ?? 'Unknown'}</td>
                  <td className="muted">{s.context.economy ?? 'Unknown'}</td>
                  <td>
                    {s.durationSeconds === null
                      ? 'Unknown'
                      : `${Math.max(1, Math.round(s.durationSeconds / 60))}m`}
                  </td>
                  <td>{s.observations.length}</td>
                  <td className="muted">
                    {s.outcome === 'died' ? 'died' : (s.endEvent ?? s.outcome)}
                  </td>
                  <td>
                    <select
                      value={s.completeness}
                      onChange={(e) =>
                        void companion.markSessionCompleteness(
                          s.id,
                          e.target.value as Completeness,
                        )
                      }
                    >
                      <option value="unknown">Unknown</option>
                      <option value="complete">Complete clear</option>
                      <option value="partial">Partial</option>
                      <option value="aborted">Aborted</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          EDFM Note: marking a session is entirely optional. The Companion cannot tell whether you
          searched every container, whether someone had looted the site before you, or whether you
          skipped part of it &mdash; so it records these as observed sessions and leaves
          completeness unknown rather than guessing.
        </p>
      </section>

      {r.unavailableFields.length > 0 && (
        <section className="card">
          <h2>Not collected</h2>
          <p className="muted">
            The research design asks for {r.unavailableFields.join(', ')}, but Elite does not
            report any of them in the journal. They are listed here rather than left blank, so the
            gap is visible rather than looking like an oversight.
          </p>
        </section>
      )}
    </>
  );
}
