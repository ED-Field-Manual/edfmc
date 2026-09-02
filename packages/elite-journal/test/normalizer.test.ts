import { describe, expect, it } from 'vitest';
import { JournalSessionContext, parseLine } from '../src/parser.js';
import { normalize, normalizeStationServices, isKnownEvent } from '../src/normalizer.js';
import { UNKNOWN } from '../src/types.js';
import type {
  ApproachSettlementData,
  ColonisationDepotData,
  DockedData,
} from '../src/normalizer.js';

/** Verbatim from Journal.2026-09-01T082623.01.log. */
const DOCKED_CONSTRUCTION =
  '{ "timestamp":"2026-09-01T13:34:55Z", "event":"Docked", "StationName":"Planetary Construction Site: Scholz Landing", "StationType":"PlanetaryConstructionDepot", "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe KO-G c24-7", "SystemAddress":2008870359762, "MarketID":4387351555, "StationFaction":{ "Name":"Brewer Corporation" }, "StationGovernment":"$government_Megaconstruction;", "StationGovernment_Localised":"Megaconstruction", "StationServices":[ "dock", "autodock", "commodities", "contacts", "rearm", "refuel", "repair", "flightcontroller", "stationoperations", "stationMenu", "colonisationcontribution" ], "StationEconomy":"$economy_Colony;", "StationEconomy_Localised":"Colony", "StationEconomies":[ { "Name":"$economy_Colony;", "Name_Localised":"Colony", "Proportion":1.000000 } ], "DistFromStarLS":92.137178, "LandingPads":{ "Small":2, "Medium":2, "Large":3 } }';

/** Verbatim from the corpus: a real Odyssey settlement with 4 economies. */
const APPROACH_SETTLEMENT =
  '{ "timestamp":"2026-09-01T13:46:58Z", "event":"ApproachSettlement", "Name":"Altieri Collection", "MarketID":4384269827, "StationFaction":{ "Name":"Sirius Special Forces", "FactionState":"Expansion" }, "StationGovernment":"$government_Corporate;", "StationGovernment_Localised":"Corporate", "StationAllegiance":"Federation", "StationServices":[ "dock", "autodock", "commodities", "contacts", "missions", "outfitting", "rearm", "refuel", "repair", "engineer", "missionsgenerated", "flightcontroller", "stationoperations", "powerplay", "searchrescue", "stationMenu", "shop", "livery", "socialspace", "registeringcolonisation" ], "StationEconomy":"$economy_Industrial;", "StationEconomy_Localised":"Industrial", "StationEconomies":[ { "Name":"$economy_Industrial;", "Name_Localised":"Industrial", "Proportion":0.900000 }, { "Name":"$economy_HighTech;", "Name_Localised":"High Tech", "Proportion":0.100000 }, { "Name":"$economy_Military;", "Name_Localised":"Military", "Proportion":0.050000 }, { "Name":"$economy_Refinery;", "Name_Localised":"Refinery", "Proportion":0.050000 } ], "SystemAddress":2008870359762, "BodyID":10, "BodyName":"Wregoe KO-G c24-7 4", "Latitude":-11.197787, "Longitude":100.834610 }';

const DEPOT =
  '{ "timestamp":"2026-09-01T13:34:56Z", "event":"ColonisationConstructionDepot", "MarketID":4387351555, "ConstructionProgress":0.000000, "ConstructionComplete":false, "ConstructionFailed":false, "ResourcesRequired":[ { "Name":"$aluminium_name;", "Name_Localised":"Aluminium", "RequiredAmount":7047, "ProvidedAmount":12, "Payment":3239 }, { "Name":"$steel_name;", "Name_Localised":"Steel", "RequiredAmount":10164, "ProvidedAmount":0, "Payment":5057 } ] }';

function norm(line: string) {
  const r = parseLine(line, 'J.log', 0, new JournalSessionContext());
  if (!r?.ok) throw new Error('fixture failed to parse');
  return normalize(r.event);
}

describe('station service normalization', () => {
  it('preserves the raw token and adds a case-folded id', () => {
    const s = normalizeStationServices(['dock', 'stationMenu']);
    expect(s).toEqual([
      { raw: 'dock', id: 'dock' },
      { raw: 'stationMenu', id: 'stationmenu' },
    ]);
  });

  it('handles the real mixed-casing array without losing evidence', () => {
    const n = norm(APPROACH_SETTLEMENT);
    const d = n.data as ApproachSettlementData;
    const services = d.services as ReadonlyArray<{ raw: string; id: string }>;

    // `stationMenu` is camelCase among lowercase peers in the genuine payload.
    const menu = services.find((s) => s.id === 'stationmenu');
    expect(menu?.raw).toBe('stationMenu');
    expect(services.some((s) => s.id === 'registeringcolonisation')).toBe(true);
    expect(services.length).toBe(20);
  });

  it('returns UNKNOWN when the field is absent rather than an empty list', () => {
    // An empty list would read as "this station has no services", which is a
    // different and much stronger claim than "the game did not tell us".
    expect(normalizeStationServices(undefined)).toBe(UNKNOWN);
  });
});

describe('Docked', () => {
  it('normalizes the fields verification depends on', () => {
    const d = norm(DOCKED_CONSTRUCTION).data as DockedData;
    expect(d.marketId).toBe(4387351555);
    expect(d.stationType).toBe('PlanetaryConstructionDepot');
    expect(d.systemAddress).toBe(2008870359762);
    expect(d.distFromStarLs).toBeCloseTo(92.137178);
    expect(d.stationFaction).toBe('Brewer Corporation');
  });

  it('reports a missing StationAllegiance as UNKNOWN, never as absent', () => {
    // Present on only 32.0% of Docked events across n=1798. Treating UNKNOWN as
    // "no allegiance" would manufacture false discrepancy reports.
    const d = norm(DOCKED_CONSTRUCTION).data as DockedData;
    expect(d.allegiance).toBe(UNKNOWN);
  });

  it('keeps the raw payload alongside the normalized projection', () => {
    const n = norm(DOCKED_CONSTRUCTION);
    expect(n.source.raw['StationGovernment']).toBe('$government_Megaconstruction;');
    expect(n.source.raw['LandingPads']).toEqual({ Small: 2, Medium: 2, Large: 3 });
  });
});

describe('StationEconomies', () => {
  it('does not renormalise proportions that do not sum to 1', () => {
    const d = norm(APPROACH_SETTLEMENT).data as ApproachSettlementData;
    const econ = d.economies as ReadonlyArray<{ proportion: number | null }>;
    const total = econ.reduce((a, e) => a + (e.proportion ?? 0), 0);
    expect(total).toBeCloseTo(1.1, 5); // Frontier's real numbers, left alone
    expect(econ[0]!.proportion).toBeCloseTo(0.9);
  });
});

describe('ColonisationConstructionDepot', () => {
  it('reads the full snapshot with no delta inference', () => {
    const d = norm(DEPOT).data as ColonisationDepotData;
    expect(d.marketId).toBe(4387351555);
    expect(d.complete).toBe(false);
    expect(d.resources).toHaveLength(2);
    expect(d.resources[0]).toEqual({
      name: '$aluminium_name;',
      localised: 'Aluminium',
      required: 7047,
      provided: 12,
      payment: 3239,
    });
  });

  it('keeps the $name; commodity form for later normalization against EDDN', () => {
    const d = norm(DEPOT).data as ColonisationDepotData;
    expect(d.resources.map((r) => r.name)).toEqual(['$aluminium_name;', '$steel_name;']);
  });
});

describe('unknown events', () => {
  it('passes unknown events through with full provenance instead of dropping them', () => {
    const n = norm('{ "timestamp":"2026-09-01T00:00:00Z", "event":"SomeFutureEvent", "X":1 }');
    expect(n.known).toBe(false);
    expect(n.kind).toBe('unknown');
    expect(n.source.event).toBe('SomeFutureEvent');
    expect(n.source.raw['X']).toBe(1);
    expect(n.source.provenance.eventId).toBe('J.log:0');
  });

  it('does not throw on the payload-less MarketID event', () => {
    const n = norm('{ "timestamp":"2026-09-01T18:26:38Z", "event":"MarketID" }');
    expect(n.known).toBe(false);
  });

  it('degrades to unknown rather than throwing when a field has an unexpected type', () => {
    // Simulates Frontier changing StationServices from array to object.
    const n = norm('{ "timestamp":"2026-09-01T00:00:00Z", "event":"Docked", "StationServices":{"oops":true} }');
    expect(n.kind).toBe('docked');
    expect((n.data as DockedData).services).toBe(UNKNOWN);
  });

  it('knows which events have typed shapes', () => {
    expect(isKnownEvent('Docked')).toBe(true);
    expect(isKnownEvent('SomeFutureEvent')).toBe(false);
  });
});
