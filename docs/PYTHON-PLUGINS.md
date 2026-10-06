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

**The Plugin panels tab.** Each plugin's `plugin_app` frame is stacked in one
tkinter window, styled with the app's dark palette, and that window lives
*inside* the app on the Plugin panels tab:

1. The host starts its window undecorated and off-screen (`EDFMC_EMBED=1`), then
   reports the window's handle (`{"type":"window","hwnd":...}`).
2. The tab leaves an empty area and reports its rectangle in physical pixels
   (`plugin_panel_place`). On the first call, `plugin_host.rs` makes the plugin
   window a child of the app window (`WS_CHILD`, `SetParent`). After that it
   just moves it over the area. Leaving the tab hides it.
3. The host is per-monitor DPI aware, so the panels are drawn at the screen's
   real resolution and match the area's size exactly.

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
