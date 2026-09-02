"""Print the shape of sampled EDDN messages, one per schema.

Companion to sample_eddn.py. Field *names* differ between schemas in ways that
matter: journal/1 mirrors Frontier's PascalCase, while commodity/3 uses its own
lowercase naming. Assuming one applies to the other silently loses data.
"""

from __future__ import annotations

import argparse
import json


def describe(value: object, depth: int = 0) -> str:
    if isinstance(value, list):
        inner = json.dumps(value[0])[:160] if value else "(empty)"
        return f"list[{len(value)}]  first={inner}"
    if isinstance(value, dict):
        return f"object{{{', '.join(sorted(value.keys()))}}}"
    return json.dumps(value)[:140]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--schemas", nargs="*", default=None)
    args = parser.parse_args()

    with open(args.path, encoding="utf-8") as fh:
        samples = json.load(fh)

    wanted = args.schemas or sorted(samples)
    for key in wanted:
        if key not in samples:
            print(f"=== {key}: not sampled ===\n")
            continue
        envelope = samples[key]
        print(f"=== {key} ===")
        print("  schemaRef :", envelope.get("$schemaRef"))
        print("  header    :", ", ".join(sorted(envelope.get("header", {}))))
        message = envelope.get("message", {})
        print("  message   :")
        for field, value in sorted(message.items()):
            print(f"      {field:<26} {describe(value)}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
