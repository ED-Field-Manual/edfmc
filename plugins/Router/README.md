# Router

Plot a neutron-star route with [Spansh](https://www.spansh.co.uk/plotter) and
follow it waypoint by waypoint, without leaving the game.

A plugin for Elite Dangerous companion apps. It runs unchanged in
**EDMC** (Elite Dangerous Market Connector) and in **EDFM Companion**. In EDFM
Companion it also shows the next jump in the game overlay.

*Router is a working name.*

## What it does

- **Plot a route** from your current system to anywhere. "From" is filled in
  with the system you are in as soon as the plugin starts, and keeps following
  you until you type a different start. Your jump range comes from your ship's
  loadout.
- **Spansh's options:** stops on the way ("via" systems, in order), route
  efficiency, and the neutron supercharge: normal (4×) or overcharged (6×) for
  Caspian / SCO drives. Swap From and To in one click.
- **Every waypoint as a card** (EDFM Companion): visited ones dimmed, the next
  one marked, each with Copy and Set as next.
- **Predictive text** on both system boxes: start typing and matching system
  names from Spansh appear underneath. Use the arrow keys and Enter, or click
  one.
- **Follow it.** The next waypoint is shown with your progress and jumps left,
  and it is copied to the clipboard each time you arrive, ready to paste into
  the galaxy map.
- **Skip ahead safely.** If you reach a later waypoint than expected, the route
  catches up.
- **Remembers the route** between sessions.
- **Imports** a route exported from Spansh as CSV.
- **EDFM Companion only:** the overlay's Route widget shows the next system,
  jumps left and destination over the game.

## Normal jumps (exact plotter)

Choose **Normal jumps** to route without relying on neutron stars, using
Spansh's exact plotter. Router reads your ship from the game's own `Loadout`:
the drive's stock figures, replaced by the engineered values the game reports,
plus your tanks and mass. Before plotting, it checks those figures reproduce
the jump range the game states for the ship, and refuses to route if they
don't. Every jump is listed with its distance, and planned refuel stops are
marked. Options: routing strategy, cargo, fuel reserve, search time, refuel at
every scoopable star, avoid secondary stars, neutron boosts, injections.

Drive figures (`router_core/data/fsd.json`) are Frontier Developments' game
data, as compiled by the Coriolis project
([EDCD/coriolis-data](https://github.com/EDCD/coriolis-data)) and used under
Frontier's terms. They are the same figures Spansh uses.
`tools/build_fsd_data.py` rebuilds the file from a pinned commit.

**Any of your ships.** Router reads every ship you own from your journals, not
just the one you are in: each ship's last `Loadout` (from the last time you
flew it), with the shipyard's stored-ships list deciding what you still own, so
sold ships drop out. Pick a ship and both plotters use it: the exact plotter
plans with its drive and tanks, and the neutron plotter takes its range and
supercharge. A ship not flown since your journals began has no figures yet;
board it once.

Normal jumps are available in EDFM Companion. In EDMC, Router plots neutron
routes.

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

## Looks

In EDFM Companion, Router's tab is drawn by the app itself (a native page),
so it looks and behaves like every other page and moves with the window. In
EDMC, Router draws its own panel, coloured by EDMC's theme (default, dark or
transparent) as with any plugin.

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
