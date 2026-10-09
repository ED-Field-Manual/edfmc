/**
 * The Inara-specific part of its Connections card.
 *
 * Everything shared with the other services -- the switch, the record, the key
 * field, what is and is not shared -- stays in `Integrations.tsx`. This adds
 * only what Inara has and they do not: the app white-list, a key Inara has
 * confirmed, per-kind sharing choices, and links back to Inara.
 *
 * "Connected" appears only when Inara said so: a verified key or an accepted
 * batch. Nothing here claims success on the strength of a switch.
 */

import type { InaraCategory } from '@edfm/integrations';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useState } from 'react';

import type { CompanionSnapshot } from './lib/companion.js';

const CATEGORY_TEXT: Record<InaraCategory, { label: string; hint: string }> = {
  travel: { label: 'Flight log and location', hint: 'Jumps, dockings, landings and your current system.' },
  ranks: { label: 'Ranks and reputation', hint: 'Pilot, navy, engineer and Powerplay ranks; faction reputation.' },
  ships: { label: 'Ships and loadouts', hint: 'Your fleet, each ship’s modules and engineering, where stored ships are.' },
  suits: { label: 'Suit loadouts', hint: 'Your on-foot loadouts.' },
  inventory: { label: 'Materials, cargo and locker', hint: 'Full lists from the game, sent when they change.' },
  statistics: { label: 'Game statistics', hint: 'The statistics page from the game, sent whole.' },
  credits: {
    label: 'Credits and loan',
    hint: 'The game’s own figure, once per session. Off unless you switch it on.',
  },
};

const ORDER: readonly InaraCategory[] = [
  'travel',
  'ranks',
  'ships',
  'suits',
  'inventory',
  'statistics',
  'credits',
];

function explain(state: string, appName: string): string {
  switch (state) {
    case 'not-configured':
      return 'Add your personal Inara API key below to set this up.';
    case 'awaiting-app-authorization':
      return `Inara has not yet approved “${appName}” to send data, so nothing is queued or sent, and the key cannot be checked. Your key and choices are kept, and sharing starts once Inara approves the app.`;
    case 'authentication-failed':
      return 'Inara did not accept your API key. Nothing is being sent. Replace the key, or press Verify if you have fixed it on Inara.';
    case 'disabled':
      // The line above the switch already says nothing is being sent.
      return 'Tick Enable Inara to start sending.';
    case 'temporarily-unavailable':
      return 'Inara could not be reached last time. What is waiting will be retried automatically.';
    case 'connected':
      return 'Inara has confirmed your key and is receiving updates.';
    default:
      return 'Ready. Your key has not been confirmed by Inara yet; press Verify to check it.';
  }
}

export function InaraPanel({ snap }: { snap: CompanionSnapshot }) {
  const inara = snap.inara;
  const [message, setMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const enabled = snap.integrations.inara.enabled;

  async function verify() {
    setMessage(null);
    const reason = await inara.verify();
    setMessage(reason ?? 'Inara confirmed your key.');
  }

  async function sync() {
    setSyncing(true);
    await inara.syncNow();
    setSyncing(false);
  }

  const canSync =
    enabled && (inara.state === 'connected' || inara.state === 'configured' || inara.state === 'temporarily-unavailable');

  return (
    <div className="inara-panel">
      <p className={inara.state === 'authentication-failed' ? 'note' : 'audit-line'}>
        <strong>{inara.label}.</strong> {explain(inara.state, inara.appName)}
      </p>

      {inara.profile && (
        <p className="muted">
          Verified as {inara.profile.userName ?? inara.profile.commanderName ?? 'your Inara account'} on{' '}
          {new Date(inara.profile.verifiedAt).toLocaleString()}.{' '}
          {inara.profile.profileUrl && (
            <button
              type="button"
              className="link"
              onClick={() => void openUrl(inara.profile!.profileUrl!).catch(() => undefined)}
            >
              Open your Inara profile
            </button>
          )}
        </p>
      )}

      <p className="audit-actions">
        <button
          type="button"
          onClick={() => void verify()}
          disabled={!inara.mayVerify}
          title={inara.mayVerify ? undefined : 'Not available until Inara approves this app and a key is saved.'}
        >
          {inara.verifying ? 'Checking…' : 'Verify key'}
        </button>
        {canSync && (
          <button type="button" onClick={() => void sync()} disabled={syncing}>
            {syncing ? 'Sending…' : 'Sync now'}
          </button>
        )}
      </p>
      {message && <p className="muted">{message}</p>}

      <h3 className="subhead">What to share</h3>
      <div className="inara-categories">
        {ORDER.map((c) => (
          <label key={c} className="check">
            <input
              type="checkbox"
              checked={inara.categories[c]}
              onChange={(e) => void inara.setCategory(c, e.target.checked)}
            />
            <span>
              {CATEGORY_TEXT[c].label}
              <span className="muted-inline"> {'—'} {CATEGORY_TEXT[c].hint}</span>
            </span>
          </label>
        ))}
      </div>

      {(inara.systemLink || inara.stationLink) && (
        <p className="muted">
          On Inara:{' '}
          {inara.systemLink && (
            <button
              type="button"
              className="link"
              onClick={() => void openUrl(inara.systemLink!.url).catch(() => undefined)}
            >
              {inara.systemLink.label}
            </button>
          )}
          {inara.systemLink && inara.stationLink && ' · '}
          {inara.stationLink && (
            <button
              type="button"
              className="link"
              onClick={() => void openUrl(inara.stationLink!.url).catch(() => undefined)}
            >
              {inara.stationLink.label}
            </button>
          )}
        </p>
      )}

      <p className="field-hint">
        Sent as {'“'}{inara.appName}{'”'}{inara.isBeingDeveloped ? ', in development mode' : ''}.
        Data from the Legacy game or a beta is never sent. Inara is an independent community
        site; this app is not affiliated with it.
      </p>
    </div>
  );
}
