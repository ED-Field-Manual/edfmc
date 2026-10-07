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


# --- native pages --------------------------------------------------------------
#
# A plugin can ask the app to draw its tab instead of drawing a tkinter panel:
#
#     page = edfmc.register_page(on_action)    # in plugin_start3
#     page.update({'kind': 'router-v1', ...})  # whenever its state changes
#
# The app renders pages whose `kind` it knows and sends the commander's input
# back as `on_action(name, args)`, called on the plugin's main thread. A plugin
# that registers a page gets no tkinter panel in EDFM Companion; in other hosts
# `edfmc` does not exist and it draws its own panel as usual.


class Page:
    def __init__(self, folder: str) -> None:
        self.folder = folder

    def update(self, state: Any) -> None:
        json.dumps(state)  # must be plain JSON; raises otherwise
        host_bridge.page_update(self.folder, state)


def register_page(on_action: Any) -> Page:
    folder = host_bridge.loading
    if folder is None:
        raise RuntimeError('register_page must be called from plugin_start3')
    if not callable(on_action):
        raise TypeError('on_action must be callable')
    host_bridge.pages[folder] = on_action
    return Page(folder)
