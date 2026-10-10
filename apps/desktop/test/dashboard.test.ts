/**
 * The Dashboard's wording, from state alone, and the game-running status.
 *
 * Every case here is a situation the screen must describe truthfully: docked,
 * landed, on foot, the game closed, a commander with nothing reported yet.
 */

import { describe, expect, it } from 'vitest';
import { initialState, UNKNOWN, type CommanderState } from '@edfm/elite-journal';
import type { LiveExobiology } from '@edfm/activity';

import {
  describeLocation,
  describeShip,
  exobiologyActivity,
  missionsActivity,
  navigationActivity,
} from '../src/lib/dashboard';
import { gameModeLabel, isLive, sessionStatus, SESSION_LABEL } from '../src/lib/session';

const state = (over: Partial<CommanderState>): CommanderState => ({ ...initialState(), ...over });

describe('is the game running?', () => {
  it('a watched journal alone does not mean the game is running', () => {
    expect(sessionStatus({ reader: 'watching', gameWindow: false, shutdownSeen: false })).toBe('game-offline');
    expect(sessionStatus({ reader: 'watching', gameWindow: null, shutdownSeen: false })).toBe('game-unknown');
  });

  it('the game window says active; Shutdown says offline when the window cannot be checked', () => {
    expect(sessionStatus({ reader: 'watching', gameWindow: true, shutdownSeen: false })).toBe('game-active');
    expect(sessionStatus({ reader: 'watching', gameWindow: null, shutdownSeen: true })).toBe('game-offline');
  });

  it('a relaunch after Shutdown is active as soon as the window is back', () => {
    expect(sessionStatus({ reader: 'watching', gameWindow: true, shutdownSeen: true })).toBe('game-active');
  });

  it('the journal reader comes first: no folder, starting, or an error', () => {
    expect(sessionStatus({ reader: 'no-directory', gameWindow: true, shutdownSeen: false })).toBe('waiting-for-journal');
    expect(sessionStatus({ reader: 'starting', gameWindow: null, shutdownSeen: false })).toBe('waiting-for-journal');
    expect(sessionStatus({ reader: 'error', gameWindow: true, shutdownSeen: false })).toBe('journal-error');
  });

  it('only "game active" is live, and every status has words', () => {
    expect(isLive('game-active')).toBe(true);
    for (const s of ['game-offline', 'game-unknown', 'waiting-for-journal', 'journal-error'] as const) {
      expect(isLive(s)).toBe(false);
      expect(SESSION_LABEL[s].length).toBeGreaterThan(3);
    }
  });

  it('names the game mode as the game does, with the private group', () => {
    expect(gameModeLabel('Solo', null)).toBe('Solo');
    expect(gameModeLabel('Open', null)).toBe('Open');
    expect(gameModeLabel('Group', 'Sythan')).toBe('Private Group: Sythan');
    expect(gameModeLabel(null, null)).toBeNull();
  });
});

describe('location', () => {
  it('docked at a station, without repeating the station as a body', () => {
    const v = describeLocation(
      state({ starSystem: 'Wregoe FH-D d12-45', travel: 'docked', stationName: 'Delsanti Hub', stationType: 'Dodec', body: 'Delsanti Hub', bodyType: 'Station' }),
    );
    expect(v).toEqual({
      system: 'Wregoe FH-D d12-45',
      where: 'Docked at Delsanti Hub',
      status: { glyph: '⚓', label: 'Docked' },
      vehicle: null,
    });
  });

  it('a fleet carrier is named with its callsign, by name only when known', () => {
    expect(
      describeLocation(state({ starSystem: 'A', travel: 'docked', stationName: 'HBN-TXN', stationType: 'FleetCarrier', carrierName: 'Crown' })).where,
    ).toBe('Docked at Crown (HBN-TXN)');
    expect(
      describeLocation(state({ starSystem: 'A', travel: 'docked', stationName: 'K8V-1QZ', stationType: 'FleetCarrier' })).where,
    ).toBe('Docked at fleet carrier K8V-1QZ');
  });

  it('landed on a body, on foot', () => {
    const v = describeLocation(
      state({ starSystem: 'Wregoe BB-F d11-77', travel: 'landed', body: 'Wregoe BB-F d11-77 7 a', bodyType: 'Planet', vehicle: 'on-foot' }),
    );
    expect(v.where).toBe('Landed on Wregoe BB-F d11-77 7 a');
    expect(v.vehicle).toBe('On foot');
  });

  it('in supercruise near the main star says nothing redundant', () => {
    const v = describeLocation(state({ starSystem: 'Sol', travel: 'supercruise', body: 'Sol', bodyType: 'Star' }));
    expect(v.where).toBeNull();
    expect(v.status?.label).toBe('Supercruise');
  });

  it('nothing reported: no system, no line, no guess', () => {
    expect(describeLocation(initialState())).toEqual({ system: null, where: null, status: null, vehicle: null });
  });
});

describe('ship', () => {
  it('custom name, proper model, cargo against capacity', () => {
    expect(
      describeShip(state({ ship: 'PantherMkII', shipName: 'Atlas Freight', shipIdent: 'SY-22P', cargoCount: 38, cargoCapacity: 1236, vehicle: 'ship' })),
    ).toEqual({
      name: 'Atlas Freight',
      model: 'Panther Clipper Mk II',
      modelRecognised: true,
      ident: 'SY-22P',
      cargo: '38 / 1236 t',
      away: false,
    });
  });

  it('capacity unknown: cargo alone; neither known: no cargo line at all', () => {
    expect(describeShip(state({ ship: 'Corsair', cargoCount: 5 }))?.cargo).toBe('5 t');
    expect(describeShip(state({ ship: 'Corsair' }))?.cargo).toBeNull();
  });

  it('an empty custom name falls back to the model; no ship yet is null', () => {
    expect(describeShip(state({ ship: 'explorer_nx', shipName: '  ' }))?.name).toBeNull();
    expect(describeShip(initialState())).toBeNull();
  });

  it('on foot or in an SRV, the ship is shown as not aboard', () => {
    expect(describeShip(state({ ship: 'Corsair', vehicle: 'srv' }))?.away).toBe(true);
  });
});

describe('activity: only what existing state supports', () => {
  it('navigation shows the next jump and the route count, and only while live', () => {
    const s = state({ jumpTarget: 'Wregoe GC-D d12-102', remainingJumps: 4 });
    expect(navigationActivity(s, true)?.lines).toEqual([
      'Next jump: Wregoe GC-D d12-102',
      '4 jumps left in your plotted route',
    ]);
    expect(navigationActivity(s, false)).toBeNull();
    expect(navigationActivity(state({ jumpTarget: 'X', remainingJumps: UNKNOWN }), true)?.lines).toEqual(['Next jump: X']);
    expect(navigationActivity(initialState(), true)).toBeNull();
  });

  it('missions: the count and the soonest to expire', () => {
    const m = (name: string, expiry: string) =>
      ({ localisedName: name, expiry, destinationSystem: UNKNOWN, destinationStation: UNKNOWN }) as never;
    const a = missionsActivity([m('Later', '2026-10-12T00:00:00Z'), m('Sooner', '2026-10-10T00:00:00Z')], () => '5h');
    expect(a?.title).toBe('2 active missions');
    expect(a?.lines[0]).toBe('Sooner · 5h left');
    expect(missionsActivity([], () => '')).toBeNull();
  });

  it('exobiology: signals, completed, and a sample count only when it is known', () => {
    const exo: LiveExobiology = {
      systemName: 'S', systemAddress: 1, bodyId: 2, bodyName: 'S 7 a',
      rows: [
        { genusToken: 'a', genus: 'Bacterium', speciesToken: 'x', species: 'Bacterium Informem', colour: null, samplesTaken: 2, samplesRequired: 3, completed: false },
        { genusToken: 'b', genus: 'Concha', speciesToken: 'y', species: 'Concha Renibus', colour: null, samplesTaken: 3, samplesRequired: 3, completed: true },
      ],
      activeGenusToken: 'a', completedCount: 1, unscannedCount: 0, total: 2, updatedAt: '',
    };
    expect(exobiologyActivity(exo)?.lines).toEqual([
      'S 7 a',
      '2 biological signals · 1 of 2 complete',
      'Sampling Bacterium Informem · 2 / 3 samples',
    ]);
    // A run first seen midway has no count; it is not shown as 0 / 3 or 1 / 3.
    const midway = { ...exo, rows: [{ ...exo.rows[0]!, samplesTaken: null }] };
    expect(exobiologyActivity(midway)?.lines.at(-1)).toBe('Sampling Bacterium Informem · sampling');
    expect(exobiologyActivity(null)).toBeNull();
    expect(exobiologyActivity({ ...exo, total: 0, rows: [] })).toBeNull();
  });
});
