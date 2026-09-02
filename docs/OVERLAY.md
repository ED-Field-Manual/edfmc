# Overlay

**Design only — this is Phase 2.** Recorded now because the Phase 0 brief asked for
overlay technique research before implementation.

## Hard constraints

From §31, these are not negotiable and not subject to "but it would work better if":

- No DLL injection into `EliteDangerous64.exe`.
- No code injection of any kind.
- No process memory reading or writing.
- No input automation, no botting.

The Companion is a read-only observer with an external window. Every overlay decision
below follows from that.

## Approach

A separate Tauri window, distinct from the main window:

| Property | Value |
|---|---|
| `transparent` | true |
| `decorations` | false |
| `alwaysOnTop` | true |
| `skipTaskbar` | true |
| `focus` | false |
| Click-through | `set_ignore_cursor_events(true)` in normal mode, `false` in edit mode |

Position is tracked against the Elite Dangerous window via Win32, so the overlay
follows the game as it moves and resizes. DPI is handled per-monitor: a window
dragged between displays of different scaling must not shift or blur.

## The exclusive-fullscreen limitation

**We expect this not to work, and we will not claim otherwise until it is
demonstrated on real hardware.**

A DirectX application in true exclusive fullscreen owns the display's swapchain. The
desktop compositor is bypassed, so a normal layered top-most window has nothing to
compose onto. The techniques that *do* draw over exclusive fullscreen all work by
hooking or injecting into the game's present path — precisely what §31 forbids.

Therefore:

- **Borderless / windowed:** expected to work. This is the supported configuration.
- **Exclusive fullscreen:** expected not to work.

The application will detect the situation and tell the user plainly, recommending
Borderless, rather than rendering an invisible overlay and leaving them to guess.
§7 asks for exactly this: communicate the limitation instead of overpromising.

This claim is stated as an expectation because it has not yet been empirically tested
against Elite Dangerous on this hardware. That test is the first task of Phase 2, and
this document gets updated with the measured result either way.

## Licensing

EDMCOverlay and EDMC Modern Overlay are GPL-licensed. We have not read or copied
their source. If we ever want to study their behaviour, that is an intentional
licensing decision to be made deliberately, not by accident during implementation.

## Edit mode

Two modes, one window:

- **Normal:** click-through. Mouse input passes to the game; the overlay cannot
  be interacted with and cannot steal focus.
- **Edit:** accepts mouse input. Widgets become draggable and resizable, with layouts
  persisted to `overlay_layouts` in local SQLite.

## Widgets

Phase 2 builds the overlay *engine* plus exactly one trivial widget (Current
Context), to prove positioning, DPI, click-through and edit mode. Building eight
widgets against an unproven engine would mean rewriting eight widgets.

Planned afterwards, in rough priority order: Current Context, Mission Next Stop,
Mission Summary, Settlement Info, Research Session, Colonisation Needs, Market
Destination, Notifications.

## Performance

The overlay redraws only when the underlying state actually changes, or when an
animation genuinely requires a frame. It must not run a render loop. This matters
more here than anywhere else in the application: the overlay is, by definition,
always running while a game is running (§30).
