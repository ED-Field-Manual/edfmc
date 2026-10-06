"""Host functions plugins may call."""

from __future__ import annotations

import host_bridge


def show_error(err: str) -> None:
    """Show a short error in the plugin window's status line."""
    host_bridge.status(err)


class PluginError(Exception):
    pass
