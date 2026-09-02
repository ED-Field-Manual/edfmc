# EDFM Verification Engine

Status: **engine, evidence model and spoiler gating built; station provider
registered; reference data still absent.**

## Shape

Generic, not station-specific. A provider answers one question — "does this event
disagree with EDFM, and how?" — and the engine owns everything else:
accumulation, deduplication, independence, conflict, and when to notify.

```
journal event -> provider -> finding -> engine -> discrepancy -> queue -> backend -> Discord
                                          |
                                    visibility gate
                                          |
                                    player-safe view
```

Adding body, settlement, system or engineer verification later is a
`engine.register(provider)` call. Nothing in the engine knows what a station is.

## Evidence

| Type | Meaning | May correct EDFM? |
|---|---|---|
| `direct` | The game explicitly reported it | Yes |
| `derived` | Deterministically computed from direct values, by a documented rule | Yes |
| `inferred` | The Companion believes it from context; Elite never said it | **No** |

`canRaiseDiscrepancy()` enforces this, and the engine drops inferred findings
before they can become a discrepancy. Inference has somewhere to live that is
clearly *not* evidence.

## Static vs dynamic

Wording follows volatility, not severity:

| Volatility | Examples | Phrasing |
|---|---|---|
| `static` | station type, body properties | "EDFM value appears incorrect" |
| `semi-static` | station services | "EDFM value may need review" |
| `dynamic` | controlling faction, market, Powerplay | "EDFM value may be outdated" |

A dynamic field never rates above `low` confidence however directly it was
observed — the observation being accurate says nothing about EDFM having been
wrong when it was recorded. Telling a maintainer that EDFM is "wrong" about a
faction that flipped last Thursday is untrue, and erodes trust in every other
report.

## Discrepancy kinds

Not a single "wrong" bucket:

`missing_in_game` · `missing_in_edfm` · `value_mismatch` · `unknown_edfm_entity` ·
`unknown_game_token` · `stale_dynamic_value` · `normalization_conflict`

Both directions are detected: EDFM having a service the game does not report, and
the game reporting one EDFM lacks.

## Lifecycle and deduplication

`new → under_review → confirmed / rejected / resolved / superseded`, plus
`conflicting`.

Identity is `entityType|entityId|field|expected|observed|gameVersion`. Game
version is part of it because the same field changing across an update is a
different finding, not the same one recurring.

- **First report** → create, notify.
- **First genuinely independent confirmation** → notify once more.
- **Everything after** → accumulate silently. Thirty users hitting one wrong
  service is one finding.
- **A contradicting observation** → status becomes `conflicting`; **neither**
  observation is discarded.

Independence requires a different commander FID, a different commander name, and
a different journal file. Conservative on purpose: over-counting duplicates only
slows confirmation, while under-counting manufactures confidence that was never
earned.

## Spoiler safety

Every observation carries a `visibility` gate, so redaction is decided by the
data rather than by whichever code path renders or notifies. See
[SPOILERS.md](SPOILERS.md) for the model, the reveal ladder, and the known gaps.

---

## The finding that shaped this phase

## The finding that shapes this phase

§9 describes comparing a station observation against "EDFM's stored station/service
data". Checked against the live wiki on 2026-09-02:

- There is **no `Stations` category**. The category list holds Engineers, Modules,
  Ships, Commodities, Materials, Guides and so on — no stations.
- The **`Locations` category contains fifteen pages**, all engineer systems
  (Deciat, Wyrd, Laksak, Meene, Muang, Kuwemaki, Colonia, Eurybia) and engineer
  workshops (Farseer Inc, Black Hide, Trader's Rest, Phoenix Base, Broo's Legacy,
  Demolition Unlimited, The Jet's Hole).
- `Deciat` mentions Farseer Inc in prose. There is no infobox, no template, and no
  machine-readable service data anywhere on it.

**EDFM currently has no station dataset, so there is nothing to verify against.**
Building the comparison and pointing it at an empty reference would report every
service at every station as a discrepancy — thousands of confident, useless
findings.

This is not a blocker so much as a reordering: the observations the Companion
collects are the only plausible seed for that dataset. Verification against EDFM
becomes possible once EDFM has something to be verified.

## What is built

**Observation capture** (`observeStation`) turns journal events into evidence.
Passive, per §9 — nothing prompts the commander and nothing is submitted anywhere.

Three channels carry `StationServices`, and the channel is recorded because they
are not equivalent evidence: `Docked` (n=1798) means the commander was physically
there, `ApproachSettlement` (n=440) is a flyby reading, and `Location` is a
session-start snapshot. Weighting can distinguish them later rather than guessing.

Every observation carries full provenance (§27): commander, FID, game version,
build, timestamp, and the `file:byteOffset` event id that ties it back to the exact
journal line.

Deliberate refusals:

- **No MarketID, no observation.** Without stable identity there is nothing to
  attach evidence to. Present on 100% of both event types.
- **No services array, no observation.** Recording an empty list would assert the
  station *has* no services, which is a far stronger claim than "the game did not
  say".
- **Allegiance is excluded from change detection.** Absent 68% of the time, so
  comparing it would make identical observations look like the station kept
  changing.

**Comparison** (`compareStation`) is written and tested but not called. It exists
now because it is small, and because getting it wrong produces confident false
reports — which for a reference project is worse than producing none.

Its rules:

- **Case-folded matching.** Frontier's array mixes cases (`stationMenu`,
  `techBroker`), so comparison uses the folded id while every report quotes the raw
  token as evidence, per §9.
- **Fleet carriers are never compared.** Their services are the owner's current
  configuration, not a fact about the galaxy.
- **"Extra" findings are suppressible.** A reference listing five services is far
  likelier to be incomplete than the game is to be wrong.
- **Identity must match.** Differing MarketIDs mean two different places, not a
  discrepancy.

**Independence** (`areIndependent`) implements §9's requirement that two reports
must not become truth if they could share an origin. Same commander, same FID, or
same journal file counts as one observation repeated. Deliberately conservative:
treating genuinely independent reports as duplicates only slows confirmation, while
the reverse manufactures confidence that was never earned.

## Open decisions

These need answers before the rest of Phase 5 is worth building:

1. **Where does station reference data come from?** The Companion can seed it from
   observations, but that makes the Companion the source of truth for data it is
   also supposed to verify — which needs care, and human review before anything
   reaches the wiki (§32 already says the verification queue and the MediaWiki
   update stay separate operations).
2. **Where does the backend live?** Discrepancy submission, server-side validation,
   independence scoring and Discord notification all require one. §19's security
   requirements — rate limiting, authentication, audit logging — are hosting
   decisions as much as code ones.
3. **What identity model?** §20 offers anonymous, CMDR-attributed and
   EDFM-account-linked. Independence scoring is materially weaker under anonymity,
   since FID is what makes two reports distinguishable.

Until then the client captures and stores locally, which costs nothing and loses
nothing: §22 already requires observations to queue offline and survive.
