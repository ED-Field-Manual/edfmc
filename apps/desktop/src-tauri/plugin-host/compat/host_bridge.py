"""Lets compat modules talk to the running host without importing it."""

from __future__ import annotations

from typing import Any, Callable

_status: Callable[[str], None] = lambda message: None
_publish: Callable[[str, Any], None] = lambda topic, data: None


def set_status_handler(handler: Callable[[str], None]) -> None:
    global _status
    _status = handler


def status(message: str) -> None:
    _status(message)


def set_publish_handler(handler: Callable[[str, Any], None]) -> None:
    global _publish
    _publish = handler


def publish(topic: str, data: Any) -> None:
    _publish(topic, data)
