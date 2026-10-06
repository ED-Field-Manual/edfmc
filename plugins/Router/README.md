# Router

Plot a neutron-star route with [Spansh](https://www.spansh.co.uk/plotter) and
follow it waypoint by waypoint, without leaving the game.

A plugin for Elite Dangerous companion apps. It runs unchanged in
**EDMC** (Elite Dangerous Market Connector) and in **EDFM Companion**. In EDFM
Companion it also shows the next jump in the game overlay.

*Router is a working name.*

## What it does

- **Plot a route** from your current system to anywhere. Your jump range is
  filled in from your ship's loadout.
- **Follow it.** The next waypoint is shown with your progress and jumps left,
  and it is copied to the clipboard each time you arrive, ready to paste into
  the galaxy map.
- **Skip ahead safely.** If you reach a later waypoint than expected, the route
  catches up.
- **Remembers the route** between sessions.
- **Imports** a route exported from Spansh as CSV.
- **EDFM Companion only:** the overlay's Route widget shows the next system,
  jumps left and destination over the game.

## Install

1. Download this repository as a ZIP (Code → Download ZIP) and unzip it.
2. Put the folder in your plugins folder:
   - **EDMC:** File → Settings → Plugins → Open.
   - **EDFM Companion:** Plugins → Open plugins folder (`Documents\EDFMC\plugins`).
3. Restart EDMC, or press Reload plugins in EDFM Companion.

No extra libraries are needed. Router uses only Python's standard library.

## Settings

In the host's settings, on the Router tab:

- **Copy the next waypoint automatically** (on by default).
- **Route efficiency** (1–100, default 60): higher stays closer to a straight
  line, lower allows longer detours to neutron stars.

## How it works

- Routes come from Spansh's public route API. A plot is a job that is submitted
  and then polled, on a background thread so the window never freezes.
- Arrival is matched on the system's address (`SystemAddress`) when the route
  has it, and on the name otherwise, for imported routes.
- Your route is saved as `route.json` in the plugin's folder.

## Development

```
python tests/test_router.py
```

`tests/fixtures/spansh_sol_achenar.json` is a real Spansh response.

## License

MIT. See [LICENSE](LICENSE).
