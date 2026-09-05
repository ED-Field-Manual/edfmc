# Plugins

Status: **built.** Plugins contribute context rules and research projects, load
at startup, and can be reloaded without restarting.

## Installing one

A plugin is a folder containing a `plugin.json`. Installing it means putting
that folder in the plugins directory.

1. Open **Settings → Plugins → Open plugins folder**. On Windows this is
   roughly `%APPDATA%\com.edfieldmanual.companion\plugins\`; the app shows the
   real path and opens it for you, so you never have to type it.
2. Drop the plugin's folder inside, so you have:

   ```
   plugins/
     deep-core-mining/
       plugin.json
   ```

3. Press **Reload plugins**.

The Settings table then lists it with its version and what it contributed. If
it did not load, it is listed anyway with the reason — a plugin that silently
did nothing is indistinguishable from one that was never installed.

That is the whole install flow. No archives, no build step, no restart, and
nothing is downloaded or executed.

## Why it is safe to install a stranger's plugin

**A plugin is data, not code.** There is no way to ship JavaScript through this
system and no code path that would run it if you did. A plugin contributes
declarative rules that the engines already evaluate.

That is not a limitation dodging effort — it is why the system can be safe.
`@edfm/context` conditions have a fixed operator set, no `eval`, and
deliberately no regular expressions (a supplied pattern is a denial-of-service
vector). Those defences exist because rules were always meant to arrive from a
server that should not be trusted. A third-party plugin is the same threat
model, so the same hardening applies unchanged.

Concretely, an installed plugin **cannot**:

- read your journal, or any file
- make a network request
- run code of any kind
- see anything the spoiler system hides from you
- replace or disable a built-in context rule

### Plugins may not collect chat, friends or identity

§21 forbids the application from persisting chat, friends, private-group
membership or commander identity. A plugin able to define its own research
observations could quietly undo that by recording `ReceiveText` into the local
database.

So there is a denylist, and a plugin that asks for one of those events is
**refused outright** rather than silently stripped:

```
Research project "chatlog" observes ReceiveText, which carries chat, friends
or commander identity. Plugins may not collect these.
```

Refusing rather than editing is deliberate. An author who asked for chat should
be told, not have their plugin quietly altered into something else.

## Writing one

```json
{
  "manifestVersion": 1,
  "id": "com.example.deep-core-mining",
  "name": "Deep Core Mining Helper",
  "version": "1.0.0",
  "author": "CMDR Example",
  "description": "Surfaces mining pages when you prospect a core asteroid.",
  "contributes": {
    "contextRules": [
      {
        "id": "core-asteroid",
        "title": "Deep core asteroid",
        "when": {
          "kind": "all",
          "of": [
            { "kind": "event", "name": "ProspectedAsteroid" },
            { "kind": "field", "path": "MotherlodeMaterial", "op": "exists" }
          ]
        },
        "priority": 80,
        "ttlSeconds": 240,
        "resources": [{ "label": "Core Mining", "page": "Mining" }]
      }
    ]
  }
}
```

A complete working example is in
[`examples/plugins/deep-core-mining`](../examples/plugins/deep-core-mining).

Check it before installing — this runs exactly the validation the app runs, so
"passes here" and "will load there" are the same statement:

```bash
npx tsx packages/plugins/tools/check.mts examples/plugins/deep-core-mining
```

```
OK: Deep Core Mining Helper 1.0.0 (com.example.deep-core-mining)
   context rules:     2
     - com.example.deep-core-mining/core-asteroid  "Deep core asteroid"  ttl 240s
```

### Conditions

| Kind | Meaning |
|---|---|
| `event` | The journal event name, e.g. `Docked`. Accepts a list. |
| `field` | A dotted path into the raw event, with `exists`, `eq`, `neq`, `contains`, `startsWith`, `endsWith`, `gt`, `gte`, `lt`, `lte` |
| `state` | The same, against current commander state |
| `service` | A case-folded station service id is present, e.g. `materialtrader` |
| `all` / `any` / `not` | Combine the above |

There is no regular-expression operator, and there will not be one.

### Ids are namespaced for you

Your rule `core-asteroid` becomes `com.example.deep-core-mining/core-asteroid`.
Two plugins can use the same short id without colliding, and no plugin can
shadow a built-in rule. If a namespacing bug ever let an id collide, built-ins
are merged first so the shipped rule wins.

### Limits

Enforced per plugin, because a plugin folder is user-supplied input:

| Limit | Value |
|---|---|
| Plugins considered | 50 |
| Context rules per plugin | 200 |
| Research projects per plugin | 10 |
| Manifest size | 512 KB |
| Rule TTL | clamped to 24 hours |

Exceeding a limit is a warning and a truncation, not a rejection — the plugin
still loads, and Settings says what was dropped.

## What is deliberately not pluggable

**Confidence thresholds.** A plugin quietly loosening them would make the app
recommend a twenty-hour-old market as trustworthy, and that failure is
invisible to the commander at exactly the moment they are deciding to fly forty
light years. Thresholds stay application- and server-controlled.

**Anything requiring code.** Verification providers and overlay widgets are
real extension points in the codebase, but exposing them means executing
third-party code with the app's privileges — which would hand a plugin author
the whole journal and the ability to defeat spoiler protection. If that becomes
worth doing, it belongs in a capability-stripped window like the overlay
already uses, not in this system.

## For maintainers

- `@edfm/plugins` holds the manifest schema and validation. It is pure and
  tested; nothing in it touches the filesystem.
- `plugins.rs` reads one directory, one level deep, and returns text. Recursing
  would let a plugin hide manifests inside another plugin's folder, which makes
  "which plugin contributed this" unanswerable.
- Loading happens before ingest starts, so a contributed rule is live for the
  first journal line rather than the second.
- The loader never throws. A plugin system that can stop the app from starting
  is worse than no plugin system.
