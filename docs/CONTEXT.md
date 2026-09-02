# Context Assistant

Surfaces EDFM material relevant to what the commander is doing, matched from journal
events by fixed rules.

## Determinism is a requirement, not a style choice

§6 forbids using a model to guess what the commander is doing, and the design takes
that literally. A context appears only when a rule's conditions are *literally*
satisfied by a journal event or by current state. There is no scoring, no inference,
no "probably mining". If the rule matches, the context shows; if it does not, nothing
shows.

This also makes the whole thing testable: the same event always produces the same
contexts.

## Rules are untrusted input

Rules are server-driven and versioned so EDFM's recommendations can change without
shipping a new desktop build. That means they arrive over the network, and the client
cannot audit what it is sent. Two design consequences:

- **Conditions are declarative.** There is no expression string, no `eval`, no
  function body — only a fixed set of comparisons combined with `all`/`any`/`not`. A
  compromised or buggy rule feed cannot execute code in the client.
- **There is deliberately no regex operator.** A server-supplied regular expression is
  a denial-of-service vector (catastrophic backtracking) against an application whose
  entire point is running quietly beside a game. `contains`, `startsWith` and
  `endsWith` cover the real matching needs.

Further guards, all tested:

- Dotted paths refuse `__proto__`, `constructor` and `prototype`.
- Condition recursion is depth-bounded.
- Rule count, resource count and string lengths are clamped on ingest.
- Duplicate rule ids are rejected — they would make expiry ambiguous.
- A missing or absurd TTL is clamped, so a context cannot pin itself on screen.
- Resource URLs must be `http(s)`. A rule set must not be able to hand the shell a
  `file:` or custom-scheme URL to open.
- An unrecognised condition kind (from a newer server) never matches and never throws.

## Condition kinds

| Kind | Matches against |
|---|---|
| `event` | The triggering event's raw name, or a list of names |
| `field` | A dotted path into the raw journal payload |
| `state` | A dotted path into current commander state |
| `service` | A normalized station-service id present in state |
| `all` / `any` / `not` | Composition |

`service` exists as its own kind rather than a `state` path because service tokens are
the most common trigger, and because matching **must** be case-folded: Frontier's raw
`StationServices` array genuinely mixes cases (`stationMenu` and `techBroker` sit
among 38 otherwise-lowercase tokens across the corpus).

## Priority and decay

§6 asks that the commander not be shown ten links at once.

- Each rule carries a **priority**; the resolver ranks by it and surfaces only the top
  few (3 in the main window, **1** in the overlay, where space over a game is scarce).
- Each rule carries a **TTL**. Without decay, a context triggered once would linger
  for the whole session. Re-matching refreshes expiry but is not treated as a change,
  so it does not force a re-render.
- Ties break on recency, because two rules of equal priority are best ordered by what
  the commander just did.

## The bundled rule set is verified twice

`packages/context/src/defaults.ts` is version 1, and doubles as the offline fallback
(§22). Everything in it was checked against reality, not assumed:

1. **Every linked page exists.** Titles were checked against a live MediaWiki
   `list=allpages` listing of EDFM (2026-09-01, ~280 pages). A rule pointing at a
   non-existent page produces a broken link that *looks* authoritative — worse than
   showing nothing. A test asserts this.
2. **Every trigger occurs in real journals.** Each event named was counted in the
   197,164-line corpus, and each service token was observed in real `StationServices`
   arrays. A rule keyed on an event the game never emits is dead weight that looks
   functional. A test asserts this too.

Rules store page *titles*, not URLs, so a change of domain or article path is a
one-line change rather than an edit to every rule.

## Station service tokens do not mean what their names suggest

A rule keyed on the `engineer` service token shipped briefly and was wrong: it
announced "At an Engineer" while the commander was docked at their own Fleet Carrier.

Measured across the corpus (242 distinct stations docked at):

| Token | Distinct stations | Verdict |
|---|---|---|
| `engineer` | **227 / 242**, including all 17 Fleet Carriers | Useless as an "at an Engineer" signal |
| `tuning` | 103 / 266, including Lave Station and Hutton Orbital | Not engineer-specific either; meaning unverified |
| `vistagenomics` | 129 / 266 | Genuine — carriers can install it, and do |
| `materialtrader` | 37 / 266 | Genuine |

Engineering is therefore triggered by **activity** (`EngineerCraft`,
`EngineerProgress`, `EngineerContribution`), which is unambiguous, rather than by a
station service.

**No service token reliably identifies an Engineer base.** Recognising one requires a
station-identity list — reference data that belongs server-side, since EDFM already
holds it. Until then the Companion says nothing rather than guessing.

The general lesson, and the reason this is recorded rather than quietly fixed: a
service token's *name* is not evidence of its meaning. Before a rule depends on one,
count how many distinct stations report it. A token present at 94% of stations cannot
be telling you anything specific.

## Content gaps found while building this

Several contexts named in the original brief have **no corresponding EDFM page**, so
no rule was written for them. These are content gaps, not code gaps — the rule engine
supports them the moment the pages exist, and because rules are server-driven, adding
them needs no client release:

| Wanted context | Status |
|---|---|
| Odyssey settlement guide | No settlement page found |
| Crime / security guide | No page found |
| Odyssey material guide | Only `Engineering Materials` exists, which is ship-side |
| Mission-type guides | No missions page found |
| Tech Broker | No page, though `techBroker` appears in 52 station observations |
| Black market | No page, though `blackmarket` appears in 475 |
| Apex Interstellar / Frontline Solutions / Bartender | No pages |

`vistagenomics` (872 observations) and `materialtrader` (131) *do* have usable targets
and are wired up.

## Overlay integration

The overlay receives only the single highest-ranked context, and its links are
rendered as **labels, not clickable links**. That is deliberate: the overlay is
click-through during normal play, so a link there could never be followed — showing
one would promise an interaction that cannot happen. The main window's Context page is
where resources actually open, in the user's browser.

## Provenance

Each active context records the event that triggered it and that event's id, shown on
the Context page (§27). When a context looks wrong, the first question — "what made
this appear?" — is answerable without guessing.
