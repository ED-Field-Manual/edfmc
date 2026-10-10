"""Lets compat modules talk to the running host without importing it."""

from __future__ import annotations

from typing import Any, Callable

_status: Callable[[str], None] = lambda message: None
_publish: Callable[[str, Any, Any], None] = lambda topic, data, folder: None


def set_status_handler(handler: Callable[[str], None]) -> None:
    global _status
    _status = handler


def status(message: str) -> None:
    _status(message)


def set_publish_handler(handler: Callable[[str, Any, Any], None]) -> None:
    global _publish
    _publish = handler


def publish(topic: str, data: Any, folder: str | None = None) -> None:
    _publish(topic, data, folder)


# --- native pages ------------------------------------------------------------

#: The plugin whose plugin_start3 is running, so `register_page` knows whose
#: page it is. Set and cleared by the host around that call.
loading: str | None = None
#: folder -> the plugin's action handler, for plugins drawn by the app.
pages: dict[str, Callable[[str, dict], None]] = {}
_page_update: Callable[[str, Any], None] = lambda folder, state: None


def set_page_handler(handler: Callable[[str, Any], None]) -> None:
    global _page_update
    _page_update = handler


def page_update(folder: str, state: Any) -> None:
    _page_update(folder, state)


# --- overlay panels ----------------------------------------------------------

#: folder -> the widget ids it registered ('' for its unnamed one).
overlay_widgets: dict[str, set[str]] = {}
_overlay_update: Callable[..., None] = lambda folder, title, content, widget=None, description=None: None


def set_overlay_handler(handler: Callable[..., None]) -> None:
    global _overlay_update
    _overlay_update = handler


def overlay_update(folder: str, title: str, content: Any, widget: str | None = None,
                   description: str | None = None) -> None:
    _overlay_update(folder, title, content, widget, description)
