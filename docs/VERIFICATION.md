# Station Verification

Status: **observation capture built; comparison built but unfed.**

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
