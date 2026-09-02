# EDDN

Verified 2026-09-01 against the EDCD `live` branch documentation and the live
service. **Not implemented yet — this is Phase 7.** Recorded now so the Phase 0
research is not lost.

## Why this is server-side

Every EDFM Companion installation subscribing directly to EDDN would be wasteful and
pointless: each client would maintain its own copy of the entire galaxy's market
data. EDDN is a live event *stream*, not a queryable database.

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
EDFM MARKET DATABASE  (PostgreSQL)
      |
      v
EDFM API  ->  EDFM COMPANION
```

The desktop client queries our API. It never opens a ZeroMQ socket.

## Connection facts

| Property | Value |
|---|---|
| Relay | `tcp://eddn.edcd.io:9500` |
| Socket | ZeroMQ **SUB** |
| Topic | empty string (some bindings require subscribing explicitly to `""`) |
| Frame encoding | **zlib-compressed** JSON — decompress each message |
| Upload endpoint | `https://eddn.edcd.io:4430/upload/` — **not used by us** |

We are a consumer only. Desktop clients must never upload; if EDFM ever contributes
data upstream, that is a server-side decision with its own review.

## Live schemas (`live` branch, 18)

`commodity-v3.0`, `journal-v1.0`, `outfitting-v2.0`, `shipyard-v2.0`,
`approachsettlement-v1.0`, `fssallbodiesfound-v1.0`, `fssbodysignals-v1.0`,
`fssdiscoveryscan-v1.0`, `fsssignaldiscovered-v1.0`, `navbeaconscan-v1.0`,
`navroute-v1.0`, `scanbarycentre-v1.0`, `codexentry-v1.0`, `blackmarket-v1.0`,
`dockingdenied-v1.0`, `dockinggranted-v1.0`, `fcmaterials_capi-v1.0`,
`fcmaterials_journal-v1.0`.

**Pin the `live` branch, not `master`.** They are not guaranteed identical, and the
live service is what actually validates messages. The worker validates each message
against the schema its own `$schemaRef` cites, and quarantines rather than discards
anything that fails.

## Worker requirements

- Reconnect with bounded exponential backoff; the relay does drop connections.
- Record both the observation timestamp and the gateway timestamp — they differ, and
  the difference matters for freshness scoring (§15).
- Preserve `softwareName` / `softwareVersion`: source quality is a confidence input,
  and a buggy uploader version is something we will eventually need to exclude.
- Tolerate unseen schema versions: log and quarantine, never crash.
- Expose ingestion health metrics (messages/sec, last message age, reject rate).
- **Never let an older observation overwrite a newer `market_latest` row.** This is an
  explicit test case in §35 and the most likely source of silent data corruption.

## Open questions for Phase 7

These are genuinely unresolved and must be answered from the schemas before the
Logistics module can be designed in detail:

- Which schema reliably supplies **station type**, **distance from arrival star**,
  **landing pad size**, **economy**, and the **orbital vs planetary** distinction?
  The commodity message alone does not carry every station attribute the optimizer
  needs; station metadata will have to be maintained separately and joined by
  `MarketID`.
- How are Fleet Carriers flagged, and how reliably?
- Commodity naming differs across sources. The journal's
  `ColonisationConstructionDepot` uses `$aluminium_name;`, while EDDN commodity
  messages use another form. A single normalization table with raw retention on both
  sides is a prerequisite for §16 — matching by display name would be a bug.

Where EDDN cannot supply a field reliably, we will not invent it.
