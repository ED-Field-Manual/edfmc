# EDFM Field Research

Status: **built.** Framework, first project, client persistence and the
Research screen all work; validated against the real journal corpus.

Contribution to the server is deliberately not built yet: recording an observed
session is local and unconditional, offering it to anyone is a separate decision
(`research_sessions.submitted_at` exists for exactly that reason and is never
set by the client today).

§12 asks for "a general research framework capable of supporting multiple EDFM
research projects", not a settlement loot tracker. So `@edfm/research` contains
nothing about settlements: a project is a declarative description of when a
session opens, what counts as an observation inside it, and when it closes.
Settlement Material Distribution is one such description, and adding a second
project is a data change rather than a code change.

## What was measured before anything was designed

Everything below comes from a 224-journal, 197,947-line corpus profiled on
2026-09-03. §36 forbids assuming an event contains a field, so nothing here was
taken from documentation.

| Event | n | What it gave |
|---|---|---|
| `ApproachSettlement` | 441 | name, MarketID, economy, government, faction, faction state, body — all 100% |
| `Disembark` | 178 | body 100%, but **`StationName` only 25.8%** |
| `CollectItems` | 281 | name, type, count, stolen 100%; `Name_Localised` 84.3% |
| `BackpackChange` | 369 | `Added` 74.5%, `Removed` 25.5%; **no locker or room** |
| `Backpack` | 248 | full snapshot, but see below |

Three findings changed the design:

**`Disembark` usually does not say where you are.** At 25.8% presence,
`StationName` cannot identify a settlement. Identity therefore comes from the
preceding `ApproachSettlement`, matched on `BodyID` — which is also what stops
an ordinary station walk being recorded as a settlement visit.

**One pickup emits two events.** 258 of 281 collections appear in both
`CollectItems` and `BackpackChange.Added` within a second. Reading both would
inflate every material by nearly 90%. The 17 additions that appear *only* in
`BackpackChange` are all consumables — 16 `bypass` (E-Breach) and a grenade —
which are bought or transferred, not found. So `CollectItems` is authoritative
and `BackpackChange` is not read at all.

**Snapshot differencing is impossible.** The obvious design — diff the backpack
at the session boundaries — cannot work: `Backpack` fires near only 45 of 178
disembarks and **0 of 175 embarks**. Incremental events are the only option.

## Fields the game does not expose

§12 asked for settlement security, powered/unpowered state, and
abandoned/active state. **None appears in any journal event.** They are listed
in `SETTLEMENT_MATERIALS.unavailableFields` rather than omitted quietly, so the
gap reads as a finding instead of an oversight.

`StationAllegiance` is present on 47.8% of approaches, so it is typed optional
and recorded as `null` when absent. Absent is not the same as unknown-and-guessed.

## Sessions

```
ApproachSettlement        capture settlement context (expires after 30 min)
        ↓
Disembark on that body    open an observed session
        ↓
CollectItems              record observations
        ↓
Embark / Died / Liftoff / FSDJump / SupercruiseEntry / Shutdown
```

The spec proposed "approach/disembark → collect → departure/embark/FSD". Real
data adds endings the model did not describe: of 30 measured sessions, 27 ended
in `Embark`, **2 in `Died`**, and 1 in `Liftoff` with no embark. A session that
ends in death is not a completed visit and is flagged `died`, not `ended`.

A session whose end is never seen — the journal simply stops — is recorded as
`interrupted` rather than silently closed or discarded. §13 wants incomplete
sessions counted, and "the game crashed" is different evidence from "the
commander left".

### Why the approach is not consumed

A commander who embarks to reposition the ship and disembarks again at the same
settlement is on a second observed session there. Consuming the captured
approach would silently discard everything collected on it: measured, 28 of 48
approach/disembark pairs are a repeat use of an approach already matched once.

Staleness is controlled by the 30-minute expiry instead, which is the control
that actually belongs there. Without it the widest real approach-to-disembark
gap accepted was **3.9 days**.

### Observed, not complete

These are **observed settlement sessions**, never "complete loot runs". §12 is
explicit about what cannot be known, and none of it is inferred:

- which container an item came from
- which room it was in
- whether every container was searched
- whether another commander had already looted the site
- whether the player deliberately skipped areas

`completeness` therefore defaults to `unknown` and stays there. The commander
may mark a session `complete`, `partial` or `aborted`, but is never asked to —
across the whole real corpus, all 30 sessions are `unknown`, which is the honest
answer.

## Data quality (§13)

> "This matters enormously. Do not build charts suggesting conclusions from tiny
> datasets."

The measured reality makes the case better than the rule does. One commander's
entire history yields:

```
30 sessions, 26 usable, 14 with any collection
12 settlements, 10 systems, 2 commanders
excluded: 4 too short, 2 ended in death, 0 interrupted

Extraction   10 sessions   6 with items    4 settlements
Industrial    9 sessions   8 with items    2 settlements
Refinery      3 sessions   0 with items    2 settlements
Colony        3 sessions   0 with items    3 settlements
Military      1 session    0 with items    1 settlement
```

A naive reading says Industrial is far more productive than Extraction — 8 of 9
against 6 of 10. But those 9 Industrial sessions are **2 settlements**. That is
not a fact about Industrial economies; it is a fact about where this commander
happened to go, and it is precisely the "five players found more there" trap
§13 warns about.

So `summarise()` reports counts and refuses rates below 30 usable sessions, and
`formatRate()` returns `null` for any group under 10 — a caller cannot
accidentally render "100%" from one session. Every group summary carries
`distinctLocations` and `distinctSystems` next to the session count, so
concentration like the above is visible rather than hidden behind a percentage.

Unknown is its own group and is never folded away or dropped: silently
discarding sessions whose economy the game did not report would bias every rate
computed from what remains.

There is deliberately **no significance test and no "X beats Y" helper**. §13
requires the analysis to be transparent and reproducible and forbids
AI-generated statistical conclusions. Presenting counts, rates where the sample
allows, and the denominator alongside both is the honest limit of what the
client should do.

## Server-driven definitions

Project definitions are versioned and intended to be served, so methodology can
improve without shipping a desktop update (§12). They therefore arrive as
untrusted data, and conditions reuse `@edfm/context`'s `Condition` schema rather
than growing a second matcher: declarative only, a fixed operator set, no
`eval`, and deliberately no regular expressions — a server-supplied regex is a
denial-of-service vector against an application whose whole job is running
quietly beside a game.

Field paths are read with an explicit walker that refuses `__proto__`,
`constructor` and `prototype`, for the same reason.

`projectVersion` is stored on every session, and game version and build are
recorded per session, so data from materially different patches can be
separated. The corpus already spans four builds (4.3.3.0 through 4.4.0.3).

## Checking the numbers yourself

```bash
npx tsx packages/research/tools/report.mts
```

Prints the full summary for the local journal directory: session count, endings,
durations, exclusions, per-economy counts and the item tally. Every figure
quoted in this document came from it.

```bash
npm test --workspace @edfm/research
```

The corpus tests replay the real journal directory through the tracker and skip
automatically where there is none, so other machines stay green. They assert
behaviour rather than exact counts, because the corpus grows every time the
commander plays.
