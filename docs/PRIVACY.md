# Privacy

The Companion reads the Elite Dangerous journal, which is a detailed record of a
commander's activity: identity, finances, travel history, chat, friends, squadron and
private-group membership. That access is a responsibility, and this document is the
commitment we hold ourselves to.

## Current state

**Nothing leaves the machine unless you turn verification on.** It is off by default
and there is no telemetry and no analytics in any configuration.

With verification **off** — the default — the application makes no network requests at
all.

With verification **on**, exactly two things happen, both only for stations you dock
at or fly past:

1. A **reference lookup** by MarketID. This tells the server which station you are at.
   It is a location disclosure, and it is the reason the feature needs consent even
   before anything is submitted.
2. An **observation submission**: what your game reported about that station.

Turning it back off stops both immediately — the setting is consulted at call time,
not read once at startup — and clears the reference data already cached.

### What a submission contains

The station's MarketID, name, type, system, the service tokens your game reported, the
timestamp, the journal event name and its `file:byteOffset`, your game version and
build, and the Companion version.

### What it does not contain

Your commander name, your FID, or your journal filename. Those are sent as **one-way
keyed hashes**, which let the server tell two reporters apart without learning who
either is. The salt lives on the server, is required at boot, and is rejected if it is
short enough to brute-force — commander FIDs are short and structured, so a weak key
would make a hash reversible by anyone holding the database.

That is what makes CMDR-attributed contribution cost the server no knowledge of your
identity: attribution is a choice about credit, not a disclosure.

Your IP address is not stored either. A keyed, truncated hash of it is kept so one
source flooding the endpoint can be noticed.

## What is stored locally

| Table | Contents |
|---|---|
| `settings` | User preferences, e.g. a manual journal folder override |
| `journal_checkpoint` | Journal filename and byte offset, scoped per commander FID |
| `commander_state` | Current system, station, ship and docking state |
| `ingest_stats` | Aggregate counters: lines read, events emitted, malformed lines |
| `unknown_events` | Event **names** without a typed shape, and how often they occurred |
| `discovery_state` | What your own game has revealed to you, scoped per commander FID |
| `verification_queue` | Findings awaiting submission, so an outage costs nothing |

`unknown_events` deliberately stores names and counts only. An unknown event's body
can contain arbitrary commander detail, and we have no reason to keep it.

## What is never done

- The journal is never copied, uploaded, or transmitted in whole or in part.
- Chat (`ReceiveText`, `SendText`), friends, squadron membership and private-group
  names are read only insofar as they pass through the pipeline; none is persisted
  and none is logged.
- Full travel history is not accumulated.
- Financial state beyond the current credit balance shown on the dashboard is not
  retained.

## Logging

Structured logs record event **names**, byte offsets, file names and counters — never
event payloads. When a line cannot be parsed we log the reason, the file and the
offset, and deliberately not the line itself, because a malformed line is still
journal content.

Anything resembling a credential is redacted before it reaches a log sink, and the
diagnostics export applies the same redaction plus a payload-free allowlist.

## Network features, and the rules they follow

Station verification (Phase 5) is built. Research contribution (Phase 6) and
market/logistics queries (Phase 8) are not. All of them honour these rules:

1. **Opt-in.** Contribution features are off until explicitly enabled. Verification
   is off by default today, and revoking consent takes effect immediately.
2. **Minimum payload.** A submission carries only the structured fields the feature
   needs. Verification sends an observation about one station, not a session.
3. **Visible before sending.** The exact payload is inspectable before anything is
   transmitted.
4. **Separable traffic.** Requests required for the application to function are
   distinguished from optional contributions in both settings and documentation.
5. **Identity is a choice.** Anonymous and CMDR-attributed modes are user-selected;
   EDFM-account-linked is not built. A commander name is never treated as
   authentication. Both modes send only hashes, so the choice affects credit rather
   than what the server learns.
6. **Discord identity only on explicit link.** Never inferred, never derived.

## What the server keeps

Documented here rather than only in [API.md](API.md), because a promise about a
desktop app that stops at the network boundary is not a privacy policy.

- **Submissions** are retained as an audit record (§19), including the observation and
  the hashes — never the identifiers.
- **Discrepancies** are aggregated across reporters. Thirty commanders reporting one
  wrong service is one finding, not thirty.
- **Discord reports** are posted to a moderation Forum as one thread per issue.
  They carry an opaque reference, never the discrepancy key — that key contains
  both values, so posting it would restore everything redaction removes.
  Spoiler-sensitive findings are **not posted at all** by default, because a
  Forum post is public and permanent. Your commander name is not included unless
  the server operator explicitly enables it. See [DISCORD.md](DISCORD.md).

## Offline behaviour

Journal monitoring, commander state, mission tracking, local research recording and
the overlay are designed to work with no network at all. Optional submissions queue
locally and retry with backoff, so a network outage costs nothing but latency.
