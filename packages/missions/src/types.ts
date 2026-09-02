/**
 * Mission tracking types.
 *
 * Field presence here is measured, not assumed (n=270 MissionAccepted across the
 * validation corpus). Roughly half of accepted missions carry no destination at
 * all, so "no destination given" is a first-class state rather than an error.
 */

import type { Known } from '@edfm/elite-journal';

/**
 * Outcome of a mission.
 *
 * `ended-unknown` exists because the game does not always tell us how a mission
 * finished. If a mission we were tracking is absent from the `Missions`
 * reconciliation snapshot, it ended while we were not watching — and claiming it
 * was "completed" would be inventing an outcome. §8 is explicit that we must not
 * fake mission state the journal does not provide.
 */
export type MissionStatus = 'active' | 'completed' | 'failed' | 'abandoned' | 'ended-unknown';

export type MissionCategory =
  | 'massacre'
  | 'assassination'
  | 'courier'
  | 'delivery'
  | 'collect'
  | 'salvage'
  | 'mining'
  | 'donation'
  | 'hack'
  | 'permit'
  | 'passenger'
  | 'other';

export interface Mission {
  /**
   * Frontier's MissionID.
   *
   * Declared u64. One real value in the corpus — 18446744073709551615 (2^64-1),
   * the colonisation pseudo-mission sentinel, seen 113 times — exceeds JavaScript's
   * safe integer range and loses precision on parse. `idIsReliable` records that,
   * so such a mission is never silently joined against another by a corrupted id.
   */
  readonly missionId: number;
  readonly idIsReliable: boolean;

  /** Raw `Name` from MissionAccepted, e.g. `Mission_Massacre_Legal_Military`. */
  readonly name: string;
  /** Case-folded key. Frontier's own casing is inconsistent (`MISSION_Salvage_Illegal`). */
  readonly typeKey: string;
  readonly category: MissionCategory;
  readonly localisedName: Known<string>;

  readonly faction: Known<string>;
  readonly influence: Known<string>;
  readonly reputation: Known<string>;
  readonly wing: Known<boolean>;

  /** Present on only 54.8% of accepted missions. UNKNOWN means the game did not say. */
  readonly destinationSystem: Known<string>;
  /** Present on only 47.0%. */
  readonly destinationStation: Known<string>;
  /** Present on only 4.8%. */
  readonly destinationSettlement: Known<string>;

  readonly targetFaction: Known<string>;
  readonly target: Known<string>;
  readonly targetType: Known<string>;

  readonly commodity: Known<string>;
  readonly commodityLocalised: Known<string>;
  readonly count: Known<number>;
  readonly killCount: Known<number>;

  /**
   * Delivery progress, from `CargoDepot`.
   *
   * This is the one kind of mission progress Elite genuinely journals, and it is
   * exact rather than inferred: `ItemsDelivered` is cumulative (observed going
   * 540 -> 1512 across two events for one mission) and `TotalItemsToDeliver` is
   * the requirement. Both are 100% present on CargoDepot (n=45).
   *
   * `Progress` on that event is NOT used: it reads 0.000000 on 43 of 45
   * occurrences, so it says nothing.
   *
   * UNKNOWN means no CargoDepot event has been seen for this mission — either it
   * is not a depot mission, or nothing has been delivered yet. It does not mean
   * zero delivered.
   */
  readonly delivered: Known<number>;
  readonly totalToDeliver: Known<number>;
  /** `ItemsCollected`, for missions that source from a start market. */
  readonly collected: Known<number>;

  /**
   * Passenger fields were NOT observed in the validation corpus. They are parsed
   * defensively because Frontier documents them, but nothing here asserts they
   * behave as expected — they will read UNKNOWN until a real sample proves
   * otherwise.
   */
  readonly passengerCount: Known<number>;
  readonly passengerType: Known<string>;
  readonly passengerVips: Known<boolean>;
  readonly passengerWanted: Known<boolean>;

  readonly reward: Known<number>;
  readonly donation: Known<number>;

  /**
   * ISO expiry from MissionAccepted (99.3% present).
   *
   * Deliberately NOT taken from the `Missions` snapshot's `Expires` field, whose
   * units are ambiguous: normal missions report seconds remaining (e.g. 85523),
   * while a colonisation entry reported 1789699599, which is only sensible as a
   * Unix timestamp. Rather than guess per-mission which unit applies, the
   * snapshot is used solely to reconcile *which* missions exist.
   */
  readonly expiry: Known<string>;

  readonly status: MissionStatus;
  /** True once MissionRedirected has moved this mission's destination. */
  readonly redirected: boolean;

  /** When we first saw it accepted, and the event that told us (§27). */
  readonly acceptedAt: string;
  readonly sourceEventId: string;
  readonly gameVersion: string | null;

  /** Set when the mission left `active`, for history and diagnostics. */
  readonly endedAt: string | null;
}

/** A destination with the missions bound for it. */
export interface DestinationGroup {
  readonly system: string;
  /** Null when the game named a system but no station. */
  readonly station: string | null;
  readonly key: string;
  readonly missions: readonly Mission[];

  readonly missionCount: number;
  /**
   * Cargo implied by delivery/collection missions with a commodity and count.
   * Missions without both contribute nothing rather than a guessed zero.
   */
  readonly cargoRequired: number;
  /** True when at least one mission here could not contribute a cargo figure. */
  readonly cargoIncomplete: boolean;
  /** Earliest ISO expiry among these missions, or null if none reported one. */
  readonly earliestExpiry: string | null;
  readonly targetFactions: readonly string[];
  /** Summed only over missions that actually reported a kill count. */
  readonly killsRequired: number;
}

export interface MissionSummary {
  readonly active: number;
  readonly withoutDestination: number;
  readonly expiringSoon: number;
  readonly totalCargo: number;
  readonly categories: Readonly<Record<string, number>>;
}
