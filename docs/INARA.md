# Inara

EDFM Companion can keep a commander's [Inara](https://inara.cz/) profile up to
date from their journals: ranks, reputation, ships and loadouts, suit loadouts,
materials and cargo, statistics and the flight log. This page is the
engineering record of how, written against Inara's own documentation:

- Developer guide: <https://inara.cz/elite/inara-api-devguide/>
- API documentation: <https://inara.cz/elite/inara-api-docs/>

Both were read in full on 2026-10-06 and are the authority for everything
below. Where they and this page disagree, they win and this page is wrong.

Inara is run by Artie. This project is not affiliated with Inara or with
Frontier Developments, and is grateful to Inara for providing the API.

## The state it ships in

**Nothing is sent to Inara in this build.** Inara white-lists each
application by its `appName` before it accepts requests from it ("Please, let
me know your app name/identifier you will be using, as it needs to be
white-listed first"). Until that approval exists, the integration sits in
**Awaiting application authorization**:

- the commander can store a key, switch the integration on, and choose what to
  share;
- nothing is queued and nothing reaches the network, including the Verify
  button, which would itself be a request;
- the settings card says so in words, rather than showing an error.

Approval is a release setting, not a code change. See [Release
configuration](#release-configuration).

There is no "application key" in this design and none is needed. Inara's
generic application key is for read-only events used without a user
(`getCommanderProfile` of somebody else, `getCommunityGoalsRecent`). Every
event this app sends is about the commander's own account and is made with
the commander's **personal** API key, which they create on Inara and paste in.
No key of any kind is embedded in the source.

## Release configuration

Read once at build time from Vite environment variables, so a release decides
them without editing code. Both default to the safe answer.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_INARA_APP_AUTHORIZED` | `false` | Set to `true` only once Inara has confirmed `appName` is white-listed. While false, nothing is queued or sent. |
| `VITE_INARA_DEVELOPMENT` | `true` | Sent as `isBeingDeveloped`. Inara skips global events (community goals) for development traffic. Turned off only for a public release, deliberately; passing tests is not a reason. |

`appName` is the constant **`EDFM Companion`**, exactly, with the space. It is
the name the white-list request names and must not change without asking Inara
first. `appVersion` is the desktop app's semver from `package.json`.

If Inara still answers "application has no access" after
`VITE_INARA_APP_AUTHORIZED=true`, the integration goes back to Awaiting
application authorization by itself, stops, and remembers that across restarts.

## Pipeline

```
journal line
  → live-game gate          (Legacy 3.8, beta and unknown versions stop here)
  → InaraTranslator          (keeps its own normalised state: ship, location,
                              taxi, commander; emits documented Inara events)
  → privacy categories       (the commander's per-category choices)
  → dedup + coalesce         (deterministic id; snapshot fingerprints)
  → integration_queue        (durable, per commander, shared with EDDN/EDSM)
  → batch planner            (one commander, ≤ 50 events, nothing > 30 days)
  → Rust `inara_submit`      (adds APIkey from Windows Credential Manager)
  → response applier         (header status, then each event's status)
```

Each stage is a pure function or class in `packages/integrations/src/`
(`inara.ts`, `inara-translate.ts`, `inara-queue.ts`, `inara-state.ts`) and is
tested on its own with mocked HTTP. `apps/desktop/src/lib/companion.ts` only
wires them to the database, the timer and the Rust command.

## Implementation matrix

Field names on the left are as they appear in this project's journal corpus
(318 files, checked 2026-10-06). "Corpus" counts how often the source event
occurs there. Events the corpus does not contain are marked, and are handled
only where Frontier's journal manual and Inara's own "Journal to JSON" example
agree on the fields.

### Implemented

| Inara event | From | Corpus | Notes |
| --- | --- | --- | --- |
| `setCommanderTravelLocation` | `Location` | 419 | Session start. System, coords, station + `marketID` when `Docked`, body name. Never `starsystemBodyCoords`. |
| `addCommanderTravelFSDJump` | `FSDJump` | 4717 | `StarSystem`, `StarPos`, `JumpDist`; ship type/ID unless in a taxi. |
| `addCommanderTravelDock` | `Docked` | 2494 | Only from a real `Docked` event. A session that starts docked produces `Location`, so Inara's warning against docking on session start is honoured by construction. |
| `addCommanderTravelLand` | `Touchdown` | 475 | Only when `PlayerControlled` and `OnPlanet`. Body name only, never latitude/longitude. |
| `addCommanderTravelCarrierJump` | `CarrierJump` | 74 | Only when `Docked` (aboard). No `jumpDistance`, as Inara asks. |
| `setCommanderRankPilot` | `Rank` + `Progress` | 402 / 402 | All eight: combat, trade, explore, soldier, exobiologist, empire, federation, cqc. Progress is journal percent ÷ 100. Sent once both halves of a login pair are seen. |
| `setCommanderRankPilot` | `Promotion` | 24 | `rankValue` only, for the ranks the event names. |
| `setCommanderRankEngineer` | `EngineerProgress` | 468 | Both shapes: the login list (`Engineers`) and single updates. Stage `Known` is not one of Inara's four and is not sent. |
| `setCommanderRankPower` | `Powerplay`, `PowerplayRank`, `PowerplayMerits`, `PowerplayLeave` | 269, 13, 1159, 0 | Rank and merits; leaving sends `rankValue: -1` as documented. Merits alone are sent only with a rank already known for that power. |
| `setCommanderReputationMajorFaction` | `Reputation` | 402 | Journal −100..100 ÷ 100. Only factions the event lists. |
| `setCommanderReputationMinorFaction` | `Factions[].MyReputation` on `FSDJump`/`Location` | 2692 | ÷ 100. Only factions whose value changed since Inara last accepted it. |
| `setCommanderCredits` | `LoadGame` | 400 | `Credits` and `Loan` once per session from the game's own figure, never from adding up transactions (Inara's warning about crew wages). No assets value: Inara calculates it. **Off by default.** |
| `setCommanderGameStatistics` | `Statistics` | 393 | The whole object, never a partial one, because Inara replaces the stored set. |
| `setCommanderShip` + `setCommanderShipLoadout` | `Loadout` | 843 | Current ship with name, ident, hull/modules value, rebuy, jump range, cargo capacity, `isCurrentShip: true`. Loadout modules mapped field by field. **`isMainShip` is never sent**: it is the commander's own choice on Inara and has nothing to do with which ship they are flying. |
| `setCommanderShipTransfer` + `setCommanderShip` | `ShipyardSwap` | 144 | Old ship docked here (`StoreShipID`) or removed (`SellShipID`); new ship set current. |
| `setCommanderShip` / `delCommanderShip` + `addCommanderShip` | `ShipyardBuy` + `ShipyardNew` | 8 / 6 | Old ship stored here or sold; new ship added. `ShipyardNew` carries `NewShipID` in the corpus, not the `ShipID` Inara's example shows. |
| `delCommanderShip` | `ShipyardSell`, `SellShipOnRebuy` | 0 / 0 | Not in the corpus. `ShipType` + `SellShipID`, type-checked; nothing is sent if either is missing. |
| `setCommanderShipTransfer` | `ShipyardTransfer` | 34 | Destination is the commander's current station, as Inara's example says, not the journal's `System` (which is where the ship came from). |
| `setCommanderShip` | `SetUserShipName` | 2 | Name and ident. |
| `setCommanderSuitLoadout` | `SuitLoadout`, `CreateSuitLoadout` | 646 / 5 | Complete loadouts only, as Inara asks. |
| `delCommanderSuitLoadout` | `DeleteSuitLoadout` | 0 | Not in the corpus; `LoadoutID` type-checked. |
| `updateCommanderSuitLoadout` | `RenameSuitLoadout` | 0 | Not in the corpus; `LoadoutID` + `LoadoutName` type-checked. |
| `setCommanderInventoryMaterials` | `Materials` | 402 | Full replacement, from the login snapshot only. An empty snapshot sends `resetCommanderInventory` (`Material`) instead, because Inara documents `set…` as replacing only types that have at least one item. |
| `setCommanderInventoryCargo` | `Cargo` with `Vessel: Ship` and `Inventory` | 339 | Full replacement, only when the event carries the full list (339 of 5307 ship `Cargo` events do). Empty hold → `resetCommanderInventory` (`Commodity`). SRV cargo is not the ship's hold and is not sent. |
| `setCommanderInventory` (`ShipLocker`) | `ShipLocker` with all four lists | 17127 | Items, Components, Consumables, Data. A type with no items gets `resetCommanderInventory` first, for the same reason as above. Coalesced hard: only the newest pending snapshot is ever sent. |
| `getCommanderProfile` | the Verify button | — | No `searchName`, so Inara returns the key owner's own profile. Cached per commander; never polled. |

### Not implemented, and why

| Inara event | Reason |
| --- | --- |
| Incremental inventory (`add…Item`, `del…Item`, `set…Item`) | Correct only if every one of the many events that move materials and cargo is handled (Inara lists MiningRefined, Synthesis, EngineerCraft, EngineerContribution and more). A missed one leaves Inara wrong until next login, which the full snapshots above already avoid. Revisit with corpus evidence per event. |
| `addCommanderMission`, `setCommanderMission*` | Out of scope for this change. The mission engine (`packages/missions`) is the right source and the mapping deserves its own review. |
| `addCommanderCombat*` | Out of scope. `Died` / `Interdicted` mapping needs its own corpus work. |
| `setCommanderStorageModules` | Out of scope; `StoredModules` mapping not yet verified. |
| `addCommanderPermit` | Inara itself says the permits list is not implemented yet. |
| `setCommunityGoal`, `setCommanderCommunityGoalProgress`, `getCommunityGoalsRecent` | Out of scope. `setCommunityGoal` is a global event Inara ignores in development mode anyway. |
| `addCommanderFriend`, `delCommanderFriend` | Not something to do on a commander's behalf without being asked. |

Inara is not used as a source of galaxy data. Its guide says plainly that the
API "does not include markets, minor faction influences, star systems,
stations", and nothing here reads from Inara except the commander's own
profile.

## Live game only

Inara: "Send data only from the Live game version (Odyssey, Horizons 4.0 and
future game updates)", "Do NOT send data from the Legacy game version (Horizons
3.8)", "Do NOT send data from the game beta versions".

Checked per event from the journal provenance (`Fileheader` / `LoadGame`
`gameversion` and `build`) **before the translator runs**, so blocked data
never reaches the queue:

- `gameversion` unknown → blocked (a live game always writes it).
- major version below 4 → Legacy, blocked.
- `beta` anywhere in `gameversion` or `build`, any case → blocked.

The corpus contains only 4.3 and 4.4 live versions, so the Legacy and beta
cases are tested with synthetic fixtures, labelled as such.

## Batching

Requests go out on the moments Inara names: session start (20 s after
`LoadGame`, so the login burst of ranks, materials and loadout travels
together), `Docked`, `FSDJump`, `CarrierJump`, `Shutdown`, plus the Sync now
button, a size threshold (50 pending) and a five-minute fallback while anything
is waiting. Automatic sends are at least 30 s apart. A request carries at most
50 events and only ever one commander's.

## Deduplication

- **Queue id** `inara:<journal event id>#<n>`: the journal event id is
  `file:offset`, stable across restarts and re-reads, and `INSERT OR IGNORE`
  makes re-reading a file a no-op. Accepted rows are kept (status `accepted`)
  for 31 days precisely so that a re-read of an already-sent line is ignored
  rather than sent again; anything older than 30 days could not be sent anyway.
- **Snapshots** (ranks, reputation, materials, cargo, locker, loadouts,
  statistics, credits, location) carry a coalesce key and a fingerprint. A newer
  snapshot replaces an older one still waiting, and a snapshot identical to the
  last one Inara accepted is not queued at all. Fingerprints are stored per
  commander in `integration_fingerprint`.
- **`eventCustomID`** is set on every event in a request (1..n) and results are
  matched by it, falling back to order, which Inara documents as preserved.

## Responses and retries

| Answer | Treated as |
| --- | --- |
| No answer, timeout, HTTP 5xx / 429 / 408, unreadable body | Temporarily unavailable. Retried with the shared backoff (5 s → 10 min, ±20 % jitter), six attempts, then given up and shown. |
| Header `400`, "application has no access" | Awaiting application authorization. Everything stops, persistently, until a release says otherwise. |
| Header `400`, anything else | Authentication failed. Everything stops until the key is replaced or Verify succeeds. Inara cancels the whole batch in this case, so the rows stay queued. |
| Header `200`/`202`/`204`, event `200` or `202` | Accepted. |
| Event `204` | Accepted: "formally OK, but no results". Not retried. |
| Event `400` | Rejected for good, with Inara's reason, sanitised. Not retried. |
| Event missing from the reply | Retried with backoff. |

Inara reserves the right to cut off keys that "constantly show high number of
errors"; this is why a header-level failure stops everything rather than
retrying.

## Commander scoping

Every row, fingerprint, profile cache and failure condition is keyed by
Frontier ID. A batch is built only from rows whose `commander_fid` is the
commander currently logged in, under that commander's name. The translator
resets its state when the journal names a different commander, so a ship or
location cannot leak from one into the next.

## The API key

Stored only in the Windows Credential Manager. JavaScript can store it, delete
it and ask whether one exists; nothing can read it back. The Rust command adds
it to the request header itself, sends only to `https://inara.cz/inapi/v1/`,
refuses redirects so it cannot be replayed to another host or over plain HTTP,
and never puts it in an error, a log line or the queue.

## Links back to Inara

`inaraLinks` builds the links the guide documents, URL-encoded:
`starsystem/?search=`, `station/?search=NAME [SYSTEM]`, `station/?search=CALLSIGN`
for carriers, `minorfaction/?search=`. URLs Inara returns in a response
(`starsystemInaraURL`, `stationInaraURL`, the profile's `inaraURL`) are
preferred when present.

## Ambiguities in Inara's documentation

- Required properties are marked in red on the page. They were read from the
  page's markup (the `negative` class) on 2026-10-06 and every event here sends
  them. One consequence: `setCommanderShipTransfer` requires `stationName`, so a
  transfer or a stored ship is not sent when the commander's station is unknown.
- `ShipyardNew`: Inara's example shows `ShipID`; the journal writes
  `NewShipID`. The journal wins.
- `resetCommanderInventory`'s example uses `itemType: "Materials"`, which is not
  in its own list of types; this project sends `Material`, which is.
- Whether an empty `setCommanderInventoryCargo` / `setCommanderInventoryMaterials`
  array clears the stored set is not stated; `resetCommanderInventory` is sent
  instead.
- `isBeingDeveloped` is described for global events only; whether it changes
  anything else is not stated.
