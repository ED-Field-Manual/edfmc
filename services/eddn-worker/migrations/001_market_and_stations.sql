-- EDFM market and station schema, migration 001.
--
-- Normalized tables for the entities we query (§26), with raw payloads kept only
-- where they earn their storage.
--
-- The central correctness rule is encoded in SQL rather than application code:
-- an older observation must never overwrite a newer one in the *_latest tables.
-- EDDN delivers out of order routinely -- two commanders dock minutes apart and
-- their uploaders relay at different speeds -- so this is the normal case, not an
-- edge case. Doing it in the ON CONFLICT clause makes it hold even with several
-- worker processes writing concurrently.

BEGIN;

-- ---------------------------------------------------------------- systems

CREATE TABLE IF NOT EXISTS systems (
    system_address   BIGINT PRIMARY KEY,
    name             TEXT NOT NULL,
    -- StarPos is present on 100% of the schemas that carry it, and is the basis
    -- for every distance calculation the optimizer will do.
    x                DOUBLE PRECISION,
    y                DOUBLE PRECISION,
    z                DOUBLE PRECISION,
    first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_systems_name ON systems (lower(name));

-- --------------------------------------------------------------- stations

CREATE TABLE IF NOT EXISTS stations (
    -- §19: MarketID is the stable key. Present on 100% of station-bearing
    -- messages, and unlike a name it does not collide across systems.
    market_id        BIGINT PRIMARY KEY,
    name             TEXT,
    station_type     TEXT,
    system_address   BIGINT REFERENCES systems (system_address),
    system_name      TEXT,

    -- Derived by us, not reported by EDDN (see docs/EDDN.md). NULL means the
    -- station type was not one we recognise -- never assume orbital.
    is_planetary     BOOLEAN,
    is_fleet_carrier BOOLEAN NOT NULL DEFAULT FALSE,

    -- journal/1 is the only source for these two, on ~13% of its messages, so
    -- coverage accrues slowly. NULL means unknown, never zero.
    dist_from_star_ls DOUBLE PRECISION,
    landing_pads      JSONB,

    -- Case-folded ids for matching; raw tokens retained as evidence (§9).
    service_ids      TEXT[],
    services_raw     TEXT[],
    economies        JSONB,

    -- Provenance of the newest observation that produced this row (§27).
    observed_at      TIMESTAMPTZ,
    gateway_at       TIMESTAMPTZ,
    software_name    TEXT,
    software_version TEXT,
    game_version     TEXT,
    game_build       TEXT,
    schema_ref       TEXT,

    first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stations_system ON stations (system_address);
CREATE INDEX IF NOT EXISTS idx_stations_name ON stations (lower(name));
-- Carriers are excluded from most logistics queries, so make that cheap.
CREATE INDEX IF NOT EXISTS idx_stations_carrier ON stations (is_fleet_carrier);

-- ------------------------------------------------------------ commodities

CREATE TABLE IF NOT EXISTS commodities (
    -- EDDN's lowercase symbol, e.g. 'advancedcatalysers'. Journal and market
    -- naming differ; the mapping to Frontier's $name; form lives in a separate
    -- table so neither side has to be guessed from the other.
    symbol           TEXT PRIMARY KEY,
    display_name     TEXT,
    first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------- market observations

-- Full history. §14 wants history, not only current state, so confidence
-- scoring can look at how a market has behaved rather than one reading.
CREATE TABLE IF NOT EXISTS market_observations (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    market_id        BIGINT NOT NULL,
    commodity        TEXT NOT NULL,
    buy_price        INTEGER,
    sell_price       INTEGER,
    mean_price       INTEGER,
    stock            INTEGER,
    demand           INTEGER,
    stock_bracket    SMALLINT,
    demand_bracket   SMALLINT,
    observed_at      TIMESTAMPTZ NOT NULL,
    gateway_at       TIMESTAMPTZ,
    software_name    TEXT,
    software_version TEXT,
    game_version     TEXT,
    recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_market_obs_lookup
    ON market_observations (market_id, commodity, observed_at DESC);

-- Materialised current state, which is what the API actually serves.
CREATE TABLE IF NOT EXISTS market_latest (
    market_id        BIGINT NOT NULL,
    commodity        TEXT NOT NULL,
    buy_price        INTEGER,
    sell_price       INTEGER,
    mean_price       INTEGER,
    stock            INTEGER,
    demand           INTEGER,
    stock_bracket    SMALLINT,
    demand_bracket   SMALLINT,
    observed_at      TIMESTAMPTZ NOT NULL,
    gateway_at       TIMESTAMPTZ,
    software_name    TEXT,
    software_version TEXT,
    game_version     TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (market_id, commodity)
);

-- Freshness is a first-class query: §15 scores confidence on observation age,
-- so "how old is this" must not require a sequential scan.
CREATE INDEX IF NOT EXISTS idx_market_latest_commodity
    ON market_latest (commodity, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_latest_stock
    ON market_latest (commodity, stock DESC) WHERE stock > 0;

-- ------------------------------------------------------------ quarantine

-- §14: reject or quarantine malformed messages. Kept rather than dropped so a
-- normalization bug can be diagnosed from what actually arrived, and replayed
-- once fixed.
CREATE TABLE IF NOT EXISTS quarantine (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schema_ref   TEXT,
    reason       TEXT NOT NULL,
    detail       TEXT,
    payload      JSONB,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quarantine_reason ON quarantine (reason, received_at DESC);

-- --------------------------------------------------------- ingest health

CREATE TABLE IF NOT EXISTS ingest_stats (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    messages_total      BIGINT NOT NULL DEFAULT 0,
    messages_accepted   BIGINT NOT NULL DEFAULT 0,
    messages_quarantined BIGINT NOT NULL DEFAULT 0,
    reconnects          BIGINT NOT NULL DEFAULT 0,
    last_message_at     TIMESTAMPTZ,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ingest_stats (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Station types seen on the wire that our orbital/planetary table does not
-- classify. A row appearing here is the signal to update the mapping.
CREATE TABLE IF NOT EXISTS unknown_station_types (
    station_type TEXT PRIMARY KEY,
    seen_count   BIGINT NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
