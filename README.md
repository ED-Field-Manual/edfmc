# EDFM Companion

EDFM Companion is the official desktop companion for the [Elite Dangerous Field
Manual](https://edfieldmanual.com/). It is a standalone Windows application that
reads Frontier's journal files, keeps track of the commander's current context and
shows relevant EDFM guidance in the application or through an in-game overlay.

> [!IMPORTANT]
> EDFM Companion is under active development and does not yet have a stable public
> release.

## Support EDFM

If you find EDFM useful and want to support its continued development and
hosting, [support XplosivOctopus on Patreon](https://patreon.com/XplosivOctopus?utm_medium=unknown&utm_source=join_link&utm_campaign=creatorshare_creator&utm_content=copyLink).

## What is EDFM Companion?

EDFM Companion follows the journal as Elite Dangerous writes it. It does not read
game memory, inject code, automate input or write to the game. When Frontier has
not reported a value, the application keeps it unknown rather than filling the gap
with a guess.

It is not an EDMC plugin, does not depend on EDMarketConnector and is not presented
as a replacement for it. The core application has its own plugin architecture,
including declarative extensions and a Python host for compatible companion-tool
plugins. Individual plugins are distributed separately from the core application.

## Features

Current core capabilities include:

- **Real-time journal processing** for commander, ship, location, mission and
  activity state, with replay-safe local persistence.
- **Context-aware EDFM guidance** in the desktop application and configurable,
  click-through in-game overlay.
- **Mission tracking** for mission state, destinations and cargo delivery progress
  where Frontier reports it.
- **Colonisation and logistics tools** that track construction-site requirements
  and deliveries, then build market sourcing plans when the commander asks for
  one.
- **Exobiology tracking** for detected biological genera, live sample progress,
  completed specimens and EDFM reference links without claiming first discovery
  or first footfall.
- **Commander Field Journal** entries for durable activity such as completed
  specimens, detected signals, exobiology data sales and completed missions. Live
  sampling progress is stored separately as current activity state.
- **Screenshot capture and cataloguing** with a commander-chosen hotkey,
  game-window capture, context-assisted filenames, categories, tags, notes,
  optional Field Journal links and a local screenshot library.
- **Plugin infrastructure** for validated declarative extensions and compatible
  Python companion-tool plugins, with management and diagnostics in the app.
- **Optional community-service integrations** with explicit controls and visible
  sharing status.

Detailed behaviour and current limitations are documented in
[missions](docs/MISSIONS.md), [logistics](docs/LOGISTICS.md),
[activity tracking](docs/ACTIVITY-JOURNAL.md),
[screenshots](docs/SCREENSHOTS.md) and the [overlay](docs/OVERLAY.md) documentation.

## Integrations

All data-sharing integrations are disabled by default.

| Service | Current status | Purpose |
|---|---|---|
| EDDN | Built and wired; schema-fixture tested | Sends a sanitised set of anonymous community observations |
| EDSM | Built and tested against live API responses | Optionally submits journal entries under the commander's own API key |
| Inara | Built; Inara has approved the application, first live test pending | Optionally keeps the commander's Inara profile up to date: flight log, ranks, ships and loadouts, inventory and statistics |
| EDFM Commander Journal | Built; push-only | Optionally sends derived Field Journal entries to the commander's EDFM account |

See [External integrations](docs/INTEGRATIONS.md) for the payloads, queue behaviour
and current service-specific limits.

## Privacy and data

The application reads journal files locally. It does not upload raw journal files
wholesale, and it has no telemetry or analytics. Optional contribution and
community-service features send only their documented payloads after the commander
enables them. Market searches happen only when the commander requests a sourcing
plan.

Python plugin update checks can make read-only GitHub requests when Python plugins
are installed; they can be disabled and do not include journal or game data.
User-supplied integration credentials are stored locally through Windows Credential
Manager and are never returned to the web interface. EDFM project, server and
administrative secrets remain server-side.

Those guarantees describe EDFM Companion's own code. Installed Python plugins run
with the commander's user permissions and may read files or use the network, so
they should be treated like any other program and installed only from trusted
sources.

The complete network and storage account is in [Privacy](docs/PRIVACY.md).

## Plugins

EDFM Companion supports two extension mechanisms:

- [Declarative plugins](docs/PLUGINS.md) contribute validated data such as context
  rules. They cannot execute code.
- [Python plugins](docs/PYTHON-PLUGINS.md) run compatible companion-tool plugins in
  a separate host process. Python plugins are programs and should be installed only
  from trusted sources.

The loader, host, APIs, compatibility layers and plugin-management interface belong
to this repository. Individual plugins are separate projects and are not core EDFM
Companion features.

## Development

The repository requires Node.js 20 or later. Common workspace checks are:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Architecture and subsystem details are kept in:

- [Architecture](docs/ARCHITECTURE.md)
- [Journal processing](docs/JOURNAL.md)
- [Overlay](docs/OVERLAY.md)
- [External integrations](docs/INTEGRATIONS.md)
- [Activity Journal](docs/ACTIVITY-JOURNAL.md)
- [Screenshot system](docs/SCREENSHOTS.md)
- [Declarative plugins](docs/PLUGINS.md)
- [Python plugin host](docs/PYTHON-PLUGINS.md)

## Licence

MIT. See [LICENSE](LICENSE).

The overlay was written from scratch against the Win32 API rather than derived
from EDMCOverlay, which keeps this project under a permissive licence.

Elite Dangerous is a trademark of Frontier Developments plc. This project is
unofficial and is not affiliated with or endorsed by Frontier Developments.
