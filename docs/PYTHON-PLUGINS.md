# Python plugins

Status: **working prototype.** Off by default. Runs community Python plugins
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

**The plugin window.** Each plugin's `plugin_app` frame is stacked in one
window, styled with the app's dark palette. Closing the window hides it. The
Plugins page has "Show plugin window" and "Plugin settings".

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

## Python

The host looks for, in order:

1. A Python bundled with the app (`resources/python/python.exe`). **Not shipped
   yet**, see below.
2. The `py` launcher (`C:\Windows\py.exe -3`).
3. `python.exe` on `PATH`, skipping the Microsoft Store alias in `WindowsApps`,
   which opens the Store instead of running Python.

### Not done yet: a bundled Python

Plugins assume the libraries a host normally ships with, most importantly
`requests`. SpanshRouter fails to load without it:
`ModuleNotFoundError: No module named 'requests'`. A standard Python install does
not have it.

The fix is to ship a Python runtime with tkinter and the usual libraries
(`requests` and its dependencies) inside the app. Until then, a commander can
install the library themselves with `py -3 -m pip install requests`.

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
| SpanshRouter | Imports resolve; stops at `requests`, see above |

Tests: `npm run test:plugin-host --workspace @edfm/desktop`, which runs
`plugin-host/tests/test_host.py` with real journal lines.
