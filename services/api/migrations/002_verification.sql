-- Verification submission and review schema, migration 002.
--
-- Two rules shape every table here.
--
-- 1. The client is untrusted (§19). It submits what its game reported; it does
--    not get to tell the server what the reference says, how independent its
--    report is, or how many confirmations exist. Those are derived here.
--
-- 2. Identifiers are hashed, never stored (§21). Independence scoring needs to
--    know whether two reports came from the same commander, which requires
--    distinguishability, not identity. A keyed hash gives exactly that and
--    nothing more: the server can say "these two differ" without ever holding
--    a commander's FID.

BEGIN;

-- ------------------------------------------------------------ submissions

-- §19 audit log. Every accepted submission, whatever it produced. Kept
-- separately from the discrepancies themselves so that deleting or merging a
-- finding never erases the record that it was reported.
CREATE TABLE IF NOT EXISTS submissions (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Keyed hashes (see identity.ts). Null when the submitter did not provide
    -- the field -- anonymous submissions still carry fid_hash, because
    -- independence is meaningless without it.
    fid_hash       TEXT,
    commander_hash TEXT,
    journal_hash   TEXT,
    -- 'anonymous' or 'commander'. Recorded so aggregate stats can report how
    -- much of the corpus is attributed without inspecting the hashes.
    identity_mode  TEXT NOT NULL,

    entity_type    TEXT NOT NULL,
    entity_id      TEXT NOT NULL,

    client_version TEXT,
    game_version   TEXT,
    game_build     TEXT,

    -- What the game actually said, verbatim. Normalization here is additive
    -- and reversible; the raw observation is the evidence (§9).
    observation    JSONB NOT NULL,

    -- What the client believed it found. Advisory only -- never used to create
    -- a discrepancy. Stored so a client-side comparison bug shows up as a
    -- disagreement with the server's own derivation instead of silently
    -- shaping the data.
    claimed        JSONB,

    -- Coarse; enough to rate limit and abuse-trace, not to locate anyone.
    source_hash    TEXT,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_submissions_entity
    ON submissions (entity_type, entity_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_received ON submissions (received_at DESC);

-- ---------------------------------------------------------- discrepancies

CREATE TABLE IF NOT EXISTS discrepancies (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Mirrors the client's discrepancyKey (§9): entity, field, both values and
    -- the game version. Version is part of identity because the same field
    -- changing across a game update is a new finding, not a recurrence.
    dedupe_key     TEXT NOT NULL UNIQUE,

    entity_type    TEXT NOT NULL,
    entity_id      TEXT NOT NULL,
    field          TEXT NOT NULL,
    kind           TEXT NOT NULL,
    volatility     TEXT NOT NULL,
    evidence_type  TEXT NOT NULL,

    expected_value JSONB,
    observed_value JSONB,
    game_version   TEXT,

    -- new | under_review | confirmed | rejected | resolved | superseded | conflicting
    status         TEXT NOT NULL DEFAULT 'new',
    confidence     TEXT NOT NULL,

    -- Derived, never submitted. report_count is every report; independent_count
    -- is how many of them could not have shared an origin.
    report_count      INTEGER NOT NULL DEFAULT 0,
    independent_count INTEGER NOT NULL DEFAULT 0,

    -- §21/spoilers: set when the finding names something a commander's own game
    -- may not have revealed. Controls Discord redaction.
    spoiler_sensitive BOOLEAN NOT NULL DEFAULT FALSE,

    first_reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_reported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discrepancies_status
    ON discrepancies (status, last_reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_discrepancies_entity
    ON discrepancies (entity_type, entity_id);

-- One row per report contributing to a discrepancy. Independence is computed
-- from these rather than stored as a running total, so the rule can be
-- corrected later and recomputed over data already collected.
CREATE TABLE IF NOT EXISTS discrepancy_reports (
    discrepancy_id BIGINT NOT NULL REFERENCES discrepancies (id) ON DELETE CASCADE,
    submission_id  BIGINT NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
    fid_hash       TEXT,
    commander_hash TEXT,
    journal_hash   TEXT,
    observed_at    TIMESTAMPTZ NOT NULL,
    recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (discrepancy_id, submission_id)
);

CREATE INDEX IF NOT EXISTS idx_reports_discrepancy ON discrepancy_reports (discrepancy_id);

-- Notify-once-on-create, once-on-first-independent-confirmation (§9). Held in
-- the database rather than in memory so a restart does not re-post everything
-- that was ever found.
CREATE TABLE IF NOT EXISTS discrepancy_notifications (
    discrepancy_id BIGINT NOT NULL REFERENCES discrepancies (id) ON DELETE CASCADE,
    reason         TEXT NOT NULL,
    redacted       BOOLEAN NOT NULL,
    delivered      BOOLEAN NOT NULL DEFAULT FALSE,
    detail         TEXT,
    sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (discrepancy_id, reason)
);

COMMIT;
