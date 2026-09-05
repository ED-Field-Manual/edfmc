# Logistics and Market Confidence

Status: **complete.** Confidence engine, sourcing planner, multi-site
construction tracking, the market search endpoint and the Logistics screen all
work, proven end to end against live data.

## What was measured first

§17 says plainly: *"Do not implement auto-delivery tracking unless journal data
can reliably support it. Research colonisation journal events carefully before
claiming this can be automatic."*

Checked against 224 journals on 2026-09-03. **It can.**
`ColonisationConstructionDepot` fired **5,703 times** and carries, at 100%
presence:

| Field | Meaning |
|---|---|
| `MarketID` | stable identity for the site |
| `ConstructionProgress` | 0..1, reported by the game |
| `ConstructionComplete` / `ConstructionFailed` | terminal states |
| `ResourcesRequired[]` | `RequiredAmount`, `ProvidedAmount`, `Payment` per commodity |

So remaining is `Required − Provided`, **reported rather than inferred**. Every
event is a complete snapshot, so nothing accumulates and a missed event cannot
corrupt a total — the next one supersedes it. That is a materially better
situation than mission `CargoDepot`, which needed careful reconstruction.

### The join that made the module possible

Construction requirements and market availability use different naming:

```
journal : $ceramiccomposites_name;
EDDN    : ceramiccomposites
```

Measured: colonisation events carry **84 distinct names for 42 commodities**,
because Frontier emits every one in *both* cases — `$aluminium_name;` **and**
`$Aluminium_name;`. Case-folding is not tidiness here. Without it every
requirement splits in two and half of them match no market row.

All 84 matched `$<symbol>_name;` exactly, and checked against the live database,
**all 42 folded symbols were present and currently purchasable**. The join is
total, not approximate. That check is what made the rest worth building.

### Post-update re-profile

The commander updated to 4.4.1.0 mid-project. Re-profiled: every field
Logistics depends on (`MarketID`, `StationName`, `StationType`,
`StationServices`, `StarSystem`, `SystemAddress`, `StationEconomy`,
`DistFromStarLS`, `LandingPads`) is still 100% present. Small sample on the new
build (n=9), so worth repeating as more accumulates.

## Confidence (§15)

Two questions §15 insists are kept apart, and which are separate types here:

- **Data confidence** — should we trust this observation for the quantity being
  asked for?
- **Destination score** — is this a good station for this task?

A market can be perfectly trustworthy and a terrible place to go. A model that
cannot express that ends up justifying a bad stop with good data.

Confidence is judged on **what we intend to buy**, not on the whole outstanding
requirement. That distinction was a real bug: judging against the requirement
made any market holding less than the full amount `unusable`, so a requirement
could never be split across stops — defeating the point of multi-stop sourcing.
§15's worked examples are unchanged by it (7,500 needed against 31,221 reported
is still 416%); it only changes the case where a market cannot cover everything,
which now rates as thin rather than impossible.

Both §15 examples are asserted in the tests:

| Needed | Reported | Age | Coverage | Verdict |
|---|---|---|---|---|
| 7,500 | 31,221 | 3m | 416% | Very High |
| 7,500 | 8,015 | 5h 17m | 107% | Poor |

Two rules are absolute regardless of the other factor: **too little stock is
unusable however fresh the reading** (knowing precisely that there is not enough
does not help), and **a very old reading is unusable however much stock it
claimed**.

The safety margin applies to the *requirement*, never to the report — inflating
someone else's measurement would be inventing stock. Thresholds live in a
versioned `ConfidenceRules` object so they can be served later, and every plan
records which version judged it.

Nothing is hidden: `ConfidenceResult` returns coverage, the raw needed and
reported figures, the age, and a `factors` array whose text is rendered
verbatim. The explanation *is* the return value rather than something the UI
reconstructs.

## The sourcing plan (§16)

> "DO NOT merely find the nearest market for each commodity independently.
> Optimize the entire procurement operation."

A greedy set-cover: repeatedly take the station that best advances what is still
outstanding, subtract what it supplies, repeat. Greedy rather than optimal **on
purpose** — a true optimum over stations × commodities would have to be taken on
trust, and §16 requires the opposite. The cost is occasionally one more stop
than strictly necessary; the benefit is a plan auditable stop by stop.

§16 forbids collapsing the factors into an unexplained magic number. There is a
score, because something must be ranked, but every component is returned beside
it, and each stop carries plain-language reasons:

```
STOP 1  Deng Landing  (Synuefai NP-I c25-3)
   Ceramic Composites     8,412   moderate  [1,156,858 of 9,254 needed (12501%), 9h 32m old]
   ...
   selected because:
     - fulfils 5 of 5 outstanding commodities
     - 895 ls from arrival
     - planetary station
```

Rejections keep their reason too, which is what makes §16's "closer station
rejected because…" sentence possible:

```
Thuot Orbital: Power Generators data is 4643h old and stock is 471% of what is needed
```

That 4,643-hour observation is real: 98 of 53,281 market rows are genuinely
older than 30 days, from stations nobody has visited. It is exactly what the
confidence engine exists to catch.

### Station preference

Four modes, and the difference between them is real rather than cosmetic:

| Mode | Behaviour |
|---|---|
| `orbital-only` | Planetary stations are **excluded**, with a reason |
| `strongly-prefer-orbital` | A planetary station loses even when it covers twice as much and is 19 ly closer |
| `no-preference` | No adjustment |
| `planetary-if-better` | Planetary wins when it is genuinely better |

An exclusion is not a low score, and the two are separate code paths: a
commander who wonders where a station went can be told.

## Demonstrated on real data

Phase 9 is gated on the basic optimiser being "demonstrably correct", and unit
tests only demonstrate that code does what it was told. Replaying the real
journals:

```
5,813 depot events -> 21 distinct sites (17 complete, 4 active)
progress reported at 0.2%, 11.0%, 11.7%, 45.6%
combined outstanding: 19 commodities
resources whose symbol did not fold cleanly: 0
```

Planned against the live market database:

```
4 active sites, 19 outstanding commodities
market search returned 120 candidate stations

STOP 1  Craterside City      fulfils 17 of 19 outstanding commodities
STOP 2  Nilson's Progress    fulfils 2 of 2 outstanding commodities

Stations required: 2
Could not source: 0 commodities
```

Nineteen commodities in two stops is the "favour reducing unnecessary stops"
behaviour §16 asks for, and each purchase carries its §17 distribution —
Aluminium's 100,503 tonnes split across four sites as 50,208 + 45,220 + 4,575 +
500.

### The bug only real data found

Running against real requirements rather than fixtures produced **42 candidate
stations and zero stops**. The safety margin was applied to a take already
capped at available stock, so a partial fill scored `stock / (stock × 1.1)` =
91% coverage, failed the coverage minimum and rated `unusable`. Every large
requirement was therefore unsourceable.

A margin is headroom *above* what you take, and there is none when you are
clearing the shelf. It is dropped in that case and kept in every other.

A second run then returned zero stops again — correctly. The local development
database had stopped ingesting, so every observation in it was 57 hours old and
the confidence engine refused all of them:

```
Maddex Manufacturing: Steel data is 57h old and stock is 503% of what is needed
```

Plenty of stock, far too old. That is the engine doing its job, and the
distinction between "no good option" and "no fresh data" is visible in the
rejection rather than hidden behind an empty list.

## Multiple sites (§17)

Requirements combine across sites, so §17's example works as written: Ceramic
Composites of 4,000 + 3,200 + 3,200 becomes one purchase of 10,400, and
`allocate()` says how to distribute it — filling higher-priority sites first
rather than trickling proportionally and completing none of them.

Completed and failed sites contribute nothing. Continuing to shop for a finished
site would be actively misleading.

## Market search

`POST /v1/market/search` returns candidate stations and their offers. **The
server filters and ranks; the client plans.** Keeping planning in the client
means the reasoning stays where the commander can inspect it, and changing how
plans are built does not require a deployment. What the server owns is the part
only it can do efficiently — three-dimensional distance, freshness and stock
filtering — because doing that client-side would mean shipping the whole market
table to every commander.

Stations are ranked by how many of the requested commodities they carry, so the
client receives the ones that can actually reduce its stop count rather than an
arbitrary slice.

## Trying it

```bash
EDFM_API=https://api.edfieldmanual.com npx tsx packages/logistics/tools/plan-demo.mts
```

Runs §16's worked example against the live market database and prints the plan,
the reasons, and the rejections.

```bash
npm test --workspace @edfm/logistics
```
