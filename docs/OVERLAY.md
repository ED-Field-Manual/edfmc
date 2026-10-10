# Overlay

**Built.** This began as a design note, recorded because the brief asked for
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
| Click-through | `set_ignore_cursor_events(true)` in normal mode, `false` in Arrange mode |

Position is tracked against the Elite Dangerous window via Win32, so the overlay
follows the game as it moves and resizes. DPI is handled per-monitor: a window
dragged between displays of different scaling must not shift or blur.

## Detecting the game window (verified against a live client)

Measured against a running Elite Dangerous 4.4.0.3 client:

| Property | Value |
|---|---|
| Window class | `FrontierDevelopmentsAppWinClass` |
| Window title | `Elite - Dangerous (CLIENT)` |
| Process | `EliteDangerous64.exe` |
| Style | `0x94020000` = `WS_POPUP \| WS_VISIBLE \| WS_CLIPSIBLINGS \| WS_MINIMIZEBOX` |
| ExStyle | `0x00000000` |
| Window rect | `0,0 → 3840,2160`, client rect identical |
| Reported DPI | 96 |

We match on the **class name**, not the title: the title is localised, the class is
not. `ExStyle` carries no `WS_EX_TOPMOST`, which is why an always-on-top overlay can
sit above the game at all.

Window rect and client rect being identical, with no caption or thick-frame style,
is the geometric signature of borderless. Positions are handled in **physical
pixels** throughout (Win32 rects and Tauri's `PhysicalPosition`/`PhysicalSize`),
which sidesteps DPI scaling arithmetic entirely rather than trying to get it right.

## Reading the display mode instead of guessing

Elite records its own display mode in
`%LOCALAPPDATA%\Frontier Developments\Elite Dangerous\Options\Graphics\DisplaySettings.xml`:

```xml
<FullScreen>2</FullScreen>
```

This matters because **window geometry cannot distinguish borderless from exclusive
fullscreen** — both cover the monitor exactly. Reading Frontier's own setting answers
the question directly, so the application can warn accurately instead of guessing.

- `2` = **Borderless — confirmed empirically.** Observed alongside the window
  properties in the table above.
- `0` = Windowed and `1` = Fullscreen follow the ordering of Frontier's settings UI
  and are **not yet directly confirmed here**. Unrecognised values degrade to
  "unknown" and say so, rather than being coerced into a guess.

Note that `<ScreenWidth>` in the same file read `4096` while the actual window was
`3840` wide. **Do not use it for positioning** — the window rect is authoritative.

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
against Elite Dangerous on this hardware. That test was done, and
this document gets updated with the measured result either way.

## Licensing

EDMCOverlay and EDMC Modern Overlay are GPL-licensed. We have not read or copied
their source. If we ever want to study their behaviour, that is an intentional
licensing decision to be made deliberately, not by accident during implementation.

## Arrange mode

Two modes, one window:

- **Normal:** click-through. Mouse input passes to the game; the overlay cannot
  be interacted with and cannot steal focus.
- **Arrange:** accepts mouse input. Widgets can be dragged by any part and
  resized from the grip on their right edge. A pill at the top of the screen
  says so and has a **Done** button; **Esc** also ends it.

The Overlay page starts it with **Arrange widgets**, which is offered only while
the overlay is actually showing over the game (arranging an overlay that is not
on screen is impossible). The button follows the real state: the backend
broadcasts `overlay://edit-mode` whenever it changes, including from Done or Esc
in the overlay and when the overlay is switched off, which also ends it.
Leaving Arrange mode always goes through `overlay_set_edit_mode(false)`, which
restores click-through (`set_ignore_cursor_events(true)`). Switching the overlay
off leaves Arrange mode first, so the window can never be left hidden and
interactive.

### Positions, sizes and where they are kept

A widget's placement is `{x, y, width}` in the overlay window's CSS pixels
(`src/lib/overlayLayout.ts`). `width` is null until the commander resizes it;
height always follows the content. Resizing is limited to 200-720 px.

The layout is stored in the **settings table** (key `overlayLayout`, version 3)
with every other overlay setting, and owned by the main window. It reaches the
overlay with the rest of its pushed state; when the commander moves or resizes
something, the overlay sends the new layout back (`overlay://layout`) once, on
release, and the main window stores it and pushes it back with a new
`layoutRevision`. The overlay applies a pushed layout only when the revision
changes, so an ordinary state push during a drag cannot snap a widget back.

Before this, positions lived in the overlay window's own browser storage
(`localStorage`, key `edfm.overlay.layout.v2`), and this document wrongly said
SQLite (`overlay_layouts`, a table that never existed). The first start of a
build with this change copies that layout into settings, so nobody's
arrangement is lost; the old key is left in place and no longer read.

**Resolution, DPI and monitors.** The overlay window is always the size of the
game window, on whichever monitor the game is on, so positions are relative to
the game, not the desktop. A layout records the window size it was arranged in;
drawn in a window of a different size (another resolution, another monitor,
another DPI scale), positions are scaled to fit and widths are kept.

**Never lost.** However a layout was stored, every widget is drawn with at least
48 px on screen. A corrupt or partial layout falls back to standard positions,
widget by widget. Clamping happens when drawing and is never written back, so a
commander who plays at two resolutions keeps one layout that fits both.

### Reset Layout, presets and saved layouts

- **Reset Layout** puts every widget, plugin widgets included, back in its
  standard position at its natural width. It changes nothing else: which
  widgets are on, their options and appearance stay. It asks first, and is
  offered only when the layout differs from the standard one.
- **Presets** are starting points, not modes. Applying one (after confirming)
  sets which built-in widgets are on, a few of their options, and their
  positions, laid out for the game window's size; everything can be changed
  afterwards. Plugin widgets keep their positions.

  | Preset | On | Notes |
  |---|---|---|
  | Minimal | Current Context, Carrier Jump, Route | Compact route, narrow column |
  | Standard | Context, Missions, Carrier Jump, Route | The shipped arrangement |
  | Detailed | Everything, including Live Journal | Wider panels, 8 missions |

- **Your layouts:** up to ten named snapshots of positions, sizes, which
  built-in widgets are on and their options (setting `overlayProfiles`).
  Switching to one asks first. Saving under an existing name, ignoring case,
  replaces it. Plugin widgets' switches are not part of a saved layout.

## Showing and hiding while playing

An optional global hotkey switches the overlay on and off, the same as the
switch on the Overlay page. It is **unset by default** so it cannot clash with a
commander's game bindings, is chosen like the screenshot hotkey, and is stored
as `overlay.toggleHotkey`. It is bound together with the app's other hotkeys
(screenshot capture, Router's copy-waypoint and copy-carrier-jump), and none of
them may share a combination: picking one that another already has is refused
with which one has it (`src/lib/hotkeys.ts`). A combination the OS will not
give is refused too, and the previous one is kept. The hotkey only starts or
stops EDFMC's own overlay window; it sends nothing to the game.

## The Overlay page

For players, in this order:

1. **The switch**, and **one status line** built from what is observed: the
   game window (found, minimised, focused), Elite's own display-mode setting,
   and whether the overlay window is really on screen (`overlay://runtime`,
   emitted by the tracking thread when visibility changes, and
   `overlay_runtime`). It never says the overlay is showing because the switch
   is on. Examples: *Elite Dangerous offline — Borderless mode supported.*,
   *Elite Dangerous running (Borderless) — overlay showing.*, *... — overlay
   hidden until Elite is the active window.*, *Elite Dangerous running in
   Fullscreen — switch to Borderless to see the overlay.*
   Then **Arrange widgets**, **Reset layout**, and *Hide when Elite isn't the
   active window*.
2. **Widgets:** one list, a row each with a short description, a switch and,
   where a widget has them, options (below). Plugin widgets follow under *From
   plugins*.
3. **Appearance**, with a preview.
4. **Layouts**: presets and saved layouts.
5. **Shortcut**: the show/hide hotkey.

Raw display-mode values, window position and size, monitor size, DPI, focus,
tracking and visibility flags and the layout's reference size moved to the
**Overlay** card on the Diagnostics page. Nothing was removed.

### Widget options

Each one changes what the overlay draws; none is decorative (setting
`overlayWidgetOptions`).

| Widget | Options |
|---|---|
| Missions | Missions listed (1-10, default 5); EDFM notes on mission types |
| Route | Compact (next system and jumps left) or Detailed; waypoint count; destination; which plugin's route, when more than one publishes one |
| Live Journal / Exobiology | Show the newest journal entry when not sampling (off: exobiology only); value and sample distance per organism |

Current Context and Carrier Jump have none.

### Preview

The Appearance section shows the enabled widgets drawn by **the overlay's own
components** (`src/overlay/widgets.tsx`) and stylesheet
(`src/overlay/widgets.css`, every rule scoped under `.overlay-root` so the main
window's styles are untouched), so the preview cannot drift from the overlay.
It uses sample data labelled **Sample data**, with names such as *Sample
Commander* that cannot be mistaken for the commander's own, follows every
appearance setting and widget option, and can be shown over a dark or a bright
scene. It is static: the sample carrier countdown does not tick, so the page
costs nothing while open. Plugin widgets appear as a placeholder, since their
content is the plugin's and live.

## Performance

The overlay redraws only when the underlying state actually changes, or when an
animation genuinely requires a frame. It must not run a render loop. The only
timers are the carrier countdown (1 s, only while a jump is scheduled) and the
Live Journal's fresh-or-collapsed check (1 min). Dragging and resizing update
only while the pointer moves in Arrange mode, and the layout is sent to the
main window once, on release. Window tracking stays at 10 Hz and moves or
shows the window only on a change; visibility changes are announced as events
rather than polled for. With the overlay off, the Overlay page checks for the
game window every 5 s, only while that page is open. This matters
more here than anywhere else in the application: the overlay is, by definition,
always running while a game is running (§30).

## The overlay as a workspace

Independently controlled widgets, not one panel. Each has its own visibility
setting, its own remembered position, and inherits the same appearance.

| Widget | Default | What it answers |
|---|---|---|
| Current Context | on | What is relevant right now |
| Missions | on | What is outstanding |
| Carrier Jump | on | When your carrier leaves |
| Live Journal | **off** | What was just recorded |
| Route | on | The next jump on a route a plugin is following |

`EDFM notes` is deliberately absent from that table: it is a **sub-option of
Missions**, not a panel. It has no position, no frame and nothing to drag, and the
settings UI disables it when Missions is off rather than offering a toggle that
cannot act.

Live Journal is off by default because it is the only widget that does not answer
"what is true now" -- it is the newest thing recorded, which some commanders want
in view and others would immediately switch off.

### Appearance

Two settings, deliberately not one.

```
--overlay-bg-opacity     panel background alpha   0 .. 1     default 0.72
--overlay-text-opacity   text and icon alpha      0.35 .. 1  default 1
```

Set once on the overlay root, so every widget inherits them and a future widget is
styled correctly by doing nothing. One combined "overall opacity" control is the
thing that makes an overlay unreadable: a commander who wants a fainter panel
almost never wants fainter text.

Background may reach fully transparent -- text on bare scenery is a real
preference, and the text keeps its own shadow. **Text may not.** Below roughly a
third it stops being legible over bright scenery, and an overlay the commander
cannot read but has not noticed is worse than one they switched off deliberately.

Verified by measurement across the four extremes: the background changes while
text opacity stays at 1, text changes while the background stays at 0.72, and all
four render at **identical dimensions** -- these are colour properties only, so no
opacity change can move anything.

Two more, both applied to each widget's contents so nothing moves:

```
--overlay-scale          widget size, text included   0.8 .. 1.5  default 1
spacing                  comfortable | compact        compact: less padding and leading
```

Size uses CSS `zoom` on the panel inside each positioned slot, so a widget grows
from its corner and a resized width stays its width on screen at any size. The
bounds keep the smallest labels above roughly 9 px at 1080p and stop one widget
covering a quarter of the screen. Text size is part of Size rather than a
separate control, because changing it alone breaks the widgets' proportions.

The Overlay page's preview uses the same variables and the same components; see
**Preview** above.

### Live Journal lifecycle

The widget shows one of two things, and which one depends on whether the commander
is in the middle of something.

**The exobiology roster, at a surface-scanned body.** Every genus the body
carries, and where the commander got to on each:

```
◆ EXOBIOLOGY

✓ Bacterium Vesicula Gold      3 / 3
◆ Aleoida Coronamus Turquoise  2 / 3
· Concha                    Unscanned

1 of 3 recorded
Wregoe LS-N b51-0 A 7 g
```

When everything is collected the summary says so outright — *All species recorded
here* — which is the other question worth answering on arrival.

An unsampled row shows the **genus only**. A surface scan reports a genus and
nothing finer, so "Concha" is what the game said and "Concha Renibus" would be a
guess. The species and variant appear as soon as the first sample is taken.

**This is persisted.** Leaving the planet, leaving the system or closing the app
does not lose it: progress is stored per commander, per body, per genus, and
reloaded on arrival. A commander pulled away mid-run by their squadron comes back
and sees exactly where they stopped.

**The newest recorded entry, otherwise.** Titled *Field Journal*, with the same
lifecycle as before:

- **Recent** (under five minutes): system, body, the entry, and how many entries
  were recorded at that body.
- **Older**: collapses to `N activities recorded`.

It does not disappear, because an empty panel that used to have content reads as a
bug; and it does not keep asserting something from half an hour ago, which is the
stale-context problem this project has fixed once already.

#### Why the roster takes precedence

Before this, the widget only ever showed the newest *completed* entry — which
during an exobiology run meant "biological signals detected" or "landed". Current
Context already says both, so the panel was spending screen space over a game to
repeat its neighbour.

Where the commander got to on each organism is the thing nothing else on screen
can say, and the thing they cannot reconstruct after being away. So when they are
at a scanned body it wins, and the title follows the content: a panel headed
*Field Journal* showing a sample counter describes itself wrongly.

The precedence is a function — `liveJournalPanel` in `src/lib/overlay.ts` — rather
than a condition inside the markup, so the decision the widget's usefulness
depends on is asserted by tests directly. An empty roster falls through to the
recorded entry, as does an activity `kind` an older overlay does not recognise.

#### The roster does not go stale

Staleness is the wrong model for it. It describes the body the commander is
standing on rather than an event that happened, so it is current for as long as
they are there and disappears when they leave — on `SupercruiseEntry` (which ends
a visit far more often than `LeaveBody`), on `LeaveBody`, or on a jump.

The five-minute collapse still applies to the recorded-entry panel.

#### What it will not claim

When the app is started midway through a run, the stage count cannot be
established: the reader resumes from a byte offset rather than replaying history,
so the first event seen may be the second or the third sample. The row then shows
no number at all, because a wrong `1 / 3` would say two samples remain when one
does. `Analyse` recovers a definite count, being itself proof of three.

`docs/ACTIVITY-JOURNAL.md` has the measurements behind the sequence, the roster
and the reset rules.

### Carrier jump: when a countdown ends

Three signals end a pending jump, because one was not enough.

| Signal | Meaning |
|---|---|
| `CarrierLocation` at the destination | Arrived |
| `CarrierLocation` anywhere, after the departure time | No longer pending |
| `CarrierJump` with a matching MarketID | The commander watched it happen |

The second exists because of a real bug: clearing required an exact match with the
destination, so a squadron carrier that arrived kept reading **DEPARTING**.
Measured over 138 real requests, five reported a *different* system next -- the
carrier had moved on again, or the report came from a later session. Past the
departure time, whatever the carrier says about where it is, it is not still
waiting to leave. Clearing then does not claim it arrived; it stops asserting a
departure that is over.

An unconfirmed departure stops displaying after **ten minutes**. 93% of real jumps
confirm within five minutes of the stated departure (median: zero); past that the
commander is almost certainly offline and confirmation may be hours away, so
continuing to say "Departing" tells them nothing true.

### Route: from a plugin

The Route widget shows what a Python plugin publishes on the `route` topic through
`edfmc.publish` (see `docs/PYTHON-PLUGINS.md`). The widget shows the next system,
in large type and marked if it is a neutron star, then the jumps left, the
waypoint count and the destination. The core application validates and displays
that published state; route planning and clipboard behaviour belong to whichever
separately distributed plugin supplied it.

**Copying from the game.** The overlay ignores the mouse, so it has no Copy
button. Router already copies the next system on every arrival. For the rest,
there is a hotkey on the Router tab to copy the next waypoint, chosen by the
commander and unset by default, like the capture hotkey. It asks the plugin that
owns the route to copy, so the clipboard has a single writer. All of the app's
hotkeys are bound together, because the shortcut plugin's `unregisterAll` would
otherwise drop whichever one was not being changed. The two hotkeys cannot share
a combination.

Routes are kept per plugin, so two route plugins do not overwrite each other. The
widget shows the plugin the commander picks in its options (offered only when
more than one plugin has published a route this session), or otherwise whichever
route changed most recently.

It is on by default because it only appears while a plugin has a route. A
commander without one never sees it. The app checks every published field on
arrival, because the data comes from a plugin: strings are capped, and counts
must be finite and non-negative. The route clears when the plugin host stops.

### Plugin widgets

A plugin can add up to four widgets of its own (`edfmc.register_overlay`, see
docs/PYTHON-PLUGINS.md). The overlay draws them from the same `ui-v1` blocks as
plugin pages, display only, under the plugin's chosen titles, through the same
positioning, resizing, appearance, layouts and reset as built-in widgets: there
is no second overlay system. Each has a switch on the Overlay page (on by
default; the list of those switched *off* is kept, keyed by `folder` or
`folder:id`). A new widget opens in a column to the right of the built-in ones.

Content is validated in the main window (`readUiOverlay`) before it reaches the
overlay; anything that is not a recognised block is dropped, so a plugin cannot
send HTML or script. Each plugin widget renders inside an error boundary: if its
content still cannot be drawn, that widget says so and the rest of the overlay
carries on. A plugin that is switched off, uninstalled or crashes takes its
widgets with it (the host's exit clears them).

Construction Logistics uses one widget for its hauling, delivery and shopping
views. The mechanism is generic and lives in core; what a widget shows is the
plugin's business.

## Guidance in the overlay

New CMDR Mode adds one line of explanation to a context, drawn from the rule's own
`guidance.beginner`. Same facts, same resources -- one extra sentence saying what
the mechanic is. Never an article: EDFM is the reference, and the overlay is over
someone's game.
