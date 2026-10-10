/**
 * The cargo manifest: from the journal at login, then Cargo.json, and never
 * an older list against a newer total.
 *
 * Shapes are those of the live journal and Cargo.json (2026-10-09/10):
 * `{ "Name":"drones", "Name_Localised":"Limpet", "Count":100, "Stolen":0 }`.
 */

import { describe, expect, it } from 'vitest';

import { applyCargoFile, cargoLines, parseInventory } from '../src/cargo.js';
import { normalize } from '../src/normalizer.js';
import { JournalSessionContext, parseLine } from '../src/parser.js';
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
const COMMANDER = (fid: string) => `{ "timestamp":"2026-10-09T23:35:00Z", "event":"Commander", "FID":"${fid}", "Name":"C${fid}" }`;
const WITH_LIST =
  '{ "timestamp":"2026-10-09T23:36:12Z", "event":"Cargo", "Vessel":"Ship", "Count":5, "Inventory":[ { "Name":"foodcartridges", "Name_Localised":"Food Cartridges", "Count":1, "Stolen":0 }, { "Name":"occupiedcryopod", "Name_Localised":"Occupied Escape Pod", "Count":1, "Stolen":0 }, { "Name":"drones", "Name_Localised":"Limpet", "Count":3, "Stolen":0 } ] }';
const COUNT_ONLY = '{ "timestamp":"2026-10-10T00:03:21Z", "event":"Cargo", "Vessel":"Ship", "Count":102 }';
const FILE = (at: string, count: number, vessel = 'Ship') =>
  JSON.stringify({
    timestamp: at,
    event: 'Cargo',
    Vessel: vessel,
    Count: count,
    Inventory: [
      { Name: 'foodcartridges', Name_Localised: 'Food Cartridges', Count: 1, Stolen: 0 },
      { Name: 'occupiedcryopod', Name_Localised: 'Occupied Escape Pod', Count: 1, Stolen: 0 },
      { Name: 'drones', Name_Localised: 'Limpet', Count: count - 2, Stolen: 0 },
    ],
  });

describe('reading an inventory', () => {
  it('uses the localised name, and tidies a plain symbol the game leaves alone', () => {
    const items = parseInventory([
      { Name: 'drones', Name_Localised: 'Limpet', Count: 4, Stolen: 0 },
      { Name: 'gold', Count: 2, Stolen: 1, MissionID: 786412662 },
    ]);
    expect(items).toEqual([
      { name: 'drones', label: 'Limpet', count: 4, stolen: false, missionId: null },
      { name: 'gold', label: 'Gold', count: 2, stolen: true, missionId: 786412662 },
    ]);
    expect(parseInventory(undefined)).toBe(UNKNOWN);
    expect(parseInventory([])).toEqual([]);
  });

  it('adds mission and stolen lots of the same goods into one line, largest first', () => {
    const lines = cargoLines([
      { name: 'silver', label: 'Silver', count: 6, stolen: false, missionId: null },
      { name: 'gold', label: 'Gold', count: 20, stolen: false, missionId: null },
      { name: 'silver', label: 'Silver', count: 4, stolen: false, missionId: 5 },
    ]);
    expect(lines).toEqual([
      { name: 'gold', label: 'Gold', count: 20 },
      { name: 'silver', label: 'Silver', count: 10 },
    ]);
  });
});

describe('the manifest in state', () => {
  it('a Cargo event with its list sets it; one without makes the old list unknown', () => {
    const feed = feeder();
    let s = initialState();
    s = feed(s, HEADER);
    s = feed(s, WITH_LIST);
    expect(s.cargoCount).toBe(5);
    expect(s.cargoManifest).not.toBe(UNKNOWN);
    s = feed(s, COUNT_ONLY);
    expect(s.cargoCount).toBe(102);
    // The old five-tonne list must not sit beside a 102-tonne total.
    expect(s.cargoManifest).toBe(UNKNOWN);
    expect(s.cargoAt).toBe('2026-10-10T00:03:21Z');
  });

  it('SRV cargo is not the ship hold', () => {
    const feed = feeder();
    let s = initialState();
    s = feed(s, HEADER);
    s = feed(s, WITH_LIST);
    s = feed(s, '{ "timestamp":"2026-10-09T23:40:00Z", "event":"Cargo", "Vessel":"SRV", "Count":2 }');
    expect(s.cargoCount).toBe(5);
    expect(s.cargoManifest).not.toBe(UNKNOWN);
  });

  it('switching commander clears it', () => {
    const feed = feeder();
    let s = initialState();
    s = feed(s, HEADER);
    s = feed(s, COMMANDER('F1'));
    s = feed(s, WITH_LIST);
    s = feed(s, COMMANDER('F2'));
    expect(s.cargoCount).toBe(UNKNOWN);
    expect(s.cargoManifest).toBe(UNKNOWN);
    expect(s.cargoAt).toBeNull();
  });
});

describe('Cargo.json', () => {
  const stateAt = (at: string, count: number) => ({ cargoCount: count, cargoAt: at, cargoManifest: UNKNOWN as never });

  it('is applied when it belongs to the latest Cargo event', () => {
    const s = stateAt('2026-10-10T00:03:21Z', 102);
    expect(applyCargoFile(s, FILE('2026-10-10T00:03:21Z', 102))).toBe('applied');
    expect(cargoLines(s.cargoManifest as never)[0]).toEqual({ name: 'drones', label: 'Limpet', count: 100 });
  });

  it('an older file (not written yet) is not applied, and says so for a retry', () => {
    const s = stateAt('2026-10-10T00:03:21Z', 102);
    expect(applyCargoFile(s, FILE('2026-10-09T23:36:12Z', 5))).toBe('older');
    expect(s.cargoManifest).toBe(UNKNOWN);
  });

  it('a newer file is left for the journal event it belongs to', () => {
    const s = stateAt('2026-10-09T23:36:12Z', 5);
    expect(applyCargoFile(s, FILE('2026-10-10T00:03:21Z', 102))).toBe('newer');
    expect(s.cargoManifest).toBe(UNKNOWN);
  });

  it('the same instant with another total, an SRV file, or junk is refused', () => {
    const s = stateAt('2026-10-10T00:03:21Z', 102);
    expect(applyCargoFile(s, FILE('2026-10-10T00:03:21Z', 99))).toBe('mismatch');
    expect(applyCargoFile(s, FILE('2026-10-10T00:03:21Z', 102, 'SRV'))).toBe('other-vessel');
    expect(applyCargoFile(s, '{ not json')).toBe('unreadable');
    expect(applyCargoFile(s, '{"event":"Market"}')).toBe('unreadable');
    expect(s.cargoManifest).toBe(UNKNOWN);
  });
});
