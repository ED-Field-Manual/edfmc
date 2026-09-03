/**
 * The join between what a construction site needs and what a market sells.
 *
 * These are two different naming schemes for the same commodity:
 *
 *   journal (ColonisationConstructionDepot) : `$ceramiccomposites_name;`
 *   EDDN / market_latest                    : `ceramiccomposites`
 *
 * Measured across 224 journals on 2026-09-03: colonisation events carry **84
 * distinct names for 42 commodities**, because Frontier emits every one in two
 * different cases — `$aluminium_name;` *and* `$Aluminium_name;`. Case-folding
 * is therefore not tidiness. Without it each commodity splits into two
 * requirements, half of which never match a market row.
 *
 * All 84 matched `$<symbol>_name;` exactly, and all 42 folded symbols were
 * present in the live EDDN commodity table, so the join is total rather than
 * approximate. That check is what made the rest of this module worth building.
 */

/** `$<symbol>_name;`. No other shape appeared in the corpus. */
const WRAPPED = /^\$([A-Za-z0-9_]+)_name;$/;

/**
 * Journal commodity name to EDDN symbol.
 *
 * Returns null rather than guessing when the shape is unfamiliar: a commodity
 * whose name Frontier changes must surface as unmatched, not silently become a
 * different commodity.
 */
export function toMarketSymbol(journalName: string): string | null {
  const match = WRAPPED.exec(journalName.trim());
  if (match !== null) return match[1]!.toLowerCase();

  // Already bare (`ceramiccomposites`) — accepted so the same function can
  // normalise values that have been through EDDN or stored locally.
  const bare = journalName.trim().toLowerCase();
  return /^[a-z0-9_]+$/.test(bare) && bare !== '' ? bare : null;
}

/**
 * A display label for a symbol.
 *
 * Prefers whatever Frontier localised, because it is correct in the
 * commander's own language. The fallback only spaces out the symbol, which is
 * imperfect (`cmmcomposite` → `Cmmcomposite`) and deliberately not a curated
 * table: a hand-maintained list of pretty names would drift out of date the
 * first time a commodity was added, and being slightly ugly is better than
 * being confidently wrong about what something is called.
 */
export function displayName(symbol: string, localised?: string | null): string {
  if (localised !== null && localised !== undefined && localised !== '') return localised;
  return symbol.charAt(0).toUpperCase() + symbol.slice(1);
}
