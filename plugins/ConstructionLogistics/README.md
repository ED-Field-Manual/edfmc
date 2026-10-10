# Construction Logistics

Track your colonisation construction sites, plan what to haul, find where to
buy it, and see it all in the game overlay.

A plugin for Elite Dangerous companion apps. It runs in **EDFM Companion**,
where the app draws its page and an overlay panel, and in **EDMC**, where it
shows a short summary in EDMC's window.

## What it does

- **Tracks every construction site** you dock at or open the construction
  screen for: name, system, type, progress, and each material's required,
  provided and remaining amounts, straight from the game.
- **Counts what you already have**: your ship's hold, and your fleet carrier's
  cargo, estimated from the transfers the game reports. Correct a carrier count
  by typing over it.
- **Plans a trip**: what to load for the next run, carrier stock first, within
  your hold, by the priorities you set. It also shows what each site will still
  need after you deliver what is aboard.
- **Finds where to buy** what is still needed, from EDFM's market data, with
  each stop's reasons in words: stock, how fresh the data is, distance, price.
  You choose the data age, station type, a safety margin, whether fleet
  carriers count, and whether a stop may exceed your hold.
- **Overlay panel** (EDFM Companion): Hauling in flight, Delivery when docked at
  one of your sites, Shopping when docked anywhere else. Or pin one.
- **Copy or export** what a site still needs, as a list or CSV.

## What it knows, and how sure it is

Every number says where it came from:

| Shown as | Source |
|---|---|
| Required, Provided, progress | The game's depot report (`ColonisationConstructionDepot`), each time you dock or open the screen |
| A delivery | The game confirming it (`ColonisationContribution`) |
| Site name and type | The station name when you dock there; or what you type |
| Ship | Your hold, from the game (`Cargo`, `Cargo.json`) |
| Carrier free space | The game (`CarrierStats`), when you open carrier management |
| Carrier per commodity | **An estimate** from transfers (`CargoTransfer`). The game never lists the whole hold |

Buying something is not delivering it, and a plan is not a delivery: a site's
totals change only when the game confirms a contribution.

## Installing

- **EDFM Companion:** copy the `ConstructionLogistics` folder into
  `Documents\EDFMC\plugins` (Plugins → Open plugins folder), then press Reload
  plugins. It appears under Plugins in the sidebar. Turn its overlay panel on
  or off on the Overlay page.
- **EDMC:** File → Settings → Plugins → Open, copy the folder there, restart.

No packages to install: standard-library Python only.

## Your data

Saved per commander. In EDFM Companion it is in
`Documents\EDFMC\plugin-data\ConstructionLogistics`, outside the plugin folder,
so updating the plugin keeps it. In EDMC it is in the plugin's `data` folder.

The first time it runs for a commander it imports, read-only and once, the
sites from EDFM Companion's old Logistics page. That table is not changed.

## Network

Only "Find where to buy" goes online, to EDFM's market search
(`api.edfieldmanual.com`), sending the commodities still needed and your
current star position. Everything else works offline.

## Tests

From this folder: `python -m unittest discover -s tests`. The sourcing planner
is checked against `tests/golden/planner.json`, which was produced by EDFM
Companion's original TypeScript planner, so the two make the same plans.
