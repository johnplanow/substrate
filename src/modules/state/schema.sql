-- Substrate State Schema v1
-- Dolt-compatible DDL: composite natural business-key primary keys,
-- DATETIME columns to avoid timezone-dependent merge conflicts.

-- ---------------------------------------------------------------------------
-- stories
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stories (
  story_key       VARCHAR(100)   NOT NULL,
  sprint          VARCHAR(50),
  status          VARCHAR(30)    NOT NULL DEFAULT 'PENDING',
  phase           VARCHAR(30)    NOT NULL DEFAULT 'PENDING',
  ac_results      JSON,
  error_message   TEXT,
  created_at      DATETIME,
  updated_at      DATETIME,
  completed_at    DATETIME,
  PRIMARY KEY (story_key)
);

-- ---------------------------------------------------------------------------
-- contracts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contracts (
  story_key    VARCHAR(100)   NOT NULL,
  name         VARCHAR(200)   NOT NULL,
  direction    VARCHAR(20)    NOT NULL,
  schema_path  VARCHAR(500),
  transport    VARCHAR(200),
  recorded_at  DATETIME,
  PRIMARY KEY (story_key, name, direction)
);

-- ---------------------------------------------------------------------------
-- metrics
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metrics (
  story_key          VARCHAR(100)   NOT NULL,
  task_type          VARCHAR(100)   NOT NULL,
  recorded_at        DATETIME       NOT NULL,
  model              VARCHAR(100),
  tokens_in          BIGINT         NOT NULL DEFAULT 0,
  tokens_out         BIGINT         NOT NULL DEFAULT 0,
  cache_read_tokens  BIGINT         NOT NULL DEFAULT 0,
  cost_usd           DECIMAL(10,6)  NOT NULL DEFAULT 0,
  wall_clock_ms      BIGINT         NOT NULL DEFAULT 0,
  review_cycles      INT            NOT NULL DEFAULT 0,
  stall_count        INT            NOT NULL DEFAULT 0,
  result             VARCHAR(30),
  PRIMARY KEY (story_key, task_type, recorded_at)
);

-- ---------------------------------------------------------------------------
-- dispatch_log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispatch_log (
  story_key      VARCHAR(100)   NOT NULL,
  dispatched_at  DATETIME       NOT NULL,
  branch         VARCHAR(200),
  worker_id      VARCHAR(100),
  result         VARCHAR(30),
  PRIMARY KEY (story_key, dispatched_at)
);

-- ---------------------------------------------------------------------------
-- build_results
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS build_results (
  story_key    VARCHAR(100)   NOT NULL,
  timestamp    DATETIME       NOT NULL,
  command      VARCHAR(500),
  exit_code    INT,
  stdout_hash  VARCHAR(64),
  PRIMARY KEY (story_key, timestamp)
);

-- ---------------------------------------------------------------------------
-- review_verdicts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_verdicts (
  story_key     VARCHAR(100)   NOT NULL,
  timestamp     DATETIME       NOT NULL,
  verdict       VARCHAR(30),
  issues_count  INT            NOT NULL DEFAULT 0,
  notes         TEXT,
  PRIMARY KEY (story_key, timestamp)
);

-- ---------------------------------------------------------------------------
-- _schema_version
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS _schema_version (
  version      INT            NOT NULL,
  applied_at   DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  description  VARCHAR(500),
  PRIMARY KEY (version)
);

-- Seed schema version (idempotent via INSERT IGNORE)
INSERT IGNORE INTO _schema_version (version, description) VALUES (1, 'Initial substrate state schema');
