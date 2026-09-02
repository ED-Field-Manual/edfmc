/**
 * The single place where internal state becomes player-visible data.
 *
 * PRINCIPLE: **Verify aggressively. Reveal conservatively.**
 *
 * Everything the UI and overlay render for spoiler-sensitive subjects must come
 * out of this module. Components are not trusted to remember the rules — a
 * widget written next year should not be able to leak by forgetting a
 * conditional, only by deliberately reaching for `unsafeAssumePlayerSafe` and
 * writing down why.
 *
 * What is NOT gated, and why:
 *
 *   Dashboard, Missions, travel state and station data are all things this
 *   commander's own game reported about their own current situation. They were
 *   on screen in Elite before they were on screen here. Gating them would be
 *   theatre.
 *
 * What IS gated:
 *
 *   Anything sourced from EDFM or from verification — reference values, expected
 *   service lists, and context resources that name a specific discovery. Those
 *   can describe things this commander has never seen.
 */

import {
  VisibilityPolicy,
  gated,
  PUBLIC,
  type DiscoveryState,
  type Gated,
  type PlayerSafe,
  type Visibility,
} from '@edfm/verification';
import { isKnown, type CommanderState } from '@edfm/elite-journal';
import type { ContextResource, ResourceGate } from '@edfm/context';

/**
 * Turn a rule's declarative gate into a concrete visibility check.
 *
 * Gates are written against "the current body" because that is what a context
 * rule can express without knowing where the commander is. Resolving them needs
 * the commander's position, which is why this lives here rather than in the
 * rule set.
 *
 * A gate that cannot be resolved — a species gate with no current body, say —
 * becomes `verification-only`, i.e. hidden. Failing closed is the only safe
 * default: failing open spoils something, and that cannot be undone.
 */
export function resolveGate(gate: ResourceGate | undefined, state: CommanderState): Visibility {
  if (!gate) return PUBLIC;

  const systemAddress = isKnown(state.systemAddress) ? state.systemAddress : null;
  const bodyId = isKnown(state.bodyId) ? state.bodyId : null;
  if (systemAddress === null || bodyId === null) {
    return { kind: 'verification-only' };
  }

  switch (gate.kind) {
    case 'genus':
      return { kind: 'genus-known', systemAddress, bodyId, genus: gate.genus };
    case 'species':
      return { kind: 'species-known', systemAddress, bodyId, species: gate.species };
    case 'body-scanned':
      return { kind: 'body-scanned', systemAddress, bodyId };
    case 'signals-known':
      return { kind: 'signals-known', systemAddress, bodyId };
    default:
      // An unrecognised gate from a newer rule set. Hidden, not shown.
      return { kind: 'verification-only' };
  }
}

/**
 * Filter context resources down to what this commander may see.
 *
 * The resolver still *matches* rules containing gated resources — verification
 * and context resolution are allowed to know more than the player. Only the
 * projection to the UI removes them.
 *
 * Removed entirely rather than replaced with a placeholder: "1 more resource
 * hidden" tells the commander there is something to find, which is the spoiler
 * in miniature.
 */
export function projectResources(
  resources: readonly ContextResource[],
  state: CommanderState,
  policy: VisibilityPolicy,
): PlayerSafe<ContextResource>[] {
  const items: Gated<ContextResource>[] = resources.map((resource) =>
    gated(resource, resolveGate(resource.requires, state)),
  );
  return policy.revealAll(items);
}

/** Build a policy for the current commander's discoveries. */
export function policyFor(discovery: DiscoveryState): VisibilityPolicy {
  return new VisibilityPolicy(discovery);
}
