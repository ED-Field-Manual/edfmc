//! Reading the plugins folder.
//!
//! The webview has no filesystem permission, so this is a narrow command in the
//! same spirit as the journal ones: it reads exactly one directory, returns
//! text, and does nothing else. Parsing and validation happen in TypeScript,
//! where the rule schemas already live.
//!
//! Nothing here executes anything. A plugin is a `plugin.json` file, and the
//! only way it can affect the application is by being valid data that the
//! existing engines already know how to evaluate.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
pub struct RawPlugin {
    /// Folder name, so a commander can find the one that misbehaved.
    directory: String,
    json: String,
}

/// `Documents/EDFM Companion/plugins`, created on first use.
///
/// Documents rather than the app data directory, and a readable name rather
/// than the bundle identifier, because installing a plugin means a person
/// putting a folder somewhere. Somewhere they can find without being told a
/// path is worth more than somewhere technically tidier:
/// `Documents\EDFM Companion\plugins` can be described over voice chat;
/// `%APPDATA%\com.edfieldmanual.companion\plugins` cannot.
///
/// Falls back to the app data directory on a platform with no Documents
/// folder, so the feature degrades rather than disappearing. The database
/// stays in app data either way -- that is not something anyone should be
/// hand-editing.
fn plugins_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app
        .path()
        .document_dir()
        .map(|d| d.join("EDFM Companion").join("plugins"))
        .or_else(|_| app.path().app_data_dir().map(|d| d.join("plugins")))
        .ok()?;

    // Best effort: a failure here surfaces as "no plugins found" rather than an
    // error dialog, which is the right outcome for an optional feature.
    let _ = fs::create_dir_all(&dir);
    Some(dir)
}

#[tauri::command]
pub fn plugins_dir(app: tauri::AppHandle) -> Option<String> {
    plugins_path(&app).map(|p| p.to_string_lossy().into_owned())
}

/// Every `plugin.json` directly inside a subfolder of the plugins directory.
///
/// One level deep only. Recursing would let a plugin hide manifests inside
/// another plugin's folder, which makes "which plugin contributed this" a
/// question with no clear answer.
#[tauri::command]
pub fn plugins_read(app: tauri::AppHandle) -> Vec<RawPlugin> {
    let Some(root) = plugins_path(&app) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let manifest = entry.path().join("plugin.json");
        // A folder without a manifest is not an error: authors leave notes,
        // screenshots and version-control directories lying around.
        let Ok(json) = fs::read_to_string(&manifest) else {
            continue;
        };
        out.push(RawPlugin {
            directory: entry.file_name().to_string_lossy().into_owned(),
            json,
        });
        // Bounded here as well as in TypeScript: reading ten thousand files to
        // then discard them is still ten thousand file reads.
        if out.len() >= 64 {
            break;
        }
    }
    out
}

/// Show the plugins folder in the system file manager.
///
/// Installing a plugin means putting a folder here, so the app has to be able
/// to point at where "here" is.
#[tauri::command]
pub fn plugins_open_folder(app: tauri::AppHandle) -> Result<(), String> {
    let path = plugins_path(&app).ok_or_else(|| "No application data directory.".to_string())?;

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(&path).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&path).spawn();

    result.map(|_| ()).map_err(|e| e.to_string())
}
