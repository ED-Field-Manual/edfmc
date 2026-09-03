# EDFM Companion

The official desktop companion for the [Elite Dangerous Field Manual](https://edfieldmanual.com/).

EDFM is the reference. The Companion is the live gameplay layer: it knows what is
happening in your game right now, surfaces the relevant EDFM material, helps you plan,
and — passively — helps EDFM verify and improve its own information.

This is **not** an EDMC plugin and does not require EDMarketConnector.

> **Status: Phases 0–5 and 7.** The journal engine, overlay, context assistant,
> mission planner, EDDN ingestion and the verification backend work end to end.
> Research (Phase 6) and logistics (Phase 8) are designed but deliberately not
> built yet. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What works today

- Locates the Elite Dangerous journal folder via the Windows Saved Games known
  folder, with a manual override.
- Tails the active journal safely: byte offsets, no partial lines, rotation
  handling, truncation detection, and resume-without-duplicate-events across
  restarts.
- Parses and normalizes events while always retaining the raw payload and full
  provenance.
- Maintains commander/session state where "the game did not say" stays visibly
  distinct from "the game said none".
- Dashboard, Settings and Diagnostics screens.
- Replays any journal file through the identical live pipeline.
- A game overlay that does not inject anything into Elite Dangerous.
- Deterministic context assistance and a mission planner with delivery
  progress.
- Ingests EDDN into PostgreSQL, and serves station reference data from it.
- Verifies what your game reports against that reference, and submits
  disagreements — **off by default**.

Everything except verification is local, and verification is opt-in. There is no
analytics in any configuration.

## Design commitments

These are constraints, not aspirations:

- **Verify aggressively. Reveal conservatively.** The verification engine may compare
  anything against EDFM's data; the app shows only what this commander's own game has
  reported. A commander who enjoys exploring is never spoiled because EDFM already
  knows the answer. See [docs/SPOILERS.md](docs/SPOILERS.md).
- **Never guess.** A value the journal did not provide is rendered `Unknown`. Field
  presence was measured across a 197,164-line corpus; anything below 100% is typed
  optional. See [docs/JOURNAL.md](docs/JOURNAL.md).
- **Raw is never discarded.** Normalization is additive, so a mapping mistake can be
  corrected later without having lost the observation.
- **Read-only with respect to the game.** No memory access, no DLL injection, no
  input automation, no botting (§31).
- **Secrets stay server-side.** The desktop client is untrusted and never holds
  Discord webhooks, database credentials or administrative keys.

## Repository layout

```
apps/desktop         Tauri 2 + React/TypeScript client
packages/
  elite-journal      Journal engine: tailer, parser, normalizer, state, replay
  context            Deterministic context rules
  missions           Mission tracking and delivery progress
  verification       Evidence model, spoiler gating, comparison engine
services/
  api                Backend API: reference data, submissions, notification
  eddn-worker        EDDN ingestion, Python
docs/                Architecture and subsystem documentation
scripts/             Journal profiling tooling
```

## Requirements

- Windows 10/11 (Windows-first; Linux support is designed for, not yet built)
- Node.js 20+
- Rust stable (MSVC toolchain) and MSVC build tools, for the desktop client

## Getting started

```bash
npm install
```

Run the test suite:

```bash
npm test --workspaces --if-present
```

Tests needing PostgreSQL skip unless `EDFM_TEST_DSN` is set, and refuse to run
against a database not named for testing — they `TRUNCATE`, and pointing them at
the development database while the EDDN worker was ingesting into it wiped a
table mid-run.

```bash
createdb edfm_test
```

Run the desktop client in development:

```bash
npm run tauri dev --workspace @edfm/desktop
```

## Validating against a game update

Elite changes. After any update, re-measure rather than assuming:

```bash
pwsh scripts/profile-journal.ps1 -Events Docked,MissionAccepted
```

Any field that drops below 100% presence must become optional in the parser. The
corpus tests in `packages/elite-journal/test/corpus.test.ts` replay your real
journals and will fail if parsing regresses; they skip automatically on machines
without a journal folder.

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack decisions and why, component boundaries, risks |
| [JOURNAL.md](docs/JOURNAL.md) | Measured journal behaviour, field presence rates, edge cases |
| [PRIVACY.md](docs/PRIVACY.md) | What is stored, what is sent, what never leaves the machine |
| [SPOILERS.md](docs/SPOILERS.md) | Discovery gating and how spoiler safety is enforced |
| [VERIFICATION.md](docs/VERIFICATION.md) | Verification engine, evidence model, discrepancy lifecycle |
| [API.md](docs/API.md) | Backend endpoints, identity hashing, notification rules |
| [DISCORD.md](docs/DISCORD.md) | Forum reporting, duplicate policy, tag configuration |
| [EDDN.md](docs/EDDN.md) | EDDN ingestion, schemas, normalization decisions |
| [OVERLAY.md](docs/OVERLAY.md) | Overlay design and the no-injection boundary |
| [CONTEXT.md](docs/CONTEXT.md) | Context rules and how they are evaluated |
| [MISSIONS.md](docs/MISSIONS.md) | Mission tracking and delivery progress |

Research and logistics documents arrive with their respective phases.
