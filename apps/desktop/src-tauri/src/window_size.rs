//! The main window's opening size.
//!
//! `tauri.conf.json` asks for a window tall enough to show the whole Dashboard
//! (1200 x 900 logical; measured with real content it needs about 880). On a
//! screen with less room than that -- a laptop, or 1080p at 125% scaling -- the
//! window would open taller than the screen with its bottom edge and title bar
//! controls out of reach. So at startup it is shrunk, if it has to be, to fit
//! the monitor's work area (the screen minus the taskbar), then centred.

use tauri::{PhysicalSize, WebviewWindow};

/// Room left between the window and the edge of the work area, in physical pixels.
const MARGIN: u32 = 16;

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

/// Shrink the window to its monitor's work area if needed, and centre it.
///
/// Best effort: if the monitor cannot be read the window keeps its configured size.
pub fn fit_to_screen(window: &WebviewWindow) {
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

#[cfg(test)]
mod tests {
    use super::fit_inner;

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
}
