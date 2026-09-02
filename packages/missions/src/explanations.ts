/**
 * Plain-language explanations of what a mission type actually asks of you.
 *
 * **This is editorial content, not derived data.** The journal does not
 * distinguish "source and return" from a delivery where cargo is handed to you —
 * `Mission_Collect_Industrial` and `Mission_Delivery_Boom` both carry a
 * `Commodity` and a `Count` and nothing else that separates them. The difference
 * is game mechanics, which only a human reference knows.
 *
 * It is bundled here so the feature works today, but it is structured exactly
 * like the context rules — versioned, keyed, replaceable — so EDFM can serve it
 * later and correct it without a client release. See docs/MISSIONS.md.
 *
 * Wording rules for anything added here:
 *  - describe only what the mission requires, not tactics or best routes;
 *  - never state a mechanic that cannot be checked against the game;
 *  - keep it to one or two sentences, because it renders under every mission.
 */

import { isKnown } from '@edfm/elite-journal';

import type { Mission, MissionCategory } from './types.js';

export const EXPLANATIONS_VERSION = 1;

const BY_CATEGORY: Partial<Record<MissionCategory, string>> = {
  collect:
    'Source and return: you acquire the commodity yourself — buy, mine or salvage it — ' +
    'and deliver it. Nothing is provided, and you pay for what you buy.',
  delivery: 'The cargo is provided when you accept. Carry it to the destination intact.',
  courier: 'Carries data rather than cargo, so it needs no hold space.',
  salvage: 'Recover the stated items and bring them back. You have to locate them yourself.',
  mining: 'Mine and refine the stated commodity yourself, then deliver it.',
  massacre: 'Destroy the stated number of ships belonging to the target faction.',
  assassination: 'Destroy one specific named target.',
  hack: 'Gain access to a stated terminal or system, usually at a settlement.',
  permit: 'Completing this grants a system permit.',
  passenger: 'Carry passengers. Needs cabins of a class that suits them.',
};

/**
 * Explanation for a mission, or null when we have nothing useful to say.
 *
 * Returning null rather than filler matters: a vague line under every mission
 * trains the eye to skip the ones that are worth reading.
 */
export function explainMission(mission: Mission): string | null {
  // Donations split on data rather than on category. Mission_Altruism and
  // Mission_AltruismCredits are both 'donation', but one wants a commodity you
  // have to source and the other wants money — a materially different job.
  if (mission.category === 'donation') {
    return isKnown(mission.commodity)
      ? 'Donate the stated commodity. You source it yourself; nothing is provided, ' +
          'and there is no payment for the goods.'
      : 'Donate credits. No cargo is involved.';
  }

  return BY_CATEGORY[mission.category] ?? null;
}

/**
 * A caveat about what the journal cannot tell us, shown alongside the mission.
 *
 * Kept separate from the explanation because it is a statement about the
 * Companion's own limits, not about the mission — and §8 requires being explicit
 * that no progress is being tracked rather than leaving the absence to be noticed.
 */
export function missionCaveat(mission: Mission): string | null {
  if (mission.category === 'massacre' || mission.category === 'assassination') {
    return 'Elite does not record kill progress in the journal, so this shows the requirement, not how many remain.';
  }
  return null;
}
