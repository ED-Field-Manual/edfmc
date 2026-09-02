/**
 * Station service verification provider.
 *
 * The first provider, and the reference implementation for the rest. It is
 * deliberately thin: all the accumulation, deduplication and independence logic
 * lives in the engine, so a provider only has to answer "does this event
 * disagree with EDFM, and how?".
 *
 * Station data is `public` visibility throughout. Everything a station reports
 * was shown to the commander the moment they docked, so there is nothing to
 * gate — unlike the body provider that will follow.
 */

import { UNKNOWN, isKnown, type NormalizedEvent } from '@edfm/elite-journal';

import { baselineConfidence, type Volatility } from '../evidence.js';
import type { ProviderFinding, ReferenceSource, VerificationProvider } from '../engine.js';
import { observeStation } from '../observe.js';
import type { StationObservation, StationReference } from '../types.js';
import { PUBLIC } from '../visibility.js';
import type { VerificationObservation } from '../discrepancy.js';

/**
 * How stable each station field is.
 *
 * Services and type rarely change; the controlling faction changes with the
 * background simulation. A mismatch on the latter usually means EDFM is stale
 * rather than wrong, and the report should say so (§12).
 */
const FIELD_VOLATILITY: Record<string, Volatility> = {
  service: 'semi-static',
  stationName: 'static',
  stationType: 'static',
  stationFaction: 'dynamic',
  stationGovernment: 'dynamic',
  stationAllegiance: 'dynamic',
};

/** Carrier services are the owner's configuration, not a fact about the galaxy. */
const NEVER_VERIFIED_TYPES = new Set(['FleetCarrier']);

export interface StationProviderOptions {
  readonly companionVersion: string;
  /**
   * Report services the game has that EDFM lacks.
   *
   * Default false while EDFM's station coverage is unknown: a reference listing
   * five services is far likelier to be incomplete than the game is to be wrong,
   * and a flood of "extra" findings would bury the useful ones.
   */
  readonly reportExtras?: boolean;
}

export function createStationProvider(
  options: StationProviderOptions,
): VerificationProvider {
  return {
    id: 'station-services',
    events: ['Docked', 'ApproachSettlement', 'Location', 'CarrierJump'],

    check(event: NormalizedEvent, reference: ReferenceSource): readonly ProviderFinding[] {
      const observation = observeStation(event);
      if (observation === null) return [];
      if (isKnown(observation.stationType) && NEVER_VERIFIED_TYPES.has(observation.stationType)) {
        return [];
      }

      const entityId = String(observation.marketId);
      const known = reference.lookup('station', entityId) as StationReference | undefined;

      // EDFM has never heard of this station. That is a finding in itself, and a
      // valuable one while EDFM has no station dataset at all -- but it is not a
      // claim that anything is *wrong*.
      if (!known) {
        return [
          {
            kind: 'unknown_edfm_entity',
            observation: build(observation, options, {
              field: 'station',
              expectedValue: null,
              observedValue: observation.stationName,
              rawToken: observation.stationName,
              volatility: 'static',
            }),
          },
        ];
      }

      const findings: ProviderFinding[] = [];
      const observed = new Map(observation.services.map((s) => [s.id, s.raw]));
      const expected = new Set(known.serviceIds.map((id) => id.toLowerCase()));

      for (const id of expected) {
        if (observed.has(id)) continue;
        findings.push({
          kind: 'missing_in_game',
          observation: build(observation, options, {
            field: `service:${id}`,
            expectedValue: 'present',
            observedValue: 'absent',
            rawToken: null,
            volatility: FIELD_VOLATILITY['service'] ?? 'semi-static',
          }),
        });
      }

      if (options.reportExtras ?? false) {
        for (const [id, raw] of observed) {
          if (expected.has(id)) continue;
          findings.push({
            kind: 'missing_in_edfm',
            observation: build(observation, options, {
              field: `service:${id}`,
              expectedValue: 'absent',
              observedValue: 'present',
              // §9: the raw token is the evidence and must travel with the report.
              rawToken: raw,
              volatility: FIELD_VOLATILITY['service'] ?? 'semi-static',
            }),
          });
        }
      }

      if (known.stationName && known.stationName !== observation.stationName) {
        findings.push({
          kind: 'value_mismatch',
          observation: build(observation, options, {
            field: 'stationName',
            expectedValue: known.stationName,
            observedValue: observation.stationName,
            rawToken: observation.stationName,
            volatility: 'static',
          }),
        });
      }

      return findings;
    },
  };
}

function build(
  o: StationObservation,
  options: StationProviderOptions,
  part: {
    field: string;
    expectedValue: string | null;
    observedValue: string | null;
    rawToken: string | null;
    volatility: Volatility;
  },
): VerificationObservation {
  return {
    entityType: 'station',
    entityId: String(o.marketId),
    field: part.field,
    expectedValue: part.expectedValue,
    observedValue: part.observedValue,
    rawToken: part.rawToken,
    // The game stated these outright; nothing here is inferred.
    evidence: 'direct',
    confidence: baselineConfidence('direct', part.volatility),
    volatility: part.volatility,
    // Station data was shown to the commander when they docked.
    visibility: PUBLIC,
    observedAt: o.observedAt,
    commander: o.commander,
    commanderFid: o.commanderFid,
    gameVersion: o.gameVersion,
    gameBuild: o.gameBuild,
    companionVersion: options.companionVersion,
    sourceEventId: o.sourceEventId,
    sourceEvent: o.sourceEvent,
    // The journal file identifies the session, which is what distinguishes a
    // second sighting from a second commander.
    sessionKey: o.sourceEventId.split(':')[0] ?? '',
  };
}

/** Re-exported so callers need not reach past the provider for the sentinel. */
export { UNKNOWN };
