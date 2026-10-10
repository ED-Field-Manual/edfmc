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

API version 2 adds three things any plugin can use (docs/PYTHON-PLUGINS.md):

- `data_dir()`: a folder for the plugin's own data, outside its plugin folder,
  so updating the plugin does not wipe it.
- page kind `ui-v1`: describe a page as headings, stats, tables and controls,
  and the app draws it in its own theme. No page needs app code of its own.
- `register_overlay(title)`: one panel in the game overlay, made of the same
  blocks, display only, with its own on/off switch on the Overlay page.
"""

from __future__ import annotations

import json
import os
from typing import Any

import config as _config
import host_bridge

#: Bumped when something is added or a topic's shape changes.
API_VERSION = 2


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


# --- data folder ----------------------------------------------------------------


def data_dir() -> str:
    """
    A folder for this plugin's own data, created if needed.

    Beside the plugins folder rather than inside the plugin's: replacing a
    plugin's folder to update it must not take its data with it. Call it from
    `plugin_start3`, which is how the host knows whose folder it is.
    """
    folder = host_bridge.loading
    if folder is None:
        raise RuntimeError('data_dir must be called from plugin_start3')
    root = os.path.join(os.path.dirname(os.path.abspath(_config.config.plugin_dir_path)), 'plugin-data')
    path = os.path.join(root, folder)
    os.makedirs(path, exist_ok=True)
    return path


# --- overlay panels ---------------------------------------------------------------
#
#     panel = edfmc.register_overlay('Construction')   # in plugin_start3
#     panel.update({'blocks': [...]})                  # ui-v1 blocks, display only
#     panel.update(None)                               # nothing to show right now
#
# The app draws the panel in the game overlay with its own frame, position,
# transparency and on/off switch. A plugin that is switched off never runs, so
# never has a panel.


class OverlayPanel:
    def __init__(self, folder: str, title: str) -> None:
        self.folder = folder
        self.title = title

    def update(self, content: Any) -> None:
        json.dumps(content)  # must be plain JSON; raises otherwise
        host_bridge.overlay_update(self.folder, self.title, content)


def register_overlay(title: str) -> OverlayPanel:
    folder = host_bridge.loading
    if folder is None:
        raise RuntimeError('register_overlay must be called from plugin_start3')
    if not isinstance(title, str) or not title.strip():
        raise ValueError('title must be a non-empty string')
    panel = OverlayPanel(folder, title.strip()[:60])
    # Registered at once, empty, so its switch appears on the Overlay page.
    panel.update(None)
    return panel
