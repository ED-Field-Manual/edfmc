# Python plugins

Status: **working.** Runs community Python plugins
written for the standard companion-tool plugin interface: a folder holding a
`load.py` that defines `plugin_start3`, `journal_entry` and so on.

These are separate from the declarative plugins in [PLUGINS.md](PLUGINS.md).
Those are data that the app validates and cannot run. These are programs.

## Why this exists

Commanders already rely on Python plugins, such as route planners and
construction trackers. A commander who uses the Companion as their only tool
should not have to give those up. Plugin authors should not have to rewrite
anything either: a plugin folder that works with other tools should work here
unchanged.

## The trade, stated plainly

**A Python plugin runs with the commander's full permissions.** It can read and
change their files, use the network and start programs. This reverses the "data,
never code" rule that PLUGINS.md is built on, so it is done in a way that keeps
the reversal visible:

- **Runs what the commander installed, and nothing else.** There is no global
  switch. A Python plugin runs because the commander put its folder in the
  plugins folder, the same choice other plugin hosts treat as consent. Each
  plugin can be switched off on its own card. The Plugins page states plainly,
  without alarm, that a plugin has the same access as any program the
  commander installs. An earlier build had an "I understand" switch, off by
  default, with a boxed warning. It was removed at the user's request because
  it read as alarmist, and other hosts have no such gate.
- **Checksums do not vet plugins.** The bundled Python runtime and its
  libraries are pinned to their publishers' SHA-256 hashes, which proves they
  are exactly what was released. A plugin has no publisher hash to check
  against, and a harmful plugin with a correct hash would still be harmful. The
  only protection against a bad plugin is installing plugins from sources you
  trust.
- **A separate process.** Plugins run in `plugin-host/host.py`, never inside the
  app. A plugin that crashes, hangs or leaks memory takes down only the host.
- **One plugins folder.** `Documents\EDFMC\plugins`, shared with declarative
  plugins, so everything the app keeps is under `Documents\EDFMC`. A
  folder with a `load.py` is a Python plugin and one with a `plugin.json` is a
  declarative plugin. Each loader skips the other kind, so the two cannot be
  mistaken for each other. The first build put Python plugins in app data, and
  anything placed there is moved over once.
- **Read-only toward the game.** The host reads the journal folder and nothing
  else of the game's. It writes nothing there.

## How it works

```
App (Tauri)                         plugin-host/host.py (Python, own process)
  plugin_host.rs  -- spawn -->        loads every <folder>/load.py
                  <-- stdout JSON --  {"type":"status", "plugins":[...]}
                  -- stdin JSON -->   {"type":"show"|"settings"|"quit"}
                                      tails Journal.*.log and Status.json itself
```

**The host reads the journal itself.** It does not use the app's events. On
start it reads the newest journal to learn the current state, such as the
commander, system, station and cargo, without delivering any of it to plugins.
After that it delivers each new line as the game writes it. This matches what
plugins expect. The app's own catch-up replays history, and a plugin given those
replayed events would act on things that already happened.

**Hooks called:** `plugin_start3`, `plugin_app`, `plugin_prefs`,
`prefs_changed`, `journal_entry`, `dashboard_entry` (from `Status.json`) and
`plugin_stop`. A string returned from `journal_entry` is shown in the plugin
window's status line.

**Modules provided** (in `plugin-host/compat/`): `config`, `monitor`, `theme`,
`myNotebook`, `l10n`, `EDMCLogging`, `ttkHyperlink` and `plug`. These are
written for this app, not copied. Copying another tool's modules would bring
that tool's licence with them, and this project is MIT. Matching the names and
behaviour plugins call is enough for compatibility.

**A tab per plugin.** Every running plugin that has a panel (`plugin_app`) gets
its own tab in the sidebar, indented under Plugins. Each panel is its own
tkinter window, styled with the app's dark palette and pinned over its tab:

1. The host creates each panel window undecorated and hidden (`EDFMC_EMBED=1`).
2. A plugin's tab leaves an empty area and reports its rectangle in physical
   pixels relative to the client area (`plugin_panel_place`). `plugin_host.rs`
   turns that into screen coordinates and adds the app window's handle.
3. The host makes the app window the panel's **owner** (`GWLP_HWNDPARENT`) and
   positions it through Tk's own geometry. An owned window stays above its
   owner and hides when the owner is minimised. Leaving the tab hides it.
4. When the app window moves or resizes, `plugin_host.rs` re-sends the showing
   panel's position, so the panel follows.
5. The host is per-monitor DPI aware, so panels are drawn at the screen's real
   resolution and match the area's size exactly.

**Why owned and not a child window.** Two earlier versions made the panel a
*child* of the app window. The first moved it from outside, and Tk put it back
off-screen. The second placed it through Tk, and it showed, once the app's web
view was given `WS_CLIPSIBLINGS` so it stopped painting over the panel. But Tk
then crashed, an access violation inside `tk86t.dll` caught by faulthandler in
Tk's own event loop, as soon as the panel was clicked. Tk's window handling
assumes a Tk top-level's parent is the desktop or another Tk window. As an owned
top-level, it is what Tk expects. Checked against a stand-in owner window: 15 of
SpanshRouter's widgets, including Plot route, were sent mouse-activate and click
messages and the host stayed up. The panel then followed a move of the owner and
hid on request.

Why not draw the panels in the page itself: plugins build them with tkinter,
which draws real native widgets, and a web page cannot contain those. Rewriting
each plugin's interface in HTML would break the point of running plugins
unchanged.

Two things were tried and rejected. Tk's own embedding (`tk.Tk(use=hwnd)`) hangs
when the container is not itself a Tk window, because Tk waits for a reply only
another Tk would send. A separate floating window worked, but it was a second
window to manage, and commanders asked for a tab.

The cost: nothing drawn by the page can appear on top of that area. A dialog
opened while the tab is showing would sit behind the panels, so the tab holds
nothing else. A plugin's own settings and pop-ups still open as small windows of
their own.

**Imports.** Both the plugins folder and each plugin's own folder go on
`sys.path`. The second is needed: SpanshRouter's `load.py` imports
`SpanshRouter.SpanshRouter`, which has to resolve to the package *inside* its
folder. With only the plugins folder on the path, the import resolved to the
outer folder and failed.

**Plugin output** (`print`, uncaught errors) goes to
`python-host/plugin-host.log`. stdout is reserved for the protocol, so a stray
`print` cannot corrupt it.

**Restarting.** Every message from the host carries its process id, and the app
ignores messages from any process but the one it last started. Without this,
after a restart the old process's exit arrived while the new one was running and
was reported as "Plugins stopped unexpectedly".

**Stopping.** The host is asked to quit, which lets plugins save in
`plugin_stop`, and is killed after five seconds if it has not exited. Closing the
app does the same, and the host also quits on its own if the app's end of stdin
closes.

## Plugin cards

Each Python plugin gets its own card on the Plugins page, below the Python
plugins switch, laid out like a declarative plugin's card. The host reports for
each folder:

- **Name**, from `plugin_start3`'s return value.
- **Version**, from `plugin_version` or `__version__` in `load.py`, or a bare
  version string in `version.json` beside it (SpanshRouter does this). If the
  plugin states none, the card says "Version not stated". Nothing is guessed.
- **Status**: running, switched off, or could not start, with the reason.
- Whether it adds a **panel** (`plugin_app`) and has **settings** (`plugin_prefs`).
- Its **README**, behind "How to use this", shown as plain text and capped at
  64 KB.

**The per-plugin switch** stores switched-off folder names in the
`pythonPlugins.disabled` setting and restarts the host. The host still lists a
switched-off plugin, so its card stays, but never imports it. A plugin that is
off runs no code at all. Restarting is the only reliable way to turn a plugin
off, because Python cannot un-import a plugin that has already run.

Cards appear while the host is running, since it is the host that reads the
plugin folders.

## The `edfmc` module: extras only EDFM Companion offers

Besides the standard modules, the host provides `edfmc` (`compat/edfmc.py`). It
exists only here, so a plugin imports it in a `try`/`except ImportError` and runs
unchanged in other hosts.

`edfmc.publish(topic, data)` hands the app a piece of plain JSON. A value that is
not plain JSON raises an error in the plugin, before anything is sent. The app
understands one topic:

| Topic | Shown as | Shape |
|---|---|---|
| `route` | The overlay's Route widget (`docs/OVERLAY.md`) | `next`, `nextIsNeutron`, `destination`, `jumpsLeft`, `waypoint`, `waypoints`, `finished`; or `None` to clear |

Unknown topics are ignored. Nothing published leaves the machine. The host sends
it to the app as `{"type":"publish","topic":...,"data":...}`, and the app checks
every field before using it.

## Native pages: tabs the app draws

A tkinter panel can only be a separate window pinned over its tab, so it lags
when the app window moves and sits above anything the page shows. A plugin
written for EDFM Companion can avoid that by asking the app to draw its tab:

```python
import edfmc                                  # in try/except ImportError

def plugin_start3(plugin_dir):
    global page
    page = edfmc.register_page(on_action)     # only valid here
    page.update({'kind': 'router-v1', ...})   # plain JSON, whenever state changes
    return 'Router'

def on_action(name, args):                    # the commander's input, main thread
    ...
```

- A plugin that registers a page gets **no tkinter panel**, and its
  `plugin_app` is not called. Its status reports `native: true`, and its tab
  shows the app's page.
- The host sends `{"type":"page","folder":...,"state":...}` to the app. The app
  sends input back as `plugin_host_action`, which reaches the plugin as
  `{"type":"action","folder":...,"action":...,"args":{...}}` →
  `on_action(name, args)`.
- The app draws only the page **kinds** it knows (`NativePluginPage.tsx`). An
  unknown kind shows a short "needs a newer version" note. Every field is
  checked before use.
- In other hosts `edfmc` does not exist, so the same plugin draws its own panel
  as usual. Router does exactly this: a native page in EDFM Companion, a
  tkinter panel in EDMC.

**Workers must not call tkinter, not even `after`.** Tk refuses calls from
other threads ("main thread is not in main loop"). Router's workers only put
results on a queue, and a poll scheduled from the main thread drains it.

## Update checks

Each Python plugin's card shows whether GitHub has a newer version
(`src/lib/pluginUpdates.ts`). The check is notify-only and nothing is
downloaded into the plugin folder, because replacing a plugin's folder would also
replace data it keeps there. ConstructionTracker keeps its construction sites
there.

**Which repository.** Tried in order:

1. A link the commander pasted on the card. Used when nothing else finds one.
2. The `origin` in the plugin's `.git/config`, if it was installed with `git clone`.
3. EDMC's wiki "Plugins" page, the community index, matched by link text or
   repository name. This is how SpanshRouter resolves, to `norohind/EDMC_SpanshRouter`.
4. A GitHub link in the plugin's README, but only one whose repository name
   matches the plugin. READMEs link EDMC and other tools too, so an unrelated
   link is never taken. ConstructionTracker's README links only EDMC, so it needs
   a pasted link (`Greybaer/EDMC-ConstructionTracker`).

Names are compared case-insensitively, without punctuation or a leading `EDMC`,
so `EDMC_SpanshRouter`, `SpanshRouter` and `EDMC-ConstructionTracker` /
`Construction Tracker` match.

**Which version.** The latest GitHub release if there is one. Otherwise the
version the plugin states on its default branch: a `version.json` (bare text or
`{"version": ...}`), or `plugin_version`/`__version__` in `load.py`. Either file
is found anywhere in the repository via the git tree, shallowest first. Neither of
the commander's plugins publishes releases, and ConstructionTracker's repo keeps
`load.py` one folder deeper than it installs.

**Results.** *Update available*, *Up to date*, *newer than GitHub* (the
commander's ConstructionTracker is 1.4.0 against GitHub's 1.3.0 because it was
changed locally, and it is not reported as out of date), or *unknown* with the
reason. Versions are compared numerically, part by part. A scheme that is not
dotted numbers is reported as unknown rather than ordered by guesswork.

**When.** At most once a day, once the plugin host has reported what is installed,
plus a "Check for updates" button. Results are stored in the
`pythonPlugins.updates` setting, so a restart does not ask GitHub again. GitHub
allows 60 unauthenticated requests an hour, and a check costs at most four per
plugin plus one for the index. The setting is on by default and can be turned off
on the Plugins page. See `docs/PRIVACY.md`.

Checked live on 2026-10-06: SpanshRouter resolved through the index and was up
to date (3.1.0 from `version.json`). ConstructionTracker was unknown until its
link was pasted, then reported as newer than GitHub (1.4.0 against 1.3.0 from
`load.py`).

## Python

**A Python runtime ships with the app**, at `resources/python/`, and is always
preferred. Plugins assume the libraries a plugin host normally provides, most
importantly `requests`, and a standard Python install lacks them. SpanshRouter
failed with `ModuleNotFoundError: No module named 'requests'` until this was
bundled.

What is bundled:

| Component | Version | Source |
|---|---|---|
| CPython, with tkinter 8.6 | 3.13.16 | Astral's python-build-standalone, release 20261003, `install_only_stripped` |
| requests | 2.34.2 | PyPI |
| urllib3 | 2.8.0 | PyPI |
| idna | 3.20 | PyPI |
| certifi | 2026.7.22 | PyPI |
| charset-normalizer | 3.5.2 (cp313, win_amd64) | PyPI |

`scripts/fetch-python-runtime.mjs` fetches these. Every file is pinned by exact
name and SHA-256, taken from the publisher (GitHub's release digest, PyPI's
`digests.sha256`). A download that does not match is deleted and nothing is
unpacked. The script also drops what plugins do not need (headers, import
libraries, pip, IDLE), which brings the runtime to about 51 MB. Before it reports
success, it checks that `tkinter` and `requests` import.

`tauri.conf.json` runs the script before every build, and the runtime is cached,
so later builds skip the download. The `python/` folder is gitignored. To
upgrade a component, change its pin and its hash in the script.

If the bundled runtime is missing, for example in a development checkout that
never ran the script, the host falls back to the `py` launcher and then to
`python.exe` on `PATH`. It skips the Microsoft Store alias in `WindowsApps`,
which opens the Store instead of running Python.

### Not supported

- **Frontier account data** (`cmdr_data`, `capi_fleetcarrier`). This needs a
  Frontier login, which the app does not have yet. Plugins that define these
  hooks still load; the hooks are simply never called.
- **Python 2 era plugins** that define only `plugin_start`. These are refused
  with that reason, not loaded half-working.

## Tested against

| Plugin | Result |
|---|---|
| ConstructionTracker 1.4.0 | Loads, reads the journal folder and carrier cargo, saves its data on stop |
| SpanshRouter 3.1.0 | Loads with the bundled runtime |

Tests: `npm run test:plugin-host --workspace @edfm/desktop`, which runs
`plugin-host/tests/test_host.py` with real journal lines.
