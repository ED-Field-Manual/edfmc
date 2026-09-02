"""EDDN ingest worker.

Connects to the live relay, validates, normalizes and persists. Runs unattended,
so every failure path degrades rather than exits: a bad frame is skipped, an
unknown schema passes, a failed database write is retried on the next batch.

Dry-run mode consumes the real stream and reports what it *would* write, which
is how the pipeline is verified end-to-end without a database.
"""

from __future__ import annotations

import argparse
import collections
import logging
import os
import signal
import sys
import time
from typing import Any

from .normalize import MarketRecord, StationRecord, is_planetary, iter_records
from .relay import RelaySettings, subscribe
from .schemas import SchemaCache, Validator

LOG = logging.getLogger("edfm_eddn")

#: Commit every N messages or every N seconds, whichever comes first. Batching
#: matters at ~10 messages/second: a commit per message would spend most of the
#: worker's time on transaction overhead.
BATCH_SIZE = 200
BATCH_SECONDS = 5.0


class Counters:
    def __init__(self) -> None:
        self.messages = 0
        self.stations = 0
        self.markets = 0
        self.commodities = 0
        self.quarantined = 0
        self.by_schema: collections.Counter[str] = collections.Counter()
        self.unknown_station_types: collections.Counter[str] = collections.Counter()
        self.started = time.time()

    def report(self) -> str:
        elapsed = max(time.time() - self.started, 1e-9)
        return (
            f"{self.messages} msgs ({self.messages / elapsed:.1f}/s) | "
            f"{self.stations} stations | {self.markets} markets "
            f"({self.commodities} commodity rows) | {self.quarantined} quarantined"
        )


def short_schema(schema_ref: Any) -> str:
    """`https://eddn.edcd.io/schemas/commodity/3` -> `commodity/3`, for reporting."""
    if not isinstance(schema_ref, str) or not schema_ref:
        return "unknown"
    parts = schema_ref.rstrip("/").split("/")
    return "/".join(parts[-2:]) if len(parts) >= 2 else schema_ref


def process(
    envelope: dict[str, Any],
    counters: Counters,
    store: Any | None,
    validator: Validator,
) -> None:
    counters.messages += 1
    counters.by_schema[short_schema(envelope.get("$schemaRef"))] += 1

    ok, reason = validator.check(envelope)
    if not ok:
        counters.quarantined += 1
        # Logged, not silent: a rising quarantine rate is how we find out that
        # either an uploader or our validation has gone wrong.
        LOG.warning("quarantined %s: %s", short_schema(envelope.get("$schemaRef")), reason)
        if store is not None:
            store.quarantine(
                envelope.get("$schemaRef"), "schema-validation", reason or "", envelope
            )
        return

    for record in iter_records(envelope):
        if isinstance(record, StationRecord):
            counters.stations += 1
            if record.station_type and is_planetary(record.station_type) is None:
                counters.unknown_station_types[record.station_type] += 1
            if store is not None:
                store.write_station(record)
        elif isinstance(record, MarketRecord):
            counters.markets += 1
            counters.commodities += len(record.commodities)
            if store is not None:
                store.write_market(record)


def connect_store(dsn: str) -> Any:
    import psycopg  # noqa: PLC0415 - only needed when actually persisting

    from .store import Store

    return Store(psycopg.connect(dsn, autocommit=False))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="EDFM EDDN ingest worker")
    parser.add_argument(
        "--dsn",
        default=os.environ.get("EDFM_DATABASE_URL"),
        help="PostgreSQL DSN. Omit for a dry run.",
    )
    parser.add_argument("--dry-run", action="store_true", help="consume but do not write")
    parser.add_argument("--seconds", type=int, default=0, help="stop after N seconds (0 = forever)")
    parser.add_argument("--no-validate", action="store_true")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
    )

    dry_run = args.dry_run or not args.dsn
    store = None
    if not dry_run:
        LOG.info("connecting to database")
        store = connect_store(args.dsn)
    else:
        LOG.info("dry run: consuming the live stream, writing nothing")

    cache = SchemaCache(offline=args.no_validate)
    validator = Validator(cache)
    counters = Counters()
    settings = RelaySettings()

    stopping = False

    def stop(_sig: int, _frame: Any) -> None:
        nonlocal stopping
        stopping = True
        LOG.info("shutting down")

    signal.signal(signal.SIGINT, stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop)

    deadline = time.time() + args.seconds if args.seconds else None
    relay_snapshot: dict[str, Any] | None = None
    since_commit = 0
    last_commit = time.time()

    try:
        for envelope in subscribe(settings):
            try:
                process(envelope, counters, store, validator)
            except Exception as exc:  # noqa: BLE001 - one bad message must not stop ingest
                counters.quarantined += 1
                LOG.exception("failed to process message: %s", exc)
                if store is not None:
                    try:
                        store.quarantine(
                            envelope.get("$schemaRef"), "processing-error", str(exc), envelope
                        )
                    except Exception:  # noqa: BLE001
                        LOG.exception("could not quarantine")

            since_commit += 1
            now = time.time()
            if store is not None and (since_commit >= BATCH_SIZE or now - last_commit > BATCH_SECONDS):
                try:
                    store.bump_stats(
                        total=since_commit,
                        accepted=since_commit - counters.quarantined,
                        quarantined=counters.quarantined,
                        reconnects=settings.stats.reconnects,
                    )
                    store.commit()
                except Exception as exc:  # noqa: BLE001
                    LOG.exception("commit failed, continuing: %s", exc)
                since_commit = 0
                last_commit = now

            if counters.messages % 500 == 0:
                LOG.info("%s", counters.report())

            if stopping or (deadline and time.time() > deadline):
                # Snapshot before breaking: closing the generator runs its
                # cleanup, which clears the connection state the summary reports.
                relay_snapshot = settings.stats.snapshot()
                break
    finally:
        if store is not None:
            try:
                store.commit()
            except Exception:  # noqa: BLE001
                LOG.exception("final commit failed")

    print("\n=== INGEST SUMMARY ===")
    print(f"  {counters.report()}")
    print(f"  relay: {relay_snapshot or settings.stats.snapshot()}")
    print(f"  schemas cached: {cache.known}")
    if cache.unavailable:
        print(f"  schemas unavailable (passed through): {', '.join(cache.unavailable)}")

    print("\n  messages by schema:")
    for schema, n in counters.by_schema.most_common(20):
        print(f"    {schema:<32} {n}")

    if counters.unknown_station_types:
        print("\n  UNCLASSIFIED STATION TYPES (update the mapping in normalize.py):")
        for station_type, n in counters.unknown_station_types.most_common():
            print(f"    {station_type:<32} {n}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
