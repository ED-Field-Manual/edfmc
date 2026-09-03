/**
 * Construction projects (§17).
 *
 * §17 says: "Do not implement auto-delivery tracking unless journal data can
 * reliably support it. Research colonisation journal events carefully before
 * claiming this can be automatic."
 *
 * Checked against 224 journals on 2026-09-03. It can.
 * `ColonisationConstructionDepot` fired 5,703 times and carries, at 100%
 * presence, `MarketID`, `ConstructionProgress`, `ConstructionComplete`,
 * `ConstructionFailed`, and a `ResourcesRequired` array giving
 * `RequiredAmount` and `ProvidedAmount` **per commodity**.
 *
 * So remaining is `Required − Provided`, reported by the game rather than
 * inferred from deliveries. That matters: the mission `CargoDepot` equivalent
 * needed careful reconstruction, and this needs none. Each event is a complete
 * snapshot, so nothing has to be accumulated and a missed event cannot corrupt
 * the total — the next one simply supersedes it.
 *
 * The one thing not inferred is which site a delivery was *for*: identity is
 * `MarketID`, and a commander with several sites gets several depots.
 */

import { UNKNOWN, type ColonisationDepotData, type NormalizedEvent } from '@edfm/elite-journal';
import { toMarketSymbol, displayName } from './symbols.js';
import type { Requirement } from './plan.js';

export interface SiteResource {
  /** EDDN symbol, folded — the join key to market data. */
  readonly commodity: string;
  readonly label: string;
  /** Frontier's own name, kept so a mapping mistake stays correctable. */
  readonly journalName: string;
  readonly required: number;
  readonly provided: number;
  readonly remaining: number;
  readonly payment: number | null;
}

export interface ConstructionSite {
  /** MarketID of the depot. Stable identity for the site. */
  readonly marketId: string;
  /** 0..1, as the game reports it. */
  readonly progress: number | null;
  readonly complete: boolean;
  readonly failed: boolean;
  readonly resources: readonly SiteResource[];
  readonly updatedAt: string;
  /** Commander-assigned, so several sites can be ordered by importance. */
  readonly priority: number;
  /** Commander-assigned label; the game does not name depots. */
  readonly name: string | null;
}

/** A depot event is a complete snapshot, so this replaces rather than merges. */
export function siteFromDepot(
  event: NormalizedEvent,
  previous?: ConstructionSite,
): ConstructionSite | null {
  if (event.kind !== 'colonisation-depot') return null;
  const data = event.data as ColonisationDepotData;
  const marketId = data.marketId === UNKNOWN ? null : data.marketId;
  if (marketId === null) return null;

  const resources: SiteResource[] = [];
  for (const r of data.resources) {
    const commodity = toMarketSymbol(r.name);
    // An unrecognised name is dropped rather than guessed at: a requirement
    // pointing at the wrong commodity would send someone to buy the wrong thing.
    if (commodity === null) continue;
    resources.push({
      commodity,
      label: displayName(commodity, r.localised),
      journalName: r.name,
      required: r.required,
      provided: r.provided,
      remaining: Math.max(0, r.required - r.provided),
      payment: r.payment,
    });
  }

  return {
    marketId: String(marketId),
    progress: data.progress === UNKNOWN ? null : data.progress,
    complete: data.complete === UNKNOWN ? false : data.complete,
    failed: data.failed === UNKNOWN ? false : data.failed,
    resources,
    updatedAt: event.source.provenance.timestamp,
    priority: previous?.priority ?? 1,
    name: previous?.name ?? null,
  };
}

/**
 * Combine several sites into one shopping list (§17).
 *
 * "The sourcing plan can purchase the combined quantity and then show how it
 * should be distributed." Buying 10,400 once beats three trips for 4,000,
 * 3,200 and 3,200 of the same thing.
 *
 * Completed and failed sites contribute nothing: a finished site does not need
 * materials, and continuing to shop for one would be actively misleading.
 */
export function combinedRequirements(
  sites: readonly ConstructionSite[],
): readonly Requirement[] {
  const totals = new Map<string, Requirement>();

  for (const site of sites) {
    if (site.complete || site.failed) continue;
    for (const resource of site.resources) {
      if (resource.remaining <= 0) continue;
      const existing = totals.get(resource.commodity);
      totals.set(resource.commodity, {
        commodity: resource.commodity,
        label: resource.label,
        amount: (existing?.amount ?? 0) + resource.remaining,
      });
    }
  }

  // Largest first: it is the order a commander actually plans in, and the
  // hardest requirement to satisfy is the one worth seeing first.
  return [...totals.values()].sort((a, b) => b.amount - a.amount);
}

export interface Allocation {
  readonly marketId: string;
  readonly siteName: string | null;
  readonly amount: number;
}

/**
 * How a purchased quantity should be split between sites.
 *
 * By priority first, then by how much each still needs. Where a purchase
 * cannot cover everything, higher-priority sites are filled first rather than
 * every site receiving a proportional trickle that completes none of them.
 */
export function allocate(
  commodity: string,
  purchased: number,
  sites: readonly ConstructionSite[],
): readonly Allocation[] {
  const claimants = sites
    .filter((s) => !s.complete && !s.failed)
    .map((site) => ({
      site,
      need: site.resources.find((r) => r.commodity === commodity)?.remaining ?? 0,
    }))
    .filter((c) => c.need > 0)
    .sort((a, b) => a.site.priority - b.site.priority || b.need - a.need);

  const out: Allocation[] = [];
  let left = purchased;
  for (const claimant of claimants) {
    if (left <= 0) break;
    const amount = Math.min(claimant.need, left);
    left -= amount;
    out.push({ marketId: claimant.site.marketId, siteName: claimant.site.name, amount });
  }
  return out;
}
