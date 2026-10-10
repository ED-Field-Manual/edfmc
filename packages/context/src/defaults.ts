/**
 * Bundled context rules — version 2.
 *
 * This is the "small verified set" §6 asks for. Two kinds of verification went into
 * it, and both matter:
 *
 *  - **Every `page` title below was checked against a live listing of EDFM's pages**
 *    (MediaWiki `list=allpages`, 2026-09-01). No rule links to a page that does not
 *    exist. Inventing plausible-looking titles would produce broken links that look
 *    authoritative, which is the exact failure mode the project is built to avoid.
 *  - **Every trigger was checked against the 197,164-line journal corpus.** Each
 *    event named here actually occurs, and each service token was observed in real
 *    `StationServices` arrays.
 *
 * Several contexts named in the original brief are deliberately ABSENT because EDFM
 * has no corresponding page yet: settlement guides, mission-type guides, a
 * crime/security guide, and an Odyssey materials guide. Those are content gaps, not
 * code gaps — see docs/CONTEXT.md. Rules for them belong in a rule-set update once
 * the pages exist, which is why rules are versioned data rather than code.
 *
 * This bundled copy is what the app uses, and is designed to remain the offline
 * fallback (§22) once a server-supplied set exists. That delivery path is not
 * built yet.
 *
 * Version 2 (2026-10-09) reviewed every rule against the journal corpus again:
 * station rules need the commander to be docked, the planetary-mining rule
 * reports locations rather than materials and also reads FSS results, and the
 * interdiction rule no longer gives instructions for a fight the journal only
 * records once it is over. Each change is explained where it was made.
 *
 * "Docked" is the commander's state, not a station's advertised list: an
 * `ApproachSettlement` line carries the settlement's services too (465 of 470
 * approaches, 91 listing Vista Genomics and 72 Pioneer Supplies), and approaching
 * a place is not being able to use it.
 */

import type { ContextRuleSet } from './types.js';

/** The commander is docked: the services in state are ones they can use. */
const DOCKED = { kind: 'state', path: 'docking', op: 'eq', value: 'docked' } as const;

export const BUNDLED_RULES: ContextRuleSet = {
  version: 2,
  updatedAt: '2026-10-09T00:00:00Z',
  source: 'bundled',
  rules: [
    /* ------------------------------------------------------------- combat */
    /*
     * `Interdicted` is written when the interdiction is already over: it is the
     * losing (or submitting) outcome, and `EscapeInterdiction` the winning one.
     * Measured: 107 Interdicted lines, the next event almost always
     * `SupercruiseExit`, and 103 of them `Submitted: true`. Version 1 told the
     * commander to "follow the blue circle to fight" -- a struggle that had
     * finished before the line existed. Now it says what is true: you are out of
     * supercruise, and here is how interdictions work.
     */
    {
      id: 'interdicted',
      title: 'Interdicted',
      subtitle: 'You were pulled out of supercruise',
      when: { kind: 'event', name: 'Interdicted' },
      // Highest priority in the set: the commander may be under attack.
      priority: 95,
      ttlSeconds: 180,
      // Over once the commander is moving again: back in supercruise, docked, jumped, or dead.
      endsOn: ['EscapeInterdiction', 'SupercruiseEntry', 'Docked', 'FSDJump', 'Died'],
      guidance: {
        topic: 'navigation',
        beginner:
          'An interdiction pulls you out of supercruise. Next time you can fight it, or submit by cutting your throttle.',
      },
      resources: [{ label: 'Frame Shift Drive Interdictor', page: 'Frame Shift Drive Interdictor' }],
      // Editorial guidance from the project owner (edfieldmanual.com), not derived
      // from journal data — that is exactly what `note` is for.
      note: 'Submitting voluntarily lets your FSD recharge faster, so you can potentially escape sooner.',
    },

    /* ------------------------------------------------------- colonisation */
    {
      id: 'colonisation-depot',
      title: 'Colonisation construction',
      subtitle: 'At a construction site that needs deliveries',
      when: { kind: 'event', name: 'ColonisationConstructionDepot' },
      priority: 85,
      ttlSeconds: 900,
      // Leaving the depot ends it; while still there the event keeps re-firing.
      endsOn: ['Undocked', 'FSDJump', 'SupercruiseEntry'],
      resources: [
        { label: 'Colonisation', page: 'Colonisation' },
        { label: 'Trailblazers', page: 'Trailblazers' },
        { label: 'Pioneer Supplies', page: 'Pioneer Supplies' },
      ],
    },
    {
      id: 'station-pioneer-supplies',
      title: 'Pioneer Supplies',
      subtitle: 'This station sells colonisation supplies',
      when: { kind: 'all', of: [DOCKED, { kind: 'service', id: 'pioneersupplies' }] },
      priority: 45,
      ttlSeconds: 1800,
      resources: [
        { label: 'Pioneer Supplies', page: 'Pioneer Supplies' },
        { label: 'Colonisation', page: 'Colonisation' },
      ],
    },

    /* --------------------------------------------------------- exobiology */
    {
      id: 'exobiology-scan',
      title: 'Exobiology sampling',
      // The commander's own scan names the species (Species_Localised on all 487
      // ScanOrganic lines), so naming it reveals nothing they have not seen.
      subtitle: 'Sampling {event.Species_Localised}',
      subtitleFallback: 'Sampling organisms on foot',
      when: { kind: 'event', name: 'ScanOrganic' },
      priority: 80,
      ttlSeconds: 600,
      /*
       * Deliberately NOT ended by Liftoff, which was the original mistake.
       *
       * Lifting off looks like leaving, and is actually how a commander travels
       * between patches on the same body. Measured: of 196 liftoffs that followed
       * an organic scan, 169 were followed by more scanning, at a median gap of 63
       * seconds, and 148 of those resumed within five minutes. Ending here made
       * the context vanish at exactly the moment it was still wanted -- on the way
       * to the next patch.
       *
       * The same check was run against every other endsOn list in this file.
       * Engineering ends on Undocked 88 times out of 88 and mining ends on leaving
       * the ring; only this one was wrong.
       */
      endsOn: ['FSDJump', 'Docked', 'SellOrganicData'],
      guidance: {
        topic: 'exobiology',
        beginner:
          'Three samples of the same species are needed, taken a short distance apart. The third completes it.',
      },
      resources: [{ label: 'Exobiology', page: 'Exobiology' }],
    },
    /*
     * Vista Genomics, but only when there is something to sell.
     *
     * The service is present at 155 of 295 stations -- over half, including fleet
     * carriers -- so on its own it fires constantly and told commanders to sell data
     * they did not have.
     *
     * Gating it needs a holdings figure the journal never states: neither `Backpack`
     * (suit inventory) nor `Materials` (engineering stock) includes organic data. So
     * `exobiologyToSell` accumulates completed `Analyse` scans and subtracts what
     * sales report, and is treated as a lower bound rather than a total. See its
     * doc comment for why a death resets it, and why that is the conservative
     * choice rather than a claim about the mechanic.
     */
    {
      id: 'station-vista-genomics',
      title: 'Selling exobiology data',
      subtitle: 'This station has Vista Genomics, and you have unsold data',
      when: {
        kind: 'all',
        of: [
          DOCKED,
          { kind: 'service', id: 'vistagenomics' },
          { kind: 'state', path: 'exobiologyToSell', op: 'gt', value: 0 },
        ],
      },
      priority: 55,
      ttlSeconds: 1800,
      guidance: {
        topic: 'exobiology',
        beginner:
          'Vista Genomics is the only place exobiology data can be sold, and it is lost if you are destroyed first.',
      },
      resources: [{ label: 'Exobiology', page: 'Exobiology' }],
    },

    /* -------------------------------------------------------- engineering */
    /*
     * Engineering is triggered by *activity*, not by a station service.
     *
     * There was previously a rule keyed on the `engineer` service token, which was
     * wrong: that token appears at 227 of 242 distinct stations in the corpus —
     * including all 17 Fleet Carriers — so it does not mean "at an Engineer". It
     * reported "At an Engineer" while docked at the commander's own carrier.
     *
     * `tuning` was evaluated as an alternative and rejected too: 103 of 266
     * stations, including Lave Station and Hutton Orbital. Its actual meaning is
     * unverified, and a rule built on an unverified token is a guess.
     *
     * EngineerCraft / EngineerProgress / EngineerContribution are unambiguous —
     * they only occur when the commander is actually engineering something.
     * Recognising the *station* as an Engineer needs a station-identity list,
     * which is reference data belonging server-side. See docs/CONTEXT.md.
     */
    {
      id: 'engineering-activity',
      title: 'Engineering',
      // All three triggers name the Engineer (817/817 EngineerCraft, 5/5
      // EngineerContribution, and every single-change EngineerProgress).
      subtitle: 'Working with {event.Engineer}',
      subtitleFallback: 'Recent engineering activity',
      when: {
        kind: 'any',
        of: [
          // Unambiguous: only emitted when something is actually being modified.
          { kind: 'event', name: 'EngineerCraft' },
          { kind: 'event', name: 'EngineerContribution' },
          /*
           * EngineerProgress has two shapes, and only one of them means anything
           * happened. 277 of 338 occurrences in the corpus carry an `Engineers`
           * array — a full progress summary emitted at startup and periodically
           * through a session, regardless of what the commander is doing. Keying
           * on the event name alone made "Engineering" appear while parked on a
           * Fleet Carrier.
           *
           * The remaining 61 omit that array and describe a single real change.
           */
          {
            kind: 'all',
            of: [
              { kind: 'event', name: 'EngineerProgress' },
              { kind: 'not', of: { kind: 'field', path: 'Engineers', op: 'exists' } },
            ],
          },
        ],
      },
      priority: 75,
      ttlSeconds: 300,
      // Engineering happens docked or landed, so leaving ends it. This is the case that was reported: "Engineering" shown at a station three systems from the Engineer.
      endsOn: ['Undocked', 'Liftoff', 'FSDJump', 'SupercruiseEntry'],
      resources: [
        { label: 'Engineering', page: 'Engineering' },
        { label: 'Engineering Blueprints', page: 'Engineering Blueprints' },
        { label: 'Engineers', page: 'Engineers' },
        { label: 'Engineer Unlock Guide', page: 'Engineer Unlock Guide' },
      ],
    },
    /*
     * Material Traders, by kind.
     *
     * `StationServices` carries only the bare token `materialtrader` and never
     * says which of the three kinds the station has -- measured over 141 docks at
     * trader stations, with no field in any event naming the type. The type comes
     * from `MaterialTrade.TraderType`, so it is known for stations the commander
     * has actually traded at and UNKNOWN elsewhere. See `learnTrader`.
     *
     * Inferring it from station economy was measured and rejected: High Tech gave
     * `encoded` 7 times but `raw` once, Industrial gave `manufactured` 10 times
     * but `raw` twice, and Extraction produced all three. A rule built on that
     * would confidently name the wrong trader.
     *
     * Hence four rules rather than one. The typed three are worth the duplication
     * because which kind it is, is the whole question a commander has when they see
     * a trader -- and the untyped rule still fires when the answer is not known,
     * so nothing is lost by not knowing.
     */
    {
      id: 'station-material-trader-encoded',
      title: 'Encoded Material Trader',
      subtitle: 'This station trades encoded materials',
      when: {
        kind: 'all',
        of: [
          DOCKED,
          { kind: 'service', id: 'materialtrader' },
          { kind: 'state', path: 'traderType', op: 'eq', value: 'encoded' },
        ],
      },
      // Above the untyped rule so the specific entry wins when both could match.
      // They are mutually exclusive by construction, but the ordering documents
      // the intent rather than relying on it.
      priority: 58,
      ttlSeconds: 1800,
      guidance: {
        topic: 'engineering',
        beginner:
          'Material Traders swap engineering materials within one category. This one handles Encoded data.',
      },
      resources: [
        {
          label: 'Material Traders',
          page: 'Engineering Materials#Material Traders',
        },
      ],
    },
    {
      id: 'station-material-trader-raw',
      title: 'Raw Material Trader',
      subtitle: 'This station trades raw materials',
      when: {
        kind: 'all',
        of: [
          DOCKED,
          { kind: 'service', id: 'materialtrader' },
          { kind: 'state', path: 'traderType', op: 'eq', value: 'raw' },
        ],
      },
      // Above the untyped rule so the specific entry wins when both could match.
      // They are mutually exclusive by construction, but the ordering documents
      // the intent rather than relying on it.
      priority: 58,
      ttlSeconds: 1800,
      guidance: {
        topic: 'engineering',
        beginner:
          'Material Traders swap engineering materials within one category. This one handles Raw elements.',
      },
      resources: [
        {
          label: 'Material Traders',
          page: 'Engineering Materials#Material Traders',
        },
      ],
    },
    {
      id: 'station-material-trader-manufactured',
      title: 'Manufactured Material Trader',
      subtitle: 'This station trades manufactured materials',
      when: {
        kind: 'all',
        of: [
          DOCKED,
          { kind: 'service', id: 'materialtrader' },
          { kind: 'state', path: 'traderType', op: 'eq', value: 'manufactured' },
        ],
      },
      // Above the untyped rule so the specific entry wins when both could match.
      // They are mutually exclusive by construction, but the ordering documents
      // the intent rather than relying on it.
      priority: 58,
      ttlSeconds: 1800,
      guidance: {
        topic: 'engineering',
        beginner:
          'Material Traders swap engineering materials within one category. This one handles Manufactured components.',
      },
      resources: [
        {
          label: 'Material Traders',
          page: 'Engineering Materials#Material Traders',
        },
      ],
    },
    {
      id: 'station-material-trader',
      title: 'Material Trader',
      // Deliberately does not name a kind. Fires only while the kind is genuinely
      // unestablished, so it degrades to the honest statement rather than guessing.
      subtitle: 'Its type shows here once you have traded at this station',
      when: {
        kind: 'all',
        of: [
          DOCKED,
          { kind: 'service', id: 'materialtrader' },
          { kind: 'not', of: { kind: 'state', path: 'traderType', op: 'exists' } },
        ],
      },
      priority: 55,
      ttlSeconds: 1800,
      resources: [
        {
          label: 'Material Traders',
          page: 'Engineering Materials#Material Traders',
        },
      ],
    },

    /* ------------------------------------------------------------- mining */
    {
      id: 'mining-prospecting',
      title: 'Asteroid mining',
      subtitle: 'Prospecting asteroids',
      when: { kind: 'event', name: 'ProspectedAsteroid' },
      priority: 70,
      ttlSeconds: 600,
      // Leaving the ring ends the mining session.
      endsOn: ['Docked', 'FSDJump', 'SupercruiseEntry'],
      resources: [
        { label: 'Mining', page: 'Mining' },
        { label: 'Laser Mining', page: 'Laser Mining' },
        { label: 'Core Mining', page: 'Core Mining' },
        { label: 'How to Use a Prospector Limpet', page: 'How to Use a Prospector Limpet' },
      ],
    },
    /*
     * `SAASignalsFound` fires for EVERY detailed surface scan, not just rings.
     * Measured: 198 events, of which only 29 are rings -- so keying on the event
     * name alone was wrong 85% of the time, and the overlay announced "Ring
     * scanned -- hotspot signals found" after DSS-ing a planet.
     *
     * The same trap as `ApproachSettlement` firing at Guardian ruins: an event name
     * that reads like it means one thing and fires for a superset.
     *
     * `BodyName` ending in "Ring" separates them exactly -- 29 of 29 rings, zero
     * false positives across the corpus. A structural test on the signal payload
     * was tried and is worse: ring signals are bare commodity names
     * ("Serendibite") while planet signals are `$SAA_SignalType_*;` tokens, but
     * planets with surface mining sites report `$PlanetaryMiningLocation_Name;`,
     * which that test misclassified 11 times.
     */
    {
      id: 'mining-ring-scan',
      title: 'Mining hotspots',
      subtitle: 'Hotspots mapped in {event.BodyName}',
      subtitleFallback: 'Hotspots mapped in this ring',
      when: {
        kind: 'all',
        of: [
          { kind: 'event', name: 'SAASignalsFound' },
          { kind: 'field', path: 'BodyName', op: 'endsWith', value: 'Ring' },
          // A ring mapped with nothing in it has no hotspot to talk about. None of
          // the 32 ring scans in the corpus was empty, but the claim needs it.
          { kind: 'field', path: 'Signals.0.Type', op: 'exists' },
        ],
      },
      priority: 60,
      ttlSeconds: 600,
      // Leaving the ring ends the mining session.
      endsOn: ['Docked', 'FSDJump', 'SupercruiseEntry'],
      guidance: {
        topic: 'mining',
        beginner:
          'Hotspots mark where a mineral is most common in this ring. Prospect asteroids inside one to find it.',
      },
      resources: [
        { label: 'Mining Hotspot', page: 'Mining Hotspot' },
        { label: 'How to Find a Mining Hotspot', page: 'How to Find a Mining Hotspot' },
        { label: 'Planetary Rings', page: 'Planetary Rings' },
      ],
    },
    /*
     * Signals on a PLANET. A detailed surface scan (`SAASignalsFound`, the same
     * event as a ring scan) or, earlier, the FSS (`FSSBodySignals`).
     *
     * Two things on a planet are worth surfacing, and they are independent: a body
     * can have both, and 89 of the surface scans carry two signals.
     *
     * Signals are not discoveries. These say organisms are present -- the guides
     * explain how to find and sample them -- and never name a species: only
     * sampling establishes which one it is (see `exobiology-scan`).
     *
     * Both events feed one rule, so a body seen in the FSS and then mapped is one
     * context, not two. The newer line wins, so mapping replaces "signals
     * detected" with the genus count. Scanning several bodies in a row leaves the
     * last one named; leaving the system ends it.
     */
    {
      id: 'planet-biological-signals',
      title: 'Biological signals',
      subtitle:
        '{event.Genuses.length} biological {event.Genuses.length|signal|signals} on {event.BodyName}',
      // FSSBodySignals carries a count only inside its Signals list, at no fixed
      // index, so it is not stated rather than guessed.
      subtitleFallback: 'Biological signals detected on {event.BodyName}',
      when: {
        kind: 'any',
        of: [
          {
            kind: 'all',
            of: [
              { kind: 'event', name: 'SAASignalsFound' },
              /*
               * `Genuses` is exactly equivalent to "has a biological signal",
               * measured: 103 events carry a Biological signal, all 103 list
               * genera, and not one event lists genera without it.
               */
              { kind: 'field', path: 'Genuses.0.Genus', op: 'exists' },
            ],
          },
          {
            kind: 'all',
            of: [
              // 114 of 639 FSSBodySignals in the corpus, every one with BodyName.
              { kind: 'event', name: 'FSSBodySignals' },
              { kind: 'field', path: 'Signals.*.Type', op: 'eq', value: '$SAA_SignalType_Biological;' },
            ],
          },
        ],
      },
      priority: 65,
      ttlSeconds: 1800,
      // Scanning and landing take a while, and the body stays interesting for as
      // long as the commander is in the system. Leaving it is what ends this.
      endsOn: ['FSDJump', 'Docked'],
      guidance: {
        topic: 'exobiology',
        beginner:
          'Biological signals mean organisms are present on this body. Map it with the Detailed Surface Scanner to see which genera, then sample them on foot.',
      },
      resources: [
        { label: 'Exobiology', page: 'Exobiology' },
        { label: 'Detailed Surface Scanner', page: 'Detailed Surface Scanner' },
      ],
    },
    /*
     * Planetary mining locations.
     *
     * The signal says how many locations a body has and nothing else: no
     * material, and nothing about how they are mined. EDFM's Surface Mining page
     * covers these (Rhino and mining rigs at "Planetary Mining Locations",
     * 4.4.1.0); version 1 also linked Sub-surface Mining, which is about deposits
     * inside asteroids, and said "Mineable surface materials detected", which the
     * event never says.
     *
     * Matched on the raw token, which is the stable identifier; `Type_Localised`
     * ("Planetary Mining Location") is present on 182 of 184 surface scans but is
     * a display string. `*` rather than a fixed index: the signal was observed at
     * index 0, 1 and 2, so `Signals.0.Type` would have matched 18% of them.
     *
     * Also read from `FSSBodySignals` (456 of 639 in the corpus), which reports
     * the same token before a body is mapped. One rule, so the two lines for one
     * body are one context. No ring ever carried this signal (0 of 32).
     */
    {
      id: 'planet-surface-mining',
      title: 'Planetary mining locations',
      subtitle: 'Planetary mining locations detected on {event.BodyName}',
      subtitleFallback: 'Planetary mining locations have been detected on this body',
      when: {
        kind: 'all',
        of: [
          { kind: 'event', name: ['SAASignalsFound', 'FSSBodySignals'] },
          { kind: 'field', path: 'Signals.*.Type', op: 'eq', value: '$PlanetaryMiningLocation_Name;' },
        ],
      },
      priority: 62,
      ttlSeconds: 1800,
      endsOn: ['FSDJump', 'Docked'],
      resources: [
        { label: 'Surface Mining', page: 'Surface Mining' },
        { label: 'Mining', page: 'Mining' },
      ],
    },
    {
      id: 'mining-refining',
      title: 'Refining',
      // Type_Localised on all 1,743 MiningRefined lines.
      subtitle: 'Your refinery produced {event.Type_Localised}',
      subtitleFallback: 'Recent refinery activity',
      when: { kind: 'event', name: 'MiningRefined' },
      priority: 50,
      ttlSeconds: 600,
      // Leaving the ring ends the mining session.
      endsOn: ['Docked', 'FSDJump', 'SupercruiseEntry'],
      resources: [
        { label: 'Refinery', page: 'Refinery' },
        { label: 'How to Use a Refinery', page: 'How to Use a Refinery' },
        { label: 'How to Resolve a Full Refinery', page: 'How to Resolve a Full Refinery' },
      ],
    },

    /* ----------------------------------------------------- fleet carriers */
    /*
     * Docked at a Fleet Carrier.
     *
     * Version 1 matched the services or the station type without asking whether
     * the commander was docked, and its "trigger" was whatever line had last
     * re-checked it -- `Shutdown`, after the game had closed. It now needs
     * docking, and is checked against state alone (see resolver.ts).
     *
     * Measured: `carriermanagement` and `carrierfuel` appear only at stations of
     * type FleetCarrier (744 of 744 docks each), so the three conditions agree;
     * all three are kept so a dock that omits one still matches.
     */
    {
      id: 'fleet-carrier',
      title: 'Fleet Carrier services',
      subtitle: 'Docked at a Fleet Carrier',
      when: {
        kind: 'all',
        of: [
          DOCKED,
          {
            kind: 'any',
            of: [
              { kind: 'service', id: 'carriermanagement' },
              { kind: 'service', id: 'carrierfuel' },
              { kind: 'state', path: 'stationType', op: 'eq', value: 'FleetCarrier' },
            ],
          },
        ],
      },
      priority: 60,
      ttlSeconds: 1800,
      resources: [
        { label: 'Fleet Carriers', page: 'Fleet Carriers' },
        {
          label: 'Fleet Carrier Administration Systems',
          page: 'Fleet Carrier Administration Systems',
        },
      ],
    },

    /* --------------------------------------------------------- powerplay */
    {
      id: 'powerplay-activity',
      title: 'Powerplay',
      // Power is on every line of all four events in the corpus (1,182 lines).
      subtitle: 'Working for {event.Power}',
      subtitleFallback: 'Recent Powerplay activity',
      when: {
        kind: 'event',
        name: ['PowerplayMerits', 'PowerplayCollect', 'PowerplayDeliver', 'PowerplayRank'],
      },
      priority: 40,
      ttlSeconds: 600,
      // Powerplay work is per-system; leaving the system ends its relevance.
      endsOn: ['FSDJump'],
      resources: [{ label: 'Powerplay', page: 'Powerplay' }],
    },

    /*
     * There is deliberately no `outfitting` rule.
     *
     * That service is present at 167 of 266 distinct stations (62.8%). A context
     * that fires at two-thirds of stations tells the commander nothing they cannot
     * already see in the station menu, and crowds out contexts that do.
     *
     * Prevalence measured across the corpus, and the bar every service rule here
     * has to clear:
     *   engineer         227/242 (93.8%)  rejected - says nothing
     *   outfitting       167/266 (62.8%)  rejected - low value
     *   shipyard         148/266 (55.6%)  not used
     *   vistagenomics    137/266 (51.5%)  used
     *   tuning           103/266 (38.7%)  rejected - meaning unverified
     *   pioneersupplies  101/266 (38.0%)  used
     *   carriermanagement 44/266 (16.5%)  used
     *   materialtrader    37/266 (13.9%)  used
     */
  ],
};
