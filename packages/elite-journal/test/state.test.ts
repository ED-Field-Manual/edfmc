import { describe, expect, it } from 'vitest';
import { JournalSessionContext, parseLine } from '../src/parser.js';
import { normalize } from '../src/normalizer.js';
import { applyEvent, initialState, learnCarrier, type CommanderState } from '../src/state.js';
import { UNKNOWN } from '../src/types.js';

const ctx = new JournalSessionContext();
let offset = 0;

function feed(state: CommanderState, line: string): CommanderState {
  const r = parseLine(line, 'J.log', (offset += 100), ctx);
  if (!r?.ok) throw new Error('fixture failed to parse');
  return applyEvent(state, normalize(r.event));
}

const DOCKED =
  '{ "timestamp":"2026-09-01T13:34:55Z", "event":"Docked", "StationName":"Elder Hub", "StationType":"Coriolis", "Taxi":false, "Multicrew":false, "StarSystem":"Mundii", "SystemAddress":99, "MarketID":128, "StationFaction":{ "Name":"F" }, "StationGovernment":"$government_Corporate;", "StationServices":[ "dock", "commodities" ], "StationEconomy":"$economy_Industrial;", "StationEconomies":[], "DistFromStarLS":10.0, "LandingPads":{ "Small":1, "Medium":1, "Large":1 } }';

describe('CommanderState', () => {
  it('starts entirely unknown rather than defaulting to empty values', () => {
    const s = initialState();
    expect(s.commander).toBe(UNKNOWN);
    expect(s.starSystem).toBe(UNKNOWN);
    expect(s.docking).toBe('unknown');
    expect(s.vehicle).toBe('unknown');
    expect(s.stationServices).toBe(UNKNOWN);
  });

  it('adopts identity from provenance', () => {
    let s = initialState();
    s = feed(s, '{ "timestamp":"2026-09-01T13:26:17Z", "event":"Fileheader", "part":1, "language":"English/UK", "Odyssey":true, "gameversion":"4.4.0.3", "build":"r330683/r0 " }');
    s = feed(s, '{ "timestamp":"2026-09-01T13:27:33Z", "event":"Commander", "FID":"F0000000", "Name":"Sythan" }');

    expect(s.commander).toBe('Sythan');
    expect(s.fid).toBe('F0000000');
    expect(s.gameVersion).toBe('4.4.0.3');
    expect(s.odyssey).toBe(true);
  });

  it('records docking and station context', () => {
    let s = initialState();
    s = feed(s, DOCKED);
    expect(s.docking).toBe('docked');
    expect(s.stationName).toBe('Elder Hub');
    expect(s.marketId).toBe(128);
    expect(s.starSystem).toBe('Mundii');
    expect(s.stationServices).toHaveLength(2);
  });

  it('takes station context from a docked Location, not only from Docked', () => {
    // Regression: replaying a real journal that began while already docked at a
    // fleet carrier left stationType Unknown, because Location carries the station
    // block (57.1% of the time) and it was not being read.
    let s = initialState();
    s = feed(
      s,
      '{ "timestamp":"2026-09-02T01:00:00Z", "event":"Location", "Docked":true, "StationName":"HBN-TXN", "StationType":"FleetCarrier", "MarketID":3703420416, "StationServices":[ "dock", "commodities" ], "StarSystem":"Wregoe JO-G c24-27", "SystemAddress":7506361389778, "StarPos":[487.96875,90.375,-10.5625], "Body":"Wregoe JO-G c24-27 A 5", "BodyID":8, "BodyType":"Planet", "Population":0, "SystemAllegiance":"", "SystemEconomy":"$economy_None;", "SystemEconomy_Localised":"None", "SystemSecondEconomy":"$economy_None;", "SystemSecondEconomy_Localised":"None", "SystemGovernment":"$government_None;", "SystemGovernment_Localised":"None", "SystemSecurity":"$GAlAXY_MAP_INFO_state_anarchy;", "SystemSecurity_Localised":"Anarchy" }',
    );

    expect(s.docking).toBe('docked');
    expect(s.stationName).toBe('HBN-TXN');
    expect(s.stationType).toBe('FleetCarrier');
    expect(s.marketId).toBe(3703420416);
    expect(s.starPos).toEqual([487.96875, 90.375, -10.5625]);
  });

  describe('fleet carrier names', () => {
    // Docked reports only the callsign; the name lives in CarrierStats and joins
    // on CarrierID === MarketID. Both were 3703420416 for this carrier.
    const CARRIER_STATS =
      '{ "timestamp":"2026-09-01T13:54:48Z", "event":"CarrierStats", "CarrierID":3703420416, "CarrierType":"FleetCarrier", "Callsign":"HBN-TXN", "Name":"PFC Atlas Unbound", "DockingAccess":"all", "AllowNotorious":true, "FuelLevel":709 }';
    const DOCKED_CARRIER =
      '{ "timestamp":"2026-09-01T17:07:40Z", "event":"Docked", "StationName":"HBN-TXN", "StationType":"FleetCarrier", "Taxi":false, "Multicrew":false, "StarSystem":"Wregoe JO-G c24-27", "SystemAddress":7506361389778, "MarketID":3703420416, "StationFaction":{ "Name":"FleetCarrier" }, "StationGovernment":"$government_Carrier;", "StationServices":[ "dock" ], "StationEconomy":"$economy_Carrier;", "StationEconomies":[], "DistFromStarLS":794.7, "LandingPads":{ "Small":4, "Medium":4, "Large":8 } }';

    it('resolves the name when stats were seen before docking', () => {
      let s = initialState();
      s = feed(s, CARRIER_STATS);
      s = feed(s, DOCKED_CARRIER);
      expect(s.stationName).toBe('HBN-TXN'); // raw journal value preserved
      expect(s.carrierName).toBe('PFC Atlas Unbound');
    });

    it('resolves the name when stats arrive after docking', () => {
      // The real ordering at session start: Location (docked) precedes CarrierStats.
      let s = initialState();
      s = feed(s, DOCKED_CARRIER);
      expect(s.carrierName).toBe(UNKNOWN);

      s = feed(s, CARRIER_STATS);
      expect(s.carrierName).toBe('PFC Atlas Unbound');
    });

    it('picks up a rename while docked', () => {
      let s = initialState();
      s = feed(s, CARRIER_STATS);
      s = feed(s, DOCKED_CARRIER);
      s = feed(
        s,
        // Real payload, including Frontier's malformed empty-string key.
        '{ "timestamp":"2026-08-28T04:18:51Z", "event":"CarrierNameChange", "CarrierID":3703420416, "":"FleetCarrier", "Name":"PFC Renamed", "Callsign":"HBN-TXN" }',
      );
      expect(s.carrierName).toBe('PFC Renamed');
    });

    it("leaves another commander's carrier UNKNOWN rather than guessing", () => {
      // No CarrierStats is emitted for someone else's carrier, so the journal
      // genuinely does not contain its name.
      let s = initialState();
      s = feed(s, CARRIER_STATS); // our own carrier
      s = feed(
        s,
        '{ "timestamp":"2026-09-01T17:07:40Z", "event":"Docked", "StationName":"XYZ-99Z", "StationType":"FleetCarrier", "Taxi":false, "Multicrew":false, "StarSystem":"Sol", "SystemAddress":1, "MarketID":9999999999, "StationFaction":{ "Name":"FleetCarrier" }, "StationGovernment":"$government_Carrier;", "StationServices":[ "dock" ], "StationEconomy":"$economy_Carrier;", "StationEconomies":[], "DistFromStarLS":1.0, "LandingPads":{ "Small":4, "Medium":4, "Large":8 } }',
      );
      expect(s.stationName).toBe('XYZ-99Z');
      expect(s.carrierName).toBe(UNKNOWN);
    });

    it('clears the carrier name on undock', () => {
      let s = initialState();
      s = feed(s, CARRIER_STATS);
      s = feed(s, DOCKED_CARRIER);
      s = feed(s, '{ "timestamp":"2026-09-01T18:00:00Z", "event":"Undocked", "StationName":"HBN-TXN", "StationType":"FleetCarrier", "MarketID":3703420416, "Taxi":false, "Multicrew":false }');
      expect(s.carrierName).toBe(UNKNOWN);
      // The identity itself is remembered for next time.
      expect(s.knownCarriers[3703420416]).toBe('PFC Atlas Unbound');
    });

    it('learnCarrier resolves the name without disturbing last-event state', () => {
      // Used when loading identities from storage or historical journals. Pushing
      // those old events through applyEvent would make the dashboard report stale
      // activity as the most recent thing that happened.
      let s = initialState();
      s = feed(s, DOCKED_CARRIER);
      const lastEvent = s.lastEventName;
      const lastId = s.lastEventId;

      learnCarrier(s, 3703420416, 'PFC Atlas Unbound');

      expect(s.carrierName).toBe('PFC Atlas Unbound');
      expect(s.lastEventName).toBe(lastEvent);
      expect(s.lastEventId).toBe(lastId);
    });

    it('learnCarrier ignores junk input', () => {
      const s = initialState();
      learnCarrier(s, Number.NaN, 'x');
      learnCarrier(s, 1, '');
      expect(Object.keys(s.knownCarriers)).toEqual([]);
    });

    it('does not attach a carrier name to a normal station', () => {
      let s = initialState();
      s = feed(s, CARRIER_STATS);
      s = feed(s, DOCKED);
      expect(s.carrierName).toBe(UNKNOWN);
    });
  });

  it('clears station context on undock', () => {
    let s = initialState();
    s = feed(s, DOCKED);
    s = feed(s, '{ "timestamp":"2026-09-01T13:40:00Z", "event":"Undocked", "StationName":"Elder Hub", "StationType":"Coriolis", "MarketID":128, "Taxi":false, "Multicrew":false }');

    expect(s.docking).toBe('undocked');
    expect(s.stationName).toBe(UNKNOWN);
    expect(s.marketId).toBe(UNKNOWN);
    expect(s.stationServices).toBe(UNKNOWN);
  });

  it('clears surface and station context on an FSD jump', () => {
    let s = initialState();
    s = feed(s, DOCKED);
    s = feed(s, '{ "timestamp":"2026-09-01T14:00:00Z", "event":"Touchdown", "PlayerControlled":true, "Taxi":false, "Multicrew":false, "StarSystem":"Mundii", "SystemAddress":99, "Body":"Mundii 4", "BodyID":4, "OnStation":false, "OnPlanet":true, "Latitude":-32.7, "Longitude":-55.9, "NearestDestination":"X" }');
    expect(s.latitude).toBeCloseTo(-32.7);

    s = feed(s, '{ "timestamp":"2026-09-01T14:10:00Z", "event":"FSDJump", "StarSystem":"Sol", "SystemAddress":10, "StarPos":[0.0,0.0,0.0], "Body":"Sol", "BodyID":0, "BodyType":"Star", "JumpDist":8.0, "FuelUsed":1.0, "FuelLevel":30.0, "Population":0, "SystemAllegiance":"", "SystemEconomy":"$economy_None;", "SystemEconomy_Localised":"None", "SystemSecondEconomy":"$economy_None;", "SystemSecondEconomy_Localised":"None", "SystemGovernment":"$government_None;", "SystemGovernment_Localised":"None", "SystemSecurity":"$SYSTEM_SECURITY_low;", "SystemSecurity_Localised":"Low", "Taxi":false, "Multicrew":false }');

    expect(s.starSystem).toBe('Sol');
    expect(s.starPos).toEqual([0, 0, 0]);
    expect(s.docking).toBe('undocked');
    expect(s.latitude).toBe(UNKNOWN);
    expect(s.stationName).toBe(UNKNOWN);
  });

  it('never overwrites a known value with an unknown one', () => {
    let s = initialState();
    s = feed(s, DOCKED);
    expect(s.starSystem).toBe('Mundii');

    // SupercruiseExit carries a Body but no StarSystem in this shape.
    s = feed(s, '{ "timestamp":"2026-09-01T13:50:00Z", "event":"SupercruiseExit", "Taxi":false, "Multicrew":false, "Body":"Mundii 7", "BodyType":"Planet" }');
    expect(s.starSystem).toBe('Mundii'); // retained, not blanked
    expect(s.body).toBe('Mundii 7');
  });

  it('tracks on-foot and vehicle transitions', () => {
    let s = initialState();
    s = feed(s, '{ "timestamp":"2026-09-01T18:38:19Z", "event":"Disembark", "SRV":false, "Taxi":false, "Multicrew":false, "ID":12, "StarSystem":"W", "SystemAddress":1, "Body":"W 6", "BodyID":16, "OnStation":false, "OnPlanet":true }');
    expect(s.vehicle).toBe('on-foot');

    s = feed(s, '{ "timestamp":"2026-09-01T20:28:07Z", "event":"Embark", "SRV":true, "Taxi":false, "Multicrew":false, "ID":20, "StarSystem":"W", "SystemAddress":1, "Body":"W 4", "BodyID":33, "OnStation":false, "OnPlanet":true }');
    expect(s.vehicle).toBe('srv');
  });

  it('only counts ship cargo, not SRV cargo', () => {
    let s = initialState();
    s = feed(s, '{ "timestamp":"2026-09-01T00:00:00Z", "event":"Cargo", "Vessel":"Ship", "Count":42, "Inventory":[] }');
    expect(s.cargoCount).toBe(42);

    s = feed(s, '{ "timestamp":"2026-09-01T00:01:00Z", "event":"Cargo", "Vessel":"SRV", "Count":2, "Inventory":[] }');
    expect(s.cargoCount).toBe(42);
  });

  it('records provenance of the last event, including unknown ones', () => {
    let s = initialState();
    s = feed(s, '{ "timestamp":"2026-09-01T18:26:38Z", "event":"MarketID" }');
    expect(s.lastEventName).toBe('MarketID');
    expect(s.lastEventAt).toBe('2026-09-01T18:26:38Z');
    expect(s.lastEventId).toMatch(/^J\.log:\d+$/);
  });

  it('marks shutdown and clears it on a new LoadGame', () => {
    let s = initialState();
    s = feed(s, '{ "timestamp":"2026-09-01T23:15:10Z", "event":"Shutdown" }');
    expect(s.shutdown).toBe(true);

    s = feed(s, '{ "timestamp":"2026-09-02T10:00:00Z", "event":"LoadGame", "Commander":"Sythan", "FID":"F0000000", "Horizons":true, "Odyssey":true, "Ship":"Python", "ShipID":1, "ShipName":"x", "ShipIdent":"y", "FuelLevel":32.0, "FuelCapacity":32.0, "GameMode":"Solo", "Credits":1, "Loan":0, "language":"English/UK", "gameversion":"4.4.0.3", "build":"r330683/r0 " }');
    expect(s.shutdown).toBe(false);
    expect(s.ship).toBe('Python');
    expect(s.gameMode).toBe('Solo');
  });
});
