# External integrations

Four built-in services, four genuinely different models, one shared rule: **the
commander can see what each integration sends before it sends anything, and no
built-in integration sends until they switch it on.**

Installed Python plugins are separate programs with the commander's user
permissions. They are not controlled by these integration switches; see
[PYTHON-PLUGINS.md](PYTHON-PLUGINS.md).

Data goes from the game's journal, through the Companion, to the service.

**No community integration's data passes through EDFM.** EDDN needs no key, and
your EDSM and Inara credentials remain local — the EDFM server never sees them.

**EDFM Commander Journal is the exception, and it is the point of it:** it sends
derived Activity Journal entries to your own EDFM account, behind a token you
generate there. It is off until you connect it.

---

## Status

| Service | State | Needs |
|---|---|---|
| **EDDN** | **Built and wired**; covered by schema fixtures | Nothing — it is anonymous community sharing |
| **EDSM** | **Built and wired**; tested against live API responses | Your personal EDSM API key |
| **Inara** | **Built**; Inara approved `EDFM Companion` on 2026-10-09; first live test pending | Your personal Inara API key, in a build made with `VITE_INARA_APP_AUTHORIZED=true` |
| **EDFM Commander Journal** | **Built** — push-only, new activity plus an optional history upload | A journal sync token from your EDFM account |

Every one ships **off**. The Connections & Data Sharing screen shows whether a
service is connected, queued, sending, paused or refusing requests. Inara has
approved the application name, but a build sends to Inara only when it is made
with `VITE_INARA_APP_AUTHORIZED=true`; without that, the screen says it is
awaiting authorization rather than presenting a working connection.

---

## EDDN

Transcribed from the **live** branch of `EDCD/EDDN` on 2026-09-29, because its
README says in capitals not to trust any other branch as a description of the
running service.

- **Endpoint** `https://eddn.edcd.io:4430/upload/` — the trailing slash is required
- **Events sent** exactly the seven the schema names: `Docked`, `FSDJump`,
  `Scan`, `Location`, `SAASignalsFound`, `CarrierJump`, `CodexEntry`
- **Header** `uploaderID`, `softwareName`, `softwareVersion`, and — easy to miss —
  **`gameversion` and `gamebuild`, both mandatory**

### Sanitisation is the whole safety property

EDDN is public and permanent. Anything sent is visible to anyone, forever. So
this is **deny by default**: only those seven events are considered, and the
schema's forbidden keys are stripped **recursively**, because `Factions` is an
array of objects carrying its own forbidden fields. A top-level sweep would
publish `MyReputation` for every faction in the system.

Stripped: `ActiveFine`, `CockpitBreach`, `BoostUsed`, `FuelLevel`, `FuelUsed`,
`JumpDist`, `Latitude`, `Longitude`, `Wanted`, `IsNewEntry`,
`NewTraitsDiscovered`, `Traits`, `VoucherAmount`, every `*_Localised` key, and
within factions `HappiestSystem`, `HomeSystem`, `MyReputation`,
`SquadronFaction`.

`Latitude`/`Longitude` matter more than they look: they say **where on a planet a
commander was standing**.

A second pass, `auditEddnMessage`, runs before anything is sent. The duplication
is deliberate — this is the last point at which a mistake is still private.

### The odyssey flag

The spec is emphatic, and the code follows it exactly: if `LoadGame` carried no
`Odyssey` boolean, the flag is **omitted entirely**. Not sent as `false`.

### Testing

EDDN provides `/test` schema forms and requires their use when exercising
EDDN-handling code. Nothing in the test suite contacts the network at all; the
message builder defaults to the test schema everywhere except a real submission.

### How it sends

Observations are **queued, never sent on the ingest path**. A slow upload must
not delay reading the journal, so events are stored and a timer drains the queue
every twenty seconds, ten at a time — a commander who has been offline for an
evening does not open a hundred connections the moment they reconnect.

The queue id is the journal event id, `sourceFile:byteOffset`, which is stable
across restart and replay. Re-reading a file re-derives the same id and the
insert is dropped, so an observation cannot be published twice.

A message is built only when the game has reported everything required —
commander, game version and build, system, position and address. A missing field
means no message, because EDDN would rather have nothing than a record with a
guessed coordinate in it.

A `400` is a schema rejection and is never retried; it would be identical however
often it was sent. Anything else — a timeout, a gateway, a 5xx — is the network
rather than the message, and backs off on the stored schedule.

---

## EDSM — built, needs your key

Documented API: `POST https://www.edsm.net/api-journal-v1` with
`commanderName`, `apiKey`, `fromSoftware`, `fromSoftwareVersion` and the journal
message.

**What you need to do:** EDSM → Settings → *My API Key*. The key identifies your
account; treat it as a password.

The submission queue and Rust transport are wired into the application. Response
handling was corrected against live API replies from a real account, including
duplicate, already-stored and discarded-event outcomes. EDSM remains off until the
commander supplies a key and enables it.

### What EDSM's answers mean

EDSM answers each entry with its own `msgnum`. Real answers from a commander's
queue (3,804 entries, 2026-10-03 to 2026-10-06) showed that most of the entries
the app had marked "rejected" were not failures:

| `msgnum` | Meaning | How the app treats it |
|---|---|---|
| 100 | Stored | Delivered |
| 101, 102, 103 | Already stored, older than the stored one, duplicate | Delivered: EDSM already has it |
| 304 | Discarded event | Dropped: EDSM does not want this event |
| anything else | A real refusal | Rejected, shown in the audit |

**Discarded events.** EDSM publishes a list of events it does not want
(`/api-journal-v1/discard`, 141 names). The app used to fetch that list only
after it had re-read the current session at startup, so each launch queued that
session's `Music`, `UnderAttack`, `ReceiveText` and so on unfiltered. Those
accounted for all 3,597 of the 304 answers. Now the list is requested before the
catch-up, and the sender checks every entry against it before sending, so
anything queued before the list arrived is dropped instead of sent. If the list
could not be fetched, the sender asks for it again on its next pass.

On the first pass after updating, rows that earlier builds marked rejected with a
1xx or 304 answer are removed, so the Rejected count shows only real problems.

---

## Inara — keeps your profile in step with the game

**The full design, the implementation matrix and the corpus evidence are in
[INARA.md](INARA.md).** This is the summary.

Inara is **not** a journal-forwarding API. It takes its own event vocabulary,
and the app translates journal lines into it: the flight log (jumps, dockings,
landings, carrier jumps), ranks (pilot, navy, engineer, Powerplay), reputation,
ships and their loadouts, suit loadouts, materials, cargo and ship locker, game
statistics, and — only if the commander switches it on — credits. Each kind can
be switched off separately, and switching one off withdraws anything of that
kind still waiting.

**Inara has no event for exobiology scans or exploration scans**, so the
Activity Journal still reaches Inara not at all.

It uses the same durable `integration_queue` as EDDN and EDSM, per commander,
with deterministic ids so a re-read journal sends nothing twice, and snapshot
fingerprints so an unchanged rank list or loadout is not sent again at the next
login. Requests are batched on session start, docking, jumps and shutdown, as
Inara's guide asks, and never mix commanders.

**Only the live game is sent.** Legacy (3.x) and beta lines are dropped before
they reach the queue, as Inara requires.

**Your surface position is never sent.** Inara accepts `starsystemBodyCoords`
— your latitude and longitude on a planet — and this app does not send it. The
body name alone keeps the profile accurate.

**Inara has to white-list the app's name first.** The header carries the
commander's *personal* API key, but Inara's developer guide asks for the app
name "as it needs to be white-listed first", and an unlisted name is refused
whatever the key. This app's first real request, on 2026-10-06, came back
`400 "This application has no access allowed."` Two earlier versions of this
file got that wrong in opposite directions; INARA.md has the corrected account.

So the integration ships in **Awaiting application authorization**: the key can
be saved and choices made, but nothing is queued and nothing is sent, the
Verify button included. A release built with `VITE_INARA_APP_AUTHORIZED=true`
lifts that once Inara has approved `EDFM Companion`. If Inara still refuses the
name, the app returns to that state by itself and remembers it across restarts.
A refused key likewise stops everything until the key is replaced or Verify
succeeds, because Inara's guide reserves the right to cut off keys that keep
producing errors.

**What you need to do:** generate a personal API key on Inara (your commander →
Settings → API key). It is not your Inara password.

Inara is an independent community site run by Artie; this project is not
affiliated with it and thanks it for the API.

---


## Credentials

**Stored in the OS credential store** — Windows Credential Manager, via the
`keyring` crate's native backend. Encrypted at rest by the OS, scoped to the user
account, no vault password to invent.

Considered and rejected:

- **`tauri-plugin-stronghold`** — a real encrypted vault, but unlocked by a
  password the commander must invent and re-enter. For one API key that is worse
  security in practice, because such passwords end up trivial or written down.
- **The settings table** — plain SQLite. Calling that credential storage would be
  exactly the kind of claim this project has already had to correct once.

### The boundary that matters more than the storage

**There is no command that reads a secret back out.** The frontend can store one,
clear one, and ask whether one exists — never fetch it. A secret that reaches
JavaScript can reach a log line, an error message, a crash report or a
screenshot.

A Rust test asserts that no such getter exists, so adding one is a deliberate act
that fails the suite rather than an oversight.

**The consequence, recorded so it is not rediscovered later: any integration
needing a credential must perform its HTTP request in Rust.** EDDN needs none,
while EDSM, Inara and EDFM Commander Journal all add their credential on the Rust
side of the boundary; Inara's also pins the app name and refuses redirects.

---

## What is never shared, by any of them

- Chat, friends, wings or squadron membership
- Where you are standing on a planet
- Anything at all while an integration is switched off

Credits, loadouts and faction reputation used to be on this list. They are not
any more, because Inara's profile sync exists to put them on the commander's own
Inara profile, at their request (credits only if they switch that on). EDDN and
the EDFM journal still never carry them, and their own manifests say so.

## What never reaches a community database

EDDN, EDSM and Inara receive observations about the galaxy. Your record
of what *you* did is not an observation about the galaxy and is not theirs to
publish, so it reaches none of them:

- Your Activity Journal, your notes, your saved items

This used to be listed above as universal. It is not, and saying so would be
false: **EDFM Commander Journal** exists precisely to send derived Activity
Journal entries — to your own EDFM account, at your request, behind a token you
created and can revoke. A false line at the top of a privacy page discredits the
true ones beside it, so the two guarantees are now stated separately and each is
asserted by its own test.

The privacy manifests in `packages/integrations/src/registry.ts` are rendered
directly by the **Connections & Data Sharing** screen and are **checked by tests
against the sanitiser**, so the promise and the code cannot drift apart.

That list is *intersected* across the integrations, not concatenated
(`universalNeverShares`): a guarantee that holds for three services and not the
fourth is not a guarantee, and printing it as one at the top of the page would
be the most consequential kind of wrong that screen could be. Anything covered
by some but not all of them appears in the per-service lists instead.

---

## Durable queues

One queue per integration, so a failing service cannot block another. There is no
shared head-of-line: EDSM being down does not stop EDDN.

| Status | Meaning |
|---|---|
| `queued` | Waiting to be sent |
| `attempting` | In flight |
| `accepted` | The service took it |
| `retryable` | Failed, will be tried again after a wait |
| `rejected` | Will never be sent — and why |

**A retry cannot duplicate.** The id is supplied by the producer and is
deterministic; for a journal submission it derives from the source event id,
which is already stable across restart and replay. Enqueueing the same
observation twice is the same row. The primary key is `(integration, id)`,
because the same event may legitimately be owed to two services and one
accepting it says nothing about the other.

**Some failures must stop.** A 4xx from a schema validator or an auth check will
be rejected identically forever, so it is marked `rejected` immediately rather
than retried. `429` and `408` are the exceptions — they mean *later*, not
*never*. Everything else backs off on a fixed schedule (5s, 30s, 2m, 5m, 10m,
10m) and gives up after six attempts, recording why.

Backoff is **stored on the row**, not held in a timer, so a wait survives a
restart instead of collapsing into a retry storm.

**An item whose owner cannot be established is never sent.** Guessing which
account should receive somebody's data is worse than not sending it.

**A stored error never carries a credential.** Query strings and named credential
parameters are stripped, and the text is bounded, before anything reaches the
database or the audit screen.

---

## EDFM Commander Journal

The first-party one, and the only one that receives your Activity Journal.

It uploads derived entries to your own EDFM account, behind a token you generate
there and can revoke there. It is push-only: the deployed API has no read
endpoint.

Two separate decisions:

- **New activity** is uploaded automatically from the moment you connect.
- **Your existing activity** goes up only when you ask for it, and the count and
  the span are shown before the upload is offered. A separate, local-only action
  rebuilds the field journal from the journal files still on disk, because
  activity from before the Companion existed was never recorded — that rebuild
  sends nothing.

Full detail — token handling, the automatic boundary, the history rebuild and
what it cannot recover, retries, what is and is not sent — is in
`docs/JOURNAL-SYNC.md`.
