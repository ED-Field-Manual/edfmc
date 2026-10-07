//! Python plugin host: start, stop and talk to it.
//!
//! Python plugins run in their own process (`plugin-host/host.py`), never in
//! this one. A plugin that crashes, hangs or leaks takes down only that process,
//! and the app keeps working.
//!
//! Python plugins share `Documents/EDFMC/plugins` with declarative plugins.
//!
//! **This runs code the commander installed, with their full permissions.**
//! Installing the plugin is the consent action, as it is in other companion-tool
//! hosts. The frontend starts the host during Python-plugin system initialisation;
//! a stored per-plugin disabled state prevents an individual `load.py` from being
//! imported (see `docs/PYTHON-PLUGINS.md`).
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
    /// The panel showing now and where, in client pixels, so it can follow the
    /// app window when that moves or resizes.
    showing: Mutex<Option<Placement>>,
}

#[derive(Clone)]
struct Placement {
    folder: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

struct Running {
    child: Child,
    stdin: ChildStdin,
}

/// Where Python plugins live: the same plugins folder as every other plugin,
/// `Documents/EDFMC/plugins`. A folder with a `load.py` is a Python plugin and
/// one with a `plugin.json` is a declarative one; each loader ignores the
/// other kind.
fn python_plugins_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = crate::plugins::plugins_path(app)?;
    // Earlier builds kept Python plugins in app data. Anything put there moves
    // over, once, and only where the name is not already taken.
    if let Ok(old) = app.path().app_data_dir().map(|d| d.join("python-plugins")) {
        if let Ok(entries) = std::fs::read_dir(&old) {
            for entry in entries.flatten() {
                let target = dir.join(entry.file_name());
                if !target.exists() {
                    let _ = std::fs::rename(entry.path(), target);
                }
            }
            let _ = std::fs::remove_dir(&old);
        }
    }
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
    disabled: Vec<String>,
) -> Result<u32, String> {
    if is_running(&state) {
        let guard = state.inner.lock().unwrap();
        return Ok(guard.as_ref().map(|r| r.child.id()).unwrap_or(0));
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
        // Folders the commander switched off: listed, never imported.
        .env(
            "EDFMC_DISABLED_PLUGINS",
            serde_json::to_string(&disabled).unwrap_or_else(|_| "[]".into()),
        )
        .env("PYTHONIOENCODING", "utf-8")
        // Each plugin's panel lives inside the app, on that plugin's own tab.
        .env("EDFMC_EMBED", "1")
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
    // Every message names the process it came from. After a restart the old
    // process's exit arrives while the new one is running, and without this
    // it read as the new one crashing.
    let pid = child.id();

    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            // Only well-formed JSON is forwarded; anything else is not protocol.
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("pid".into(), pid.into());
                    let _ = handle.emit(EVENT, value);
                }
            }
        }
        let _ = handle.emit(EVENT, serde_json::json!({ "type": "exited", "pid": pid }));
    });

    *state.inner.lock().unwrap() = Some(Running { child, stdin });
    Ok(pid)
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

/// Stop and wait, off the main thread, then call `then`. Used when the app is
/// closing: plugins get to save, and the app exits once they have.
///
/// The wait cannot happen on the main thread. Plugin panels are windows owned
/// by the app window, so the host closing them needs the app's message loop
/// running; blocking it stalled the host until the five-second kill.
///
/// Returns false when no host was running, so the caller can exit at once.
pub fn stop_then(state: &State<'_, PluginHostState>, then: impl FnOnce() + Send + 'static) -> bool {
    match take(state) {
        Some(running) => {
            std::thread::spawn(move || {
                finish(running);
                then();
            });
            true
        }
        None => false,
    }
}

fn take(state: &State<'_, PluginHostState>) -> Option<Running> {
    let _ = send_line(state, &serde_json::json!({ "type": "quit" }));
    *state.showing.lock().unwrap() = None;
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

/// Show one plugin's panel over its tab's free area in the app window.
///
/// Plugins draw with tkinter, real native widgets that a web page cannot
/// contain. So each panel is its own borderless window, owned by the app
/// window and kept exactly over the space the tab leaves for it. `x`, `y`,
/// `width` and `height` are physical pixels relative to the app window's
/// client area; `visible` false hides it when another tab is showing.
///
/// Owned, not a child. An earlier version made the panel a child of the app
/// window, and Tk crashed (an access violation inside tk86t.dll) on the first
/// click into it: Tk's window handling assumes a Tk top-level's parent is the
/// desktop or another Tk window. An owned window keeps Tk's assumptions true,
/// still stays above the app window, and hides when it is minimised.
#[tauri::command]
pub fn plugin_panel_place(
    app: AppHandle,
    state: State<'_, PluginHostState>,
    folder: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    visible: bool,
) -> Result<(), String> {
    if !visible {
        let mut showing = state.showing.lock().unwrap();
        if showing.as_ref().is_some_and(|p| p.folder == folder) {
            *showing = None;
        }
        drop(showing);
        return send_line(
            &state,
            &serde_json::json!({ "type": "place", "folder": folder, "visible": false }),
        );
    }
    let placement = Placement { folder, x, y, width, height };
    *state.showing.lock().unwrap() = Some(placement.clone());
    send_placement(&app, &state, &placement)
}

/// Re-send the showing panel's position after the app window moved or resized.
pub fn follow_main_window(app: &AppHandle) {
    let state = app.state::<PluginHostState>();
    let current = state.showing.lock().unwrap().clone();
    if let Some(placement) = current {
        let _ = send_placement(app, &state, &placement);
    }
}

fn send_placement(app: &AppHandle, state: &State<'_, PluginHostState>, p: &Placement) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("The main window is missing.")?;
    // Screen position of the client area: the panel is a top-level window.
    let origin = main.inner_position().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let owner = main.hwnd().map_err(|e| e.to_string())?.0 as isize;
    #[cfg(not(windows))]
    let owner = 0isize;
    send_line(
        state,
        &serde_json::json!({
            "type": "place",
            "folder": p.folder,
            "owner": owner,
            "x": origin.x + p.x,
            "y": origin.y + p.y,
            "width": p.width,
            "height": p.height,
            "visible": true,
        }),
    )
}
