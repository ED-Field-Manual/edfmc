/**
 * Relevant guides: ED Field Manual articles for what the commander is doing.
 *
 * Player-facing, so it says what is relevant and why, and links to the guide --
 * nothing about how a recommendation was matched. Rule ids, journal event names
 * and the rule set's version live on the Diagnostics page.
 *
 * It does not repeat the Dashboard. The Dashboard says where the commander is
 * and what they are doing; this page is the reading that goes with it.
 */

import { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { resourceUrl, type ContextTiming, type GuidanceMode } from '@edfm/context';

import type { ProjectedContext } from './lib/companion.js';

/** "Now", "4 min ago", "Last session". Words, not colour alone (§29). */
export function guideWhen(ctx: Pick<ProjectedContext, 'timing' | 'matchedAt'>, now: number): string {
  if (ctx.timing === 'current') return 'Now';
  if (ctx.timing === 'last-session') return 'Last session';
  const minutes = Math.floor(Math.max(0, now - ctx.matchedAt) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

const WHEN_TITLE: Readonly<Record<ContextTiming, string>> = {
  current: 'True right now',
  recent: 'Based on something you did recently',
  'last-session': 'From when you last played; the game is closed',
};

/** Re-render on a slow tick so "4 min ago" stays true without a journal line. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function Guides({
  contexts,
  guidance,
}: {
  contexts: readonly ProjectedContext[];
  guidance: GuidanceMode;
}) {
  const now = useNow(30_000);
  const offline = contexts.length > 0 && contexts.every((c) => c.timing === 'last-session');

  return (
    <>
      <header className="page-head">
        <h1>Relevant guides</h1>
        <p className="muted">ED Field Manual guides for what you are doing in game.</p>
      </header>

      {contexts.length === 0 ? (
        <p className="guides-empty">
          Nothing to suggest right now. Guides appear here when you do something the Field
          Manual covers.
        </p>
      ) : (
        <>
          {offline && <p className="guides-offline">The game is closed. These are from your last session.</p>}
          <ul className="guides" aria-label="Relevant guides">
            {contexts.map((ctx) => (
              <GuideCard key={ctx.rule.id} ctx={ctx} now={now} guidance={guidance} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function GuideCard({
  ctx,
  now,
  guidance,
}: {
  ctx: ProjectedContext;
  now: number;
  guidance: GuidanceMode;
}) {
  const links = ctx.rule.resources
    .map((r) => ({ label: r.label, url: resourceUrl(r) }))
    .filter((r): r is { label: string; url: string } => r.url !== null);
  const headingId = `guide-${ctx.rule.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;

  return (
    <li className={`guide ${ctx.timing}`} aria-labelledby={headingId}>
      <div className="guide-head">
        <h2 className="guide-title" id={headingId}>
          {ctx.title}
        </h2>
        <span className="guide-when" title={WHEN_TITLE[ctx.timing]}>
          {guideWhen(ctx, now)}
        </span>
      </div>

      {ctx.subtitle && <p className="guide-why">{ctx.subtitle}</p>}
      {guidance === 'new-cmdr' && ctx.rule.guidance?.beginner && (
        <p className="guide-explain">{ctx.rule.guidance.beginner}</p>
      )}

      {ctx.rule.actions && ctx.rule.actions.length > 0 && (
        <ol className="guide-actions">
          {ctx.rule.actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ol>
      )}

      {links.length > 0 && (
        <ul className="guide-links" aria-label={`Guides for ${ctx.title}`}>
          {links.map((link) => (
            <li key={link.url}>
              <button
                type="button"
                className="guide-link"
                onClick={() => void openUrl(link.url)}
                aria-label={`${link.label} (opens the ED Field Manual in your browser)`}
              >
                {link.label}
                <span className="guide-link-go" aria-hidden="true">
                  ↗
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {ctx.rule.note && (
        <p className="guide-note">
          <span className="guide-note-label">EDFM note</span>
          {ctx.rule.note}
        </p>
      )}
    </li>
  );
}
