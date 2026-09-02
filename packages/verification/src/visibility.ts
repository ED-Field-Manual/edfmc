/**
 * Spoiler-safe projection.
 *
 * PRINCIPLE: **Verify aggressively. Reveal conservatively.**
 *
 * The verification engine may compare anything it likes against EDFM's data,
 * including facts this commander has never encountered. The player-facing
 * application may show only what this commander's own game has told them.
 *
 * Those are two different questions and they are answered in two different
 * places. Everything that crosses from the first world to the second must pass
 * through `VisibilityPolicy`, and the type system is used to make that hard to
 * forget: UI-bound data is typed `PlayerSafe<T>`, and the only way to obtain one
 * is to call the policy. A developer adding a widget cannot leak by omission —
 * they would have to reach for `unsafeAssumePlayerSafe` and explain themselves.
 *
 * This is treated as a privacy boundary. The protected resource happens to be
 * undiscovered gameplay rather than personal data, but the failure mode is the
 * same: it is silent, it is irreversible for the person affected, and nobody
 * notices until someone's exploration has already been spoiled.
 */

import { DiscoveryState } from './discovery.js';

declare const PLAYER_SAFE: unique symbol;

/**
 * Data that has passed the visibility policy and may be rendered.
 *
 * The brand is phantom — it costs nothing at runtime and exists purely so that
 * handing raw internal state to a UI component is a type error.
 */
export type PlayerSafe<T> = T & { readonly [PLAYER_SAFE]: true };

/**
 * What a commander must have done before a value may be shown.
 *
 * Modelled on the reveal ladder actually observed in the journal, not on
 * intuition — a commander can know a genus without knowing the species, so
 * those are separate gates rather than one "exobiology" gate.
 */
export type Visibility =
  /** Safe without gating: mechanics, guides, the commander's own current state. */
  | { readonly kind: 'public' }
  /** Requires the commander to have been in the system at all. */
  | { readonly kind: 'system-visited'; readonly systemAddress: number }
  /** Requires a `Scan` of the body (physical properties). */
  | { readonly kind: 'body-scanned'; readonly systemAddress: number; readonly bodyId: number }
  /** Requires FSSBodySignals or SAASignalsFound (counts, no identities). */
  | { readonly kind: 'signals-known'; readonly systemAddress: number; readonly bodyId: number }
  /** Requires a DSS genus list or an organic scan naming this genus. */
  | {
      readonly kind: 'genus-known';
      readonly systemAddress: number;
      readonly bodyId: number;
      readonly genus: string;
    }
  /** Requires ScanOrganic naming this species. The strictest exobiology gate. */
  | {
      readonly kind: 'species-known';
      readonly systemAddress: number;
      readonly bodyId: number;
      readonly species: string;
    }
  /**
   * Never shown to a player under any circumstances. Exists so verification can
   * carry EDFM's expected values around without them being one refactor away
   * from a widget.
   */
  | { readonly kind: 'verification-only' };

export const PUBLIC: Visibility = { kind: 'public' };
export const VERIFICATION_ONLY: Visibility = { kind: 'verification-only' };

/** A value tagged with what it takes to see it. */
export interface Gated<T> {
  readonly value: T;
  readonly visibility: Visibility;
}

export function gated<T>(value: T, visibility: Visibility): Gated<T> {
  return { value, visibility };
}

export function publicFact<T>(value: T): Gated<T> {
  return { value, visibility: PUBLIC };
}

/**
 * Decides what this commander is currently allowed to know.
 *
 * One instance per commander, rebuilt when the commander changes. Holding a
 * policy for the wrong commander would reveal someone else's discoveries, so it
 * takes the DiscoveryState rather than reaching for a global.
 */
export class VisibilityPolicy {
  constructor(private readonly discovery: DiscoveryState) {}

  /** Has this commander earned the right to see something at this gate? */
  isRevealed(visibility: Visibility): boolean {
    switch (visibility.kind) {
      case 'public':
        return true;

      // Never, by construction. Not a judgement call at the call site.
      case 'verification-only':
        return false;

      case 'system-visited':
        return this.discovery.hasVisitedSystem(visibility.systemAddress);

      case 'body-scanned':
        return this.discovery.hasScanned(visibility.systemAddress, visibility.bodyId);

      case 'signals-known':
        return this.discovery.knowsSignalCounts(visibility.systemAddress, visibility.bodyId);

      case 'genus-known':
        return this.discovery.knowsGenus(
          visibility.systemAddress,
          visibility.bodyId,
          visibility.genus,
        );

      case 'species-known':
        return this.discovery.knowsSpecies(
          visibility.systemAddress,
          visibility.bodyId,
          visibility.species,
        );

      default: {
        // An unrecognised gate — from a newer rule set, say — is treated as
        // hidden. Failing closed is the only safe default here: failing open
        // spoils something and cannot be undone.
        return false;
      }
    }
  }

  /** The value if permitted, otherwise null. Null means "do not render". */
  reveal<T>(item: Gated<T>): PlayerSafe<T> | null {
    return this.isRevealed(item.visibility) ? (item.value as PlayerSafe<T>) : null;
  }

  /** Filter a list, dropping anything not yet revealed. */
  revealAll<T>(items: readonly Gated<T>[]): PlayerSafe<T>[] {
    const out: PlayerSafe<T>[] = [];
    for (const item of items) {
      const value = this.reveal(item);
      if (value !== null) out.push(value);
    }
    return out;
  }

  /**
   * Project an object whose fields carry individual gates.
   *
   * Fields the commander may not see are **omitted entirely** rather than set to
   * null or a placeholder. A key that is present-but-empty still tells the
   * player something exists, and a count of hidden items is itself a spoiler.
   */
  project<T extends Record<string, Gated<unknown>>>(
    fields: T,
  ): PlayerSafe<{ [K in keyof T]?: T[K] extends Gated<infer V> ? V : never }> {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(fields)) {
      if (this.isRevealed(item.visibility)) out[key] = item.value;
    }
    return out as PlayerSafe<{ [K in keyof T]?: T[K] extends Gated<infer V> ? V : never }>;
  }
}

/**
 * Escape hatch. Use only for values that never had a spoiler dimension.
 *
 * Named to be conspicuous in review and in a diff. If reaching for this feels
 * convenient, the value probably should have been `publicFact` with a reason,
 * or should not be going to the UI at all.
 */
export function unsafeAssumePlayerSafe<T>(value: T, _reason: string): PlayerSafe<T> {
  return value as PlayerSafe<T>;
}
