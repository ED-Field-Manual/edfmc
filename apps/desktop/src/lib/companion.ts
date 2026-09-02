/**
 * Application service: wires the journal engine to local persistence and state.
 *
 * Deliberately framework-free so the same object can drive the React UI today and
 * the overlay window (Phase 2) without duplication.
 */

import Database from '@tauri-apps/plugin-sql';
import {
  JournalEngine,
  learnCarrier,
  listJournalFiles,
  replayFile,
  applyEvent,
  initialState,
  resolveJournalDirectory,
  setDefaultFs,
  isKnown,
  type CommanderState,
  type Known,
  type IngestStats,
  type JournalCheckpoint,
  type NormalizedEvent,
} from '@edfm/elite-journal';

import {
  BUNDLED_RULES,
  ContextResolver,
  resourceUrl,
  type ActiveContext,
} from '@edfm/context';

import {
  MISSION_COLUMNS,
  MissionStore,
  explainMission,
  fromRow,
  hasDeliveryProgress,
  remainingCargo,
  toRow,
  type DestinationGroup,
  type Mission,
  type MissionRow,
  type MissionSummary,
} from '@edfm/missions';

import { logger } from './logger.js';
import {
  DEFAULT_WIDGETS,
  overlayApi,
  type OverlayMissionRow,
  type OverlayMissions,
  type OverlayWidgets,
} from './overlay.js';
import { savedGamesDir, tauriFs, watchJournalDirectory } from './tauriFs.js';

/**
 * Events that fire constantly and carry no dashboard value.
 * `FSSSignalDiscovered` alone was 45,545 of 197,164 lines in the validation corpus;
 * re-rendering for each would burn CPU beside a running game for nothing (§30).
 */
const HIGH_FREQUENCY_NOISE = new Set([
  'Music',
  'FSSSignalDiscovered',
  'ReservoirReplenished',
  'UnderAttack',
  'ShipTargeted',
  'ReceiveText',
]);

/**
 * Install the Tauri adapter as this host's filesystem.
 *
 * Call sites also pass it explicitly; registering it here means any future code
 * path that relies on the default gets the right one rather than throwing.
 */
setDefaultFs(tauriFs);

/**
 * Human label for a travel state.
 *
 * "Unknown" is reserved for genuinely unknown. When the commander is in
 * supercruise there is no station, and reporting that as missing data would
 * misdescribe a situation the journal states plainly.
 */
export function travelLabel(travel: CommanderState['travel']): string {
  switch (travel) {
    case 'docked':
      return 'Docked';
    case 'landed':
      return 'Landed';
    case 'normal-space':
      return 'In flight';
    case 'supercruise':
      return 'Supercruise';
    case 'witch-space':
      return 'Witch space';
    default:
      return 'Unknown';
  }
}

/**
 * How many mission rows reach the overlay.
 *
 * Small on purpose. The overlay competes with the game for attention, and a long
 * list there is worse than none — the main window holds the complete set.
 */
const OVERLAY_MISSION_ROWS = 5;

/** Relative expiry for display. "Expired" rather than a negative duration. */
export function relativeExpiry(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return 'Unknown';
  if (ms <= 0) return 'Expired';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Cargo line for a mission row.
 *
 * Leads with what is still owed when the journal has told us, because that is the
 * number the next run is planned around — after handing in 1,236 of 1,386, "150
 * left" is useful and "1386 t" is actively misleading.
 */
function cargoLabel(m: Mission): string | null {
  const commodity = isKnown(m.commodityLocalised) ? ` ${m.commodityLocalised}` : '';
  if (hasDeliveryProgress(m)) {
    return `${remainingCargo(m)} t left of ${m.totalToDeliver as number}${commodity}`;
  }
  return isKnown(m.count) && isKnown(m.commodity) ? `${m.count} t${commodity}`.trim() : null;
}

export type ConnectionState = 'starting' | 'watching' | 'no-directory' | 'stopped' | 'error';

export interface CompanionSnapshot {
  readonly state: CommanderState;
  readonly stats: IngestStats;
  readonly connection: ConnectionState;
  readonly directory: string | null;
  readonly directoryDetail: string;
  readonly activeFile: string | null;
  readonly lastError: string | null;
  readonly contexts: readonly ActiveContext[];
  readonly contextRuleVersion: number;
  readonly contextRuleSource: string;
  readonly missions: MissionView;
}

export interface MissionView {
  readonly summary: MissionSummary;
  readonly groups: readonly DestinationGroup[];
  readonly withoutDestination: readonly Mission[];
  readonly byExpiry: readonly Mission[];
}

const EMPTY_STATS: IngestStats = {
  linesRead: 0,
  eventsEmitted: 0,
  malformedJson: 0,
  notAnObject: 0,
  missingEventField: 0,
  unknownEventKinds: {},
  filesOpened: 0,
  rotations: 0,
  emptyFilesSkipped: 0,
};

export class Companion {
  private started = false;
  private overlayEnabled = false;
  /**
   * Starts on the bundled rule set so context works offline and on first run
   * (§22). A server-supplied set supersedes it via `setContextRules`.
   */
  private readonly resolver = new ContextResolver(BUNDLED_RULES, { maxActive: 3 });
  private readonly missions = new MissionStore();
  /** Set when mission state changed and has not yet been written to disk. */
  private missionsDirty = false;
  private widgets: OverlayWidgets = { ...DEFAULT_WIDGETS };
  private cachedSnapshot: CompanionSnapshot | null = null;
  private db: Database | null = null;
  private engine: JournalEngine | null = null;
  private state: CommanderState = initialState();
  private connection: ConnectionState = 'starting';
  private directory: string | null = null;
  private directoryDetail = '';
  private lastError: string | null = null;
  private readonly listeners = new Set<() => void>();
  /** Coalesces renders: the UI does not need one per journal line. */
  private notifyScheduled = false;
  private dirtyCheckpoint: JournalCheckpoint | null = null;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Current snapshot.
   *
   * MUST return a referentially stable value between changes. React's
   * `useSyncExternalStore` compares snapshots by identity: returning a fresh
   * object on every call makes it believe the store changed during render, and
   * it throws rather than looping forever. The cache is invalidated in `notify`.
   */
  snapshot(): CompanionSnapshot {
    if (!this.cachedSnapshot) {
      this.cachedSnapshot = {
        state: { ...this.state },
        stats: this.engine?.stats ?? EMPTY_STATS,
        connection: this.connection,
        directory: this.directory,
        directoryDetail: this.directoryDetail,
        activeFile: this.engine?.currentFile ?? null,
        lastError: this.lastError,
        contexts: this.resolver.current(),
        contextRuleVersion: this.resolver.version,
        contextRuleSource: this.resolver.source,
        missions: this.missionView(),
      };
    }
    return this.cachedSnapshot;
  }

  private notify(): void {
    // Invalidate immediately: a listener may read the snapshot before the
    // scheduled flush runs, and must not be handed a stale one.
    this.cachedSnapshot = null;
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      this.cachedSnapshot = null;
      for (const fn of this.listeners) fn();
    });
  }

  async start(): Promise<void> {
    // Idempotent: React StrictMode intentionally mounts effects twice in
    // development, and starting two engines against one journal would double
    // every event.
    if (this.started) return;
    this.started = true;

    try {
      this.db = await Database.load('sqlite:edfm-companion.db');
      logger.info('db', 'Local database ready');
    } catch (err) {
      this.lastError = `Database unavailable: ${String(err)}`;
      logger.error('db', 'Failed to open local database', { error: String(err) });
    }

    const storedWidgets = await this.getSetting('overlayWidgets');
    if (storedWidgets) {
      try {
        // Merged over the defaults so a setting saved by an older build, before a
        // widget existed, does not leave that widget permanently undefined.
        this.widgets = { ...DEFAULT_WIDGETS, ...(JSON.parse(storedWidgets) as OverlayWidgets) };
      } catch {
        this.widgets = { ...DEFAULT_WIDGETS };
      }
    }

    const override = await this.getSetting('journalDirectory');
    const saved = await savedGamesDir();
    const resolution = await resolveJournalDirectory({
      manualOverride: override ?? undefined,
      savedGamesPath: saved ?? undefined,
      fs: tauriFs,
    });

    this.directory = resolution.directory;
    this.directoryDetail = resolution.detail;
    logger.info('journal', 'Directory resolution', {
      strategy: resolution.strategy,
      found: resolution.directory !== null,
    });

    if (!resolution.directory) {
      this.connection = 'no-directory';
      this.notify();
      return;
    }

    // Load before ingest starts, so a carrier we are already docked at resolves
    // on the first Location/Docked event rather than after it.
    const rememberedCarriers = await this.loadKnownCarriers();
    await this.loadMissions();

    const checkpoint = await this.loadCheckpoint();
    this.engine = new JournalEngine({
      directory: resolution.directory,
      checkpoint,
      fs: tauriFs,
      watchDirectory: watchJournalDirectory,
      safetyPollMs: 2000,
      onEvent: (e) => this.onEvent(e),
      onFailure: (f) =>
        // Excerpt only, never the whole line: §21.
        logger.warn('journal', `Unusable line (${f.reason})`, {
          file: f.sourceFile,
          offset: f.byteOffset,
        }),
      onCheckpoint: (c) => {
        this.dirtyCheckpoint = c;
      },
      onRotate: (from, to) => logger.info('journal', 'Rotated journal', { from, to }),
    });

    try {
      await this.engine.start();
      this.connection = 'watching';
      logger.info('journal', 'Watching', { file: this.engine.currentFile });
    } catch (err) {
      this.connection = 'error';
      this.lastError = String(err);
      logger.error('journal', 'Engine failed to start', { error: String(err) });
    }

    // Checkpoints are written on a timer rather than per event: at 45k events per
    // session a write per event would be pointless disk churn.
    setInterval(() => {
      void this.flushCheckpoint();
      if (this.missionsDirty) {
        this.missionsDirty = false;
        void this.saveMissions();
      }
    }, 3000);
    this.notify();

    // Deliberately not awaited: this reads historical journals and must never
    // delay live ingest. Only runs when nothing is remembered yet.
    if (rememberedCarriers === 0) {
      void this.backfillCarrierIdentities(resolution.directory);
    }
  }

  stop(): void {
    this.engine?.stop();
    this.connection = 'stopped';
    void this.flushCheckpoint();
    this.notify();
  }

  private onEvent(event: NormalizedEvent): void {
    applyEvent(this.state, event);

    if (this.missions.observe(event)) {
      this.missionsDirty = true;
      this.notify();
    }

    // Carrier identities are stable reference data: learn once, remember forever.
    if (event.kind === 'carrier-identity') void this.saveCarrierIdentity(event);

    // Context resolution runs on every event, including the high-frequency ones:
    // a rule may legitimately key on them, and evaluating a dozen declarative
    // conditions is far cheaper than a React render.
    const contextChanged = this.resolver.observe(event, this.state);

    if (contextChanged || !HIGH_FREQUENCY_NOISE.has(event.source.event)) {
      logger.trace('journal', event.source.event, { id: event.source.provenance.eventId });
      this.notify();
      if (this.overlayEnabled) this.pushOverlayState();
    }
  }

  /* --------------------------------------------------------------- overlay */

  setOverlayEnabled(enabled: boolean): void {
    this.overlayEnabled = enabled;
    if (enabled) this.pushOverlayState();
  }

  /**
   * Send the overlay a flattened view of current state.
   *
   * Only the handful of fields the widget renders — not the whole state object —
   * so the overlay never holds commander data it has no use for.
   */
  pushOverlayState(): void {
    const s = this.state;
    const text = (v: Known<string>): string | null => (isKnown(v) ? v : null);
    const top = this.resolver.current()[0] ?? null;

    void overlayApi
      .pushState({
        commander: text(s.commander),
        starSystem: text(s.starSystem),
        // Carrier name and callsign go on one line: two rows for one place wasted
        // scarce overlay space and read as two separate things.
        //
        // When not docked, this row shows what the commander is *doing* instead of
        // "Unknown". There is no station, and saying so as though it were missing
        // data misrepresents a perfectly known situation.
        station: isKnown(s.stationName)
          ? isKnown(s.carrierName)
            ? `${s.carrierName} (${s.stationName})`
            : s.stationName
          : travelLabel(s.travel),
        // Body is omitted when it merely repeats the station. BodyType "Station"
        // means the journal reported Body='Elder Hub' next to
        // StationName='Elder Hub'; a carrier is Planet or Star, so its body is
        // genuinely different information and stays.
        body: isKnown(s.bodyType) && s.bodyType === 'Station' ? null : text(s.body),
        docking: s.docking === 'unknown' ? null : s.docking,
        vehicle: s.vehicle === 'unknown' ? null : s.vehicle,
        // Destination and route progress, shown only while actually travelling.
        jumpTarget: isKnown(s.jumpTarget) ? s.jumpTarget : null,
        remainingJumps: isKnown(s.remainingJumps) ? s.remainingJumps : null,
        // Only the single highest-ranked context reaches the overlay. Space over a
        // game window is scarce, and §6 is explicit that the commander should not
        // be handed a wall of links mid-flight.
        missions: this.overlayMissions(),
        widgets: this.widgets,
        context: top
          ? {
              title: top.rule.title,
              subtitle: top.rule.subtitle ?? null,
              resources: top.rule.resources
                .map((r) => ({ label: r.label, url: resourceUrl(r) }))
                .filter((r): r is { label: string; url: string } => r.url !== null)
                .slice(0, 3),
            }
          : null,
      })
      .catch(() => undefined); // overlay may not be open; not an error
  }

  /** Widgets the overlay should draw. Persisted, and pushed on every update. */
  get overlayWidgets(): OverlayWidgets {
    return this.widgets;
  }

  async setOverlayWidgets(widgets: OverlayWidgets): Promise<void> {
    this.widgets = widgets;
    await this.setSetting('overlayWidgets', JSON.stringify(widgets));
    this.pushOverlayState();
    this.notify();
  }

  /**
   * Mission data shaped for the overlay.
   *
   * Two constraints drive the shape. Expiry is pre-formatted here because the
   * overlay is a passive view with no clock of its own, and the row list is
   * capped because an overlay listing forty missions is unreadable in flight —
   * the main window is where the full list belongs.
   */
  private overlayMissions(): OverlayMissions {
    const { groups, withoutDestination } = this.missions.byDestination();
    const summary = this.missions.summary();
    const top = groups[0] ?? null;

    const rows: OverlayMissionRow[] = this.missions
      .byExpiry()
      .slice(0, OVERLAY_MISSION_ROWS)
      .map((m) => ({
        id: m.missionId,
        name: isKnown(m.localisedName) ? m.localisedName : m.name,
        destination: isKnown(m.destinationSystem)
          ? isKnown(m.destinationStation)
            ? `${m.destinationSystem} · ${m.destinationStation}`
            : m.destinationSystem
          : null,
        expiry: isKnown(m.expiry) ? relativeExpiry(m.expiry) : null,
        cargo: cargoLabel(m),
        note: this.widgets.edfmNotes ? explainMission(m) : null,
      }));

    return {
      active: summary.active,
      cargo: summary.totalCargo,
      expiringSoon: summary.expiringSoon,
      withoutDestination: withoutDestination.length,
      nextStop: top
        ? {
            system: top.system,
            station: top.station,
            missions: top.missionCount,
            cargo: top.cargoRequired,
            cargoIncomplete: top.cargoIncomplete,
            kills: top.killsRequired,
            expiry: top.earliestExpiry ? relativeExpiry(top.earliestExpiry) : null,
          }
        : null,
      rows,
      more: Math.max(0, summary.active - rows.length),
    };
  }

  /**
   * Replace the context rules, e.g. from the backend once one exists.
   *
   * Kept here rather than inside the resolver so the fetch, caching and version
   * policy stay in application code where they can be logged and surfaced.
   */
  setContextRules(ruleSet: Parameters<ContextResolver['setRuleSet']>[0]): void {
    this.resolver.setRuleSet(ruleSet);
    logger.info('context', 'Rule set replaced', {
      version: this.resolver.version,
      source: this.resolver.source,
    });
    this.notify();
  }

  /* -------------------------------------------------------------- missions */

  private missionView(): MissionView {
    const { groups, withoutDestination } = this.missions.byDestination();
    return {
      summary: this.missions.summary(),
      groups,
      withoutDestination,
      byExpiry: this.missions.byExpiry(),
    };
  }

  private async loadMissions(): Promise<void> {
    if (!this.db) return;
    try {
      const rows = await this.db.select<MissionRow[]>('SELECT * FROM missions');
      this.missions.load(rows.map(fromRow));
      logger.info('missions', 'Loaded from storage', { count: rows.length });
    } catch (err) {
      logger.warn('db', 'Could not load missions', { error: String(err) });
    }
  }

  /**
   * Persist every mission the store currently holds.
   *
   * Written wholesale rather than per-change because a single `Missions`
   * reconciliation can alter many rows at once, and the set is small — the
   * busiest snapshot in the corpus held 20 active missions.
   */
  private async saveMissions(): Promise<void> {
    if (!this.db) return;
    const all = this.missions.all();
    if (all.length === 0) return;

    const columns = MISSION_COLUMNS.join(', ');
    const placeholders = MISSION_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');

    try {
      for (const mission of all) {
        const row = toRow(mission) as unknown as Record<string, unknown>;
        await this.db.execute(
          `INSERT OR REPLACE INTO missions (${columns}) VALUES (${placeholders})`,
          MISSION_COLUMNS.map((c) => row[c] ?? null),
        );
      }
    } catch (err) {
      logger.warn('db', 'Could not save missions', { error: String(err) });
    }
  }

  /* ------------------------------------------------- carrier identities */

  /**
   * Load remembered carrier names into state before ingest begins.
   *
   * `CarrierStats` is emitted when carrier management is opened, not at session
   * start, so in most sessions the name is never mentioned at all. Remembering it
   * is the only way the name is available while simply docked.
   */
  private async loadKnownCarriers(): Promise<number> {
    if (!this.db) return 0;
    try {
      const rows = await this.db.select<Array<{ carrier_id: number; name: string }>>(
        'SELECT carrier_id, name FROM known_carriers',
      );
      for (const row of rows) this.state.knownCarriers[row.carrier_id] = row.name;
      return rows.length;
    } catch {
      return 0;
    }
  }

  private async saveCarrierIdentity(event: NormalizedEvent): Promise<void> {
    if (!this.db) return;
    const d = event.data as { carrierId: unknown; name: unknown; callsign: unknown };
    if (typeof d.carrierId !== 'number' || typeof d.name !== 'string' || d.name.length === 0) return;

    try {
      await this.db.execute(
        `INSERT INTO known_carriers (carrier_id, name, callsign, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(carrier_id) DO UPDATE SET
           name = excluded.name, callsign = excluded.callsign, updated_at = excluded.updated_at`,
        [
          d.carrierId,
          d.name,
          typeof d.callsign === 'string' ? d.callsign : null,
          new Date().toISOString(),
        ],
      );
    } catch (err) {
      logger.warn('db', 'Could not remember carrier identity', { error: String(err) });
    }
  }

  /**
   * Learn carrier identities from recent journal history.
   *
   * Runs only when nothing is remembered yet. Live ingest resumes from a
   * checkpoint, so a `CarrierStats` written before the app was ever installed
   * would otherwise never be seen — the name would stay unavailable until the
   * commander happened to open carrier management again.
   *
   * Bounded to the most recent journals and stops as soon as an identity is
   * found, so this cannot become a 220-file scan on startup (§30). Deliberately
   * kicked off after the engine is running, so it never delays live ingest.
   */
  private async backfillCarrierIdentities(directory: string, maxFiles = 25): Promise<void> {
    try {
      const files = (await listJournalFiles(directory, tauriFs)).filter((f) => f.sizeBytes > 0);
      const recent = files.slice(-maxFiles).reverse(); // newest first

      for (const file of recent) {
        const result = await replayFile(file.fullPath, tauriFs);
        let found = false;

        for (const event of result.events) {
          if (event.kind !== 'carrier-identity') continue;
          const d = event.data as { carrierId: unknown; name: unknown };
          if (typeof d.carrierId !== 'number' || typeof d.name !== 'string') continue;
          // learnCarrier rather than applyEvent: these are historical events, and
          // replaying them through the reducer would make the dashboard report
          // stale activity as the latest thing that happened.
          learnCarrier(this.state, d.carrierId, d.name);
          await this.saveCarrierIdentity(event);
          found = true;
        }

        if (found) {
          logger.info('journal', 'Learned carrier identities from history', {
            file: file.fileName,
          });
          // Re-resolve: we may already be docked at a carrier we just learned about.
          this.notify();
          if (this.overlayEnabled) this.pushOverlayState();
          return;
        }
      }
    } catch (err) {
      logger.warn('journal', 'Carrier identity backfill failed', { error: String(err) });
    }
  }

  /* ------------------------------------------------------------ persistence */

  private async getSetting(key: string): Promise<string | null> {
    if (!this.db) return null;
    try {
      const rows = await this.db.select<Array<{ value: string }>>(
        'SELECT value FROM settings WHERE key = $1',
        [key],
      );
      return rows[0]?.value ?? null;
    } catch {
      return null;
    }
  }

  async setSetting(key: string, value: string): Promise<void> {
    if (!this.db) return;
    await this.db.execute(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, new Date().toISOString()],
    );
  }

  /**
   * Checkpoints are scoped per commander FID where known.
   *
   * A single global checkpoint would let one commander resume at another's byte
   * offset after a commander switch, which §35 calls out explicitly.
   */
  private checkpointScope(): string {
    const fid = this.state.fid;
    return typeof fid === 'string' ? `fid:${fid}` : 'default';
  }

  private async loadCheckpoint(): Promise<JournalCheckpoint | null> {
    if (!this.db) return null;
    try {
      const rows = await this.db.select<
        Array<{ source_file: string; byte_offset: number; last_event_id: string | null; updated_at: string }>
      >('SELECT source_file, byte_offset, last_event_id, updated_at FROM journal_checkpoint WHERE scope = $1', [
        this.checkpointScope(),
      ]);
      const row = rows[0];
      if (!row) return null;
      return {
        sourceFile: row.source_file,
        byteOffset: row.byte_offset,
        lastEventId: row.last_event_id,
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  private async flushCheckpoint(): Promise<void> {
    const c = this.dirtyCheckpoint;
    if (!c || !this.db) return;
    this.dirtyCheckpoint = null;
    try {
      await this.db.execute(
        `INSERT INTO journal_checkpoint (scope, source_file, byte_offset, last_event_id, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(scope) DO UPDATE SET
           source_file = excluded.source_file,
           byte_offset = excluded.byte_offset,
           last_event_id = excluded.last_event_id,
           updated_at = excluded.updated_at`,
        [this.checkpointScope(), c.sourceFile, c.byteOffset, c.lastEventId, c.updatedAt],
      );
    } catch (err) {
      logger.warn('db', 'Checkpoint write failed', { error: String(err) });
    }
  }
}

export const companion = new Companion();
