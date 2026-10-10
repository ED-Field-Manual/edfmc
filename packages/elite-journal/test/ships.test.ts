/**
 * Ship names, the current ship, and commander switches.
 *
 * Journal lines below keep the corpus's shapes and spellings (symbols such as
 * `PantherMkII`, `TestBuggy`, `TacticalSuit_Class2`), with other values changed.
 */

import { describe, expect, it } from 'vitest';

import { normalize } from '../src/normalizer.js';
import { JournalSessionContext, parseLine } from '../src/parser.js';
import { shipDisplayName, vehicleKind } from '../src/ships.js';
import { applyEvent, initialState, type CommanderState } from '../src/state.js';
import { UNKNOWN } from '../src/types.js';

function feeder() {
  const ctx = new JournalSessionContext();
  let offset = 0;
  return (state: CommanderState, line: string): CommanderState => {
    const r = parseLine(line, 'J.log', (offset += 100), ctx);
    if (!r?.ok) throw new Error('fixture failed to parse');
    return applyEvent(state, normalize(r.event));
  };
}

const HEADER =
  '{ "timestamp":"2026-10-09T23:34:11Z", "event":"Fileheader", "part":1, "language":"English/UK", "Odyssey":true, "gameversion":"4.4.1.1", "build":"r332841/r0 " }';
const loadGame = (fid: string, name: string, extra: string) =>
  `{ "timestamp":"2026-10-09T23:35:09Z", "event":"LoadGame", "FID":"${fid}", "Commander":"${name}", "Horizons":true, "Odyssey":true, ${extra}, "GameMode":"Solo", "Credits":1, "Loan":0, "language":"English/UK", "gameversion":"4.4.1.1", "build":"r332841/r0 " }`;
const PANTHER =
  '"Ship":"PantherMkII", "Ship_Localised":"Panther Clipper Mk II", "ShipID":21, "ShipName":"Atlas Freight", "ShipIdent":"SY-22P", "FuelLevel":10, "FuelCapacity":16';

describe('ship names', () => {
  it('uses the names the corpus pairs with each symbol', () => {
    expect(shipDisplayName('PantherMkII').name).toBe('Panther Clipper Mk II');
    expect(shipDisplayName('Krait_MkII').name).toBe('Krait Mk II');
    expect(shipDisplayName('explorer_nx').name).toBe('Caspian Explorer');
    expect(shipDisplayName('LakonMiner').name).toBe('Type-11 Prospector');
    expect(shipDisplayName('Type9').name).toBe('Type-9 Heavy');
    expect(shipDisplayName('SmallCombat01_NX').name).toBe('Kestrel Mk II');
    expect(shipDisplayName('MediumTransport01').name).toBe('Lynx Highliner');
  });

  it('plain-word symbols the game does not localise still read properly', () => {
    expect(shipDisplayName('Corsair').name).toBe('Corsair');
    expect(shipDisplayName('SideWinder').name).toBe('Sidewinder');
    expect(shipDisplayName('Anaconda').name).toBe('Anaconda');
  });

  it("prefers the game's own localised name, but never a $TOKEN; placeholder", () => {
    expect(shipDisplayName('Whatever', 'Some Real Name')).toEqual({ name: 'Some Real Name', recognised: true });
    expect(shipDisplayName('PantherMkII', '$PANTHER_NAME;').name).toBe('Panther Clipper Mk II');
  });

  it('an unknown symbol is tidied and marked as not recognised, never shown raw', () => {
    const n = shipDisplayName('Future_ShipMkVII');
    expect(n.recognised).toBe(false);
    expect(n.name).toBe('Future Ship Mk VII');
    expect(n.name).not.toContain('_');
  });

  it('tells ships from the SRVs, suits and taxis a login can name', () => {
    expect(vehicleKind('PantherMkII')).toBe('ship');
    expect(vehicleKind('TestBuggy')).toBe('srv');
    expect(vehicleKind('Combat_Multicrew_SRV_01')).toBe('srv');
    expect(vehicleKind('TacticalSuit_Class2')).toBe('suit');
    expect(vehicleKind('FlightSuit')).toBe('suit');
    expect(vehicleKind('vulture_taxi')).toBe('taxi');
  });
});

describe('the current ship', () => {
  it('LoadGame in a ship sets it, with the localised name and no stale capacity', () => {
    const feed = feeder();
    let s = initialState();
    s = feed(s, HEADER);
    s = feed(s, loadGame('F1', 'Sythan', PANTHER));
    expect(s.ship).toBe('PantherMkII');
    expect(s.shipLocalised).toBe('Panther Clipper Mk II');
    expect(s.shipName).toBe('Atlas Freight');
    expect(s.shipId).toBe(21);
    expect(s.vehicle).toBe('ship');
    expect(s.cargoCapacity).toBe(UNKNOWN);
  });

  it('logging in on foot or in an SRV does not replace the ship with the suit or buggy', () => {
    const feed = feeder();
    let s = initialState();
    s = feed(s, HEADER);
    s = feed(s, loadGame('F1', 'Sythan', PANTHER));
    s = feed(s, loadGame('F1', 'Sythan', '"Ship":"TacticalSuit_Class2", "Ship_Localised":"$TacticalSuit_Class1_Name;"'));
    expect(s.ship).toBe('PantherMkII');
    expect(s.vehicle).toBe('on-foot');
    s = feed(s, loadGame('F1', 'Sythan', '"Ship":"TestBuggy", "Ship_Localised":"SRV Scarab"'));
    expect(s.ship).toBe('PantherMkII');
    expect(s.vehicle).toBe('srv');
  });

  it('a Loadout after a shipyard swap changes the ship mid-session, with its capacity', () => {
    const feed = feeder();
    let s = initialState();
    s = feed(s, HEADER);
    s = feed(s, loadGame('F1', 'Sythan', PANTHER));
    s = feed(s, '{ "timestamp":"2026-10-09T23:36:09Z", "event":"Loadout", "Ship":"panthermkii", "ShipID":21, "ShipName":"Atlas Freight", "ShipIdent":"SY-22P", "CargoCapacity":1236, "MaxJumpRange":22.6, "Modules":[] }');
    expect(s.cargoCapacity).toBe(1236);
    expect(s.shipLocalised).toBe('Panther Clipper Mk II'); // same ship, name kept
    s = feed(s, '{ "timestamp":"2026-10-09T23:50:00Z", "event":"Loadout", "Ship":"explorer_nx", "ShipID":28, "ShipName":"", "ShipIdent":"EX-01", "CargoCapacity":64, "MaxJumpRange":32.5, "Modules":[] }');
    expect(s.ship).toBe('explorer_nx');
    expect(s.shipId).toBe(28);
    expect(s.cargoCapacity).toBe(64);
    // The Panther's localised name must not label the Caspian.
    expect(s.shipLocalised).toBe(UNKNOWN);
    expect(shipDisplayName(s.ship as string).name).toBe('Caspian Explorer');
  });
});

describe('sessions', () => {
  it('Shutdown is recorded, and the next LoadGame clears it along with the old route', () => {
    const feed = feeder();
    let s = initialState();
    s = feed(s, HEADER);
    s = feed(s, loadGame('F1', 'Sythan', PANTHER));
    s = feed(s, '{ "timestamp":"2026-10-09T23:40:00Z", "event":"FSDTarget", "Name":"Wregoe RH-O b47-5", "SystemAddress":1, "StarClass":"M", "RemainingJumpsInRoute":4 }');
    s = feed(s, '{ "timestamp":"2026-10-09T23:59:00Z", "event":"Shutdown" }');
    expect(s.shutdown).toBe(true);
    s = feed(s, HEADER);
    s = feed(s, loadGame('F1', 'Sythan', PANTHER));
    expect(s.shutdown).toBe(false);
    expect(s.jumpTarget).toBe(UNKNOWN);
    expect(s.remainingJumps).toBe(UNKNOWN);
  });

  it('a different commander starts clean: no ship, place or route carried over', () => {
    const feed = feeder();
    let s = initialState();
    s = feed(s, HEADER);
    s = feed(s, loadGame('F1', 'Sythan', PANTHER));
    s = feed(s, '{ "timestamp":"2026-10-09T23:36:09Z", "event":"Location", "Docked":true, "StationName":"Wheal Friendly", "StationType":"Dodec", "MarketID":4371433731, "StarSystem":"Synuefe XR-H d11-45", "SystemAddress":1556749470051, "StarPos":[1,2,3], "Body":"Wheal Friendly", "BodyType":"Station", "BodyID":5 }');
    expect(s.stationName).toBe('Wheal Friendly');

    s = feed(s, HEADER);
    s = feed(s, '{ "timestamp":"2026-10-10T10:00:00Z", "event":"Commander", "FID":"F2", "Name":"AltOne" }');
    expect(s.commander).toBe('AltOne');
    expect(s.fid).toBe('F2');
    expect(s.ship).toBe(UNKNOWN);
    expect(s.shipName).toBe(UNKNOWN);
    expect(s.starSystem).toBe(UNKNOWN);
    expect(s.stationName).toBe(UNKNOWN);
    expect(s.gameVersion).toBe('4.4.1.1'); // provenance re-applied for the new commander
  });
});
