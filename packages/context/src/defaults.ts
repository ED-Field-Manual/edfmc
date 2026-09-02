/**
 * Bundled context rules — version 1.
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
 * code gaps — see docs/CONTEXT.md. Rules for them should be added server-side once
 * the pages exist, which is exactly why the rule set is server-driven.
 *
 * This bundled copy is the offline fallback (§22). The server-supplied set
 * supersedes it when one is available.
 */

import type { ContextRuleSet } from './types.js';

export const BUNDLED_RULES: ContextRuleSet = {
  version: 1,
  updatedAt: '2026-09-01T00:00:00Z',
  source: 'bundled',
  rules: [
    /* ------------------------------------------------------------- combat */
    {
      id: 'interdicted',
      title: 'Being interdicted',
      subtitle: 'Someone is pulling you out of supercruise',
      when: { kind: 'event', name: 'Interdicted' },
      // Highest priority in the set: it is the only entry that is time-critical.
      priority: 95,
      ttlSeconds: 300,
      resources: [{ label: 'Frame Shift Drive Interdictor', page: 'Frame Shift Drive Interdictor' }],
    },

    /* ------------------------------------------------------- colonisation */
    {
      id: 'colonisation-depot',
      title: 'Construction site',
      subtitle: 'Delivering to a colonisation depot',
      when: { kind: 'event', name: 'ColonisationConstructionDepot' },
      priority: 85,
      ttlSeconds: 1800,
      resources: [
        { label: 'Colonisation', page: 'Colonisation' },
        { label: 'Trailblazers', page: 'Trailblazers' },
        { label: 'Pioneer Supplies', page: 'Pioneer Supplies' },
      ],
    },
    {
      id: 'station-pioneer-supplies',
      title: 'Pioneer Supplies available',
      when: { kind: 'service', id: 'pioneersupplies' },
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
      title: 'Sampling biology',
      subtitle: 'Scanning organic life on foot',
      when: { kind: 'event', name: 'ScanOrganic' },
      priority: 80,
      ttlSeconds: 900,
      resources: [{ label: 'Exobiology', page: 'Exobiology' }],
    },
    {
      id: 'station-vista-genomics',
      title: 'Vista Genomics available',
      subtitle: 'Sell exobiology data here',
      when: { kind: 'service', id: 'vistagenomics' },
      priority: 55,
      ttlSeconds: 1800,
      resources: [{ label: 'Exobiology', page: 'Exobiology' }],
    },

    /* -------------------------------------------------------- engineering */
    {
      id: 'station-engineer',
      title: 'At an Engineer',
      when: { kind: 'service', id: 'engineer' },
      priority: 75,
      ttlSeconds: 1800,
      resources: [
        { label: 'Engineering', page: 'Engineering' },
        { label: 'Engineering Blueprints', page: 'Engineering Blueprints' },
        { label: 'Engineers', page: 'Engineers' },
        { label: 'Engineer Unlock Guide', page: 'Engineer Unlock Guide' },
      ],
    },
    {
      id: 'station-material-trader',
      title: 'Material Trader available',
      when: { kind: 'service', id: 'materialtrader' },
      priority: 55,
      ttlSeconds: 1800,
      resources: [{ label: 'Engineering Materials', page: 'Engineering Materials' }],
    },

    /* ------------------------------------------------------------- mining */
    {
      id: 'mining-prospecting',
      title: 'Prospecting',
      subtitle: 'Assessing an asteroid',
      when: { kind: 'event', name: 'ProspectedAsteroid' },
      priority: 70,
      ttlSeconds: 900,
      resources: [
        { label: 'Mining', page: 'Mining' },
        { label: 'Laser Mining', page: 'Laser Mining' },
        { label: 'Core Mining', page: 'Core Mining' },
        { label: 'How to Use a Prospector Limpet', page: 'How to Use a Prospector Limpet' },
      ],
    },
    {
      id: 'mining-ring-scan',
      title: 'Ring scanned',
      subtitle: 'Hotspot signals found',
      when: { kind: 'event', name: 'SAASignalsFound' },
      priority: 60,
      ttlSeconds: 900,
      resources: [
        { label: 'Mining Hotspot', page: 'Mining Hotspot' },
        { label: 'How to Find a Mining Hotspot', page: 'How to Find a Mining Hotspot' },
        { label: 'Planetary Rings', page: 'Planetary Rings' },
      ],
    },
    {
      id: 'mining-refining',
      title: 'Refining',
      when: { kind: 'event', name: 'MiningRefined' },
      priority: 50,
      ttlSeconds: 600,
      resources: [
        { label: 'Refinery', page: 'Refinery' },
        { label: 'How to Use a Refinery', page: 'How to Use a Refinery' },
        { label: 'How to Resolve a Full Refinery', page: 'How to Resolve a Full Refinery' },
      ],
    },

    /* ----------------------------------------------------- fleet carriers */
    {
      id: 'fleet-carrier',
      title: 'Fleet Carrier services',
      when: {
        kind: 'any',
        of: [
          { kind: 'service', id: 'carriermanagement' },
          { kind: 'service', id: 'carrierfuel' },
          { kind: 'state', path: 'stationType', op: 'eq', value: 'FleetCarrier' },
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
      title: 'Powerplay activity',
      when: {
        kind: 'event',
        name: ['PowerplayMerits', 'PowerplayCollect', 'PowerplayDeliver', 'PowerplayRank'],
      },
      priority: 40,
      ttlSeconds: 900,
      resources: [{ label: 'Powerplay', page: 'Powerplay' }],
    },

    /* -------------------------------------------------------- outfitting */
    {
      id: 'station-outfitting',
      title: 'Outfitting available',
      when: { kind: 'service', id: 'outfitting' },
      // Lowest priority: useful, but never what the commander most needs to see.
      priority: 25,
      ttlSeconds: 1800,
      resources: [
        { label: 'Ship Modules', page: 'Ship Modules' },
        { label: 'Ships and Equipment', page: 'Ships and Equipment' },
      ],
    },
  ],
};
