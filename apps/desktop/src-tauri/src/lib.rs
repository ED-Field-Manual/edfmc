//! EDFM Companion desktop shell.
//!
//! The native layer stays deliberately thin: known-folder resolution, narrow
//! journal read commands, directory watching, and SQLite migrations. All parsing,
//! normalization and state live in TypeScript so that replay and live ingestion run
//! the identical pipeline (see docs/ARCHITECTURE.md §2.2).

mod journal;
mod overlay;

use tauri_plugin_sql::{Migration, MigrationKind};

/// Phase 1 local schema.
///
/// Normalized tables rather than a generic JSON blob store (§26). `journal_checkpoint`
/// is the mechanism behind restart-without-duplicate-events.
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "phase 1 foundation",
        sql: r#"
            CREATE TABLE IF NOT EXISTS settings (
                key         TEXT PRIMARY KEY,
                value       TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

            -- One row per commander (FID), so switching commanders cannot make one
            -- resume at another's offset.
            CREATE TABLE IF NOT EXISTS journal_checkpoint (
                scope         TEXT PRIMARY KEY,
                source_file   TEXT NOT NULL,
                byte_offset   INTEGER NOT NULL,
                last_event_id TEXT,
                updated_at    TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS commander_state (
                fid           TEXT PRIMARY KEY,
                commander     TEXT,
                game_version  TEXT,
                build         TEXT,
                star_system   TEXT,
                system_address INTEGER,
                station_name  TEXT,
                market_id     INTEGER,
                docking       TEXT NOT NULL DEFAULT 'unknown',
                vehicle       TEXT NOT NULL DEFAULT 'unknown',
                ship          TEXT,
                cargo_count   INTEGER,
                updated_at    TEXT NOT NULL
            );

            -- Ingest counters for the diagnostics screen (§25). Keeps no journal
            -- content, only aggregate counts.
            CREATE TABLE IF NOT EXISTS ingest_stats (
                id              INTEGER PRIMARY KEY CHECK (id = 1),
                lines_read      INTEGER NOT NULL DEFAULT 0,
                events_emitted  INTEGER NOT NULL DEFAULT 0,
                malformed_json  INTEGER NOT NULL DEFAULT 0,
                rotations       INTEGER NOT NULL DEFAULT 0,
                updated_at      TEXT NOT NULL
            );

            -- Names only, never payloads: an unknown event's body can contain
            -- commander detail we have no reason to persist (§21).
            CREATE TABLE IF NOT EXISTS unknown_events (
                event_name   TEXT PRIMARY KEY,
                count        INTEGER NOT NULL DEFAULT 0,
                first_seen   TEXT NOT NULL,
                last_seen    TEXT NOT NULL,
                game_version TEXT
            );
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 2,
        description: "remember fleet carrier identities",
        sql: r#"
            -- Docked at a carrier reports only the callsign; the name arrives in
            -- CarrierStats, which is emitted when carrier management is opened --
            -- not every session. Without persistence the name is unavailable in
            -- any session where the commander did not open that panel.
            CREATE TABLE IF NOT EXISTS known_carriers (
                carrier_id  INTEGER PRIMARY KEY,
                name        TEXT NOT NULL,
                callsign    TEXT,
                updated_at  TEXT NOT NULL
            );
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 3,
        description: "missions",
        sql: r#"
            -- Explicit columns rather than a JSON blob (§26): missions are a
            -- first-class entity that later phases group and query.
            --
            -- Every optional column is nullable, and NULL means "the game did not
            -- report this" -- distinct from 0 or ''. Collapsing that distinction
            -- on the way to disk would destroy it across a restart.
            CREATE TABLE IF NOT EXISTS missions (
                mission_id             INTEGER PRIMARY KEY,
                id_reliable            INTEGER NOT NULL DEFAULT 1,
                name                   TEXT NOT NULL,
                type_key               TEXT NOT NULL,
                category               TEXT NOT NULL,
                localised_name         TEXT,
                faction                TEXT,
                influence              TEXT,
                reputation             TEXT,
                wing                   INTEGER,
                destination_system     TEXT,
                destination_station    TEXT,
                destination_settlement TEXT,
                target_faction         TEXT,
                target                 TEXT,
                target_type            TEXT,
                commodity              TEXT,
                commodity_localised    TEXT,
                count                  INTEGER,
                kill_count             INTEGER,
                passenger_count        INTEGER,
                passenger_type         TEXT,
                passenger_vips         INTEGER,
                passenger_wanted       INTEGER,
                reward                 INTEGER,
                donation               INTEGER,
                expiry                 TEXT,
                status                 TEXT NOT NULL,
                redirected             INTEGER NOT NULL DEFAULT 0,
                accepted_at            TEXT NOT NULL,
                source_event_id        TEXT NOT NULL,
                game_version           TEXT,
                ended_at               TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
            CREATE INDEX IF NOT EXISTS idx_missions_expiry ON missions(expiry);
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 4,
        description: "cargo delivery progress",
        sql: r#"
            -- From CargoDepot, which is the one kind of mission progress Elite
            -- genuinely journals. NULL means no depot event has been seen for the
            -- mission -- not that nothing has been delivered.
            ALTER TABLE missions ADD COLUMN delivered INTEGER;
            ALTER TABLE missions ADD COLUMN total_to_deliver INTEGER;
            ALTER TABLE missions ADD COLUMN collected INTEGER;
        "#,
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:edfm-companion.db", migrations())
                .build(),
        )
        .manage(journal::WatcherState::default())
        .manage(overlay::OverlayState::default())
        .setup(|app| {
            // Arm click-through at creation, before the overlay can ever be shown.
            // The overlay is sized to the whole game window, so an interactive one
            // swallows every click in that area.
            use tauri::Manager;
            if let Some(win) = app.get_webview_window(overlay::OVERLAY_LABEL) {
                let _ = win.set_ignore_cursor_events(true);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            journal::saved_games_dir,
            journal::journal_read_dir,
            journal::journal_file_size,
            journal::journal_is_dir,
            journal::journal_read_range,
            journal::journal_watch,
            journal::journal_unwatch,
            overlay::elite_window_info,
            overlay::elite_display_mode,
            overlay::overlay_start,
            overlay::overlay_stop,
            overlay::overlay_set_edit_mode,
            overlay::overlay_push_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running EDFM Companion");
}
