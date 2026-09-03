-- Discord Forum reporting, migration 003.
--
-- Two things are persisted, for two different reasons.
--
-- 1. `discord_reports` is the mapping from a discrepancy to the Forum thread
--    that represents it. Without it, every re-detection of the same issue
--    opens another Forum post, and moderators get thirty threads for one wrong
--    service. The thread id comes from Discord's own response and is
--    authoritative -- it is never inferred from a post title.
--
-- 2. `discord_report_queue` decouples reporting from journal ingest. Discord
--    being slow, rate limited, or down must never propagate back into game
--    monitoring, and a report must survive an outage rather than being lost
--    with the process that held it in memory.

BEGIN;

-- ------------------------------------------------------------- reports

CREATE TABLE IF NOT EXISTS discord_reports (
    report_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Stable identity, denormalised on purpose. It is built from Elite's own
    -- identifiers (MarketID, SystemAddress, BodyID) rather than display names,
    -- because names collide and are renamed while ids do not.
    discrepancy_key    TEXT NOT NULL UNIQUE,
    -- Kept as a convenience link. ON DELETE SET NULL rather than CASCADE: if a
    -- discrepancy row is ever removed, the record that we posted about it to a
    -- public forum must not vanish with it.
    discrepancy_id     BIGINT REFERENCES discrepancies (id) ON DELETE SET NULL,

    report_type        TEXT NOT NULL,
    -- Human-facing subject: station, settlement or system name.
    object_identifier  TEXT,

    -- Discord's own ids, captured from its response.
    discord_thread_id  TEXT,
    discord_message_id TEXT,
    -- active | deleted | archived | invalid. A thread a moderator removed must
    -- stop being a retry target rather than failing forever.
    thread_status      TEXT NOT NULL DEFAULT 'active',

    -- open | resolved
    status             TEXT NOT NULL DEFAULT 'open',
    confirmation_count INTEGER NOT NULL DEFAULT 1,
    -- What was last actually posted, so an update is only sent when something
    -- meaningfully changed rather than on every game event.
    last_reported_value TEXT,
    last_reported_expected TEXT,
    -- Guards the "post the resolution once" rule across restarts.
    resolution_posted_at TIMESTAMPTZ,

    first_detected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discord_reports_thread
    ON discord_reports (discord_thread_id) WHERE discord_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_discord_reports_status
    ON discord_reports (status, last_detected_at DESC);

-- --------------------------------------------------------------- queue

CREATE TABLE IF NOT EXISTS discord_report_queue (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    discrepancy_key TEXT NOT NULL,
    -- create | update | resolve | test
    action          TEXT NOT NULL,
    -- Rendered at enqueue time, after the spoiler check has already passed.
    -- Nothing downstream re-derives content from game state, so there is no
    -- second path by which unfiltered data could reach Discord.
    payload         JSONB NOT NULL,

    -- pending | sent | failed | skipped
    status          TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT,

    enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

-- The worker's only query: what is due, oldest first.
CREATE INDEX IF NOT EXISTS idx_discord_queue_due
    ON discord_report_queue (next_attempt_at)
    WHERE status = 'pending';

-- Collapses a burst of identical detections before any of them is sent. A
-- commander re-docking repeatedly must not become a queue of identical posts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_queue_dedupe
    ON discord_report_queue (discrepancy_key, action)
    WHERE status = 'pending';

COMMIT;
