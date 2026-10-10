//! The main window's size and position: remembered between launches.
//!
//! The first launch uses `tauri.conf.json`'s size, chosen to show the whole
//! Dashboard (1200 x 900 logical; measured with real content it needs about
//! 880), shrunk if the screen is smaller and centred. After that the window
//! opens where and how big it was when it was last closed, including maximised.
//!
//! The saved place is only used if it is still on a screen: a monitor that has
//! since been unplugged or rearranged must not leave the window opening where
//! nobody can see it. Saved in the app's data folder as `window.json`.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Room left between the window and the edge of the work area, in physical pixels.
const MARGIN: u32 = 16;
const FILE: &str = "window.json";

/// The window's normal (not maximised) place, in physical pixels, and whether
/// it was maximised. `x`/`y` are the outer top-left; `width`/`height` the inner size,
/// matching what `set_position` and `set_size` take.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// The latest normal bounds and the ones before, kept in memory as the window
/// moves and written once when it closes.
///
/// Two, because maximising reports one last move at the maximised size before
/// the window says it is maximised; the place before that is the real one.
#[derive(Default)]
pub struct WindowMemory(Mutex<[Option<Bounds>; 2]>);

/// The place to restore to after a maximised window: the newest normal
/// bounds, unless they are the maximised size itself (that transition move),
/// in which case the ones before.
pub fn normal_place(history: [Option<Bounds>; 2], maximized_size: (u32, u32)) -> Option<Bounds> {
    match history {
        [Some(last), prev] if (last.width, last.height) == maximized_size => prev,
        [last, _] => last,
    }
}

/// A monitor's work area: x, y, width, height.
pub type Area = (i32, i32, u32, u32);

/// The inner size to use: the requested one, or as much of it as fits.
///
/// `chrome` is the title bar and borders (outer minus inner size), which must
/// fit on screen too. Never grows a window, only shrinks one that cannot fit.
pub fn fit_inner(requested: (u32, u32), chrome: (u32, u32), work_area: (u32, u32)) -> (u32, u32) {
    let room = |area: u32, chrome: u32| area.saturating_sub(chrome).saturating_sub(MARGIN * 2);
    (
        requested.0.min(room(work_area.0, chrome.0)).max(1),
        requested.1.min(room(work_area.1, chrome.1)).max(1),
    )
}

/// The monitor saved bounds can still be used on: the one under the title bar,
/// so the window can be seen and dragged. None if it is on no screen any more,
/// or its size is nonsense.
pub fn home_area(b: &Bounds, areas: &[Area]) -> Option<Area> {
    if b.width < 200 || b.height < 150 {
        return None;
    }
    // A point on the title bar, a little in from the left.
    let (px, py) = (b.x as i64 + 60, b.y as i64 + 10);
    areas.iter().copied().find(|&(x, y, w, h)| {
        px >= x as i64 && py >= y as i64 && px < x as i64 + w as i64 && py < y as i64 + h as i64
    })
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(FILE))
}

fn load(app: &AppHandle) -> Option<Bounds> {
    let text = std::fs::read_to_string(file(app)?).ok()?;
    serde_json::from_str(&text).ok()
}

/// At startup: the remembered place if it is still on a screen, otherwise the
/// configured size fitted to this screen and centred.
pub fn restore(window: &WebviewWindow) {
    let app = window.app_handle();
    let areas: Vec<Area> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let a = m.work_area();
            (a.position.x, a.position.y, a.size.width, a.size.height)
        })
        .collect();

    let saved = load(app).and_then(|b| home_area(&b, &areas).map(|area| (b, area)));
    if let Some((saved, area)) = saved {
        // Never larger than that screen: a resolution or scaling change since
        // the last run must not leave the bottom edge out of reach.
        let chrome = match (window.outer_size(), window.inner_size()) {
            (Ok(o), Ok(i)) => (o.width.saturating_sub(i.width), o.height.saturating_sub(i.height)),
            _ => (0, 0),
        };
        let (w, h) = fit_inner((saved.width, saved.height), chrome, (area.2, area.3));
        let saved = Bounds { width: w, height: h, ..saved };
        let _ = window.set_size(PhysicalSize::new(saved.width, saved.height));
        let _ = window.set_position(PhysicalPosition::new(saved.x, saved.y));
        if saved.maximized {
            let _ = window.maximize();
        }
        remember_bounds(app, saved);
        return;
    }
    fit_to_screen(window);
}

/// Shrink the window to its monitor's work area if needed, and centre it.
fn fit_to_screen(window: &WebviewWindow) {
    let (Ok(Some(monitor)), Ok(inner), Ok(outer)) =
        (window.current_monitor(), window.inner_size(), window.outer_size())
    else {
        return;
    };
    let area = monitor.work_area().size;
    let chrome = (
        outer.width.saturating_sub(inner.width),
        outer.height.saturating_sub(inner.height),
    );
    let (w, h) = fit_inner((inner.width, inner.height), chrome, (area.width, area.height));
    if (w, h) != (inner.width, inner.height) {
        let _ = window.set_size(PhysicalSize::new(w, h));
    }
    let _ = window.center();
}

fn remember_bounds(app: &AppHandle, bounds: Bounds) {
    if let Some(memory) = app.try_state::<WindowMemory>() {
        if let Ok(mut h) = memory.0.lock() {
            if h[0] != Some(bounds) {
                h[1] = h[0];
                h[0] = Some(bounds);
            }
        }
    }
}

/// The window's current normal bounds, or None while it is maximised or minimised.
fn normal_bounds(window: &tauri::Window) -> Option<Bounds> {
    if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return None;
    }
    let (pos, size) = (window.outer_position().ok()?, window.inner_size().ok()?);
    Some(Bounds { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized: false })
}

/// On every move or resize. A maximised or minimised window keeps the last
/// normal place, so restoring it later still has somewhere sensible to go.
pub fn track(window: &tauri::Window) {
    if let Some(b) = normal_bounds(window) {
        remember_bounds(window.app_handle(), b);
    }
}

/// When the main window closes: its current place, or the last normal place
/// if it is maximised (so un-maximising next time goes somewhere sensible).
/// Best effort: failing to save only means the next launch opens at the
/// default size.
pub fn save(window: &tauri::Window) {
    let app = window.app_handle();
    let history = app
        .try_state::<WindowMemory>()
        .and_then(|m| m.0.lock().ok().map(|h| *h))
        .unwrap_or([None, None]);
    let maximized = window.is_maximized().unwrap_or(false);
    let size = window.inner_size().map(|s| (s.width, s.height)).unwrap_or((0, 0));
    let bounds = match normal_bounds(window) {
        Some(b) => b,
        None => match normal_place(history, if maximized { size } else { (0, 0) }) {
            Some(b) => Bounds { maximized, ..b },
            None => return,
        },
    };
    let Some(path) = file(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(&bounds) {
        let _ = std::fs::write(path, text);
    }
}

#[cfg(test)]
mod tests {
    use super::{fit_inner, home_area, normal_place, Bounds};

    #[test]
    fn maximising_restores_to_the_place_before_it() {
        let normal = Bounds { x: 300, y: 120, width: 1384, height: 961, maximized: false };
        let transition = Bounds { x: -8, y: -8, width: 3840, height: 2089, maximized: false };
        assert_eq!(normal_place([Some(transition), Some(normal)], (3840, 2089)), Some(normal));
        // Without that transition move the newest is right.
        assert_eq!(normal_place([Some(normal), None], (3840, 2089)), Some(normal));
        assert_eq!(normal_place([None, None], (3840, 2089)), None);
    }

    #[test]
    fn a_window_that_fits_is_left_alone() {
        // 1920x1080 at 100%, taskbar 48: 1200x900 plus chrome fits.
        assert_eq!(fit_inner((1200, 900), (16, 39), (1920, 1032)), (1200, 900));
    }

    #[test]
    fn a_window_taller_than_the_screen_is_shrunk_to_it() {
        // 1080p at 125%: 1200x900 logical is 1500x1125 physical.
        assert_eq!(fit_inner((1500, 1125), (20, 49), (1920, 1032)), (1500, 1032 - 49 - 32));
        // A small laptop: both directions.
        assert_eq!(fit_inner((1500, 1125), (20, 49), (1366, 728)), (1366 - 20 - 32, 728 - 49 - 32));
    }

    #[test]
    fn never_zero() {
        assert_eq!(fit_inner((1200, 900), (16, 39), (10, 10)), (1, 1));
    }

    const B: Bounds = Bounds { x: 100, y: 80, width: 1200, height: 900, maximized: false };

    #[test]
    fn a_saved_place_on_a_screen_is_used() {
        assert!(home_area(&B, &[(0, 0, 1920, 1032)]).is_some());
        // On a second monitor to the left.
        let left = Bounds { x: -1800, ..B };
        assert!(home_area(&left, &[(0, 0, 1920, 1032), (-1920, 0, 1920, 1032)]).is_some());
    }

    #[test]
    fn a_saved_place_off_every_screen_is_not() {
        // That monitor has been unplugged.
        let left = Bounds { x: -1800, ..B };
        assert!(home_area(&left, &[(0, 0, 1920, 1032)]).is_none());
        // Title bar above the top of the screen.
        assert!(home_area(&Bounds { y: -200, ..B }, &[(0, 0, 1920, 1032)]).is_none());
        // Windows' minimised placeholder position.
        assert!(home_area(&Bounds { x: -32000, y: -32000, ..B }, &[(0, 0, 1920, 1032)]).is_none());
        // Nonsense size.
        assert!(home_area(&Bounds { width: 10, ..B }, &[(0, 0, 1920, 1032)]).is_none());
        assert!(home_area(&B, &[]).is_none());
    }
}
