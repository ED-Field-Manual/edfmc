//! Overlay engine: Elite window tracking and overlay positioning.
//!
//! Hard constraint (§31): this module observes the game window through ordinary
//! public Win32 APIs and nothing else. No DLL injection, no code injection, no
//! process memory access, no input synthesis. Everything here is information any
//! window manager can see.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

#[cfg(windows)]
use windows::{
    Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE},
    Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    Win32::UI::HiDpi::GetDpiForWindow,
    Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowRect, IsIconic, IsWindowVisible,
    },
};

/// Elite's window class, confirmed against a live 4.4.0.3 client.
/// The window title is localised; the class name is not, so match on the class.
#[cfg(windows)]
const ELITE_CLASS: &str = "FrontierDevelopmentsAppWinClass";

pub const OVERLAY_LABEL: &str = "overlay";

#[derive(Serialize, Clone, Default, Debug)]
pub struct EliteWindowInfo {
    pub found: bool,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// Raw DPI reported for the game window. Positions below are physical pixels,
    /// so this is informational rather than something we scale by.
    pub dpi: u32,
    pub is_foreground: bool,
    pub is_minimised: bool,
    pub monitor_width: i32,
    pub monitor_height: i32,
    /// The window exactly covers its monitor — consistent with borderless or
    /// exclusive fullscreen. It does NOT by itself distinguish the two.
    pub covers_monitor: bool,
}

/* ------------------------------------------------------- window discovery */

#[cfg(windows)]
struct FindState {
    hwnd: Option<HWND>,
}

#[cfg(windows)]
unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = &mut *(lparam.0 as *mut FindState);

    if !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }

    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buf);
    if len > 0 {
        let class = String::from_utf16_lossy(&buf[..len as usize]);
        if class == ELITE_CLASS {
            state.hwnd = Some(hwnd);
            return BOOL(0); // stop enumerating
        }
    }
    TRUE
}

#[cfg(windows)]
fn find_elite_hwnd() -> Option<HWND> {
    let mut state = FindState { hwnd: None };
    unsafe {
        let _ = EnumWindows(
            Some(enum_proc),
            LPARAM(&mut state as *mut FindState as isize),
        );
    }
    state.hwnd
}

#[cfg(windows)]
fn read_window(hwnd: HWND) -> Option<EliteWindowInfo> {
    unsafe {
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).ok()?;

        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let have_monitor = GetMonitorInfoW(monitor, &mut mi).as_bool();

        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        let (mw, mh) = if have_monitor {
            (
                mi.rcMonitor.right - mi.rcMonitor.left,
                mi.rcMonitor.bottom - mi.rcMonitor.top,
            )
        } else {
            (0, 0)
        };

        Some(EliteWindowInfo {
            found: true,
            x: rect.left,
            y: rect.top,
            width,
            height,
            dpi: GetDpiForWindow(hwnd),
            is_foreground: GetForegroundWindow() == hwnd,
            is_minimised: IsIconic(hwnd).as_bool(),
            monitor_width: mw,
            monitor_height: mh,
            covers_monitor: have_monitor
                && rect.left == mi.rcMonitor.left
                && rect.top == mi.rcMonitor.top
                && width == mw
                && height == mh,
        })
    }
}

#[cfg(windows)]
pub fn elite_window() -> EliteWindowInfo {
    find_elite_hwnd()
        .and_then(read_window)
        .unwrap_or_default()
}

#[cfg(not(windows))]
pub fn elite_window() -> EliteWindowInfo {
    EliteWindowInfo::default()
}

#[tauri::command]
pub fn elite_window_info() -> EliteWindowInfo {
    elite_window()
}

/* ---------------------------------------------------------- display mode */

#[derive(Serialize, Clone, Debug)]
pub struct DisplayModeInfo {
    /// Raw `<FullScreen>` value, so a value we do not recognise is still visible
    /// rather than silently coerced into a guess.
    pub raw: Option<i64>,
    pub mode: String,
    /// Whether a non-injecting external overlay can be expected to draw over it.
    pub overlay_supported: Option<bool>,
    pub detail: String,
}

/// Read Elite's own display configuration.
///
/// `Options/Graphics/DisplaySettings.xml` carries `<FullScreen>`, which is the
/// authoritative answer to the question the overlay actually cares about. Guessing
/// from window geometry cannot distinguish borderless from exclusive fullscreen —
/// both cover the monitor exactly — so we read the setting instead of inferring it.
///
/// `2` = Borderless is **confirmed empirically**: observed alongside a window with
/// WS_POPUP, no caption, no WS_EX_TOPMOST, covering the monitor exactly.
/// `0` (Windowed) and `1` (Fullscreen) follow Frontier's ordering in the settings UI
/// and are not yet directly confirmed here, so unknown values degrade honestly.
#[tauri::command]
pub fn elite_display_mode() -> DisplayModeInfo {
    let Some(local) = dirs_local_appdata() else {
        return DisplayModeInfo {
            raw: None,
            mode: "unknown".into(),
            overlay_supported: None,
            detail: "Could not locate the local application data folder.".into(),
        };
    };

    let path = local
        .join("Frontier Developments")
        .join("Elite Dangerous")
        .join("Options")
        .join("Graphics")
        .join("DisplaySettings.xml");

    let Ok(xml) = std::fs::read_to_string(&path) else {
        return DisplayModeInfo {
            raw: None,
            mode: "unknown".into(),
            overlay_supported: None,
            detail: format!("Could not read {}", path.display()),
        };
    };

    let value = extract_tag_i64(&xml, "FullScreen");

    match value {
        Some(0) => DisplayModeInfo {
            raw: value,
            mode: "windowed".into(),
            overlay_supported: Some(true),
            detail: "Elite is set to Windowed. The overlay can draw over it.".into(),
        },
        Some(1) => DisplayModeInfo {
            raw: value,
            mode: "fullscreen".into(),
            overlay_supported: Some(false),
            detail: "Elite is set to Fullscreen. An overlay that does not inject code \
                     into the game cannot draw over an exclusive-fullscreen swapchain. \
                     Switch Elite to Borderless to use the overlay."
                .into(),
        },
        Some(2) => DisplayModeInfo {
            raw: value,
            mode: "borderless".into(),
            overlay_supported: Some(true),
            detail: "Elite is set to Borderless. The overlay can draw over it.".into(),
        },
        other => DisplayModeInfo {
            raw: other,
            mode: "unknown".into(),
            overlay_supported: None,
            detail: format!(
                "Unrecognised FullScreen value {:?} in DisplaySettings.xml. The overlay \
                 will still run; if you cannot see it, try Borderless.",
                other
            ),
        },
    }
}

/// Minimal tag reader. Deliberately not a full XML parser: we want one integer, and
/// a malformed or unexpected file must degrade to "unknown", never panic.
fn extract_tag_i64(xml: &str, tag: &str) -> Option<i64> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    xml[start..end].trim().parse::<i64>().ok()
}

#[cfg(windows)]
fn dirs_local_appdata() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)
}

#[cfg(not(windows))]
fn dirs_local_appdata() -> Option<std::path::PathBuf> {
    None
}

/* ------------------------------------------------------- tracking thread */

type Geometry = (i32, i32, i32, i32);

#[derive(Default)]
pub struct OverlayState {
    pub running: Arc<AtomicBool>,
    /// Whether the overlay hides while Elite is not the foreground window.
    pub hide_when_inactive: Arc<AtomicBool>,
    /// Last applied geometry, so the window is only moved when it actually moved.
    last: Arc<Mutex<Option<Geometry>>>,
}

/// Start following the Elite window.
///
/// Polls rather than hooking: a window-position hook would require injecting into
/// the game's message loop, which §31 forbids. 10 Hz is imperceptible for window
/// following and costs almost nothing (§30).
#[tauri::command]
pub fn overlay_start(
    app: AppHandle,
    state: tauri::State<'_, OverlayState>,
    hide_when_inactive: bool,
) -> Result<(), String> {
    state
        .hide_when_inactive
        .store(hide_when_inactive, Ordering::Relaxed);

    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(()); // already running
    }

    let running = state.running.clone();
    let hide_inactive = state.hide_when_inactive.clone();
    let last = state.last.clone();

    std::thread::spawn(move || {
        while running.load(Ordering::Relaxed) {
            let info = elite_window();

            if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
                let should_show = info.found
                    && !info.is_minimised
                    && (!hide_inactive.load(Ordering::Relaxed) || info.is_foreground);

                if should_show {
                    let geometry = (info.x, info.y, info.width, info.height);
                    let moved = {
                        let mut guard = last.lock().unwrap_or_else(|e| e.into_inner());
                        if *guard == Some(geometry) {
                            false
                        } else {
                            *guard = Some(geometry);
                            true
                        }
                    };

                    // Repositioning every tick would fight the compositor and burn
                    // CPU beside a running game for no visible benefit.
                    if moved {
                        let _ = win.set_position(PhysicalPosition::new(info.x, info.y));
                        let _ = win.set_size(PhysicalSize::new(
                            info.width.max(1) as u32,
                            info.height.max(1) as u32,
                        ));
                    }
                    let _ = win.show();
                } else {
                    let _ = win.hide();
                }
            }

            let _ = app.emit("overlay://elite-window", &info);
            std::thread::sleep(Duration::from_millis(100));
        }
    });

    Ok(())
}

#[tauri::command]
pub fn overlay_stop(
    app: AppHandle,
    state: tauri::State<'_, OverlayState>,
) -> Result<(), String> {
    state.running.store(false, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = win.hide();
    }
    Ok(())
}

/// Toggle interactivity.
///
/// Normal mode is click-through so the overlay cannot intercept a single mouse
/// event meant for the game. Edit mode accepts input so widgets can be arranged.
#[tauri::command]
pub fn overlay_set_edit_mode(app: AppHandle, editing: bool) -> Result<(), String> {
    let win = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or_else(|| "overlay window not found".to_string())?;

    win.set_ignore_cursor_events(!editing).map_err(|e| e.to_string())?;
    if editing {
        let _ = win.set_focus();
    }
    app.emit_to(OVERLAY_LABEL, "overlay://edit-mode", editing)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Push commander state to the overlay window.
///
/// The main window owns the single journal engine; the overlay is a view onto it.
/// Running a second engine in the overlay would double every event and duplicate
/// the checkpoint bookkeeping.
#[tauri::command]
pub fn overlay_push_state(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    app.emit_to(OVERLAY_LABEL, "overlay://state", payload)
        .map_err(|e| e.to_string())
}
