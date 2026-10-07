/**
 * Journal → Inara, one mapping at a time.
 *
 * Fixtures copy the *shape* of real lines from the project's journal corpus
 * (field names, types, which fields are present), with names and numbers
 * changed. Where the corpus has no example -- Legacy and beta headers,
 * ShipyardSell, DeleteSuitLoadout -- the fixture says so.
 */

import { describe, expect, it } from 'vitest';

import {
  INARA_CATEGORY_DEFAULTS,
  INARA_MAX_AGE_MS,
  InaraTranslator,
  inaraLiveGate,
  type InaraOutgoing,
  type InaraProvenance,
} from '../src/inara-translate.js';

const NOW = Date.parse('2026-10-06T22:30:00Z');
const FID = 'F1000001';

function prov(at = '2026-10-06T22:06:49Z', over: Partial<InaraProvenance> = {}): InaraProvenance {
  return {
    timestamp: at,
    timestampMs: Date.parse(at),
    gameVersion: '4.4.1.1',
    build: 'r332841/r0 ',
    fid: FID,
    ...over,
  };
}

function feed(t: InaraTranslator, lines: Array<Record<string, unknown>>, p = prov()): InaraOutgoing[] {
  return lines.flatMap((l) => [...t.observe(l, p, NOW).events]);
}

const one = (events: InaraOutgoing[], name: string) => {
  const found = events.filter((e) => e.eventName === name);
  expect(found, `expected exactly one ${name}`).toHaveLength(1);
  return found[0]!;
};

const LOADGAME = {
  event: 'LoadGame',
  FID,
  Commander: 'Testpilot',
  Horizons: true,
  Odyssey: true,
  Ship: 'corsair',
  ShipID: 18,
  ShipName: 'Test Wing',
  ShipIdent: 'TE-01',
  GameMode: 'Solo',
  Credits: 2274416971,
  Loan: 0,
  gameversion: '4.4.1.1',
  build: 'r332841/r0 ',
};

/* ------------------------------------------------------------------ gate */

describe('only the live game reaches Inara', () => {
  it('accepts 4.x live versions, as the corpus has', () => {
    for (const v of ['4.3.3.0', '4.4.0.3', '4.4.1.1']) {
      expect(inaraLiveGate({ gameVersion: v, build: 'r332841/r0 ' })).toBe('live');
    }
  });

  it('refuses Legacy 3.8 (synthetic: the corpus has no Legacy session)', () => {
    expect(inaraLiveGate({ gameVersion: '3.8.0.407', build: 'r270683/r0 ' })).toBe('legacy');
  });

  it('refuses beta builds, whichever field says so (synthetic)', () => {
    expect(inaraLiveGate({ gameVersion: '4.5.0.0 Beta', build: 'r1/r0 ' })).toBe('beta');
    expect(inaraLiveGate({ gameVersion: '4.5.0.0', build: 'r1/r0 BETA' })).toBe('beta');
  });

  it('refuses a line whose version is unknown rather than assuming it is live', () => {
    expect(inaraLiveGate({ gameVersion: null, build: null })).toBe('unknown-version');
    expect(inaraLiveGate({ gameVersion: '', build: null })).toBe('unknown-version');
  });

  it('produces nothing at all from a Legacy or beta line, before translation', () => {
    const t = new InaraTranslator();
    for (const over of [{ gameVersion: '3.8.0.407' }, { gameVersion: '4.5.0.0 Beta' }]) {
      const r = t.observe(LOADGAME, prov(undefined, over), NOW);
      expect(r.events).toEqual([]);
      expect(r.flush).toBeNull();
      expect(r.blocked).not.toBeNull();
    }
  });

  it('produces nothing for a line with no known commander', () => {
    const t = new InaraTranslator();
    const r = t.observe({ event: 'Rank', Combat: 1 }, prov(undefined, { fid: null }), NOW);
    expect(r.blocked).toBe('no-commander');
  });

  it('withholds events older than 30 days, Inara’s limit', () => {
    const t = new InaraTranslator();
    const old = new Date(NOW - INARA_MAX_AGE_MS - 60_000).toISOString();
    const r = t.observe(LOADGAME, prov(old), NOW);
    expect(r.events).toEqual([]);
    expect(r.blocked).toBe('too-old');
  });

  it('still learns the ship from a too-old line, because it is still true', () => {
    const t = new InaraTranslator();
    const old = new Date(NOW - INARA_MAX_AGE_MS - 60_000).toISOString();
    t.observe(LOADGAME, prov(old), NOW);
    const jump = one(
      feed(t, [{ event: 'FSDJump', Taxi: false, StarSystem: 'Alpha', StarPos: [1, 2, 3], JumpDist: 9.5 }]),
      'addCommanderTravelFSDJump',
    );
    expect(jump.eventData).toMatchObject({ shipType: 'corsair', shipGameID: 18 });
  });
});

/* ---------------------------------------------------------------- travel */

describe('travel', () => {
  it('Location sets the current location at session start, with no flight-log entry', () => {
    const t = new InaraTranslator();
    const out = feed(t, [
      {
        event: 'Location',
        Docked: true,
        StationName: 'Test Town',
        StationType: 'Coriolis',
        MarketID: 4320425475,
        StarSystem: 'Alpha',
        StarPos: [1.5, -2.25, 3],
        Body: 'Test Town',
        BodyType: 'Station',
        Latitude: 12.3,
        Longitude: 45.6,
      },
    ]);
    const loc = one(out, 'setCommanderTravelLocation');
    expect(loc.eventData).toEqual({
      starsystemName: 'Alpha',
      starsystemCoords: [1.5, -2.25, 3],
      stationName: 'Test Town',
      marketID: 4320425475,
    });
    // Docking is not inferred at session start: Inara warns against it.
    expect(out.some((e) => e.eventName === 'addCommanderTravelDock')).toBe(false);
    expect(loc.coalesceKey).toBe('location');
  });

  it('names a real body, never the station-as-body, and never a surface position', () => {
    const t = new InaraTranslator();
    const loc = one(
      feed(t, [
        {
          event: 'Location',
          Docked: false,
          StarSystem: 'Alpha',
          StarPos: [0, 0, 0],
          Body: 'Alpha 3 a',
          BodyType: 'Planet',
          Latitude: 12.3,
          Longitude: 45.6,
        },
      ]),
      'setCommanderTravelLocation',
    );
    expect(loc.eventData).toMatchObject({ starsystemBodyName: 'Alpha 3 a' });
    expect(JSON.stringify(loc.eventData)).not.toContain('BodyCoords');
  });

  it('FSDJump adds a jump with distance and the ship flown, and asks for a send', () => {
    const t = new InaraTranslator();
    feed(t, [LOADGAME]);
    const r = t.observe(
      { event: 'FSDJump', Taxi: false, StarSystem: 'Beta', StarPos: [502.4, 89.8, -7.9], JumpDist: 17.567 },
      prov('2026-10-06T22:20:00Z'),
      NOW,
    );
    expect(r.flush).toBe('now');
    expect(one([...r.events], 'addCommanderTravelFSDJump').eventData).toEqual({
      starsystemName: 'Beta',
      starsystemCoords: [502.4, 89.8, -7.9],
      jumpDistance: 17.567,
      shipType: 'corsair',
      shipGameID: 18,
    });
  });

  it('a taxi jump carries the taxi kind instead of the commander’s ship', () => {
    const t = new InaraTranslator();
    feed(t, [LOADGAME, { event: 'BookDropship', Retreat: false, Cost: 0, DestinationSystem: 'Beta' }]);
    const d = one(
      feed(t, [{ event: 'FSDJump', Taxi: true, StarSystem: 'Beta', StarPos: [1, 1, 1], JumpDist: 5 }]),
      'addCommanderTravelFSDJump',
    ).eventData as Record<string, unknown>;
    expect(d['isTaxiDropship']).toBe(true);
    expect(d['shipType']).toBeUndefined();

    feed(t, [{ event: 'BookTaxi', Cost: 47253, DestinationSystem: 'Gamma' }]);
    const shuttle = one(
      feed(t, [{ event: 'Docked', Taxi: true, StationName: 'Port', StarSystem: 'Gamma', MarketID: 1 }]),
      'addCommanderTravelDock',
    ).eventData as Record<string, unknown>;
    expect(shuttle['isTaxiShuttle']).toBe(true);
  });

  it('Docked adds a dock with the market id', () => {
    const t = new InaraTranslator();
    feed(t, [LOADGAME]);
    const r = t.observe(
      { event: 'Docked', StationName: 'Delta Hub', StationType: 'Dodec', Taxi: false, StarSystem: 'Beta', MarketID: 4388945667 },
      prov('2026-10-06T22:21:00Z'),
      NOW,
    );
    expect(r.flush).toBe('now');
    expect(one([...r.events], 'addCommanderTravelDock').eventData).toEqual({
      starsystemName: 'Beta',
      stationName: 'Delta Hub',
      marketID: 4388945667,
      shipType: 'corsair',
      shipGameID: 18,
    });
  });

  it('Touchdown is a landing only when the commander flew it, on a planet; never lat/long', () => {
    const t = new InaraTranslator();
    feed(t, [LOADGAME]);
    const base = {
      event: 'Touchdown',
      Taxi: false,
      Multicrew: false,
      StarSystem: 'Beta',
      Body: 'Beta 7 a',
      OnStation: false,
      OnPlanet: true,
      Latitude: 29.6,
      Longitude: -59.7,
    };
    expect(feed(t, [{ ...base, PlayerControlled: false }])).toEqual([]);
    const land = one(feed(t, [{ ...base, PlayerControlled: true }]), 'addCommanderTravelLand');
    expect(land.eventData).toEqual({
      starsystemName: 'Beta',
      starsystemBodyName: 'Beta 7 a',
      shipType: 'corsair',
      shipGameID: 18,
    });
  });

  it('CarrierJump is logged only when aboard, without a jump distance', () => {
    const t = new InaraTranslator();
    feed(t, [LOADGAME]);
    const aboard = {
      event: 'CarrierJump',
      Docked: true,
      StationName: 'HBN-TXN',
      StationType: 'FleetCarrier',
      MarketID: 3703420416,
      StarSystem: 'Gamma',
      StarPos: [4, 5, 6],
    };
    const c = one(feed(t, [aboard]), 'addCommanderTravelCarrierJump');
    expect(c.eventData).toEqual({
      starsystemName: 'Gamma',
      starsystemCoords: [4, 5, 6],
      stationName: 'HBN-TXN',
      marketID: 3703420416,
      shipType: 'corsair',
      shipGameID: 18,
    });
    expect(feed(t, [{ ...aboard, Docked: false }]).filter((e) => e.category === 'travel')).toEqual([]);
  });
});

/* ----------------------------------------------------------------- ranks */

describe('ranks and reputation', () => {
  const RANK = { event: 'Rank', Combat: 4, Trade: 13, Explore: 6, Soldier: 3, Exobiologist: 4, Empire: 0, Federation: 6, CQC: 0 };
  const PROGRESS = { event: 'Progress', Combat: 63, Trade: 100, Explore: 55, Soldier: 59, Exobiologist: 22, Empire: 82, Federation: 76, CQC: 0 };

  it('Rank + Progress become all eight pilot ranks, exobiologist included, progress 0..1', () => {
    const t = new InaraTranslator();
    const out = feed(t, [LOADGAME, RANK, PROGRESS]);
    const e = one(out, 'setCommanderRankPilot');
    const items = e.eventData as Array<Record<string, unknown>>;
    expect(items).toHaveLength(8);
    expect(items.map((i) => i['rankName'])).toEqual([
      'combat', 'trade', 'explore', 'soldier', 'exobiologist', 'empire', 'federation', 'cqc',
    ]);
    expect(items[4]).toEqual({ rankName: 'exobiologist', rankValue: 4, rankProgress: 0.22 });
    expect(items[1]).toEqual({ rankName: 'trade', rankValue: 13, rankProgress: 1 });
    expect(e.coalesceKey).toBe('rank-pilot');
  });

  it('Progress without a Rank since login is not sent', () => {
    const t = new InaraTranslator();
    expect(feed(t, [LOADGAME, PROGRESS])).not.toContainEqual(
      expect.objectContaining({ eventName: 'setCommanderRankPilot' }),
    );
  });

  it('Promotion sends only the ranks it names', () => {
    const t = new InaraTranslator();
    const e = one(feed(t, [{ event: 'Promotion', Exobiologist: 5 }]), 'setCommanderRankPilot');
    expect(e.eventData).toEqual([{ rankName: 'exobiologist', rankValue: 5 }]);
  });

  it('EngineerProgress: the login list, skipping Inara’s unknown stage Known', () => {
    const t = new InaraTranslator();
    const e = one(
      feed(t, [
        {
          event: 'EngineerProgress',
          Engineers: [
            { Engineer: 'The Sarge', EngineerID: 300040, Progress: 'Invited' },
            { Engineer: 'Professor Palin', EngineerID: 300220, Progress: 'Unlocked', RankProgress: 0, Rank: 5 },
            { Engineer: 'Eleanor Bresa', EngineerID: 400011, Progress: 'Known' },
          ],
        },
      ]),
      'setCommanderRankEngineer',
    );
    expect(e.eventData).toEqual([
      { engineerName: 'The Sarge', rankStage: 'Invited' },
      { engineerName: 'Professor Palin', rankStage: 'Unlocked', rankValue: 5 },
    ]);
  });

  it('EngineerProgress: the single-update shape, with a rank and no stage', () => {
    const t = new InaraTranslator();
    const e = one(
      feed(t, [{ event: 'EngineerProgress', Engineer: "Tod 'The Blaster' McQuinn", EngineerID: 300260, Rank: 2 }]),
      'setCommanderRankEngineer',
    );
    expect(e.eventData).toEqual([{ engineerName: "Tod 'The Blaster' McQuinn", rankValue: 2 }]);
  });

  it('Powerplay sets rank and merits; merits alone need a known rank; leaving sends -1', () => {
    const t = new InaraTranslator();
    expect(
      feed(t, [{ event: 'PowerplayMerits', Power: 'Felicia Winters', MeritsGained: 19, TotalMerits: 100 }]),
    ).toEqual([]);
    const pp = one(
      feed(t, [{ event: 'Powerplay', Power: 'Felicia Winters', Rank: 20, Merits: 136941, TimePledged: 1 }]),
      'setCommanderRankPower',
    );
    expect(pp.eventData).toEqual({ powerName: 'Felicia Winters', rankValue: 20, meritsValue: 136941 });
    const merits = one(
      feed(t, [{ event: 'PowerplayMerits', Power: 'Felicia Winters', MeritsGained: 19, TotalMerits: 136960 }]),
      'setCommanderRankPower',
    );
    expect(merits.eventData).toEqual({ powerName: 'Felicia Winters', rankValue: 20, meritsValue: 136960 });
    const leave = one(feed(t, [{ event: 'PowerplayLeave', Power: 'Felicia Winters' }]), 'setCommanderRankPower');
    expect(leave.eventData).toEqual({ powerName: 'Felicia Winters', rankValue: -1 });
  });

  it('Reputation is divided into Inara’s -1..1 range', () => {
    const t = new InaraTranslator();
    const e = one(
      feed(t, [{ event: 'Reputation', Empire: 36.4837, Federation: 98.258003, Independent: 0.0, Alliance: -100 }]),
      'setCommanderReputationMajorFaction',
    );
    const items = e.eventData as Array<{ majorfactionName: string; majorfactionReputation: number }>;
    expect(items.map((i) => i.majorfactionName)).toEqual(['empire', 'federation', 'independent', 'alliance']);
    expect(items[0]!.majorfactionReputation).toBeCloseTo(0.364837, 9);
    expect(items[1]!.majorfactionReputation).toBeCloseTo(0.98258003, 9);
    expect(items[2]!.majorfactionReputation).toBe(0);
    expect(items[3]!.majorfactionReputation).toBe(-1);
  });

  it('minor faction reputation is sent from MyReputation, and only when it changed', () => {
    const t = new InaraTranslator();
    const jump = (rep: number) => ({
      event: 'FSDJump',
      StarSystem: 'Beta',
      StarPos: [0, 0, 0],
      JumpDist: 1,
      Factions: [
        { Name: 'Mother Gaia', MyReputation: rep },
        { Name: 'No Rep Here' },
      ],
    });
    const first = one(feed(t, [jump(50)]), 'setCommanderReputationMinorFaction');
    expect(first.eventData).toEqual([{ minorfactionName: 'Mother Gaia', minorfactionReputation: 0.5 }]);
    expect(feed(t, [jump(50)]).some((e) => e.eventName === 'setCommanderReputationMinorFaction')).toBe(false);
    expect(feed(t, [jump(60)]).some((e) => e.eventName === 'setCommanderReputationMinorFaction')).toBe(true);
  });
});

/* -------------------------------------------------- credits and statistics */

describe('credits and statistics', () => {
  it('credits come only from LoadGame, the game’s own figure, with no invented assets', () => {
    const t = new InaraTranslator();
    const r = t.observe(LOADGAME, prov(), NOW);
    expect(r.flush).toBe('session-start');
    const c = one([...r.events], 'setCommanderCredits');
    expect(c.eventData).toEqual({ commanderCredits: 2274416971, commanderLoan: 0 });
    expect(c.category).toBe('credits');
  });

  it('credits are off by default; everything else is on', () => {
    expect(INARA_CATEGORY_DEFAULTS.credits).toBe(false);
    expect(Object.entries(INARA_CATEGORY_DEFAULTS).filter(([, v]) => !v)).toEqual([['credits', false]]);
  });

  it('Statistics are sent whole, never partially', () => {
    const t = new InaraTranslator();
    const stats = {
      event: 'Statistics',
      Bank_Account: { Current_Wealth: 1, Spent_On_Ships: 2 },
      Combat: { Bounties_Claimed: 5 },
      Exobiology: { Organic_Data: 3 },
    };
    const e = one(feed(t, [stats]), 'setCommanderGameStatistics');
    expect(e.eventData).toEqual({
      Bank_Account: { Current_Wealth: 1, Spent_On_Ships: 2 },
      Combat: { Bounties_Claimed: 5 },
      Exobiology: { Organic_Data: 3 },
    });
  });
});

/* ----------------------------------------------------------------- ships */

describe('ships', () => {
  const LOADOUT = {
    event: 'Loadout',
    Ship: 'corsair',
    ShipID: 18,
    ShipName: 'Test Wing',
    ShipIdent: 'TE-01',
    HullValue: 79304746,
    ModulesValue: 215780835,
    HullHealth: 1.0,
    UnladenMass: 785.1,
    CargoCapacity: 64,
    MaxJumpRange: 27.648794,
    FuelCapacity: { Main: 32.0, Reserve: 0.41 },
    Rebuy: 14754281,
    Modules: [
      {
        Slot: 'LargeHardpoint1',
        Item: 'hpt_multicannon_gimbal_large',
        On: true,
        Priority: 2,
        AmmoInClip: 77,
        AmmoInHopper: 2100,
        Health: 1.0,
        Value: 578436,
        Engineering: {
          Engineer: "Tod 'The Blaster' McQuinn",
          EngineerID: 300260,
          BlueprintID: 128673504,
          BlueprintName: 'Weapon_Overcharged',
          Level: 5,
          Quality: 1.0,
          ExperimentalEffect: 'special_auto_loader',
          ExperimentalEffect_Localised: 'Auto Loader',
          Modifiers: [
            { Label: 'Damage', Value: 4.828, OriginalValue: 2.84, LessIsGood: 0 },
            { Label: 'ThermalLoad', Value: 0.391, OriginalValue: 0.34, LessIsGood: 1 },
            { Label: 'DamageType', ValueStr: '$Thermic;', ValueStr_Localised: 'Thermal' },
          ],
        },
      },
      { Slot: 'Armour', Item: 'corsair_armour_grade1', On: true, Priority: 1, Health: 1.0 },
    ],
  };

  it('Loadout sets the current ship, never the main ship', () => {
    const t = new InaraTranslator();
    const ship = one(feed(t, [LOADOUT]), 'setCommanderShip');
    expect(ship.eventData).toEqual({
      shipType: 'corsair',
      shipGameID: 18,
      isCurrentShip: true,
      shipName: 'Test Wing',
      shipIdent: 'TE-01',
      shipHullValue: 79304746,
      shipModulesValue: 215780835,
      shipRebuyCost: 14754281,
      shipCargoCapacity: 64,
      shipMaxJumpRange: 27.648794,
    });
    expect(JSON.stringify(ship.eventData)).not.toContain('isMainShip');
    expect(ship.coalesceKey).toBe('ship:18');
  });

  it('Loadout modules map field by field, engineering included', () => {
    const t = new InaraTranslator();
    const lo = one(feed(t, [LOADOUT]), 'setCommanderShipLoadout');
    const d = lo.eventData as { shipLoadout: Array<Record<string, unknown>> };
    expect(d.shipLoadout[0]).toEqual({
      slotName: 'LargeHardpoint1',
      itemName: 'hpt_multicannon_gimbal_large',
      itemValue: 578436,
      itemHealth: 1,
      isOn: true,
      itemPriority: 2,
      itemAmmoClip: 77,
      itemAmmoHopper: 2100,
      engineering: {
        blueprintName: 'Weapon_Overcharged',
        blueprintLevel: 5,
        blueprintQuality: 1,
        experimentalEffect: 'special_auto_loader',
        modifiers: [
          { name: 'Damage', value: 4.828, originalValue: 2.84, lessIsGood: false },
          { name: 'ThermalLoad', value: 0.391, originalValue: 0.34, lessIsGood: true },
          { name: 'DamageType', value: '$Thermic;' },
        ],
      },
    });
    // A module with no value in the journal gets none invented.
    expect(d.shipLoadout[1]).not.toHaveProperty('itemValue');
    expect(lo.coalesceKey).toBe('loadout:18');
  });

  it('ShipyardSwap stores the old ship where the commander is, and makes the new one current', () => {
    const t = new InaraTranslator();
    feed(t, [
      LOADGAME,
      { event: 'Docked', StationName: 'Port', StarSystem: 'Beta', MarketID: 3703420416 },
    ]);
    const out = feed(t, [
      { event: 'ShipyardSwap', ShipType: 'corsair', ShipID: 18, StoreOldShip: 'PantherMkII', StoreShipID: 21, MarketID: 3703420416 },
    ]);
    expect(out.map((e) => e.eventName)).toEqual(['setCommanderShipTransfer', 'setCommanderShip']);
    expect(out[0]!.eventData).toEqual({
      shipType: 'PantherMkII',
      shipGameID: 21,
      starsystemName: 'Beta',
      stationName: 'Port',
      marketID: 3703420416,
    });
    expect(out[1]!.eventData).toEqual({ shipType: 'corsair', shipGameID: 18, isCurrentShip: true });
  });

  it('ShipyardSwap that sells the old ship removes it (journal manual shape)', () => {
    const t = new InaraTranslator();
    const out = feed(t, [
      { event: 'ShipyardSwap', ShipType: 'sidewinder', ShipID: 10, SellOldShip: 'Asp', SellShipID: 2 },
    ]);
    expect(out[0]).toMatchObject({ eventName: 'delCommanderShip', eventData: { shipType: 'Asp', shipGameID: 2 } });
  });

  it('ShipyardBuy + ShipyardNew store the old ship and add the new one by NewShipID', () => {
    const t = new InaraTranslator();
    feed(t, [{ event: 'Docked', StationName: 'Yard', StarSystem: 'Beta', MarketID: 5 }]);
    const out = feed(t, [
      { event: 'ShipyardBuy', ShipType: 'explorer_nx', ShipType_Localised: 'Caspian Explorer', ShipPrice: 1, StoreOldShip: 'Corsair', StoreShipID: 18, MarketID: 5 },
      { event: 'ShipyardNew', ShipType: 'explorer_nx', ShipType_Localised: 'Caspian Explorer', NewShipID: 28 },
    ]);
    expect(out).toEqual([
      expect.objectContaining({
        eventName: 'setCommanderShip',
        eventData: { shipType: 'Corsair', shipGameID: 18, starsystemName: 'Beta', stationName: 'Yard', marketID: 5 },
      }),
      expect.objectContaining({ eventName: 'addCommanderShip', eventData: { shipType: 'explorer_nx', shipGameID: 28 } }),
    ]);
  });

  it('ShipyardSell removes the ship (synthetic: the corpus has none)', () => {
    const t = new InaraTranslator();
    const e = one(
      feed(t, [{ event: 'ShipyardSell', ShipType: 'Adder', SellShipID: 6, ShipPrice: 79027, System: 'Eranin' }]),
      'delCommanderShip',
    );
    expect(e.eventData).toEqual({ shipType: 'Adder', shipGameID: 6 });
  });

  it('ShipyardTransfer is set to where the commander is, not where the ship came from', () => {
    const t = new InaraTranslator();
    feed(t, [{ event: 'Docked', StationName: 'Home', StarSystem: 'Here', MarketID: 9 }]);
    const e = one(
      feed(t, [{ event: 'ShipyardTransfer', ShipType: 'Dolphin', ShipID: 10, System: 'Matipu', ShipMarketID: 1, Distance: 185.3, TransferPrice: 72085, TransferTime: 2153, MarketID: 9 }]),
      'setCommanderShipTransfer',
    );
    expect(e.eventData).toEqual({
      shipType: 'Dolphin',
      shipGameID: 10,
      starsystemName: 'Here',
      stationName: 'Home',
      marketID: 9,
      transferTime: 2153,
    });
  });

  it('a transfer is not sent without a station, which Inara requires', () => {
    const t = new InaraTranslator();
    feed(t, [{ event: 'FSDJump', StarSystem: 'Open Space', StarPos: [0, 0, 0], JumpDist: 1 }]);
    expect(
      feed(t, [{ event: 'ShipyardTransfer', ShipType: 'Dolphin', ShipID: 10, TransferTime: 5 }]),
    ).toEqual([]);
  });

  it('SetUserShipName sets name and ident', () => {
    const t = new InaraTranslator();
    const e = one(
      feed(t, [{ event: 'SetUserShipName', Ship: 'panthermkii', ShipID: 21, UserShipName: 'Atlas Freight', UserShipId: 'SY-22P' }]),
      'setCommanderShip',
    );
    expect(e.eventData).toEqual({ shipType: 'panthermkii', shipGameID: 21, shipName: 'Atlas Freight', shipIdent: 'SY-22P' });
  });
});

/* ----------------------------------------------------------------- suits */

describe('suits', () => {
  it('SuitLoadout becomes a complete suit loadout', () => {
    const t = new InaraTranslator();
    const e = one(
      feed(t, [
        {
          event: 'SuitLoadout',
          SuitID: 1875787831902376,
          SuitName: 'tacticalsuit_class5',
          SuitName_Localised: '$TacticalSuit_Class1_Name;',
          SuitMods: ['suit_improvedarmourrating'],
          LoadoutID: 4293000004,
          LoadoutName: 'Test Kit',
          Modules: [
            { SlotName: 'PrimaryWeapon1', SuitModuleID: 1869922851367525, ModuleName: 'wpn_m_assaultrifle_laser_fauto', ModuleName_Localised: 'TK Aphelion', Class: 5, WeaponMods: ['weapon_range'] },
          ],
        },
      ]),
      'setCommanderSuitLoadout',
    );
    expect(e.eventData).toEqual({
      loadoutGameID: 4293000004,
      loadoutName: 'Test Kit',
      suitGameID: 1875787831902376,
      suitType: 'tacticalsuit_class5',
      suitMods: ['suit_improvedarmourrating'],
      suitLoadout: [
        {
          slotName: 'PrimaryWeapon1',
          itemName: 'wpn_m_assaultrifle_laser_fauto',
          itemClass: 5,
          itemGameID: 1869922851367525,
          engineering: [{ blueprintName: 'weapon_range' }],
        },
      ],
    });
  });

  it('a loadout without its module list is not complete and is not sent', () => {
    const t = new InaraTranslator();
    expect(feed(t, [{ event: 'SuitLoadout', SuitID: 1, SuitName: 'x', SuitMods: [], LoadoutID: 2 }])).toEqual([]);
  });

  it('DeleteSuitLoadout and RenameSuitLoadout (synthetic: none in the corpus)', () => {
    const t = new InaraTranslator();
    expect(one(feed(t, [{ event: 'DeleteSuitLoadout', LoadoutID: 4293000001 }]), 'delCommanderSuitLoadout').eventData)
      .toEqual({ loadoutGameID: 4293000001 });
    expect(
      one(feed(t, [{ event: 'RenameSuitLoadout', LoadoutID: 4293000001, LoadoutName: 'New' }]), 'updateCommanderSuitLoadout').eventData,
    ).toEqual({ loadoutGameID: 4293000001, loadoutName: 'New' });
  });
});

/* ------------------------------------------------------------- inventory */

describe('inventory, with replacement semantics', () => {
  it('Materials replaces the whole materials list', () => {
    const t = new InaraTranslator();
    const e = one(
      feed(t, [
        {
          event: 'Materials',
          Raw: [{ Name: 'phosphorus', Count: 131 }],
          Manufactured: [{ Name: 'chemicalprocessors', Name_Localised: 'Chemical Processors', Count: 3 }],
          Encoded: [],
        },
      ]),
      'setCommanderInventoryMaterials',
    );
    expect(e.eventData).toEqual([
      { itemName: 'phosphorus', itemCount: 131 },
      { itemName: 'chemicalprocessors', itemCount: 3 },
    ]);
    expect(e.coalesceKey).toBe('materials');
  });

  it('an empty materials list resets rather than sending an empty set', () => {
    const t = new InaraTranslator();
    const e = one(feed(t, [{ event: 'Materials', Raw: [], Manufactured: [], Encoded: [] }]), 'resetCommanderInventory');
    expect(e.eventData).toEqual([{ itemType: 'Material' }]);
  });

  it('Cargo replaces the ship’s hold only from a full list, never the SRV’s', () => {
    const t = new InaraTranslator();
    expect(feed(t, [{ event: 'Cargo', Vessel: 'Ship', Count: 5 }])).toEqual([]);
    expect(feed(t, [{ event: 'Cargo', Vessel: 'SRV', Count: 1, Inventory: [{ Name: 'gold', Count: 1, Stolen: 0 }] }])).toEqual([]);
    const e = one(
      feed(t, [
        {
          event: 'Cargo',
          Vessel: 'Ship',
          Count: 6,
          Inventory: [
            { Name: 'drones', Name_Localised: 'Limpet', Count: 4, Stolen: 0 },
            { Name: 'gold', Count: 2, Stolen: 1, MissionID: 786412662 },
          ],
        },
      ]),
      'setCommanderInventoryCargo',
    );
    expect(e.eventData).toEqual([
      { itemName: 'drones', itemCount: 4, isStolen: false },
      { itemName: 'gold', itemCount: 2, isStolen: true, missionGameID: 786412662 },
    ]);
    const empty = one(feed(t, [{ event: 'Cargo', Vessel: 'Ship', Count: 0, Inventory: [] }]), 'resetCommanderInventory');
    expect(empty.eventData).toEqual([{ itemType: 'Commodity' }]);
  });

  it('ShipLocker resets empty types first, then sets the rest, in one batch', () => {
    const t = new InaraTranslator();
    const out = feed(t, [
      {
        event: 'ShipLocker',
        Items: [{ Name: 'chemicalsample', Name_Localised: 'Chemical Sample', OwnerID: 0, Count: 1 }],
        Components: [],
        Consumables: [{ Name: 'healthpack', OwnerID: 0, Count: 2 }],
        Data: [],
      },
    ]);
    expect(out.map((e) => e.eventName)).toEqual(['resetCommanderInventory', 'setCommanderInventory']);
    expect(out[0]!.eventData).toEqual([
      { itemType: 'Component', itemLocation: 'ShipLocker' },
      { itemType: 'Data', itemLocation: 'ShipLocker' },
    ]);
    expect(out[1]!.eventData).toEqual([
      { itemName: 'chemicalsample', itemCount: 1, itemType: 'Item', itemLocation: 'ShipLocker' },
      { itemName: 'healthpack', itemCount: 2, itemType: 'Consumable', itemLocation: 'ShipLocker' },
    ]);
  });

  it('the short ShipLocker event, with no lists, sends nothing', () => {
    const t = new InaraTranslator();
    expect(feed(t, [{ event: 'ShipLocker' }])).toEqual([]);
  });
});

/* ------------------------------------------------------- commander scoping */

describe('commander switching', () => {
  it('a new commander starts with no ship, location or ranks from the last one', () => {
    const t = new InaraTranslator();
    feed(t, [LOADGAME, { event: 'Docked', StationName: 'Port', StarSystem: 'Beta', MarketID: 1 }]);
    expect(t.commander).toBe(FID);

    const other = prov(undefined, { fid: 'F2000002' });
    t.observe({ event: 'Rank', Combat: 1 }, other, NOW);
    expect(t.commander).toBe('F2000002');
    // A transfer cannot be placed at the first commander's station.
    expect(
      t.observe({ event: 'ShipyardTransfer', ShipType: 'Adder', ShipID: 3, TransferTime: 1 }, other, NOW).events,
    ).toEqual([]);
    const jump = one(
      [...t.observe({ event: 'FSDJump', StarSystem: 'Zeta', StarPos: [0, 0, 0], JumpDist: 1 }, other, NOW).events],
      'addCommanderTravelFSDJump',
    );
    // The first commander's corsair must not appear in the second's flight log.
    expect(jump.eventData).not.toHaveProperty('shipType');
  });
});

/* -------------------------------------------------------------- privacy */

describe('privacy', () => {
  it('no event ever carries a surface position, an API key or exobiology scans', () => {
    const t = new InaraTranslator();
    const out = feed(t, [
      LOADGAME,
      { event: 'Location', StarSystem: 'A', StarPos: [0, 0, 0], Body: 'A 1', BodyType: 'Planet', Latitude: 1, Longitude: 2 },
      { event: 'Touchdown', PlayerControlled: true, OnPlanet: true, StarSystem: 'A', Body: 'A 1', Latitude: 1, Longitude: 2 },
      { event: 'ScanOrganic', ScanType: 'Analyse', Genus: '$Codex_Ent_Bacterial_Genus_Name;', SystemAddress: 1, Body: 2 },
      { event: 'SellOrganicData', MarketID: 1, BioData: [] },
    ]);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/Latitude|Longitude|BodyCoords/);
    expect(text).not.toMatch(/APIkey/i);
    expect(out.some((e) => /organic|bio/i.test(e.eventName))).toBe(false);
  });

  it('every event uses the journal’s own timestamp, never the current time', () => {
    const t = new InaraTranslator();
    const out = feed(t, [LOADGAME], prov('2026-10-01T10:00:00Z'));
    expect(out.every((e) => e.eventTimestamp === '2026-10-01T10:00:00Z')).toBe(true);
  });

  it('every event name produced is one Inara documents', () => {
    const documented = new Set([
      'setCommanderTravelLocation', 'addCommanderTravelFSDJump', 'addCommanderTravelDock',
      'addCommanderTravelLand', 'addCommanderTravelCarrierJump', 'setCommanderRankPilot',
      'setCommanderRankEngineer', 'setCommanderRankPower', 'setCommanderReputationMajorFaction',
      'setCommanderReputationMinorFaction', 'setCommanderCredits', 'setCommanderGameStatistics',
      'setCommanderShip', 'setCommanderShipLoadout', 'setCommanderShipTransfer', 'addCommanderShip',
      'delCommanderShip', 'setCommanderSuitLoadout', 'delCommanderSuitLoadout',
      'updateCommanderSuitLoadout', 'setCommanderInventoryMaterials', 'setCommanderInventoryCargo',
      'setCommanderInventory', 'resetCommanderInventory',
    ]);
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'inara-translate.ts'),
      'utf8',
    ) as string;
    const used = new Set([...src.matchAll(/'((?:set|add|del|reset|update)Commander[A-Za-z]+)'/g)].map((m) => m[1]!));
    for (const name of used) expect(documented, name).toContain(name);
  });
});
