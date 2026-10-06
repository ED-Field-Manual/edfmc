"""Lets compat modules talk to the running host without importing it."""

from __future__ import annotations

from typing import Callable

_status: Callable[[str], None] = lambda message: None


def set_status_handler(handler: Callable[[str], None]) -> None:
    global _status
    _status = handler


def status(message: str) -> None:
    _status(message)
