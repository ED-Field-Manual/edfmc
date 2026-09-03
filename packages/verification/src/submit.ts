/**
 * Submitting observations to the EDFM API.
 *
 * The client sends **what its game reported**, never a finding. A finding is a
 * claim about what the reference says, and the client does not hold the
 * reference (§19) — the server re-derives every comparison from the observation
 * and its own data. That is what turns a client-side comparison bug into a
 * visible disagreement instead of something that quietly shapes the corpus.
 *
 * Consent is checked at call time, not captured at construction, so revoking it
 * takes effect immediately rather than at the next restart. With consent off,
 * nothing here touches the network.
 */

import { UNKNOWN, type Known } from '@edfm/elite-journal';
import type { StationObservation } from './types.js';

/** §20: anonymous or CMDR-attributed. Both send hashes, never identifiers. */
export type IdentityMode = 'anonymous' | 'commander';

export type SubmitOutcome =
  | { readonly kind: 'accepted'; readonly submissionId: string; readonly findings: number }
  /** Consent is off, or there is nothing to send. No request was made. */
  | { readonly kind: 'skipped'; readonly reason: string }
  /** The server refused the payload. Retrying sends the same mistake again. */
  | { readonly kind: 'rejected'; readonly detail: string }
  /** Offline, timeout, or a server error. Worth retrying later. */
  | { readonly kind: 'unavailable'; readonly detail: string };

export interface SubmitterOptions {
  readonly baseUrl: string;
  readonly isEnabled: () => boolean;
  readonly identityMode: () => IdentityMode;
  readonly clientVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface Submitter {
  submit(observation: StationObservation): Promise<SubmitOutcome>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** `Known<T>` collapses to null: "the game did not say" must not become a value. */
function known<T>(value: Known<T>): T | null {
  return value === UNKNOWN ? null : (value as T);
}

/**
 * Build the request body.
 *
 * Exported so a settings screen can show the commander the exact payload before
 * anything leaves the machine — §21 requires that it be inspectable, and a
 * description of the payload written by hand would drift from the real one.
 */
export function buildSubmission(
  observation: StationObservation,
  mode: IdentityMode,
  clientVersion: string,
): Record<string, unknown> {
  const system = known(observation.systemAddress);
  return {
    observation: {
      marketId: String(observation.marketId),
      stationName: observation.stationName,
      stationType: known(observation.stationType),
      systemName: known(observation.starSystem),
      systemAddress: system === null ? null : String(system),
      // Frontier's own casing, which is the evidence (§9). The server folds it
      // for comparison and quotes the raw token in any report.
      servicesRaw: observation.services.map((s) => s.raw),
      observedAt: observation.observedAt,
      sourceEvent: observation.sourceEvent,
      sourceEventId: observation.sourceEventId,
      gameVersion: observation.gameVersion,
      gameBuild: observation.gameBuild,
      sourceKey: observation.sourceEventId,
      sessionKey: observation.sourceEventId.split(':')[0] ?? 'unknown',
    },
    identity: {
      mode,
      // Sent in both modes, because independence scoring is meaningless without
      // a distinguisher. The server stores a keyed hash and never the value, so
      // attribution is a decision about credit rather than about disclosure.
      fid: observation.commanderFid,
      // Only when the commander chose to be attributed.
      commanderName: mode === 'commander' ? observation.commander : null,
      journalFile: observation.sourceEventId.split(':')[0] ?? null,
    },
    clientVersion,
  };
}

export function createSubmitter(options: SubmitterOptions): Submitter {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const base = options.baseUrl.replace(/\/+$/, '');

  return {
    async submit(observation) {
      if (!options.isEnabled()) {
        return { kind: 'skipped', reason: 'contribution disabled' };
      }
      // Without stable identity there is nothing to attach evidence to.
      if (!Number.isFinite(observation.marketId)) {
        return { kind: 'skipped', reason: 'no market id' };
      }

      const body = buildSubmission(observation, options.identityMode(), options.clientVersion);

      let response: Response;
      try {
        response = await doFetch(`${base}/v1/discrepancies`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Offline is the normal case for a desktop app, not an exception. The
        // queue row is left pending so the next attempt is a clean retry.
        return { kind: 'unavailable', detail: (error as Error).name };
      }

      if (response.status === 429 || response.status >= 500) {
        return { kind: 'unavailable', detail: `http ${response.status}` };
      }
      if (!response.ok) {
        // 4xx is our mistake; sending it again sends the same mistake. The row
        // is marked failed rather than retried forever.
        let detail = `http ${response.status}`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) detail += `: ${payload.error}`;
        } catch {
          /* body was not JSON; the status is enough */
        }
        log('submit.rejected', { status: response.status });
        return { kind: 'rejected', detail };
      }

      try {
        const payload = (await response.json()) as {
          submissionId?: string;
          findings?: number;
        };
        return {
          kind: 'accepted',
          submissionId: String(payload.submissionId ?? ''),
          findings: Number(payload.findings ?? 0),
        };
      } catch {
        // Accepted but unparseable. The submission landed, so it must not be
        // sent again; treating this as a failure would duplicate it.
        return { kind: 'accepted', submissionId: '', findings: 0 };
      }
    },
  };
}
