/**
 * Turning mining into activity: one entry per mining run, with what was refined.
 *
 * ## What the journal says
 *
 * `MiningRefined` is written each time the refinery turns fragments into a unit
 * of cargo -- one tonne -- and carries only `Type` and `Type_Localised`
 * (1,974 of them in the corpus, both fields on every one). One entry per tonne
 * would bury everything else in the journal (a single run in the corpus refined
 * 248 tonnes), so refines are added up into a **run**, recorded once it is over.
 *
 * ## Where a run starts and ends
 *
 * A run starts with its first `MiningRefined` and ends when the commander moves
 * on: `SupercruiseEntry`, `FSDJump`, `Docked`, `Died`, or the session ending
 * (`Shutdown`, or a new `LoadGame` / `Fileheader` after a crash). Measured on
 * the corpus: 18 runs, ended by SupercruiseEntry 12 times, FSDJump 5, Shutdown 1.
 *
 * The place is the body of the last `SupercruiseExit`: a planetary ring on 16 of
 * the 18 runs. A run that ended near a station (refining can finish after
 * arriving) names the system only rather than calling the station the mine.
 *
 * ## Identity
 *
 * The entry's id is the first refine's event id, so re-reading a journal (the
 * startup catch-up, a history rebuild) reproduces it exactly and storage ignores
 * the repeat. Recorded at the run's end, so a run is either complete or absent:
 * never half a total.
 *
 * Local only: mining runs are not part of what EDFM Commander Journal syncs.
 */

import type { NormalizedEvent } from '@edfm/elite-journal';

import type { ActivityContext, ActivityEntry } from './types.js';

const ENDS_A_RUN = new Set(['SupercruiseEntry', 'FSDJump', 'Docked', 'Died', 'Shutdown', 'LoadGame', 'Fileheader']);
const MINING_BODIES = new Set(['PlanetaryRing', 'Planet']);
/** Provenance kept per entry; more is a list nobody reads. */
const MAX_SOURCES = 400;

interface Run {
  readonly firstEventId: string;
  readonly startedAt: string;
  endedAt: string;
  readonly bodyName: string | null;
  readonly systemName: string | null;
  readonly systemAddress: number | null;
  readonly counts: Map<string, { label: string; tonnes: number }>;
  readonly sources: string[];
}

/** `147 t`. */
const tonnes = (n: number) => `${n.toLocaleString('en-GB')} t`;

export class MiningRuns {
  private run: Run | null = null;
  /** The body the commander last dropped out of supercruise at, and its type. */
  private body: { name: string; type: string | null } | null = null;

  reset(): void {
    this.run = null;
    this.body = null;
  }

  /** Feed one event; returns the finished run's entry when this event ends one. */
  observe(event: NormalizedEvent, ctx: ActivityContext): readonly ActivityEntry[] {
    const raw = event.source.raw as Record<string, unknown>;
    const name = event.source.event;

    if (name === 'MiningRefined') {
      // `$Bromellite_name;` and `$bromellite_name;` are one commodity: folded to `bromellite`.
      const type = typeof raw['Type'] === 'string' ? (raw['Type'] as string).trim() : null;
      const symbol = type === null ? null : (/^\$(\w+)_name;$/.exec(type)?.[1] ?? type).toLowerCase();
      if (symbol === null) return [];
      const label = typeof raw['Type_Localised'] === 'string' ? (raw['Type_Localised'] as string) : symbol;
      if (this.run === null) {
        const place = this.body && MINING_BODIES.has(this.body.type ?? '') ? this.body.name : null;
        this.run = {
          firstEventId: event.source.provenance.eventId,
          startedAt: event.source.provenance.timestamp,
          endedAt: event.source.provenance.timestamp,
          bodyName: place,
          // Where it happened, kept from the start: the jump that ends a run
          // has already moved the commander on.
          systemName: ctx.systemName,
          systemAddress: ctx.systemAddress,
          counts: new Map(),
          sources: [],
        };
      }
      const run = this.run;
      run.endedAt = event.source.provenance.timestamp;
      const current = run.counts.get(symbol) ?? { label, tonnes: 0 };
      run.counts.set(symbol, { label: current.label, tonnes: current.tonnes + 1 });
      if (run.sources.length < MAX_SOURCES) run.sources.push(event.source.provenance.eventId);
      return [];
    }

    let finished: readonly ActivityEntry[] = [];
    if (ENDS_A_RUN.has(name) && this.run !== null) {
      finished = [this.entry(this.run, ctx)];
      this.run = null;
    }

    if (name === 'SupercruiseExit') {
      const body = typeof raw['Body'] === 'string' ? (raw['Body'] as string) : null;
      const type = typeof raw['BodyType'] === 'string' ? (raw['BodyType'] as string) : null;
      this.body = body === null ? null : { name: body, type };
    } else if (name === 'SupercruiseEntry' || name === 'FSDJump' || name === 'LoadGame' || name === 'Fileheader') {
      this.body = null;
    }
    return finished;
  }

  private entry(run: Run, ctx: ActivityContext): ActivityEntry {
    const refined = [...run.counts.entries()]
      .map(([commodity, v]) => ({ commodity, label: v.label, tonnes: v.tonnes }))
      .sort((a, b) => b.tonnes - a.tonnes || a.label.localeCompare(b.label));
    const total = refined.reduce((n, r) => n + r.tonnes, 0);
    return {
      id: run.firstEventId,
      commanderFid: ctx.commanderFid,
      occurredAt: run.endedAt,
      category: 'mining',
      subtype: 'mining-run',
      systemName: run.systemName,
      systemAddress: run.systemAddress,
      bodyName: run.bodyName,
      bodyId: null,
      locationName: null,
      title: `Refined ${tonnes(total)}`,
      detail: refined.map((r) => `${r.label} ${tonnes(r.tonnes)}`).join(' · '),
      data: { total, refined, startedAt: run.startedAt, endedAt: run.endedAt },
      sources: run.sources,
    };
  }
}

/** Every mining run's refines, added up: what the Mining filter totals. */
export function miningTotals(
  entries: readonly ActivityEntry[],
): { total: number; refined: ReadonlyArray<{ label: string; tonnes: number }> } {
  const by = new Map<string, { label: string; tonnes: number }>();
  for (const e of entries) {
    if (e.subtype !== 'mining-run' || !Array.isArray(e.data['refined'])) continue;
    for (const r of e.data['refined'] as Array<{ commodity?: unknown; label?: unknown; tonnes?: unknown }>) {
      if (typeof r.commodity !== 'string' || typeof r.tonnes !== 'number') continue;
      const label = typeof r.label === 'string' ? r.label : r.commodity;
      const cur = by.get(r.commodity) ?? { label, tonnes: 0 };
      by.set(r.commodity, { label: cur.label, tonnes: cur.tonnes + r.tonnes });
    }
  }
  const refined = [...by.values()].sort((a, b) => b.tonnes - a.tonnes || a.label.localeCompare(b.label));
  return { total: refined.reduce((n, r) => n + r.tonnes, 0), refined };
}
