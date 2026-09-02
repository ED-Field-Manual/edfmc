# Spoiler Safety

> **Verify aggressively. Reveal conservatively.**
>
> If this commander's game has not revealed it, the Companion must not reveal it.

This is treated as a privacy boundary. The protected resource happens to be
undiscovered gameplay rather than personal data, but the failure mode is the
same: silent, irreversible for the person affected, and unnoticed until someone's
exploration has already been spoiled.

## The two worlds

| | May know | May show |
|---|---|---|
| **Verification engine** | Anything, including EDFM data about places the commander has never visited | Nothing directly |
| **Player-facing app** | Only what this commander's own game has reported | Everything it knows |

Crossing from the first to the second happens in exactly one place:
`VisibilityPolicy`. Nothing else may.

## The reveal ladder, as Elite actually implements it

Measured from the journal corpus. It is more granular than intuition suggests,
and collapsing any two of these steps would spoil something:

| Event | Reveals | Does **not** reveal |
|---|---|---|
| `FSDJump` / `Location` | the system was visited | anything per-body |
| `FSSDiscoveryScan` | how many bodies exist | which, or what is on them |
| `FSSBodySignals` | **signal counts** for a body ("Biological: 5") | genus, species |
| `SAASignalsFound` | signal counts **and the genus list** | species |
| `ScanOrganic` | **genus, species and variant** of one sample | other species on the body |

A commander who has mapped a planet legitimately knows `Stratum`. They do **not**
know `Stratum Tectonicas`. Those are separate gates (`genus-known`,
`species-known`) precisely because the game treats them separately.

## Visibility levels

```ts
{ kind: 'public' }                                   // guides, mechanics, own state
{ kind: 'system-visited';  systemAddress }
{ kind: 'body-scanned';    systemAddress, bodyId }
{ kind: 'signals-known';   systemAddress, bodyId }   // FSS or DSS
{ kind: 'genus-known';     systemAddress, bodyId, genus }
{ kind: 'species-known';   systemAddress, bodyId, species }
{ kind: 'verification-only' }                        // never shown, by construction
```

Two rules that are not negotiable:

- **Unrecognised gates fail closed.** A gate from a newer server than this client
  resolves to hidden. Failing open spoils something, and that cannot be undone.
- **Hidden fields are omitted, not nulled.** A present-but-empty key still says
  "there is something here", and a count of hidden items is itself a spoiler.

## How the boundary is enforced

The type system, not discipline:

```ts
export type PlayerSafe<T> = T & { readonly [PLAYER_SAFE]: true };
```

The brand is phantom — free at runtime. `VisibilityPolicy.reveal()` and
`.project()` are the only functions that produce one. A developer adding a widget
next year cannot leak by forgetting a conditional; they would have to reach for
`unsafeAssumePlayerSafe(value, reason)`, which is deliberately conspicuous in a
diff and demands a written justification.

In the client, `apps/desktop/src/lib/spoiler.ts` is the single crossing point.
Context resources are filtered there, in `Companion.projectedContexts()`, before
the snapshot is built — so no component ever receives an ungated resource.

### What is deliberately *not* gated

Dashboard, Missions, travel state and station data are all things this
commander's own game reported about their own situation. They were on screen in
Elite before they were on screen here. Gating them would be theatre, and would
dilute the meaning of the gates that matter.

## Discovery state

- Built **only** from local journal events. EDFM and EDDN are never discovery
  sources — the question is not "is this known?" but "has this commander been
  told?".
- Scoped by commander **FID**, and `DiscoveryState.fromJSON` re-checks the FID
  rather than trusting the stored row. Two commanders sharing a PC is ordinary;
  inheriting each other's discoveries is not.
- Persisted (`discovery_state` table) so a restart neither loses legitimate
  discoveries nor reveals anything because server data happens to exist.
- Additive only. The game never un-tells a commander something.

## Context links

The label is the spoiler; the link never has to be clicked. Offering
"Stratum Tectonicas" to a commander who has not identified the species tells them
what is on the planet.

Rules therefore carry a declarative gate:

```ts
{ label: 'Exobiology' }                                      // public
{ label: 'Stratum Tectonicas', requires: { kind: 'species', species: 'Stratum Tectonicas' } }
```

The resolver still *matches* rules containing gated resources — resolution is
allowed to know more than the player. Only projection removes them.

## Discord redaction

Spoiler-sensitive discrepancies are redacted **by default**. An administrative
channel is still forwardable, searchable and permanent, and an exploration
finding names an unvisited system and an unscanned species.

A redacted payload carries: type, game version, confirmation count, and an opaque
reference. It does **not** carry the system, body, species, field, or either
value.

One trap worth recording, because it was nearly shipped: the discrepancy key is
`entityType|entityId|field|expected|observed|gameVersion`. Posting it as the
"observation id" would have put everything the redaction removes straight back
into the channel. Payloads carry `opaqueReference(key)` — an FNV-1a hash — which
resolves to one discrepancy for a reviewer and reads as nothing to anyone else.

`notificationStrings(payload)` returns every string a payload would post, so
tests assert on the whole payload rather than on the fields someone remembered to
check. A field added later is covered automatically.

## Where leakage is still possible

Stated plainly, because claiming completeness would be worse than the gaps:

1. **No body/exobiology provider exists yet.** The gates and tests are in place,
   but nothing yet compares body data, so the exobiology path is proven at the
   policy level rather than end to end.
2. **Overlay and Dashboard render ungated journal state.** Correct today — it is
   all the commander's own reported state — but nothing *structurally* prevents a
   future widget there from being handed EDFM-sourced data. Only the context path
   is currently forced through the projection.
3. **Log files.** Verification logging deliberately records entity type and field
   but never values. A future `logger.debug` with a discrepancy object in it
   would write undiscovered data to disk.
4. **`unsafeAssumePlayerSafe` exists.** By design, but it is a real bypass.
5. **Aggregate counts.** Contributions shows totals only, which cannot identify a
   location. A future per-discrepancy list there would need gating.

## Tests

`packages/verification/test/spoiler.test.ts` walks one body through the whole
ladder — arrival, FSS, DSS, organic scan — asserting at each step both what
becomes visible and what must not. Plus commander-switch isolation, restart
persistence, fail-closed behaviour, and Discord redaction.
