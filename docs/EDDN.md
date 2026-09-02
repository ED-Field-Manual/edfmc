# EDDN

Measured against the **live stream**, not documentation. A 120-second sample on
2026-09-02 captured 1,176 messages across 19 schemas with zero undecodable frames.

## Why this is server-side

Every Companion installation subscribing directly would mean each client
maintaining its own copy of the galaxy's market data. EDDN is a live event
*stream*, not a queryable database.

```
EDDN LIVE STREAM
      |
      v
EDFM EDDN WORKER      (one process, server-side)
      |
      v
NORMALIZATION / VALIDATION
      |
      v
EDFM DATABASE  (PostgreSQL)
      |
      v
EDFM API  ->  EDFM COMPANION
```

## Connection

| Property | Value |
|---|---|
| Relay | `tcp://eddn.edcd.io:9500` |
| Socket | ZeroMQ **SUB**, empty topic subscription (nothing arrives without it) |
| Frame | **zlib-compressed** JSON |
| Upload endpoint | `https://eddn.edcd.io:4430/upload/` — **not used**; we consume only |
| Observed rate | ~9.8 messages/second, ~850k/day |

## The live service is ahead of the repository

**Verified 2026-09-02.** `outfitting/3` messages are on the wire *right now*, and
`https://eddn.edcd.io/schemas/outfitting/3` serves a valid schema — but
`https://raw.githubusercontent.com/EDCD/EDDN/live/schemas/outfitting-v3.0.json`
returns **HTTP 404**. The `live` branch lists only `outfitting-v2.0.json`.

This is exactly the divergence §14 warns about, and it has a concrete consequence:

> **Fetch schemas from the live service by the message's own `$schemaRef` URL,
> and cache them. Never pin to a GitHub branch listing.**

A worker that validated against the repo would reject every `outfitting/3` message
as an unknown schema. Both outfitting versions are live simultaneously
(`outfitting/2` at 29 messages, `outfitting/3` at 1 in the sample), so the worker
must handle concurrent versions of the same schema rather than assuming one.

## Schema volume (120s sample, n=1,176)

| Schema | Messages | Share |
|---|---:|---:|
| `journal/1` | 549 | 46.7% |
| `fsssignaldiscovered/1` | 218 | 18.5% |
| `commodity/3` | 70 | 6.0% |
| `dockinggranted/1` | 56 | 4.8% |
| `fssdiscoveryscan/1` | 56 | 4.8% |
| `navroute/1` | 46 | 3.9% |
| `fssbodysignals/1` | 37 | 3.1% |
| `outfitting/2` | 29 | 2.5% |
| `shipyard/2` | 25 | 2.1% |
| `fssallbodiesfound/1` | 24 | 2.0% |
| `scanbarycentre/1` | 21 | 1.8% |
| `dockingdenied/1` | 16 | 1.4% |
| `codexentry/1` | 11 | 0.9% |
| `approachsettlement/1` | 6 | 0.5% |
| `scanorganic/1` | 6 | 0.5% |
| `fcmaterials_journal/1` | 3 | 0.3% |
| `outfitting/3`, `navbeaconscan/1`, `fcmaterials_capi/1` | 1 each | 0.1% |

## Field naming is NOT consistent across schemas

The single most dangerous assumption here, and one that silently loses data rather
than erroring:

| Schema | Naming | Example fields |
|---|---|---|
| `commodity/3`, `outfitting/*`, `shipyard/2` | **lowercase** | `marketId`, `stationName`, `stationType`, `systemName` |
| `journal/1`, `approachsettlement/1`, `dockinggranted/1` | **PascalCase** (Frontier's) | `MarketID`, `StationName`, `StationType`, `StarSystem` |

A first pass of the sampling tool looked only for PascalCase and concluded
`commodity/3` carried no station attributes at all. It carries four.

## Which schema supplies which station attribute

§14 asks this explicitly and forbids inventing what EDDN cannot supply. Measured:

| Attribute | Sources | Notes |
|---|---|---|
| `MarketID` | journal/1, commodity/3, approachsettlement/1, dockinggranted/1, dockingdenied/1, fcmaterials_* | The join key throughout |
| `stationName` | journal/1, commodity/3, outfitting/*, shipyard/2, dockinggranted/1, dockingdenied/1 | |
| `stationType` | journal/1 (13%), commodity/3, dockinggranted/1 (100%), dockingdenied/1 (100%) | Basis for orbital/planetary |
| **`DistFromStarLS`** | **journal/1 only** (~14% of its messages) | Sparse |
| **`LandingPads`** | **journal/1 only** (~12%) | Sparse |
| `StationServices` | journal/1 (13%), approachsettlement/1 (100%) | |
| `StationEconomies` | journal/1 (13%), approachsettlement/1 (100%) | |
| `StarPos` | journal/1, approachsettlement/1, and every FSS schema (100%) | System coordinates are abundant |
| `StationAllegiance` | journal/1 (3.8%), approachsettlement/1 (33%) | Too sparse to rely on |
| Orbital vs planetary | **Nowhere directly** | Must be derived from `stationType` via a normalization table |
| Fleet-carrier flag | **Nowhere directly** | `stationType == "FleetCarrier"` |

**Consequences for the Logistics optimizer (§16):**

- The commodity message alone is *not* enough. §14 anticipated this and it is
  confirmed: `commodity/3` gives market prices plus `stationType`, but neither
  arrival distance nor landing pads. Station metadata must be accumulated
  separately and merged by `MarketID`.
- Arrival distance and pad size come only from `journal/1` Docked/Location events,
  so coverage builds gradually as commanders dock. A station with no distance
  recorded must render as unknown, never as zero.
- Orbital vs planetary is a **derived** classification, not a reported field. That
  mapping is ours, and belongs in a documented table rather than scattered
  conditionals.

## Provenance available on every message

The header carries everything §27 needs:

```json
{
  "softwareName": "E:D Market Connector [Windows]",
  "softwareVersion": "6.1.2",
  "uploaderID": "9412b0bc…",
  "gameversion": "4.4.0.3",
  "gamebuild": "r330683/r0 ",
  "gatewayTimestamp": "2026-09-02T05:43:40.032604Z"
}
```

- `gatewayTimestamp` (relay receipt) and the message's own `timestamp` (observation)
  are **both** recorded. They differ, and the difference matters for freshness (§15).
- `gameversion`/`gamebuild` give §28's version segmentation for free.
- `uploaderID` is already hashed by the relay, as EDCD documents.

Top uploaders in the sample: E:D Market Connector (451), EDDiscovery (223), Elite
Warboard (116), EDO Materials Helper (86), EDDLite (45). Software identity is
retained because source quality is a confidence input, and a buggy uploader version
is something we will eventually need to exclude.

## Validation: what actually fails, and why we pass unknown schemas

Measured over 1,514 live messages: **4 failed validation (0.26%)**, all of them
`outfitting/2` violating `uniqueItems` at `message.modules` — uploaders sending
the same module twice in one list. That is an uploader bug, not ours, and it is
exactly what the `quarantine` table exists to make visible rather than silent.

**Messages whose schema cannot be fetched are passed through, not rejected.**
That is deliberate and follows directly from the `outfitting/3` finding: EDDN
adds schema versions before the repository catches up, so a worker that rejected
anything it did not already recognise would silently stop ingesting an entire
message type the day Frontier shipped an update. Normalization is defensive on
its own, so an unvalidated message is degraded rather than dangerous.

`$schemaRef` is attacker-influenced in principle — anyone can upload to EDDN — so
schema fetching is restricted to `eddn.edcd.io` over HTTPS, size-capped, and a
failed fetch is remembered so a hostile ref cannot cause one outbound request per
message.

## Verified end to end

The worker was run against the live stream in dry-run mode (956 messages over
120s): 250 station records, 62 markets, 9,947 commodity rows, 0 undecodable
frames, 0 reconnects, 18 schemas fetched and cached from the live service —
including `outfitting/3`, which the repository does not have.

```bash
python -m edfm_eddn.worker --dry-run --seconds 120
```

Dry-run consumes the real stream and reports what it *would* write, so the
pipeline is verifiable without a database.

## Reproducing

```bash
cd services/eddn-worker
python -m venv .venv && .venv/Scripts/pip install pyzmq
.venv/Scripts/python tools/sample_eddn.py --seconds 120 --out samples.json
.venv/Scripts/python tools/inspect_samples.py samples.json --schemas commodity/3
```

Re-run after any EDDN announcement. A new schema version appearing on the wire
before it appears in the repository is a normal event, not an anomaly.
