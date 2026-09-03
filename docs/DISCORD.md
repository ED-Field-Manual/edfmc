# Discord Forum Reporting

Status: **built and tested.** Discrepancies become Discord Forum posts, one per
issue, updated in place rather than reposted.

Lives entirely in `services/api`. The desktop client is not involved and holds
no Discord credential — see [Why there is no button in the app](#why-there-is-no-button-in-the-app).

## Enabling it

1. Create a webhook on a **Forum** channel (Channel Settings → Integrations →
   Webhooks). A text-channel webhook will not work; see [Forum channels are not
   text channels](#forum-channels-are-not-text-channels).
2. Copy `services/api/.env.example` to `services/api/.env`.
3. Set `EDFM_DISCORD_WEBHOOK` and `EDFM_DISCORD_ENABLED=true`.
4. Test it:

```bash
npm run discord:test --workspace @edfm/api
```

That posts a thread titled `EDFM Companion — Webhook Test` whose body is a fixed
string containing no game data. Delete it when you are done.

Reporting stays off unless `EDFM_DISCORD_ENABLED=true` **and** a webhook is set.
A half-configured deployment posts nothing rather than posting somewhere
unintended.

## Where the secret lives

`services/api/.env`, which is gitignored (`.env`, `.env.*`, with an
`!.env.example` exception). It is never in source, never in a log, never in an
error message, and never returned by an endpoint.

The webhook URL is a credential: anyone holding it can post to the channel as
the Companion. `redactUrl()` in `client.ts` exists because the natural thing for
an HTTP client to do — put the failing URL in the exception — would leak the
token into the log the first time Discord had an outage. It keeps the webhook
**id** (useful for telling several webhooks apart) and drops the token.

If a webhook is ever exposed, delete it in Discord and create a new one.
Rotating is the only remedy; the old URL keeps working until deleted.

`EDFM_ADMIN_TOKEN` guards `/v1/admin/*`. When it is unset, those routes are
**not registered at all**, so an unconfigured deployment exposes nothing rather
than exposing something open. The token is compared in constant time; a
length-or-prefix comparison would be a guessing oracle.

## Forum channels are not text channels

Executing a webhook against a Forum channel *must* carry `thread_name`, and that
call creates a new post. Adding to an existing post is a different request: same
webhook, `?thread_id=` on the query string, and **no** `thread_name`.

Getting this wrong does not fail usefully — it either 400s or silently opens a
duplicate post — so `createForumPost` and `sendThreadMessage` are separate
methods rather than one method with a flag.

## How thread ids are stored

`?wait=true` makes Discord return the created message, and that message's
`channel_id` **is** the new thread's id. It is parsed from the response and
written to `discord_reports.discord_thread_id`.

It is never inferred from the post title, which is neither unique nor stable —
two stations can produce the same title, and a moderator can rename a thread.
The stored id is the authoritative target for every later update.

## Duplicate identification

One Forum post per discrepancy. Identity is `discord_reports.discrepancy_key`,
which is the verification engine's existing key:

```
entityType | entityId | field | expectedValue | observedValue | gameVersion
```

Built from Elite's own identifiers — MarketID, SystemAddress, BodyID — rather
than display names, because names collide across systems and get renamed while
ids do not. Game version is part of it because the same field changing across a
game update is a genuinely different finding.

Two further layers stop repeat posts:

- A **partial unique index** on `(discrepancy_key, action) WHERE status =
  'pending'` collapses a burst of identical detections into one queued row, so a
  commander re-docking repeatedly does not become a queue of identical posts.
- `report()` only enqueues an update when something **material** changed: a new
  independent confirmation, a changed observed value, or a changed reference
  value. Otherwise it logs `discord.duplicate_suppressed` and stops. Thirty
  commanders hitting one wrong service is one thread with a confirmation count,
  not thirty threads.

## Resolution

When a discrepancy stops disagreeing, the report is marked resolved and one
message is posted:

> Resolved: EDFM now matches the value observed by the Companion.

`resolution_posted_at` is set **before** the message is queued, so a retry storm
or a restart cannot produce a second one. Set
`EDFM_DISCORD_POST_RESOLUTIONS=false` to mark resolutions locally without
posting.

## Spoiler protection

The pipeline, in order:

```
observation → normalize → compare → classify
  → spoiler/privacy eligibility → duplicate check → queue → Discord
```

The gate is **before** the transport, and it is the only entry point.
`reporter.report()` runs `eligible()` before anything is rendered, let alone
enqueued. The queue row holds finished text and nothing downstream re-reads game
state, so there is no second path by which unfiltered data could reach Discord —
"can this leak?" is answered by reading one function rather than auditing every
call site.

Default policy is **`suppress`**, not redact. The existing redaction was
designed for an administrative channel; a Forum post is public, permanent,
searchable, and readable by anyone in the server. "Verify aggressively, reveal
conservatively" points at not posting at all.

What is never submitted:

- undiscovered biological species
- biological signal contents before the appropriate scan
- unexplored body details that would spoil exploration
- first-discovery information not already legitimately known
- anything present in journal or state data but not yet revealed to the
  commander by their own game

`EDFM_DISCORD_SPOILER_POLICY=redact` posts a locationless stub instead: report
type, timestamp, Companion version and the opaque reference. No system, body,
station, field, or either value — an id is enough to look a system up, so it is
not a safe substitute for a name.

The suppression **log line carries no subject either**, only the category. A log
that named what it declined to post would be the leak the suppression prevented.

### The reference is not the key

Posts carry `opaqueReference(key)` — an FNV-1a hash that resolves to one
discrepancy for a reviewer and reads as nothing to anyone else.

Never the discrepancy key itself. That key is
`entityType|entityId|field|expected|observed|version`, so posting it as an
"observation id" would put the system, the field and both values straight into
the channel the redaction exists to keep them out of.

## Forum tags

Discord applies Forum tags by **snowflake id**, not by the name a moderator
sees, and those ids are per-channel. So they are configuration, never constants
in source:

```
EDFM_DISCORD_FORUM_TAGS=Station=123,Service=456,Needs Review=789
EDFM_DISCORD_FORUM_TAGS={"Station":"123","Service":"456"}
```

To find an id: Discord Settings → Advanced → Developer Mode, then right-click
the tag in the Forum channel's settings and Copy ID.

Recognised names: `Station`, `Settlement`, `System`, `Commodity`, `Service`,
`Outfitting`, `Shipyard`, `Engineer`, `Colonisation`, plus the lifecycle tags
`Needs Review`, `Confirmed`, `Resolved`.

**An unmapped category is simply not tagged.** A report that fails to post
because nobody configured a "Colonisation" tag id is strictly worse than one
that posts untagged. Unknown names and non-snowflake values are dropped with a
warning rather than throwing — the commonest mistake is pasting a display name
where an id belongs, and that must not stop the service booting.

Discord caps applied tags at five; more is a 400, so the list is truncated.

## Reliability

Reporting is decoupled from ingest by `discord_report_queue`. The server drains
it on a timer. Discord being slow, rate limited, or down never reaches back into
journal processing, and a queued report survives a restart because it is a row,
not memory.

| Condition | Behaviour |
|---|---|
| `429` | Honours `retry_after`, bounded by max attempts — not an unbounded honour-the-header loop |
| `5xx`, timeout, network failure | Exponential backoff with jitter, then abandoned after 5 attempts |
| `401` / `403`, or `404` on create | `invalid-webhook`; not retried, since a revoked credential will never start working |
| Missing / locked / archived thread | `thread-gone`; association marked `deleted`, not retried |
| Other `4xx` | `rejected`; not retried, because sending the same mistake again sends the same mistake |

Classification uses Discord's **error codes**, not status alone. Verified
against the live API: posting to a thread that does not exist returns HTTP
**400 with code 10003**, not the 404 the status-based assumption would predict.
Matching on `10003` / `10008` / `160005` is what makes that come out as
`thread-gone` rather than a generic rejection.

### Deleted threads

If a moderator deletes a thread, the failure is detected, `thread_status`
becomes `deleted`, `discord.thread_deleted` is logged, and nothing retries
against it. If the discrepancy is **still open**, the next detection clears the
dead association and creates a replacement post — so removing a thread does not
make the issue permanently invisible.

## Logged events

Never the webhook URL or token.

`discord.report_queued` · `discord.forum_post_created` · `discord.thread_updated` ·
`discord.duplicate_suppressed` · `discord.suppressed_by_spoiler_policy` ·
`discord.thread_deleted` · `discord.thread_association_invalid` ·
`discord.invalid_webhook` · `discord.rate_limited` · `discord.server_error` ·
`discord.network_error` · `discord.report_rejected` ·
`discord.report_retry_scheduled` · `discord.report_abandoned` ·
`discord.tag_unknown` · `discord.tag_not_a_snowflake`

## Why there is no button in the app

The original specification (§19) says the desktop client must never hold a
Discord webhook, database credential, or administrative key. A "send test
report" button in the app would need either the webhook or an admin token
present on the client, and neither may be there — a client that could post to
the channel could post anything to the channel.

So the test action is server-side: `npm run discord:test`, or
`POST /v1/admin/discord/test` with the admin token. The desktop Settings screen
governs whether *this commander contributes observations at all*, which is the
decision that actually belongs to them.

## Tests

```bash
npm test --workspace @edfm/api
```

No real Discord request is made anywhere in the suite: `fetchImpl` is injected
and `sleep` is stubbed so backoff does not slow the tests. Covered: one post per
discrepancy, duplicates suppressed, updates into the existing thread, resolution
posted once, spoiler-protected content never reaching the client, a missing tag
mapping not breaking reporting, 429 and 5xx handling, invalid webhook, deleted
and archived threads, the token never appearing in a log or a returned error,
and a disabled integration making no request at all.
