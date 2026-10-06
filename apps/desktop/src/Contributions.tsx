/**
 * Contribution history (§11).
 *
 * Deliberately not a leaderboard, not a score, and not a streak. §11 warns that
 * incentivising accuracy encourages people to manufacture reports, so this
 * shows what this commander's client actually sent and nothing to compete with.
 *
 * §11 also requires required traffic, optional telemetry and optional
 * contribution to be clearly separated. There is no telemetry at all, and the
 * only network traffic the Companion makes is the contribution below — so the
 * page says exactly that rather than implying a distinction that does not
 * exist.
 */

import { companion, type CompanionSnapshot } from './lib/companion';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="field-value">{value}</div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Contributions({ snap }: { snap: CompanionSnapshot }) {
  const c = snap.contributions;

  return (
    <>
      <header className="page-head">
        <h1>Contributions</h1>
        <p className="muted">
          What this Companion has sent to EDFM. Counts only &mdash; there is no ranking here, by
          design.
        </p>
      </header>

      {!c.enabled && (
        <section className="card">
          <h2>Contribution is off</h2>
          <p className="muted">
            Nothing is being sent. {c.pending > 0
              ? `${c.pending} observation${c.pending === 1 ? '' : 's'} recorded on this machine ` +
                'would be offered if you turn it on; they are kept locally rather than discarded, ' +
                'so opting in does not start from nothing.'
              : 'Observations are still recorded locally as you play.'}
          </p>
          <p className="muted">Enable it under Settings &rarr; Verification.</p>
        </section>
      )}

      <section className="card">
        <h2>Sent</h2>
        <div className="grid">
          <Stat label="Observations submitted" value={String(c.submitted)} />
          <Stat
            label="Waiting to send"
            value={String(c.pending)}
            hint={c.enabled ? 'Retries automatically' : 'Held until you opt in'}
          />
          <Stat
            label="Findings derived"
            value={String(c.findingsFromSubmissions)}
            hint="By the server, from your observations"
          />
          {c.failed > 0 && (
            <Stat label="Rejected" value={String(c.failed)} hint="Not retried" />
          )}
        </div>
        <p className="muted">
          Last contribution:{' '}
          {c.lastContributionAt === null
            ? 'never'
            : new Date(c.lastContributionAt).toLocaleString()}
        </p>
        <p className="muted">
          EDFM Note: your Companion sends what your game reported, not what it thinks is wrong.
          The comparison is redone on the server against its own data, so a bug in this app shows
          up as a disagreement to investigate rather than quietly becoming part of the record.
          &ldquo;Findings derived&rdquo; is what the server concluded, which is why it can differ
          from what this app detected.
        </p>
      </section>

      <section className="card">
        <h2>Recorded locally</h2>
        <div className="grid">
          <Stat
            label="Discrepancies detected"
            value={String(c.discrepanciesDetected)}
            hint="On this machine"
          />
          <Stat
            label="Research sessions"
            value={String(c.researchSessions)}
            hint="Not yet contributed"
          />
        </div>
        <p className="muted">
          Research sessions are recorded on this machine only. Contributing them is a separate
          feature that is not built yet, so nothing from Field Research has been sent anywhere.
        </p>
      </section>

      <section className="card">
        <h2>How you are identified</h2>
        <label className="stack" htmlFor="identity-mode">
          <span>Identity</span>
          <select
            id="identity-mode"
            value={c.identityMode}
            onChange={(e) =>
              void companion.setIdentityMode(e.target.value === 'commander' ? 'commander' : 'anonymous')
            }
          >
            <option value="anonymous">Anonymous</option>
            <option value="commander">Attributed to my commander name</option>
          </select>
        </label>
        <p className="muted">
          Either way, your commander name and Frontier ID are sent as one-way hashes, never as
          values &mdash; the server can tell two reporters apart without knowing who either is.
          Choosing attribution adds your name for credit; it does not reveal anything the
          anonymous mode conceals from the database.
        </p>
        <p className="muted">
          EDFM-account linking is offered in the design but is not built. Your commander name is
          never treated as authentication.
        </p>
      </section>

      <section className="card">
        <h2>What the Companion sends</h2>
        <p className="muted">
          Only station observations, and only while contribution is on: the station&rsquo;s
          MarketID, name, type, system, the service tokens your game reported, the timestamp, the
          journal event and its byte offset, your game version and build.
        </p>
        <p className="muted">
          There is no telemetry and no analytics in any configuration. Besides contribution, the
          Companion only reaches the network for the services you switch on under Connections
          and, if you have Python plugins installed, a daily check of their GitHub pages for
          updates. Your journals are never uploaded, and chat, friends, private groups and travel
          history are never sent anywhere.
        </p>
      </section>
    </>
  );
}
