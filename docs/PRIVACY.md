# Privacy

The Companion reads the Elite Dangerous journal, which is a detailed record of a
commander's activity: identity, finances, travel history, chat, friends, squadron and
private-group membership. That access is a responsibility, and this document is the
commitment we hold ourselves to.

## Current state (Phase 1)

**Nothing leaves the machine.** There is no network client in the application yet, no
telemetry, and no analytics. The only data written anywhere is the local SQLite
database.

## What is stored locally

| Table | Contents |
|---|---|
| `settings` | User preferences, e.g. a manual journal folder override |
| `journal_checkpoint` | Journal filename and byte offset, scoped per commander FID |
| `commander_state` | Current system, station, ship and docking state |
| `ingest_stats` | Aggregate counters: lines read, events emitted, malformed lines |
| `unknown_events` | Event **names** without a typed shape, and how often they occurred |

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

## Planned network features, and the rules they will follow

Later phases add station verification (Phase 5), research contribution (Phase 6) and
market/logistics queries (Phase 7–8). Each will honour these rules:

1. **Opt-in.** Contribution features are off until explicitly enabled.
2. **Minimum payload.** A submission carries only the structured fields the feature
   needs. Verification sends an observation about one station, not a session.
3. **Visible before sending.** The exact payload is inspectable before anything is
   transmitted.
4. **Separable traffic.** Requests required for the application to function are
   distinguished from optional contributions in both settings and documentation.
5. **Identity is a choice.** Anonymous, CMDR-attributed, and EDFM-account-linked modes
   are user-selected. A commander name is never treated as authentication.
6. **Discord identity only on explicit link.** Never inferred, never derived.

## Offline behaviour

Journal monitoring, commander state, mission tracking, local research recording and
the overlay are designed to work with no network at all. Optional submissions queue
locally and retry with backoff, so a network outage costs nothing but latency.
