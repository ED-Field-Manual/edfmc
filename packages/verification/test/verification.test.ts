import { describe, expect, it } from 'vitest';
import {
  JournalSessionContext,
  UNKNOWN,
  normalize,
  parseLine,
  type NormalizedEvent,
} from '@edfm/elite-journal';

import {
  areIndependent,
  compareStation,
  isCarrier,
  observeStation,
  sameObservation,
  type StationObservation,
  type StationReference,
} from '../src/index.js';

let offset = 0;

function ev(line: string, file = 'J.log', ctx = sharedCtx): NormalizedEvent {
  const r = parseLine(line, file, (offset += 100), ctx);
  if (!r?.ok) throw new Error('fixture failed to parse');
  return normalize(r.event);
}
const sharedCtx = new JournalSessionContext();

/* ---- Fixtures verbatim from the validation corpus ---- */

const HEADER =
  '{ "timestamp":"2026-09-01T13:26:17Z", "event":"Fileheader", "part":1, "language":"English/UK", "Odyssey":true, "gameversion":"4.4.0.3", "build":"r330683/r0 " }';
const CMDR =
  '{ "timestamp":"2026-09-01T13:27:33Z", "event":"Commander", "FID":"F0000000", "Name":"Sythan" }';

const DOCKED_STATION =
  '{ "timestamp":"2026-09-01T13:34:55Z", "event":"Docked", "StationName":"Elder Hub", "StationType":"Coriolis", "Taxi":false, "Multicrew":false, "StarSystem":"Mundii", "SystemAddress":99, "MarketID":128, "StationFaction":{ "Name":"Brewer Corporation" }, "StationGovernment":"$government_Corporate;", "StationServices":[ "dock", "autodock", "commodities", "contacts", "stationMenu", "techBroker" ], "StationEconomy":"$economy_Industrial;", "StationEconomies":[ { "Name":"$economy_Industrial;", "Name_Localised":"Industrial", "Proportion":0.900000 }, { "Name":"$economy_HighTech;", "Name_Localised":"High Tech", "Proportion":0.100000 } ], "DistFromStarLS":92.137178, "LandingPads":{ "Small":2, "Medium":2, "Large":3 } }';

const APPROACH_SETTLEMENT =
  '{ "timestamp":"2026-09-01T13:46:58Z", "event":"ApproachSettlement", "Name":"Altieri Collection", "MarketID":4384269827, "StationFaction":{ "Name":"Sirius Special Forces", "FactionState":"Expansion" }, "StationGovernment":"$government_Corporate;", "StationAllegiance":"Federation", "StationServices":[ "dock", "engineer", "stationMenu" ], "StationEconomy":"$economy_Industrial;", "StationEconomies":[], "SystemAddress":2008870359762, "BodyID":10, "BodyName":"Wregoe KO-G c24-7 4", "Latitude":-11.19, "Longitude":100.83 }';

const DOCKED_CARRIER =
  '{ "timestamp":"2026-09-01T17:07:40Z", "event":"Docked", "StationName":"HBN-TXN", "StationType":"FleetCarrier", "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe JO-G c24-27", "SystemAddress":750, "MarketID":3703420416, "StationFaction":{ "Name":"FleetCarrier" }, "StationGovernment":"$government_Carrier;", "StationServices":[ "dock", "engineer", "carriermanagement" ], "StationEconomy":"$economy_Carrier;", "StationEconomies":[], "DistFromStarLS":794.7, "LandingPads":{ "Small":4, "Medium":4, "Large":8 } }';

function observed(line: string, file?: string, ctx?: JournalSessionContext): StationObservation {
  const o = observeStation(ev(line, file, ctx));
  if (!o) throw new Error('expected an observation');
  return o;
}

describe('capturing observations', () => {
  it('captures a docked station with full provenance', () => {
    const ctx = new JournalSessionContext();
    ev(HEADER, 'J.log', ctx);
    ev(CMDR, 'J.log', ctx);
    const o = observed(DOCKED_STATION, 'J.log', ctx);

    expect(o.marketId).toBe(128);
    expect(o.stationName).toBe('Elder Hub');
    expect(o.stationType).toBe('Coriolis');
    expect(o.channel).toBe('docked');

    // §27: an observation must answer "where did this come from?"
    expect(o.commander).toBe('Sythan');
    expect(o.commanderFid).toBe('F0000000');
    expect(o.gameVersion).toBe('4.4.0.3');
    expect(o.gameBuild).toBe('r330683/r0 ');
    expect(o.sourceEventId).toMatch(/^J\.log:\d+$/);
  });

  it('preserves raw service tokens alongside folded ids', () => {
    // Both camelCase tokens in one array. Comparison uses the id; a report must
    // quote the raw token as evidence (§9).
    const o = observed(DOCKED_STATION);
    const menu = o.services.find((s) => s.id === 'stationmenu');
    const broker = o.services.find((s) => s.id === 'techbroker');

    expect(menu?.raw).toBe('stationMenu');
    expect(broker?.raw).toBe('techBroker');
  });

  it('does not renormalise economy proportions', () => {
    const o = observed(DOCKED_STATION);
    expect(o.economies.map((e) => e.proportion)).toEqual([0.9, 0.1]);
  });

  it('captures a settlement approach, naming it from Name not StationName', () => {
    const o = observed(APPROACH_SETTLEMENT);
    expect(o.stationName).toBe('Altieri Collection');
    expect(o.channel).toBe('approach');
    expect(o.marketId).toBe(4384269827);
  });

  it('records a missing allegiance as UNKNOWN', () => {
    // Present on only 32.0% of Docked events; absence is not "no allegiance".
    expect(observed(DOCKED_STATION).allegiance).toBe(UNKNOWN);
    expect(observed(APPROACH_SETTLEMENT).allegiance).toBe('Federation');
  });

  it('ignores events with no station', () => {
    expect(observeStation(ev('{ "timestamp":"2026-09-01T00:00:00Z", "event":"Music" }'))).toBeNull();
  });

  it('ignores a station event with no services rather than recording an empty list', () => {
    // An empty list asserts the station has no services, which is a much stronger
    // claim than "the game did not tell us".
    const e = ev(
      '{ "timestamp":"2026-09-01T00:00:00Z", "event":"Docked", "StationName":"X", "MarketID":1, "StationType":"Coriolis" }',
    );
    expect(observeStation(e)).toBeNull();
  });

  it('ignores a station event with no usable MarketID', () => {
    const e = ev(
      '{ "timestamp":"2026-09-01T00:00:00Z", "event":"Docked", "StationName":"X", "StationServices":[ "dock" ] }',
    );
    expect(observeStation(e)).toBeNull();
  });
});

describe('deduplication', () => {
  it('treats an unchanged re-dock as the same observation', () => {
    expect(sameObservation(observed(DOCKED_STATION), observed(DOCKED_STATION))).toBe(true);
  });

  it('detects a changed service list', () => {
    const changed = DOCKED_STATION.replace('"techBroker"', '"shipyard"');
    expect(sameObservation(observed(DOCKED_STATION), observed(changed))).toBe(false);
  });

  it('does not treat a missing allegiance as a change', () => {
    // Absent 68% of the time; comparing it would make identical observations
    // look like the station kept changing.
    const withAllegiance = DOCKED_STATION.replace(
      '"StationType":"Coriolis"',
      '"StationType":"Coriolis", "StationAllegiance":"Federation"',
    );
    expect(sameObservation(observed(DOCKED_STATION), observed(withAllegiance))).toBe(true);
  });
});

describe('comparison against reference data', () => {
  const reference: StationReference = {
    marketId: 128,
    stationName: 'Elder Hub',
    serviceIds: ['dock', 'autodock', 'commodities', 'contacts', 'stationmenu', 'techbroker'],
    source: 'test',
    updatedAt: null,
  };

  it('reports nothing when everything matches', () => {
    // §9: do not bother the commander when the data agrees.
    expect(compareStation(observed(DOCKED_STATION), reference)).toEqual([]);
  });

  it('matches services case-insensitively', () => {
    // EDFM would reasonably store "stationMenu"; the folded id must still match.
    const cased: StationReference = {
      ...reference,
      serviceIds: ['dock', 'autodock', 'commodities', 'contacts', 'stationMenu', 'techBroker'],
    };
    expect(compareStation(observed(DOCKED_STATION), cased)).toEqual([]);
  });

  it('reports a service EDFM lists that the game did not', () => {
    const withExtra: StationReference = { ...reference, serviceIds: [...reference.serviceIds, 'shipyard'] };
    const found = compareStation(observed(DOCKED_STATION), withExtra);

    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe('service-missing');
    expect(found[0]!.field).toBe('shipyard');
    expect(found[0]!.observation.sourceEventId).toBeTruthy(); // evidence travels with it
  });

  it('reports a service the game has that EDFM does not, quoting the raw token', () => {
    const missing: StationReference = {
      ...reference,
      serviceIds: reference.serviceIds.filter((s) => s !== 'techbroker'),
    };
    const found = compareStation(observed(DOCKED_STATION), missing);

    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe('service-extra');
    // The raw token is the evidence, and it is the camelCase one.
    expect(found[0]!.rawToken).toBe('techBroker');
  });

  it('can suppress extras, since a sparse reference is likelier than a wrong game', () => {
    const missing: StationReference = {
      ...reference,
      serviceIds: reference.serviceIds.filter((s) => s !== 'techbroker'),
    };
    expect(compareStation(observed(DOCKED_STATION), missing, { reportExtras: false })).toEqual([]);
  });

  it('never reports discrepancies for a fleet carrier', () => {
    // Carrier services are the owner's configuration, not a fact about the galaxy.
    const carrierRef: StationReference = {
      marketId: 3703420416,
      stationName: 'HBN-TXN',
      serviceIds: ['shipyard', 'outfitting'],
      source: 'test',
      updatedAt: null,
    };
    const o = observed(DOCKED_CARRIER);
    expect(isCarrier(o)).toBe(true);
    expect(compareStation(o, carrierRef)).toEqual([]);
  });

  it('refuses to compare two different stations', () => {
    const other: StationReference = { ...reference, marketId: 999 };
    expect(compareStation(observed(DOCKED_STATION), other)).toEqual([]);
  });
});

describe('independence of observations', () => {
  function withIdentity(commander: string, fid: string, file: string): StationObservation {
    const ctx = new JournalSessionContext();
    ev(HEADER, file, ctx);
    ev(`{ "timestamp":"2026-09-01T13:27:33Z", "event":"Commander", "FID":"${fid}", "Name":"${commander}" }`, file, ctx);
    return observed(DOCKED_STATION, file, ctx);
  }

  it('does not count the same commander twice', () => {
    // §9: two reports must not become truth if they could share an origin.
    const a = withIdentity('Sythan', 'F1', 'A.log');
    const b = withIdentity('Sythan', 'F1', 'B.log');
    expect(areIndependent(a, b)).toBe(false);
  });

  it('does not count two observations from one session', () => {
    const a = withIdentity('Sythan', 'F1', 'Same.log');
    const b = withIdentity('Other', 'F2', 'Same.log');
    expect(areIndependent(a, b)).toBe(false);
  });

  it('counts different commanders in different sessions', () => {
    const a = withIdentity('Sythan', 'F1', 'A.log');
    const b = withIdentity('Other', 'F2', 'B.log');
    expect(areIndependent(a, b)).toBe(true);
  });
});
