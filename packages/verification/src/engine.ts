/**
 * The verification engine.
 *
 * Providers turn (journal event + EDFM reference) into observations; the engine
 * accumulates them into discrepancies, applies deduplication and independence
 * rules, and decides what — if anything — is worth notifying about.
 *
 * The engine knows nothing about stations, bodies or species. Adding body
 * verification later is a new provider, not a change here.
 */

import type { NormalizedEvent } from '@edfm/elite-journal';

import { canRaiseDiscrepancy } from './evidence.js';
import {
  applyObservation,
  discrepancyKey,
  shouldNotify,
  type Discrepancy,
  type DiscrepancyKind,
  type VerificationObservation,
} from './discrepancy.js';
import type { DiscoveryState } from './discovery.js';

/** What a provider produces: an observation plus how to classify it. */
export interface ProviderFinding {
  readonly observation: VerificationObservation;
  readonly kind: DiscrepancyKind;
}

/**
 * Reference data lookup.
 *
 * Deliberately narrow and async-free: providers must not perform I/O mid-event.
 * The caller supplies whatever reference is already loaded, and a provider that
 * has nothing to compare against simply returns no findings.
 */
export interface ReferenceSource {
  /** EDFM's record for an entity, or undefined when EDFM has never heard of it. */
  lookup(entityType: string, entityId: string): unknown | undefined;
}

export interface VerificationProvider {
  readonly id: string;
  /** Journal event names this provider cares about. Keeps dispatch cheap. */
  readonly events: readonly string[];
  /**
   * Compare one event against reference data.
   *
   * Returning an empty array is the overwhelmingly common case — §9 requires
   * that nothing happens when the data agrees.
   */
  check(event: NormalizedEvent, reference: ReferenceSource): readonly ProviderFinding[];
}

export interface EngineOptions {
  /**
   * Discovery state for the current commander.
   *
   * The engine does not use it to decide what to *verify* — verification is
   * aggressive and may compare things the commander has never seen. It is here
   * so findings can be tagged for later redaction without a second lookup.
   */
  readonly discovery?: DiscoveryState;
  readonly onNotify?: (event: NotifyEvent) => void;
}

export interface NotifyEvent {
  readonly reason: 'created' | 'confirmed' | 'conflicting';
  readonly discrepancy: Discrepancy;
}

export class VerificationEngine {
  private readonly providers = new Map<string, VerificationProvider>();
  /** event name -> providers interested in it */
  private readonly byEvent = new Map<string, VerificationProvider[]>();
  private readonly discrepancies = new Map<string, Discrepancy>();
  private readonly options: EngineOptions;

  /** Observations checked, for the Contributions screen (§15). */
  private checked = 0;
  private matched = 0;

  constructor(options: EngineOptions = {}) {
    this.options = options;
  }

  register(provider: VerificationProvider): void {
    this.providers.set(provider.id, provider);
    for (const event of provider.events) {
      const list = this.byEvent.get(event);
      if (list) list.push(provider);
      else this.byEvent.set(event, [provider]);
    }
  }

  /**
   * Run every interested provider over one event.
   *
   * Returns the discrepancies that changed, so a caller can persist or submit
   * only what moved rather than re-walking the whole set.
   */
  observe(event: NormalizedEvent, reference: ReferenceSource): readonly Discrepancy[] {
    const providers = this.byEvent.get(event.source.event);
    if (!providers || providers.length === 0) return [];

    const changed: Discrepancy[] = [];

    for (const provider of providers) {
      let findings: readonly ProviderFinding[];
      try {
        findings = provider.check(event, reference);
      } catch {
        // A broken provider must not stop ingest or the other providers.
        continue;
      }

      this.checked += 1;
      if (findings.length === 0) {
        this.matched += 1;
        continue;
      }

      for (const finding of findings) {
        // INFERRED never becomes a correction to EDFM. It can exist, be logged,
        // and inform the UI, but it is not evidence that anyone is wrong.
        if (!canRaiseDiscrepancy(finding.observation.evidence)) continue;

        const key = discrepancyKey(finding.observation);
        const before = this.discrepancies.get(key);
        const after = applyObservation(before, finding.observation, finding.kind);

        if (after === before) continue; // duplicate source event

        this.discrepancies.set(key, after);
        changed.push(after);

        const reason = shouldNotify(before, after);
        if (reason && this.options.onNotify) {
          this.options.onNotify({ reason, discrepancy: after });
        }
      }
    }

    return changed;
  }

  all(): readonly Discrepancy[] {
    return [...this.discrepancies.values()];
  }

  get(key: string): Discrepancy | undefined {
    return this.discrepancies.get(key);
  }

  /** Counters for the Contributions screen. Aggregates only, never details. */
  stats(): {
    checked: number;
    matched: number;
    discrepancies: number;
    independentlyConfirmed: number;
    conflicting: number;
  } {
    const all = this.all();
    return {
      checked: this.checked,
      matched: this.matched,
      discrepancies: all.length,
      independentlyConfirmed: all.filter((d) => d.independentConfirmations >= 2).length,
      conflicting: all.filter((d) => d.status === 'conflicting').length,
    };
  }

  /** Seed from persisted discrepancies on startup. */
  load(discrepancies: readonly Discrepancy[]): void {
    for (const d of discrepancies) this.discrepancies.set(d.key, d);
  }
}

/** A reference source backed by a plain map. Used in tests and offline. */
export function mapReference(
  data: Map<string, unknown> | Record<string, unknown>,
): ReferenceSource {
  const map = data instanceof Map ? data : new Map(Object.entries(data));
  return {
    lookup(entityType, entityId) {
      return map.get(`${entityType}:${entityId}`);
    },
  };
}

/** A reference source that knows nothing. The current real-world state. */
export const EMPTY_REFERENCE: ReferenceSource = {
  lookup() {
    return undefined;
  },
};
