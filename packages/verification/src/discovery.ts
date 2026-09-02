/**
 * What has THIS commander's game actually revealed to them?
 *
 * This is the single source of truth for spoiler gating, and it is built
 * exclusively from local journal events. EDFM's database, EDDN, and any other
 * external source are deliberately not inputs: the question is not "is this
 * known?" but "has this commander been told?".
 *
 * The reveal ladder for exploration was measured against the journal corpus and
 * is more granular than it first appears:
 *
 *   FSSDiscoveryScan  -> how many bodies exist. Nothing per-body.
 *   FSSBodySignals    -> signal COUNTS for a body. No genus.
 *   SAASignalsFound   -> signal counts AND `Genuses`. Still no species.
 *   ScanOrganic       -> Genus, Species and Variant of one sample.
 *
 * So "the commander mapped the planet" and "the commander knows what lives
 * there" are different states, and a commander can legitimately know a genus
 * without knowing the species. Gating has to respect that, not collapse it.
 *
 * State is scoped per commander FID. Two commanders sharing a PC must not
 * inherit each other's discoveries.
 */

import type { NormalizedEvent } from '@edfm/elite-journal';

/** `${systemAddress}:${bodyId}` — stable across sessions and name changes. */
export type BodyKey = string;

export function bodyKey(systemAddress: number, bodyId: number): BodyKey {
  return `${systemAddress}:${bodyId}`;
}

export interface BodyDiscovery {
  /** A `Scan` event reported this body's physical properties. */
  scanned: boolean;
  /** Detailed surface scan completed (`SAAScanComplete`). */
  mapped: boolean;
  /**
   * Signal counts by localised type, e.g. { Biological: 5 }.
   * Empty map means "we know there are none reported"; absence of the body
   * entirely means "we have not been told".
   */
  signalCounts: Record<string, number>;
  /** Genus names revealed by a DSS (`SAASignalsFound.Genuses`) or by scanning. */
  genuses: Set<string>;
  /** Species revealed by `ScanOrganic`/`SellOrganicData`. */
  species: Set<string>;
  variants: Set<string>;
}

function emptyBody(): BodyDiscovery {
  return {
    scanned: false,
    mapped: false,
    signalCounts: {},
    genuses: new Set(),
    species: new Set(),
    variants: new Set(),
  };
}

/**
 * Everything one commander's game has revealed.
 *
 * Deliberately additive: discoveries are never removed, because the game does
 * not un-tell a commander something. That also makes the structure safe to
 * persist and reload without ordering concerns.
 */
export class DiscoveryState {
  /** FID this state belongs to. Null only before a Commander event is seen. */
  readonly commanderFid: string | null;

  private readonly systems = new Set<number>();
  private readonly bodies = new Map<BodyKey, BodyDiscovery>();

  constructor(commanderFid: string | null = null) {
    this.commanderFid = commanderFid;
  }

  /* ------------------------------------------------------------ queries */

  hasVisitedSystem(systemAddress: number): boolean {
    return this.systems.has(systemAddress);
  }

  body(systemAddress: number, bodyId: number): BodyDiscovery | undefined {
    return this.bodies.get(bodyKey(systemAddress, bodyId));
  }

  /** Has the commander been told this body's signal counts? */
  knowsSignalCounts(systemAddress: number, bodyId: number): boolean {
    const b = this.body(systemAddress, bodyId);
    return b !== undefined && Object.keys(b.signalCounts).length > 0;
  }

  knowsGenus(systemAddress: number, bodyId: number, genus: string): boolean {
    return this.body(systemAddress, bodyId)?.genuses.has(genus) ?? false;
  }

  knowsSpecies(systemAddress: number, bodyId: number, species: string): boolean {
    return this.body(systemAddress, bodyId)?.species.has(species) ?? false;
  }

  /** Any species at all identified on this body. */
  knowsAnySpecies(systemAddress: number, bodyId: number): boolean {
    return (this.body(systemAddress, bodyId)?.species.size ?? 0) > 0;
  }

  hasScanned(systemAddress: number, bodyId: number): boolean {
    return this.body(systemAddress, bodyId)?.scanned ?? false;
  }

  /* ------------------------------------------------------------ ingest */

  /**
   * Fold a journal event in. Returns true when something new was learned.
   *
   * Only events that genuinely reveal information to the player are handled.
   * Adding an event here widens what the Companion is willing to show, so each
   * one is a deliberate decision rather than a convenience.
   */
  observe(event: NormalizedEvent): boolean {
    const raw = event.source.raw;
    const name = event.source.event;

    switch (name) {
      case 'FSDJump':
      case 'Location':
      case 'CarrierJump': {
        const address = num(raw['SystemAddress']);
        if (address === null) return false;
        if (this.systems.has(address)) return false;
        this.systems.add(address);
        return true;
      }

      case 'Scan': {
        const address = num(raw['SystemAddress']);
        const id = num(raw['BodyID']);
        if (address === null || id === null) return false;
        const b = this.ensure(address, id);
        if (b.scanned) return false;
        b.scanned = true;
        return true;
      }

      case 'SAAScanComplete': {
        const address = num(raw['SystemAddress']);
        const id = num(raw['BodyID']);
        if (address === null || id === null) return false;
        const b = this.ensure(address, id);
        if (b.mapped) return false;
        b.mapped = true;
        return true;
      }

      // Reveals counts only. A commander who has honked and run the FSS knows
      // "5 biological signals" and nothing whatever about what they are.
      case 'FSSBodySignals':
        return this.absorbSignals(raw, false);

      // A detailed surface scan additionally reveals the genus list.
      case 'SAASignalsFound':
        return this.absorbSignals(raw, true);

      case 'ScanOrganic': {
        const address = num(raw['SystemAddress']);
        // ScanOrganic names the body by integer id in `Body`, not `BodyID`.
        const id = num(raw['Body']);
        if (address === null || id === null) return false;
        const b = this.ensure(address, id);
        let changed = false;
        changed = addTo(b.genuses, str(raw['Genus_Localised']) ?? str(raw['Genus'])) || changed;
        changed = addTo(b.species, str(raw['Species_Localised']) ?? str(raw['Species'])) || changed;
        changed = addTo(b.variants, str(raw['Variant_Localised']) ?? str(raw['Variant'])) || changed;
        return changed;
      }

      default:
        return false;
    }
  }

  private absorbSignals(raw: Readonly<Record<string, unknown>>, withGenus: boolean): boolean {
    const address = num(raw['SystemAddress']);
    const id = num(raw['BodyID']);
    if (address === null || id === null) return false;

    const b = this.ensure(address, id);
    let changed = false;

    const signals = raw['Signals'];
    if (Array.isArray(signals)) {
      for (const entry of signals) {
        if (entry === null || typeof entry !== 'object') continue;
        const s = entry as Record<string, unknown>;
        const type = str(s['Type_Localised']) ?? str(s['Type']);
        const count = num(s['Count']);
        if (type === null || count === null) continue;
        if (b.signalCounts[type] !== count) {
          b.signalCounts[type] = count;
          changed = true;
        }
      }
    }

    if (withGenus) {
      const genuses = raw['Genuses'];
      if (Array.isArray(genuses)) {
        for (const entry of genuses) {
          if (entry === null || typeof entry !== 'object') continue;
          const g = entry as Record<string, unknown>;
          changed = addTo(b.genuses, str(g['Genus_Localised']) ?? str(g['Genus'])) || changed;
        }
      }
    }

    return changed;
  }

  private ensure(systemAddress: number, bodyId: number): BodyDiscovery {
    const key = bodyKey(systemAddress, bodyId);
    let b = this.bodies.get(key);
    if (!b) {
      b = emptyBody();
      this.bodies.set(key, b);
    }
    return b;
  }

  /* --------------------------------------------------------- persistence */

  toJSON(): SerializedDiscovery {
    return {
      commanderFid: this.commanderFid,
      systems: [...this.systems],
      bodies: Object.fromEntries(
        [...this.bodies].map(([key, b]) => [
          key,
          {
            scanned: b.scanned,
            mapped: b.mapped,
            signalCounts: b.signalCounts,
            genuses: [...b.genuses],
            species: [...b.species],
            variants: [...b.variants],
          },
        ]),
      ),
    };
  }

  /**
   * Restore persisted discovery for one commander.
   *
   * The FID is checked rather than trusted: loading another commander's state
   * would reveal their discoveries, which is the exact failure this class
   * exists to prevent.
   */
  static fromJSON(data: SerializedDiscovery, expectedFid: string | null): DiscoveryState {
    if (expectedFid !== null && data.commanderFid !== expectedFid) {
      return new DiscoveryState(expectedFid);
    }

    const state = new DiscoveryState(data.commanderFid ?? expectedFid);
    for (const address of data.systems ?? []) state.systems.add(address);
    for (const [key, b] of Object.entries(data.bodies ?? {})) {
      state.bodies.set(key, {
        scanned: Boolean(b.scanned),
        mapped: Boolean(b.mapped),
        signalCounts: b.signalCounts ?? {},
        genuses: new Set(b.genuses ?? []),
        species: new Set(b.species ?? []),
        variants: new Set(b.variants ?? []),
      });
    }
    return state;
  }
}

export interface SerializedBody {
  scanned: boolean;
  mapped: boolean;
  signalCounts: Record<string, number>;
  genuses: string[];
  species: string[];
  variants: string[];
}

export interface SerializedDiscovery {
  commanderFid: string | null;
  systems: number[];
  bodies: Record<string, SerializedBody>;
}

/* ------------------------------------------------------------- helpers */

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function addTo(set: Set<string>, value: string | null): boolean {
  if (value === null || set.has(value)) return false;
  set.add(value);
  return true;
}
