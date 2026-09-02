/**
 * Submitter identity, reduced to what independence scoring actually needs.
 *
 * §9 requires two reports to be treated as one unless they came from a
 * different commander FID, a different commander name, and a different journal
 * file. That needs distinguishability -- "are these the same?" -- and nothing
 * else. It does not need the identifiers.
 *
 * So the server stores keyed hashes and never the values. It can still answer
 * the only question it has to answer, and a database dump contains no
 * commander FIDs to leak.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type IdentityMode = 'anonymous' | 'commander';

export interface SubmitterIdentity {
  readonly mode: IdentityMode;
  readonly fid?: string | undefined;
  readonly commanderName?: string | undefined;
  readonly journalFile?: string | undefined;
}

export interface HashedIdentity {
  readonly mode: IdentityMode;
  readonly fidHash: string | null;
  readonly commanderHash: string | null;
  readonly journalHash: string | null;
}

export function hashValue(salt: string, domain: string, value: string): string {
  // Domain separation: without it, a commander whose name equals their journal
  // file name would hash identically in two columns and look like corroboration
  // of itself.
  return createHmac('sha256', salt).update(`${domain}:${value}`).digest('hex').slice(0, 32);
}

export function hashIdentity(salt: string, identity: SubmitterIdentity): HashedIdentity {
  const hash = (domain: string, value: string | undefined): string | null =>
    value === undefined || value === '' ? null : hashValue(salt, domain, value);

  return {
    mode: identity.mode,
    fidHash: hash('fid', identity.fid),
    // Case-folded before hashing: "Hadfield" and "hadfield" are one commander,
    // and hashing preserves the difference unless it is removed first.
    commanderHash: hash('cmdr', identity.commanderName?.toLowerCase()),
    journalHash: hash('journal', identity.journalFile),
  };
}

/**
 * §9's independence rule, applied to hashes.
 *
 * Deliberately conservative, and deliberately fails closed: a missing hash on
 * either side means we cannot show the two differ, so they are treated as the
 * same origin. Over-counting duplicates only slows confirmation down.
 * Under-counting manufactures confidence that was never earned.
 */
export function areIndependent(a: HashedIdentity, b: HashedIdentity): boolean {
  const differs = (x: string | null, y: string | null): boolean =>
    x !== null && y !== null && x !== y;

  return differs(a.fidHash, b.fidHash) && differs(a.commanderHash, b.commanderHash) &&
    differs(a.journalHash, b.journalHash);
}

/**
 * How many of these reports could not have shared an origin.
 *
 * Greedy: walk the reports and keep one only if it is independent of every
 * report already kept. That under-counts in contrived cases, which is the
 * direction this is allowed to be wrong in.
 */
export function independentCount(reports: readonly HashedIdentity[]): number {
  const kept: HashedIdentity[] = [];
  for (const report of reports) {
    if (kept.every((k) => areIndependent(k, report))) kept.push(report);
  }
  return kept.length;
}

/** Constant-time compare, for anything a caller might use as a shared secret. */
export function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
