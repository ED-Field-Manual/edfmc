"""Schema fetching and validation.

Schemas are fetched from the **live service** by each message's own `$schemaRef`,
never from a GitHub branch listing. That is not a stylistic preference: verified
2026-09-02, `outfitting/3` messages were on the wire and
`https://eddn.edcd.io/schemas/outfitting/3` served a valid schema, while
`outfitting-v3.0.json` on the repo's `live` branch returned HTTP 404.

A worker pinned to the repository would have rejected every one of those
messages as an unknown schema. Both `outfitting/2` and `outfitting/3` were live
simultaneously, so concurrent versions of one schema are normal.
"""

from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.request
from typing import Any

LOG = logging.getLogger(__name__)

#: Only these hosts may be fetched. A `$schemaRef` is attacker-influenced in
#: principle -- anyone can upload to EDDN -- so it must never become an
#: arbitrary outbound request.
ALLOWED_SCHEMA_HOSTS = frozenset({"eddn.edcd.io"})

FETCH_TIMEOUT_S = 10.0
MAX_SCHEMA_BYTES = 2 * 1024 * 1024


class SchemaCache:
    """Fetches and remembers EDDN schemas, including ones we have never seen.

    A schema that fails to fetch is remembered as unavailable so a broken or
    hostile `$schemaRef` cannot cause one outbound request per message.
    """

    def __init__(self, *, offline: bool = False) -> None:
        self._schemas: dict[str, dict[str, Any] | None] = {}
        self._lock = threading.Lock()
        #: When offline, nothing is fetched and everything validates trivially.
        #: Useful for tests and for running against captured samples.
        self.offline = offline

    def get(self, schema_ref: str) -> dict[str, Any] | None:
        if not schema_ref or self.offline:
            return None

        with self._lock:
            if schema_ref in self._schemas:
                return self._schemas[schema_ref]

        schema = self._fetch(schema_ref)
        with self._lock:
            self._schemas[schema_ref] = schema
        return schema

    def _fetch(self, schema_ref: str) -> dict[str, Any] | None:
        try:
            parsed = urllib.parse.urlsplit(schema_ref)
        except ValueError:
            return None

        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_SCHEMA_HOSTS:
            LOG.warning("refusing to fetch schema from %s", schema_ref)
            return None

        try:
            with urllib.request.urlopen(schema_ref, timeout=FETCH_TIMEOUT_S) as response:
                body = response.read(MAX_SCHEMA_BYTES)
            schema = json.loads(body.decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError) as exc:
            # A new schema version can appear on the wire before it is servable.
            # That is a reason to pass the message through, not to crash.
            LOG.warning("could not fetch schema %s: %s", schema_ref, exc)
            return None

        if not isinstance(schema, dict):
            return None

        LOG.info("cached schema %s", schema_ref)
        return schema

    @property
    def known(self) -> int:
        with self._lock:
            return sum(1 for v in self._schemas.values() if v is not None)

    @property
    def unavailable(self) -> list[str]:
        with self._lock:
            return sorted(k for k, v in self._schemas.items() if v is None)


class Validator:
    """Validates messages against their declared schema.

    Unknown or unfetchable schemas **pass**. That is deliberate: EDDN adds schema
    versions before the repository catches up, and a worker that rejected
    anything it did not already recognise would silently stop ingesting a whole
    message type the day Frontier shipped an update. Normalization is defensive
    on its own, so an unvalidated message is degraded, not dangerous.
    """

    def __init__(self, cache: SchemaCache) -> None:
        self.cache = cache
        self._impl = None
        try:
            import jsonschema  # noqa: PLC0415 - optional dependency

            self._impl = jsonschema
        except ImportError:
            LOG.warning("jsonschema not installed; messages will not be validated")

    def check(self, envelope: dict[str, Any]) -> tuple[bool, str | None]:
        """Return (ok, reason). `ok` is True when there is nothing to object to."""
        schema_ref = str(envelope.get("$schemaRef", ""))
        if not schema_ref:
            return False, "missing $schemaRef"

        if self._impl is None:
            return True, None

        schema = self.cache.get(schema_ref)
        if schema is None:
            return True, None  # unknown schema: pass, see class docstring

        try:
            self._impl.validate(envelope, schema)
        except self._impl.ValidationError as exc:
            # Bounded: a validation error against a large message can be huge.
            return False, str(exc.message)[:500]
        except Exception as exc:  # noqa: BLE001 - a broken schema must not stop ingest
            LOG.warning("validation error for %s: %s", schema_ref, exc)
            return True, None

        return True, None


import urllib.parse  # noqa: E402  - imported late to keep the module docstring first
