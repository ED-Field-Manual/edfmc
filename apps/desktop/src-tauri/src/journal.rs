//! Native journal access.
//!
//! These commands are deliberately narrow. Granting the webview a general
//! filesystem permission would let any renderer bug read arbitrary user files;
//! instead the frontend gets exactly four operations, all confined to reading, and
//! all of which the TypeScript `JournalFs` port already expects.
//!
//! Nothing here writes to, or executes anything from, the journal directory.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{ipc::Response, AppHandle, Emitter, State};

/// Resolve the Windows *Saved Games* known folder.
///
/// §3 explicitly forbids assembling `C:\Users\<name>\Saved Games` by hand: the
/// folder can be relocated, and the profile directory is not authoritative.
#[cfg(windows)]
fn saved_games() -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_SavedGames, KF_FLAG_DEFAULT};

    unsafe {
        let raw: PWSTR = SHGetKnownFolderPath(&FOLDERID_SavedGames, KF_FLAG_DEFAULT, None).ok()?;
        let value = raw.to_string().ok();
        // SHGetKnownFolderPath allocates; the caller owns the buffer.
        CoTaskMemFree(Some(raw.0 as *const _));
        value
    }
}

#[cfg(not(windows))]
fn saved_games() -> Option<String> {
    // Linux/macOS have no Saved Games folder. The frontend falls back to a manual
    // override, and `resolveJournalDirectory` reports that clearly.
    None
}

#[tauri::command]
pub fn saved_games_dir() -> Option<String> {
    saved_games()
}

/// Entry names directly inside `path`. Returns an empty list rather than erroring,
/// so a missing directory degrades to "no journals yet".
#[tauri::command]
pub fn journal_read_dir(path: String) -> Vec<String> {
    let Ok(entries) = fs::read_dir(&path) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect()
}

/// Size in bytes, or `None` when the file is unreadable or absent.
#[tauri::command]
pub fn journal_file_size(path: String) -> Option<u64> {
    fs::metadata(&path).ok().map(|m| m.len())
}

/// True when `path` exists and is a directory.
#[tauri::command]
pub fn journal_is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

/// Read up to `length` bytes from `offset`.
///
/// Returned as a raw byte response rather than a JSON number array: journals reach
/// several megabytes, and serialising them element-by-element would be pointlessly
/// expensive for an application that must stay light while a game is running (§30).
///
/// A short read is legal and expected — the file may be shrinking or rotating.
#[tauri::command]
pub fn journal_read_range(path: String, offset: u64, length: u64) -> Response {
    // Cap a single read so a malformed request cannot balloon memory.
    const MAX: u64 = 64 * 1024 * 1024;
    let length = length.min(MAX) as usize;

    let mut buf = vec![0u8; length];
    let read = (|| -> std::io::Result<usize> {
        let mut f = fs::File::open(&path)?;
        f.seek(SeekFrom::Start(offset))?;
        let mut total = 0;
        while total < length {
            match f.read(&mut buf[total..])? {
                0 => break,
                n => total += n,
            }
        }
        Ok(total)
    })()
    .unwrap_or(0);

    buf.truncate(read);
    Response::new(buf)
}

/* --------------------------------------------------------------- watching */

#[derive(Default)]
pub struct WatcherState(pub Mutex<Option<RecommendedWatcher>>);

/// Watch the journal directory and emit `journal://changed` on activity.
///
/// This is the primary trigger for the ingest pump; the TypeScript side keeps a
/// low-frequency poll only as a backstop. Event-driven rather than polled, per §30.
#[tauri::command]
pub fn journal_watch(
    app: AppHandle,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = handle.emit("journal://changed", ());
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .configure(notify::Config::default().with_poll_interval(Duration::from_secs(2)))
        .ok();

    watcher
        .watch(&PathBuf::from(&path), RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    // Replacing the previous watcher drops it, which unregisters it.
    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn journal_unwatch(state: State<'_, WatcherState>) -> Result<(), String> {
    *state.0.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}
