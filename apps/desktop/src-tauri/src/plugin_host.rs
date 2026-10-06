//! Python plugin host: start, stop and talk to it.
//!
//! Python plugins run in their own process (`plugin-host/host.py`), never in
//! this one. A plugin that crashes, hangs or leaks takes down only that process,
//! and the app keeps working.
//!
//! **This runs code the commander installed, with their full permissions.**
//! That is the point of the feature and the reason it is off until they switch
//! it on past a warning (see `docs/PYTHON-PLUGINS.md`). Nothing here starts it
//! on its own: the frontend calls `plugin_host_start` only when the setting is
//! on.
//!
//! The protocol is one JSON object per line in each direction. Lines from the
//! host are forwarded to the frontend as `plugin-host://message` events, and the
//! process ending is reported as `{"type":"exited"}`.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

pub const EVENT: &str = "plugin-host://message";

#[derive(Default)]
pub struct PluginHostState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    child: Child,
    stdin: ChildStdin,
}

/// Where Python plugins live: a folder of its own, next to the app's data.
///
/// Deliberately not the declarative plugins folder. Those are data the app
/// validates; these are programs, and mixing the two would blur exactly the
/// line the warning asks the commander to understand.
fn python_plugins_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("python-plugins");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn host_data_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("python-host");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// The host script. Bundled as a resource; in a development build it is read
/// straight from the source tree.
fn host_script(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("plugin-host").join("host.py"));
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("plugin-host").join("host.py"));
    candidates.into_iter().find(|p| p.is_file())
}

/// Find a Python to run plugins with.
///
/// A runtime bundled with the app wins, because it carries the libraries
/// plugins expect. Otherwise an installed Python 3, found through the `py`
/// launcher first and then `PATH`. The Microsoft Store's `python.exe` alias in
/// `WindowsApps` is skipped: it opens the Store instead of running anything.
fn find_python(app: &AppHandle) -> Option<(PathBuf, Vec<String>)> {
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("python").join("python.exe");
        if bundled.is_file() {
            return Some((bundled, vec![]));
        }
    }

    #[cfg(windows)]
    {
        if let Some(windir) = std::env::var_os("WINDIR") {
            let py = PathBuf::from(windir).join("py.exe");
            if py.is_file() {
                return Some((py, vec!["-3".into()]));
            }
        }
    }

    let exe = if cfg!(windows) { "python.exe" } else { "python3" };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(exe))
        .find(|p| p.is_file() && !p.to_string_lossy().contains("WindowsApps"))
        .map(|p| (p, vec![]))
}

#[derive(serde::Serialize)]
pub struct PythonPluginInfo {
    /// The folder plugins go in.
    folder: Option<String>,
    /// The Python that would run them, or None when none was found.
    python: Option<String>,
    running: bool,
}

#[tauri::command]
pub fn plugin_host_info(app: AppHandle, state: State<'_, PluginHostState>) -> PythonPluginInfo {
    PythonPluginInfo {
        folder: python_plugins_path(&app).map(|p| p.to_string_lossy().into_owned()),
        python: find_python(&app).map(|(p, _)| p.to_string_lossy().into_owned()),
        running: is_running(&state),
    }
}

fn is_running(state: &State<'_, PluginHostState>) -> bool {
    let mut guard = state.inner.lock().unwrap();
    match guard.as_mut() {
        Some(r) => match r.child.try_wait() {
            Ok(None) => true,
            _ => {
                *guard = None;
                false
            }
        },
        None => false,
    }
}

#[tauri::command]
pub fn plugin_host_start(
    app: AppHandle,
    state: State<'_, PluginHostState>,
    journal_dir: String,
) -> Result<(), String> {
    if is_running(&state) {
        return Ok(());
    }
    let script = host_script(&app).ok_or("The plugin host is missing from this install.")?;
    let (python, pre_args) = find_python(&app).ok_or(
        "No Python 3 was found. Install Python 3 from python.org, then try again.",
    )?;
    let plugins = python_plugins_path(&app).ok_or("The plugins folder could not be created.")?;
    let data = host_data_path(&app).ok_or("The plugin data folder could not be created.")?;

    let mut command = Command::new(&python);
    command
        .args(&pre_args)
        .arg("-u")
        .arg(&script)
        .env("EDFMC_JOURNAL_DIR", &journal_dir)
        .env("EDFMC_PLUGIN_DIR", &plugins)
        .env("EDFMC_DATA_DIR", &data)
        .env("EDFMC_VERSION", env!("CARGO_PKG_VERSION"))
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window behind the plugin window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|e| format!("Python could not be started: {e}"))?;
    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;

    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            // Only well-formed JSON is forwarded; anything else is not protocol.
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                let _ = handle.emit(EVENT, value);
            }
        }
        let _ = handle.emit(EVENT, serde_json::json!({ "type": "exited" }));
    });

    *state.inner.lock().unwrap() = Some(Running { child, stdin });
    Ok(())
}

fn send_line(state: &State<'_, PluginHostState>, message: &serde_json::Value) -> Result<(), String> {
    let mut guard = state.inner.lock().unwrap();
    let running = guard.as_mut().ok_or("Plugins are not running.")?;
    writeln!(running.stdin, "{message}")
        .and_then(|_| running.stdin.flush())
        .map_err(|e| e.to_string())
}

/// Bring the plugin window forward, or open its settings.
#[tauri::command]
pub fn plugin_host_send(state: State<'_, PluginHostState>, kind: String) -> Result<(), String> {
    if kind != "show" && kind != "settings" {
        return Err("Unknown command".into());
    }
    send_line(&state, &serde_json::json!({ "type": kind }))
}

/// Ask the host to stop, giving plugins the chance to save, then make sure.
///
/// Returns at once; the wait happens on a thread, so the window does not
/// freeze while a plugin saves.
#[tauri::command]
pub fn plugin_host_stop(state: State<'_, PluginHostState>) {
    if let Some(running) = take(&state) {
        std::thread::spawn(move || finish(running));
    }
}

/// Stop and wait. Used when the app is closing, where waiting is the point.
pub fn stop(state: &State<'_, PluginHostState>) {
    if let Some(running) = take(state) {
        finish(running);
    }
}

fn take(state: &State<'_, PluginHostState>) -> Option<Running> {
    let _ = send_line(state, &serde_json::json!({ "type": "quit" }));
    state.inner.lock().unwrap().take()
}

/// Give plugins five seconds to save, then end the process regardless: a
/// plugin that hangs on stop must not hold anything open.
fn finish(mut running: Running) {
    drop(running.stdin);
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = running.child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = running.child.kill();
    let _ = running.child.wait();
}

#[tauri::command]
pub fn python_plugins_open_folder(app: AppHandle) -> Result<(), String> {
    let path = python_plugins_path(&app).ok_or("The plugins folder could not be created.")?;
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(format!("Open this folder: {}", path.to_string_lossy()))
    }
}
