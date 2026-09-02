"""EDDN relay subscriber.

Handles the connection concerns §14 calls for: reconnect with sane backoff,
zlib framing, and tolerating anything the wire hands us without dying.

Nothing here interprets messages -- that is normalize.py's job -- so this stays
small enough to reason about, which matters for the piece that has to survive
unattended for weeks.
"""

from __future__ import annotations

import json
import logging
import random
import time
import zlib
from dataclasses import dataclass, field
from typing import Any, Iterator

import zmq

LOG = logging.getLogger(__name__)

RELAY_URL = "tcp://eddn.edcd.io:9500"

#: Nothing arrives without an explicit empty-topic subscription: EDDN publishes
#: on no topic, and ZeroMQ SUB sockets are silent until subscribed.
EMPTY_TOPIC = b""


@dataclass
class RelayStats:
    messages: int = 0
    undecodable: int = 0
    reconnects: int = 0
    last_message_at: float | None = None
    connected_since: float | None = None

    def snapshot(self) -> dict[str, Any]:
        now = time.time()
        return {
            "messages": self.messages,
            "undecodable": self.undecodable,
            "reconnects": self.reconnects,
            # Silence is the failure mode that matters: a dead relay looks
            # identical to a quiet one until you check message age.
            "seconds_since_last_message": (
                None if self.last_message_at is None else round(now - self.last_message_at, 1)
            ),
            "uptime_seconds": (
                None if self.connected_since is None else round(now - self.connected_since, 1)
            ),
        }


@dataclass
class RelaySettings:
    url: str = RELAY_URL
    #: Treat the connection as dead after this long with no traffic. The live
    #: stream runs near 10 messages/second, so a full minute of silence means
    #: something is wrong rather than quiet.
    silence_timeout_s: float = 60.0
    receive_timeout_ms: int = 5_000
    initial_backoff_s: float = 1.0
    max_backoff_s: float = 60.0
    stats: RelayStats = field(default_factory=RelayStats)


def _next_backoff(current: float, settings: RelaySettings) -> float:
    """Exponential backoff with jitter, capped.

    Jitter matters even for a single client: without it, every EDDN consumer
    that dropped during the same outage reconnects in lockstep the moment the
    relay returns.
    """
    doubled = min(current * 2, settings.max_backoff_s)
    return doubled * (0.5 + random.random() * 0.5)


def subscribe(settings: RelaySettings | None = None) -> Iterator[dict[str, Any]]:
    """Yield decoded EDDN messages forever, reconnecting as needed.

    Undecodable frames are counted and skipped rather than raised: a single bad
    frame must never take down an ingest process that is otherwise healthy.
    """
    settings = settings or RelaySettings()
    stats = settings.stats
    ctx = zmq.Context.instance()
    backoff = settings.initial_backoff_s

    while True:
        sub = ctx.socket(zmq.SUB)
        sub.setsockopt(zmq.SUBSCRIBE, EMPTY_TOPIC)
        sub.setsockopt(zmq.RCVTIMEO, settings.receive_timeout_ms)
        # Drop pending messages instantly on close; a backlog after a reconnect
        # is stale by definition.
        sub.setsockopt(zmq.LINGER, 0)

        try:
            sub.connect(settings.url)
            stats.connected_since = time.time()
            LOG.info("connected to %s", settings.url)
            last_seen = time.time()
            backoff = settings.initial_backoff_s  # reset only after connecting

            while True:
                try:
                    raw = sub.recv()
                except zmq.Again:
                    # A receive timeout is not an error at this rate, but a long
                    # run of them is: ZeroMQ reconnects underneath us silently,
                    # so a socket can look alive while delivering nothing.
                    if time.time() - last_seen > settings.silence_timeout_s:
                        LOG.warning(
                            "no messages for %.0fs; reconnecting",
                            settings.silence_timeout_s,
                        )
                        break
                    continue

                last_seen = time.time()
                stats.last_message_at = last_seen

                try:
                    envelope = json.loads(zlib.decompress(raw).decode("utf-8"))
                except Exception as exc:  # noqa: BLE001 - any bad frame is skippable
                    stats.undecodable += 1
                    LOG.debug("undecodable frame: %s", exc)
                    continue

                if not isinstance(envelope, dict):
                    stats.undecodable += 1
                    continue

                stats.messages += 1
                yield envelope

        except zmq.ZMQError as exc:
            LOG.warning("relay error: %s", exc)
        finally:
            sub.close()
            stats.connected_since = None

        stats.reconnects += 1
        LOG.info("reconnecting in %.1fs", backoff)
        time.sleep(backoff)
        backoff = _next_backoff(backoff, settings)
