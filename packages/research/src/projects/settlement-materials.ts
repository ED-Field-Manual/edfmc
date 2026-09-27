/**
 * Settlement Material Distribution — the first research project (§12).
 *
 * The question is whether settlement properties correlate with particular
 * Odyssey material outcomes. We do **not** assume they do. This collects
 * observations so the question can be answered; it draws no conclusions, and
 * nothing downstream is allowed to either (§13).
 *
 * Every field below was measured against a 224-journal, 197,947-line corpus on
 * 2026-09-03. Nothing is here because the documentation implied it.
 */

import type { ResearchProject } from '../types.js';

export const SETTLEMENT_MATERIALS: ResearchProject = {
  id: 'settlement-material-distribution',
  version: 1,
  title: 'Settlement Material Distribution',
  summary:
    'Records what was collected during observed visits to Odyssey settlements, ' +
    'together with the settlement properties the game reports, so any correlation ' +
    'can be measured rather than assumed.',

  /**
   * Settlement identity comes from `ApproachSettlement`, not from the disembark.
   *
   * Measured: `Disembark` carries `StationName` on only 25.8% of events
   * (n=178), so it cannot identify where the commander landed. Every field
   * captured here is present on 100% of `ApproachSettlement` (n=441) except
   * allegiance, which is present on 47.8% and is therefore allowed to be null.
   */
  context: [
    {
      on: 'ApproachSettlement',
      /**
       * Only approaches that are actually settlements.
       *
       * `ApproachSettlement` also fires for Guardian sites -- `$Ancient:#index=3;`
       * ("Ancient Ruins"), `$Ancient_Small_005:#index=1;` ("Guardian Structure").
       * Measured on 2026-09-27: 5 of 462 events, all on game 4.4.1.1, carrying
       * only a name, body and coordinates. Every one of them lacks MarketID,
       * StationEconomy, StationFaction, StationGovernment and StationServices.
       *
       * They are a different kind of place sharing an event name, and without
       * this guard a walk around Guardian ruins opened a settlement session and
       * filed it under an economy of `null`. That is not a thin observation; it
       * is a different subject entirely, and mixing it into the corpus would
       * quietly bias every rate computed from it.
       *
       * MarketID is the test because it is the same identity rule station
       * verification already applies -- no MarketID, no observation -- and it is
       * what distinguishes a place with a market from a ruin.
       */
      when: { kind: 'field', path: 'MarketID', op: 'exists' },
      capture: {
        settlementName: { path: 'Name' },
        marketId: { path: 'MarketID' },
        systemAddress: { path: 'SystemAddress' },
        bodyId: { path: 'BodyID' },
        bodyName: { path: 'BodyName' },
        // The spec's example correlate ("Military", "Industrial") is the
        // station economy; there is no separate settlement-type field.
        economy: { path: 'StationEconomy_Localised', fallbackPath: 'StationEconomy' },
        government: { path: 'StationGovernment_Localised', fallbackPath: 'StationGovernment' },
        // 47.8% present. Null is a real answer here, not a failure.
        allegiance: { path: 'StationAllegiance' },
        controllingFaction: { path: 'StationFaction.Name' },
        factionState: { path: 'StationFaction.FactionState' },
      },
      // Measured session start is typically a minute or two after approach, but
      // a commander may circle first. Thirty minutes is generous; beyond that
      // an approach is stale and must not attach itself to a later disembark.
      expiresAfterSeconds: 1800,
    },
  ],

  /**
   * A session opens on disembarking onto the body that was approached.
   *
   * The body match is what stops an ordinary station walk being recorded as a
   * settlement visit — necessary precisely because `Disembark` usually does not
   * name the station. Both sides must be present and equal; a missing value on
   * either side cannot establish it is the same place.
   */
  start: {
    on: 'Disembark',
    requireContextMatch: {
      bodyId: { path: 'BodyID' },
    },
  },

  /**
   * Endings, measured rather than assumed.
   *
   * The spec proposed "departure/embark/FSD transition". Real data adds two the
   * model did not describe: of 30 measured sessions 27 ended in `Embark`, 2
   * in `Died`, and 1 in `Liftoff` without an embark. A session that ends in death is not a
   * completed visit and must not be counted as one.
   */
  end: ['Embark', 'FSDJump', 'SupercruiseEntry', 'Liftoff', 'Died', 'Shutdown'],
  abortiveEnd: ['Died'],

  /**
   * `CollectItems` is the authoritative record, and `BackpackChange` is not
   * used at all.
   *
   * Measured: 258 of 281 collections appear in both within a second, so using
   * both would nearly double every count. The 17 additions that appear *only*
   * in `BackpackChange` are all consumables — 16 `bypass` (E-Breach) and one
   * grenade — which are bought, crafted or transferred rather than found. So
   * `BackpackChange` contributes noise, not missing signal.
   *
   * The dedupe window is kept anyway: it costs nothing, and it protects the
   * count if Frontier ever emits `CollectItems` twice.
   */
  observe: [
    {
      on: 'CollectItems',
      name: { path: 'Name' },
      label: { path: 'Name_Localised' },
      category: { path: 'Type' },
      count: { path: 'Count' },
      dedupeWindowSeconds: 1,
    },
  ],

  // Measured: 4 of 30 sessions ran under a minute (shortest 17s), an approach
  // and leave rather than a visit. Nothing in the corpus exceeds the upper
  // bound: the longest visit was 34 minutes, so that guard is precautionary.
  minPlausibleSeconds: 60,
  maxPlausibleSeconds: 3600,

  /**
   * Asked for by §12, absent from every journal event.
   *
   * Listed here rather than omitted silently, so the gap reads as a finding
   * instead of an oversight. `ApproachSettlement` carries economy, government,
   * allegiance, faction and faction state — and none of these three.
   */
  unavailableFields: [
    'security',
    'powered/unpowered state',
    'abandoned/active state',
  ],
};
