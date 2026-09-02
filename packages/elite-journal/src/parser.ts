/**
 * Line -> RawJournalEvent.
 *
 * This layer is deliberately dumb: it does not know what any event means. Its only
 * jobs are (a) never throwing on bad input, and (b) distinguishing malformed JSON
 * from valid-but-unsupported content, per §3.
 */

import type { EventProvenance, IngestResult, RawJournalEvent } from './types.js';

const EXCERPT_LIMIT = 200;

/**
 * Tracks the header/identity context that later events inherit.
 *
 * Rebuilt per journal file, because `Fileheader` is per file. Commander identity is
 * carried forward within a file once `Commander`/`LoadGame` is seen.
 *
 * Note: a journal is NOT guaranteed to start with a Fileheader — the corpus contains
 * two zero-byte files, and a tailer resuming mid-file will never see the header at
 * all. Every field here is therefore nullable and stays null rather than guessing.
 */
export class JournalSessionContext {
  gameVersion: string | null = null;
  build: string | null = null;
  odyssey: boolean | null = null;
  part: number | null = null;
  commander: string | null = null;
  fid: string | null = null;

  /** Seed from a previously persisted context so a mid-file resume is not blind. */
  static restore(seed: Partial<JournalSessionContext>): JournalSessionContext {
    const ctx = new JournalSessionContext();
    Object.assign(ctx, seed);
    return ctx;
  }

  /** Absorb identity-bearing events. Silently ignores anything of the wrong type. */
  observe(event: string, raw: Readonly<Record<string, unknown>>): void {
    if (event === 'Fileheader' || event === 'LoadGame') {
      if (typeof raw['gameversion'] === 'string') this.gameVersion = raw['gameversion'];
      if (typeof raw['build'] === 'string') this.build = raw['build'];
      if (typeof raw['Odyssey'] === 'boolean') this.odyssey = raw['Odyssey'];
      if (typeof raw['part'] === 'number') this.part = raw['part'];
    }
    if (event === 'Commander' || event === 'LoadGame' || event === 'NewCommander') {
      // `Name` on Commander/NewCommander, `Commander` on LoadGame.
      const name = raw['Name'] ?? raw['Commander'];
      if (typeof name === 'string' && name.length > 0) this.commander = name;
      if (typeof raw['FID'] === 'string') this.fid = raw['FID'];
    }
  }

  snapshot(): Pick<
    EventProvenance,
    'gameVersion' | 'build' | 'odyssey' | 'part' | 'commander' | 'fid'
  > {
    return {
      gameVersion: this.gameVersion,
      build: this.build,
      odyssey: this.odyssey,
      part: this.part,
      commander: this.commander,
      fid: this.fid,
    };
  }
}

function excerpt(line: string): string {
  return line.length > EXCERPT_LIMIT ? `${line.slice(0, EXCERPT_LIMIT)}...` : line;
}

/**
 * Parse a single journal line.
 *
 * `context` is mutated as identity events are seen, so callers must feed lines in
 * file order. The returned provenance is a snapshot taken at parse time.
 */
export function parseLine(
  line: string,
  sourceFile: string,
  byteOffset: number,
  context: JournalSessionContext,
): IngestResult | null {
  // Blank lines are normal padding in these files, not errors.
  if (line.trim().length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    return {
      ok: false,
      failure: {
        reason: 'malformed-json',
        sourceFile,
        byteOffset,
        excerpt: excerpt(line),
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      failure: {
        reason: 'not-an-object',
        sourceFile,
        byteOffset,
        excerpt: excerpt(line),
        error: null,
      },
    };
  }

  const raw = parsed as Record<string, unknown>;
  const eventName = raw['event'];

  if (typeof eventName !== 'string' || eventName.length === 0) {
    return {
      ok: false,
      failure: {
        reason: 'missing-event-field',
        sourceFile,
        byteOffset,
        excerpt: excerpt(line),
        error: null,
      },
    };
  }

  context.observe(eventName, raw);

  // `timestamp` was present on 100% of the corpus, but a missing one must not throw.
  const rawTs = raw['timestamp'];
  const timestamp = typeof rawTs === 'string' ? rawTs : '';
  const parsedMs = timestamp ? Date.parse(timestamp) : Number.NaN;

  const provenance: EventProvenance = {
    eventId: `${sourceFile}:${byteOffset}`,
    sourceFile,
    byteOffset,
    timestamp,
    timestampMs: Number.isNaN(parsedMs) ? null : parsedMs,
    ...context.snapshot(),
  };

  const event: RawJournalEvent = { event: eventName, raw, provenance };
  return { ok: true, event };
}
