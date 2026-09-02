"""Sample the live EDDN stream and report which schemas carry which fields.

Research tool, not part of the worker. §14 requires finding out which EDDN
schemas actually supply station type, arrival distance, landing pads, economy,
services and the orbital/planetary distinction -- and explicitly forbids
inventing a field EDDN cannot supply reliably. The only way to know is to look.

Usage:
    python tools/sample_eddn.py --seconds 120
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
import time
import zlib

import zmq

RELAY = "tcp://eddn.edcd.io:9500"

# Station attributes the Logistics optimizer will need (§14). Tracked by name so
# the report says plainly which schema, if any, is a source for each.
STATION_FIELDS = [
    "StationType",
    "DistFromStarLS",
    "LandingPads",
    "StationServices",
    "StationEconomy",
    "StationEconomies",
    "StationName",
    "MarketID",
    "StarSystem",
    "SystemAddress",
    "StarPos",
    "StationFaction",
    "StationGovernment",
    "StationAllegiance",
    "Body",
    "BodyType",
    "CarrierDockingAccess",
    "Economies",
    "Services",
]


def schema_name(ref: str) -> str:
    """Short name from a $schemaRef URL, e.g. .../commodity/3 -> commodity/3."""
    return "/".join(ref.rstrip("/").split("/")[-2:])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=int, default=90)
    parser.add_argument("--out", default=None, help="write one sample per schema as JSON")
    args = parser.parse_args()

    ctx = zmq.Context()
    sub = ctx.socket(zmq.SUB)
    # Empty topic: EDDN publishes on no topic, so an empty subscription is
    # required or nothing arrives at all.
    sub.setsockopt(zmq.SUBSCRIBE, b"")
    sub.setsockopt(zmq.RCVTIMEO, 5000)
    sub.connect(RELAY)

    counts: collections.Counter[str] = collections.Counter()
    # schema -> field -> how many messages carried it
    fields: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    softwares: collections.Counter[str] = collections.Counter()
    samples: dict[str, dict] = {}
    total = 0
    bad = 0

    deadline = time.time() + args.seconds
    print(f"Subscribing to {RELAY} for {args.seconds}s ...", file=sys.stderr)

    while time.time() < deadline:
        try:
            raw = sub.recv()
        except zmq.Again:
            continue

        try:
            # Every frame is zlib-compressed JSON.
            msg = json.loads(zlib.decompress(raw).decode("utf-8"))
        except Exception:
            bad += 1
            continue

        total += 1
        schema = schema_name(msg.get("$schemaRef", "unknown"))
        counts[schema] += 1

        header = msg.get("header", {})
        softwares[f"{header.get('softwareName')} {header.get('softwareVersion')}"] += 1

        message = msg.get("message", {})
        if isinstance(message, dict):
            for field in STATION_FIELDS:
                if field in message:
                    fields[schema][field] += 1
            samples.setdefault(schema, msg)

    print(f"\nMessages: {total}   undecodable: {bad}   distinct schemas: {len(counts)}\n")

    print("=== SCHEMA VOLUME ===")
    for schema, n in counts.most_common():
        print(f"  {schema:<34} {n:>6}  ({100.0 * n / max(total, 1):.1f}%)")

    print("\n=== STATION FIELD AVAILABILITY BY SCHEMA ===")
    print("(percentage of that schema's messages carrying the field)\n")
    for schema, n in counts.most_common():
        present = fields[schema]
        if not present:
            continue
        print(f"  {schema}  (n={n})")
        for field, seen in present.most_common():
            print(f"      {field:<24} {seen:>6}  {100.0 * seen / n:>5.1f}%")
        print()

    print("=== FIELD -> SCHEMAS THAT SUPPLY IT ===")
    for field in STATION_FIELDS:
        providers = [
            f"{schema} ({100.0 * fields[schema][field] / counts[schema]:.0f}%)"
            for schema in counts
            if fields[schema][field] > 0
        ]
        print(f"  {field:<24} {', '.join(providers) if providers else 'NONE OBSERVED'}")

    print("\n=== TOP UPLOADERS ===")
    for name, n in softwares.most_common(8):
        print(f"  {name:<40} {n}")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(samples, fh, indent=2)
        print(f"\nWrote one sample per schema to {args.out}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
