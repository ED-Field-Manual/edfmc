# EDFM API

Status: **deployed** at `https://api.edfieldmanual.com`. Reference lookup,
discrepancy submission, independence scoring and Discord reporting all work end
to end. See [DEPLOYMENT.md](DEPLOYMENT.md) for how it is hosted.

`services/api` — Node 20, Fastify 5, PostgreSQL. Shares a database with the EDDN
worker, and shares its comparison vocabulary with `@edfm/verification` so the
client and the server cannot drift into describing the same finding differently.

## The rule that shapes every endpoint

**The client is untrusted (§19).** It submits what its game reported. It does
not submit findings.

A finding is a claim about what the reference says, and the client does not hold
the reference. So the server re-derives every comparison from the submitted
observation and its own data. What the client believed it found travels in
`claimed`, is stored, and is never acted on — which turns a client-side
comparison bug into a visible disagreement instead of something that quietly
shapes the corpus.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Liveness, including a database round trip |
| `GET` | `/v1/reference/stations/:marketId` | Reference for one station |
| `POST` | `/v1/reference/stations/lookup` | Up to 200 at once |
| `POST` | `/v1/discrepancies` | Submit an observation |
| `GET` | `/v1/stats` | Public aggregate counters |
| `POST` | `/v1/admin/discord/test` | Post a webhook test (admin token) |
| `POST` | `/v1/admin/discord/flush` | Drain the report queue (admin token) |

`404` from a reference lookup means **not observed**, not *nonexistent*. The
client must never turn that absence into a finding.

## What the reference actually is

Worth being exact, because it is easy to overclaim.

The reference is the **aggregated community observation set** built by the EDDN
worker. It is served with `source: "eddn-aggregate"`, and no wording anywhere
may call it "what EDFM says".

EDFM still has no station dataset — see [VERIFICATION.md](VERIFICATION.md) for
the check that established that. Comparing against the aggregate answers a real
question ("does this commander's game disagree with what everyone else has
reported?") and is what seeds a dataset EDFM does not yet have. It is a
different question from "is EDFM wrong?", and the field name keeps the
difference visible. When EDFM gains station data it becomes a second
`ReferenceSource` alongside this one.

## Identity

Independence scoring needs to answer one question: *are these two reports from
the same reporter?* That needs distinguishability, not identity.

So the server stores keyed hashes — `fid_hash`, `commander_hash`,
`journal_hash` — and never the values. A database dump contains no commander
FIDs.

- `EDFM_IDENTITY_SALT` is **required at boot** and rejected below 32 characters.
  FIDs are short and structured, so a weak key makes the hashes reversible by
  anyone holding the database. That would make the privacy claim false rather
  than merely weak, which is worse than not making it.
- Domains are separated, so a commander whose name matches their journal
  filename does not corroborate themselves across two columns.
- Commander names are case-folded before hashing: one commander is one
  commander.
- Independence **fails closed**. A missing hash means we cannot show two reports
  differ, so they count as one. Anonymous reports therefore cannot inflate a
  confirmation count.

## Confirmation and notification

`independent_count` is **recomputed from the stored reports** on every write
rather than incremented. The rule will be refined; recomputation means the
refinement can be replayed over data already collected instead of applying only
to new reports.

Notification is once on creation and once on the first genuinely independent
confirmation, then silence. That is enforced by a primary key on
`(discrepancy_id, reason)`, so concurrent workers cannot both post and a restart
does not re-announce every finding ever made.

### Bulk differences are one finding

A real submission against Jaques Station produced **32 discrepancies from one
observation**, which would have been 32 Discord alerts.

A submission disagreeing about most of a station's services is far more likely
to be a partial observation than a station that lost twenty-nine services at
once. The channels are measurably not equivalent: `ApproachSettlement` (n=440)
is a flyby carrying a smaller set than `Docked` (n=1798).

So a bulk difference collapses into a single `normalization_conflict`, rated
`low` explicitly rather than inheriting `medium` from the semi-static baseline —
its whole premise is that the reading was probably partial, so it must not reach
a reviewer weighted like a finding we believe. Two independent triggers, because
one threshold is wrong either way: a proportion catches small stations, an
absolute count catches large ones.

Deliberate non-findings: an unknown station is absent data; fleet carrier
services are the owner's configuration, not a fact about the galaxy; and a
missing services array is not an empty one.

## Secrets

`EDFM_DISCORD_WEBHOOK` lives in the server's environment and nowhere else. It is
never returned by an endpoint, never logged, and never shipped to the client — a
client that could post to the channel could post anything to the channel.

Spoiler-sensitive findings are **suppressed** from Discord by default rather
than redacted: a Forum post is public and permanent, which is weaker containment
than the admin channel redaction was designed for. Reporting is off unless
explicitly enabled *and* given a webhook. See [DISCORD.md](DISCORD.md).

## Configuration

| Variable | Required | Default |
|---|---|---|
| `EDFM_DATABASE_URL` | yes | — |
| `EDFM_IDENTITY_SALT` | yes | — (min 32 chars) |
| `EDFM_DISCORD_ENABLED` | no | `false` |
| `EDFM_DISCORD_WEBHOOK` | no | none; reporting inert |
| `EDFM_DISCORD_FORUM_TAGS` | no | none; reports post untagged |
| `EDFM_DISCORD_SPOILER_POLICY` | no | `suppress` |
| `EDFM_DISCORD_POST_RESOLUTIONS` | no | `true` |
| `EDFM_DISCORD_INCLUDE_COMMANDER` | no | `false` |
| `EDFM_ADMIN_TOKEN` | no | none; `/v1/admin/*` not registered |
| `EDFM_RATE_LIMIT_PER_MINUTE` | no | `60` |
| `EDFM_PORT` / `EDFM_HOST` | no | `8787` / `127.0.0.1` |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Running it

```bash
npm run migrate --workspace @edfm/api
```

```bash
npm start --workspace @edfm/api
```

Migrations apply the EDDN worker's schema and the API's together, in filename
order, each inside the transaction that records it — so a migration that fails
halfway is not recorded as applied.

## Tests

```bash
npm test --workspace @edfm/api
```

Unit tests always run. The integration suite needs `EDFM_TEST_DSN` and skips
without it.

It **refuses to run against a database not named for testing**, and this is not
hypothetical: pointed at `edfm_dev` while the EDDN worker was ingesting into it,
the suite's `TRUNCATE` wiped the stations table mid-run. `dev` is not an
acceptable name — dev is where the real ingest lands.

```bash
createdb edfm_test
```
