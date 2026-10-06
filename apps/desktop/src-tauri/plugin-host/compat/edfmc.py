"""
EDFM Companion extras for plugins.

Only exists inside EDFM Companion, so a plugin that does `import edfmc` in a
try/except gains these features here and loses nothing elsewhere.

`publish(topic, data)` hands the app a small piece of JSON to show. Topics the
app understands:

- `route`: the plugin's current route, shown in the overlay's Route widget.
  `data` is an object with `next`, `nextIsNeutron`, `destination`, `jumpsLeft`,
  `totalJumps`, `waypoint`, `waypoints`, `finished`; or `None` to clear it.

Anything else is ignored. Nothing published leaves the machine.
"""

from __future__ import annotations

import json
from typing import Any

import host_bridge

#: Bumped if the shape of a topic changes.
API_VERSION = 1


def publish(topic: str, data: Any) -> None:
    if not isinstance(topic, str) or not topic:
        raise ValueError('topic must be a non-empty string')
    json.dumps(data)  # must be plain JSON; raises otherwise
    host_bridge.publish(topic, data)
