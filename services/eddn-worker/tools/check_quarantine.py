"""Find out precisely why live messages fail schema validation.

The worker truncates validation errors to keep logs bounded, which is right for
production and useless for diagnosis. This prints the validator's own words.
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
import time
import zlib

import jsonschema
import zmq

sys.path.insert(0, "src")
from edfm_eddn.schemas import SchemaCache  # noqa: E402

RELAY = "tcp://eddn.edcd.io:9500"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=int, default=180)
    args = parser.parse_args()

    cache = SchemaCache()
    ctx = zmq.Context()
    sub = ctx.socket(zmq.SUB)
    sub.setsockopt(zmq.SUBSCRIBE, b"")
    sub.setsockopt(zmq.RCVTIMEO, 5000)
    sub.connect(RELAY)

    reasons: collections.Counter[str] = collections.Counter()
    per_schema: collections.Counter[str] = collections.Counter()
    total = 0
    failures = 0
    deadline = time.time() + args.seconds

    while time.time() < deadline:
        try:
            raw = sub.recv()
        except zmq.Again:
            continue
        try:
            envelope = json.loads(zlib.decompress(raw).decode("utf-8"))
        except Exception:
            continue

        total += 1
        ref = str(envelope.get("$schemaRef", ""))
        schema = cache.get(ref)
        if schema is None:
            continue

        try:
            jsonschema.validate(envelope, schema)
        except jsonschema.ValidationError as exc:
            failures += 1
            short = "/".join(ref.rstrip("/").split("/")[-2:])
            per_schema[short] += 1
            # The validator keyword is the diagnosis; the message body is noise.
            path = ".".join(str(p) for p in exc.absolute_path) or "(root)"
            reasons[f"{short}  {exc.validator} at {path}"] += 1
        except Exception as exc:  # noqa: BLE001
            reasons[f"validator error: {type(exc).__name__}"] += 1

    rate = 100.0 * failures / max(total, 1)
    print(f"\nValidated {total} messages, {failures} failed ({rate:.2f}%)\n")

    print("=== FAILURES BY SCHEMA ===")
    for schema, n in per_schema.most_common():
        print(f"  {schema:<28} {n}")

    print("\n=== FAILURE REASONS ===")
    for reason, n in reasons.most_common(20):
        print(f"  {n:>4}  {reason}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
