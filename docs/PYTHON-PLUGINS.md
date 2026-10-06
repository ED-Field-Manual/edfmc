# Python plugins

Status: **working.** Off by default. Runs community Python plugins
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

- **Off until switched on.** The Plugins page shows the warning above the switch
  and keeps showing it while the switch is on. It is not a dialog that gets
  clicked through once and forgotten.
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
its own tab in the sidebar, indented under Plugins. Each panel is its own tkinter
window, styled with the app's dark palette, and lives *inside* the app:

1. The host creates each panel window undecorated and hidden (`EDFMC_EMBED=1`).
2. A plugin's tab leaves an empty area and reports its rectangle in physical
   pixels (`plugin_panel_place`). `plugin_host.rs` adds the app window's handle
   and passes it to the host as `{"type":"place", ...}`.
3. The host makes the panel window a child of the app window (`WS_CHILD`,
   `SetParent`), then positions it **through Tk's own geometry**. Leaving the tab
   hides it.
4. The host is per-monitor DPI aware, so panels are drawn at the screen's real
   resolution and match the area's size exactly.

The host moves the window, not the app, because of the first version's bug. The
app moved the window from outside with `SetWindowPos`, and Tk, which keeps its
own record of where its windows are, put it straight back off-screen. The tab
showed an empty area. Placing through Tk keeps the two in agreement. This was
checked against a stand-in parent window: the panel appeared at the requested
size with all of the plugin's widgets inside, stayed there, and hid on request.

**The web view has to be clipped.** The panel did end up above the app's web
view, at the right place, and the tab still looked empty. The web view is a
sibling window covering the whole client area, and it was created without
`WS_CLIPSIBLINGS`, so it painted over the panel regardless of z-order. When the
host makes a panel a child of the app window, it adds `WS_CLIPSIBLINGS` to the
panel and to the app window's other direct children.

**Commands never stop the loop.** Each command from the app is handled on its
own, and the next poll is always scheduled. In an earlier build, one failing
command (Plugin settings, see below) ended the loop for good. Every later
command, including "hide this panel", was ignored, and a panel stayed on top of
every other tab. Journal delivery is protected the same way.

**Settings pages get the notebook.** `plugin_prefs` is called with the settings
notebook itself, and the frame it returns becomes the tab. ConstructionTracker
builds `nb.Frame(parent)` and returns it. When it was handed a page inside the
notebook instead, the notebook refused to add a grandchild as a tab.

**Every plugin has a tab.** Declarative plugins, and Python plugins with no panel
or that did not start, get a tab too. It shows the plugin's card instead of a
panel.

**Closing the app** waits, off the main thread, for plugins to save before
exiting. The app's message loop has to keep running while the host closes,
because its panels are child windows of the app window. Blocking the main thread
stalled the host until the five-second kill.

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
