# Plugins

This directory currently contains standalone plugins that are co-located with the
core application source. They are distributable plugin projects, not EDFM
Companion core features, and are intended to move to separate repositories under
the `ED-Field-Manual` organization.

Each folder is a complete plugin that can be copied into a plugins folder as it
is. Keeping the implementation here for now does not make it part of the core
application.

| Plugin | Kind | Runs in |
|---|---|---|
| [Router](Router) | Python (`load.py`) | EDFM Companion and EDMC |

## Installing one

Copy the plugin's folder into:

- **EDFM Companion:** `Documents\EDFMC\plugins` (Plugins → Open plugins folder),
  then press Reload plugins.
- **EDMC:** File → Settings → Plugins → Open, then restart EDMC.

## Writing one

Python plugins use the standard interface (`plugin_start3`, `journal_entry`,
`plugin_app` and so on), so one plugin runs in both apps. Features only EDFM
Companion offers come from its `edfmc` module. Import it in a
`try`/`except ImportError` so the plugin still runs unchanged in other apps.
See `docs/PYTHON-PLUGINS.md`.

Each plugin keeps its own tests. Run them with `npm run test:plugins`.
