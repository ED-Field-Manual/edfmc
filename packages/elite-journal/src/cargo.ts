/**
 * The ship's cargo manifest: what is in the hold, not just how much.
 *
 * Two sources, and the order matters.
 *
 * - The journal's `Cargo` event carries the full `Inventory` only sometimes:
 *   339 of 5307 ship `Cargo` events in the corpus, essentially at login.
 *   Every other `Cargo` event gives `Count` alone and the game writes the full
 *   list to `Cargo.json` next to the journal instead.
 * - `Cargo.json` holds a single `Cargo` object (`timestamp`, `Vessel`, `Count`,
 *   `Inventory`) and is overwritten on every change. Checked on a live file:
 *   its `timestamp` equals the journal `Cargo` event it accompanies.
 *
 * So the file is only trusted for the journal event it belongs to: same
 * timestamp, same vessel, same count. Anything else is either older (not
 * written yet) or newer (a later journal event will claim it), and is not
 * applied. That is what stops stale or out-of-order data replacing newer.
 *
 * The game writes a `Cargo` event after buying, selling, collecting,
 * mining, ejecting and transferring cargo, so following `Cargo` covers every
 * kind of change without interpreting each event that causes one.
 */

import { isKnown, UNKNOWN, type Known } from './types.js';

export interface CargoItem {
  /** Journal symbol, lower case (`drones`, `gold`). */
  readonly name: string;
  /** Human-readable: the journal's `Name_Localised` when given, else the symbol tidied. */
  readonly label: string;
  readonly count: number;
  readonly stolen: boolean;
  /** Set when the cargo belongs to a mission. */
  readonly missionId: number | null;
}

const isPlaceholder = (v: string) => /^\$.*;$/.test(v.trim());

/** `Name_Localised` is absent when the name is already a word (`gold`, `silver`). */
function label(name: string, localised: unknown): string {
  if (typeof localised === 'string' && localised.trim() && !isPlaceholder(localised)) return localised.trim();
  const s = name.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Read an `Inventory` array; UNKNOWN when it is not one (absent from the event). */
export function parseInventory(raw: unknown): Known<readonly CargoItem[]> {
  if (!Array.isArray(raw)) return UNKNOWN;
  const out: CargoItem[] = [];
  for (const x of raw) {
    if (x === null || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const name = typeof o['Name'] === 'string' ? o['Name'].toLowerCase() : null;
    const count = typeof o['Count'] === 'number' && Number.isFinite(o['Count']) ? o['Count'] : null;
    if (name === null || count === null || count <= 0) continue;
    out.push({
      name,
      label: label(name, o['Name_Localised']),
      count,
      stolen: typeof o['Stolen'] === 'number' ? o['Stolen'] > 0 : false,
      missionId: typeof o['MissionID'] === 'number' ? o['MissionID'] : null,
    });
  }
  return out;
}

/** One line per commodity: mission and stolen lots of the same goods added together. */
export interface CargoLine {
  readonly name: string;
  readonly label: string;
  readonly count: number;
}

export function cargoLines(items: readonly CargoItem[]): CargoLine[] {
  const by = new Map<string, CargoLine>();
  for (const i of items) {
    const prev = by.get(i.name);
    by.set(i.name, { name: i.name, label: prev?.label ?? i.label, count: (prev?.count ?? 0) + i.count });
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** What `applyCargoFile` decided, for logging and for retrying an unwritten file. */
export type CargoFileResult = 'applied' | 'older' | 'newer' | 'other-vessel' | 'mismatch' | 'unreadable';

/** The fields of state this touches; a subset of `CommanderState`. */
export interface CargoState {
  cargoCount: Known<number>;
  cargoAt: string | null;
  cargoManifest: Known<readonly CargoItem[]>;
}

/**
 * Apply the contents of `Cargo.json`, if it belongs to the latest `Cargo` event.
 *
 * Returns `older` when the file predates that event (the game has not written
 * it yet: worth reading again shortly) and `newer` when it is ahead (a later
 * journal event will apply it).
 */
export function applyCargoFile(state: CargoState, text: string): CargoFileResult {
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(text) as unknown;
    if (v === null || typeof v !== 'object') return 'unreadable';
    o = v as Record<string, unknown>;
  } catch {
    return 'unreadable';
  }
  if (o['event'] !== 'Cargo' || typeof o['timestamp'] !== 'string') return 'unreadable';
  if (o['Vessel'] !== 'Ship') return 'other-vessel';
  if (state.cargoAt === null) return 'newer';
  const at = o['timestamp'];
  if (at < state.cargoAt) return 'older';
  if (at > state.cargoAt) return 'newer';
  const items = parseInventory(o['Inventory']);
  if (!isKnown(items)) return 'unreadable';
  // Same instant, but a different total means it is not the same change.
  if (isKnown(state.cargoCount) && typeof o['Count'] === 'number' && o['Count'] !== state.cargoCount) {
    return 'mismatch';
  }
  state.cargoManifest = items;
  return 'applied';
}
