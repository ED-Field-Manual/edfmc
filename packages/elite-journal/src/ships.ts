/**
 * Human-readable ship and vehicle names.
 *
 * The journal identifies a ship by its internal symbol (`PantherMkII`,
 * `Krait_MkII`, `explorer_nx`) and only sometimes adds a localised name:
 * `Ship_Localised` appears on 281 of 400 `LoadGame` events in the corpus, and is
 * absent exactly when the symbol is already a plain word (`Corsair`,
 * `Anaconda`, `SideWinder`). So a name is taken, in order, from:
 *
 * 1. the journal's own localised name, when it is a real name rather than a
 *    `$TOKEN;` placeholder (suits report `$TacticalSuit_Class1_Name;`);
 * 2. the table below;
 * 3. the symbol tidied into words, marked as not recognised so a screen can
 *    say so rather than present it as a canonical name.
 *
 * Table entries marked `corpus` were seen paired with that localised name in
 * this project's journal corpus. The rest are Frontier's names for the
 * remaining ships, as published in EDCD's shared ship data; a symbol missing
 * from both falls through to rule 3.
 */

/** Lower-cased journal symbol to the ship's in-game name. */
const SHIP_NAMES: Readonly<Record<string, string>> = {
  adder: 'Adder',
  anaconda: 'Anaconda',
  asp: 'Asp Explorer',
  asp_scout: 'Asp Scout',
  belugaliner: 'Beluga Liner',
  cobramkiii: 'Cobra Mk III',
  cobramkiv: 'Cobra Mk IV',
  cobramkv: 'Cobra Mk V',
  corsair: 'Corsair',
  cutter: 'Imperial Cutter',
  diamondback: 'Diamondback Scout',
  diamondbackxl: 'Diamondback Explorer',
  dolphin: 'Dolphin',
  eagle: 'Eagle',
  empire_courier: 'Imperial Courier',
  empire_eagle: 'Imperial Eagle',
  empire_trader: 'Imperial Clipper',
  explorer_nx: 'Caspian Explorer', // corpus
  federation_corvette: 'Federal Corvette',
  federation_dropship: 'Federal Dropship',
  federation_dropship_mkii: 'Federal Assault Ship',
  federation_gunship: 'Federal Gunship',
  ferdelance: 'Fer-de-Lance',
  hauler: 'Hauler',
  independant_trader: 'Keelback',
  krait_light: 'Krait Phantom',
  krait_mkii: 'Krait Mk II', // corpus
  lakonminer: 'Type-11 Prospector', // corpus
  mamba: 'Mamba',
  mandalay: 'Mandalay',
  mediumtransport01: 'Lynx Highliner', // corpus
  orca: 'Orca',
  panthermkii: 'Panther Clipper Mk II', // corpus
  python: 'Python',
  python_nx: 'Python Mk II',
  sidewinder: 'Sidewinder',
  smallcombat01_nx: 'Kestrel Mk II', // corpus
  type6: 'Type-6 Transporter',
  type7: 'Type-7 Transporter', // corpus
  type8: 'Type-8 Transporter',
  type9: 'Type-9 Heavy', // corpus
  type9_military: 'Type-10 Defender',
  typex: 'Alliance Chieftain',
  typex_2: 'Alliance Crusader',
  typex_3: 'Alliance Challenger',
  viper: 'Viper Mk III', // corpus
  viper_mkiv: 'Viper Mk IV',
  vulture: 'Vulture',
};

/** What a `LoadGame.Ship` symbol actually is. Login can happen out of a ship. */
export type VehicleKind = 'ship' | 'srv' | 'suit' | 'taxi' | 'fighter';

/**
 * Classify a symbol.
 *
 * From the corpus: `TestBuggy` and `Combat_Multicrew_SRV_01` are SRVs,
 * `TacticalSuit_Class2`, `ExplorationSuit_Class3` and `FlightSuit` are suits
 * (on foot), `vulture_taxi` is an Apex taxi.
 */
export function vehicleKind(symbol: string): VehicleKind {
  const s = symbol.toLowerCase();
  if (s.includes('suit')) return 'suit';
  if (s === 'testbuggy' || s.includes('_srv')) return 'srv';
  if (s.endsWith('_taxi')) return 'taxi';
  if (s.includes('fighter')) return 'fighter';
  return 'ship';
}

export interface ShipName {
  readonly name: string;
  /** False when the name is the symbol tidied up, not a known ship. */
  readonly recognised: boolean;
}

const isPlaceholder = (v: string) => /^\$.*;$/.test(v.trim());

/** The ship's in-game name, never a raw internal symbol presented as one. */
export function shipDisplayName(symbol: string, localised?: string | null): ShipName {
  if (localised && localised.trim() && !isPlaceholder(localised)) {
    return { name: localised.trim(), recognised: true };
  }
  const known = SHIP_NAMES[symbol.toLowerCase()];
  if (known) return { name: known, recognised: true };
  const tidied = symbol
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return { name: tidied.charAt(0).toUpperCase() + tidied.slice(1), recognised: false };
}
