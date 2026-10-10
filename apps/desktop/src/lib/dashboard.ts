/**
 * What the Dashboard says, worked out from state and nothing else.
 *
 * Pure: each function takes what the app already tracks and returns plain
 * lines to show, so every case (docked, landed, on foot, a new commander, a
 * missing field, the game closed) is tested without rendering anything.
 *
 * The rule the rest of the app follows holds here too: a value the game did
 * not report is left out, not filled in. Nothing returned is a placeholder.
 */

import { isKnown, shipDisplayName, type CommanderState } from '@edfm/elite-journal';
import type { LiveExobiology } from '@edfm/activity';
import type { ConstructionSite } from '@edfm/logistics';
import type { Mission } from '@edfm/missions';

const known = <T>(v: unknown): T | null => (isKnown(v as never) ? (v as T) : null);

/* ----------------------------------------------------------------- location */

export interface LocationView {
  readonly system: string | null;
  /** "Docked at Wheal Friendly", "Landed on Wregoe BB-F d11-77 7 a", … */
  readonly where: string | null;
  /** A short status word with its own glyph: Docked, Landed, Supercruise, … */
  readonly status: { readonly glyph: string; readonly label: string } | null;
  /** "On foot" or "In an SRV", when that is how the commander is getting around. */
  readonly vehicle: string | null;
}

export function describeLocation(s: CommanderState): LocationView {
  const system = known<string>(s.starSystem);
  const station = known<string>(s.stationName);
  const body = known<string>(s.body);
  // The body is the system's main star while in supercruise: saying "near
  // Sol" in Sol says nothing.
  const usefulBody = body !== null && body !== system && !(isKnown(s.bodyType) && s.bodyType === 'Station') ? body : null;
  const carrier = isKnown(s.stationType) && s.stationType === 'FleetCarrier';
  const stationName =
    station === null
      ? null
      : carrier
        ? isKnown(s.carrierName)
          ? `${s.carrierName} (${station})`
          : `fleet carrier ${station}`
        : station;

  let where: string | null = null;
  let status: LocationView['status'] = null;
  switch (s.travel) {
    case 'docked':
      where = stationName ? `Docked at ${stationName}` : null;
      status = { glyph: '⚓', label: 'Docked' };
      break;
    case 'landed':
      where = usefulBody ? `Landed on ${usefulBody}` : null;
      status = { glyph: '▼', label: 'Landed' };
      break;
    case 'supercruise':
      where = usefulBody ? `Near ${usefulBody}` : null;
      status = { glyph: '»', label: 'Supercruise' };
      break;
    case 'normal-space':
      where = usefulBody ? `Near ${usefulBody}` : null;
      status = { glyph: '•', label: 'In normal space' };
      break;
    case 'witch-space':
      where = isKnown(s.jumpTarget) ? `Jumping to ${s.jumpTarget}` : null;
      status = { glyph: '⟿', label: 'Hyperspace jump' };
      break;
    default:
      where = stationName ? `At ${stationName}` : usefulBody ? `Near ${usefulBody}` : null;
  }

  const vehicle =
    s.vehicle === 'on-foot' ? 'On foot' : s.vehicle === 'srv' ? 'In an SRV' : s.vehicle === 'taxi' ? 'In a taxi' : null;

  return { system, where, status, vehicle };
}

/* --------------------------------------------------------------------- ship */

export interface ShipView {
  /** The commander's own name for it, when they gave one. */
  readonly name: string | null;
  /** "Panther Clipper Mk II": the game's or Frontier's name, never a symbol. */
  readonly model: string | null;
  /** False when the model is the symbol tidied into words, not a known ship. */
  readonly modelRecognised: boolean;
  readonly ident: string | null;
  /** "38 / 64 t", "38 t", or null when the game has not said. */
  readonly cargo: string | null;
  /** Set while the commander is not in it (on foot, in an SRV, in a taxi). */
  readonly away: boolean;
}

export function describeShip(s: CommanderState): ShipView | null {
  if (!isKnown(s.ship)) return null;
  const model = shipDisplayName(s.ship, known<string>(s.shipLocalised));
  const name = known<string>(s.shipName);
  const count = known<number>(s.cargoCount);
  const capacity = known<number>(s.cargoCapacity);
  const cargo =
    count !== null && capacity !== null
      ? `${count} / ${capacity} t`
      : count !== null
        ? `${count} t`
        : null;
  return {
    name: name && name.trim() ? name.trim() : null,
    model: model.name,
    modelRecognised: model.recognised,
    ident: known<string>(s.shipIdent),
    cargo,
    away: s.vehicle === 'on-foot' || s.vehicle === 'srv' || s.vehicle === 'taxi',
  };
}

/* ----------------------------------------------------------------- activity */

export interface ActivityItem {
  readonly key: 'navigation' | 'missions' | 'exobiology' | 'construction';
  readonly title: string;
  readonly lines: readonly string[];
  /** 0..1 when there is a real figure behind it. */
  readonly progress?: number;
}

/** The in-game route: FSDTarget names the next jump, not the final destination. */
export function navigationActivity(s: CommanderState, live: boolean): ActivityItem | null {
  if (!live || !isKnown(s.jumpTarget)) return null;
  const lines = [`Next jump: ${s.jumpTarget}`];
  if (isKnown(s.remainingJumps)) {
    lines.push(`${s.remainingJumps} ${s.remainingJumps === 1 ? 'jump' : 'jumps'} left in your plotted route`);
  }
  return { key: 'navigation', title: 'Navigation', lines };
}

export function missionsActivity(
  active: readonly Mission[],
  relative: (iso: string) => string,
): ActivityItem | null {
  if (active.length === 0) return null;
  const withExpiry = active
    .filter((m) => isKnown(m.expiry))
    .sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)));
  const lines: string[] = [];
  for (const m of withExpiry.slice(0, 2)) {
    const name = isKnown(m.localisedName) ? m.localisedName : 'Mission';
    const to = isKnown(m.destinationSystem)
      ? ` → ${m.destinationSystem}${isKnown(m.destinationStation) ? `, ${m.destinationStation}` : ''}`
      : '';
    lines.push(`${name}${to} · ${relative(String(m.expiry))} left`);
  }
  return {
    key: 'missions',
    title: `${active.length} active ${active.length === 1 ? 'mission' : 'missions'}`,
    lines,
  };
}

export function exobiologyActivity(exo: LiveExobiology | null): ActivityItem | null {
  if (exo === null || exo.total === 0) return null;
  const lines: string[] = [];
  if (exo.bodyName) lines.push(exo.bodyName);
  lines.push(
    `${exo.total} biological ${exo.total === 1 ? 'signal' : 'signals'} · ${exo.completedCount} of ${exo.total} complete`,
  );
  const active =
    exo.rows.find((r) => r.genusToken === exo.activeGenusToken && !r.completed) ??
    exo.rows.find((r) => !r.completed && r.samplesTaken !== 0) ??
    null;
  if (active) {
    const who = active.species ?? active.genus;
    // A count first seen midway is null: shown as sampling, not as a number.
    const stage =
      active.samplesTaken === null ? 'sampling' : `${active.samplesTaken} / ${active.samplesRequired} samples`;
    lines.push(`Sampling ${who} · ${stage}`);
  }
  return {
    key: 'exobiology',
    title: 'Exobiology',
    lines,
    progress: exo.total > 0 ? exo.completedCount / exo.total : undefined,
  };
}

export function constructionActivity(sites: readonly ConstructionSite[]): ActivityItem | null {
  const open = sites.filter((s) => !s.complete && !s.failed);
  if (open.length === 0) return null;
  const site = [...open].sort((a, b) => a.priority - b.priority)[0]!;
  const remaining = site.resources.reduce((t, r) => t + Math.max(0, r.remaining), 0);
  const outstanding = site.resources.filter((r) => r.remaining > 0).length;
  const lines = [
    site.name ?? 'Construction site',
    `${remaining.toLocaleString()} t still needed across ${outstanding} ${outstanding === 1 ? 'commodity' : 'commodities'}`,
  ];
  if (open.length > 1) lines.push(`${open.length - 1} more ${open.length - 1 === 1 ? 'site' : 'sites'} on the Logistics page`);
  return {
    key: 'construction',
    title: 'Construction',
    lines,
    progress: site.progress !== null ? Math.max(0, Math.min(1, site.progress)) : undefined,
  };
}
