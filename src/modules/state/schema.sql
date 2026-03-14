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

-- ---------------------------------------------------------------------------
-- turn_analysis (story 27-4)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS turn_analysis (
  story_key         VARCHAR(64)    NOT NULL,
  span_id           VARCHAR(128)   NOT NULL,
  turn_number       INTEGER        NOT NULL,
  name              VARCHAR(255)   NOT NULL DEFAULT '',
  timestamp         BIGINT         NOT NULL DEFAULT 0,
  source            VARCHAR(32)    NOT NULL DEFAULT '',
  model             VARCHAR(64),
  input_tokens      INTEGER        NOT NULL DEFAULT 0,
  output_tokens     INTEGER        NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER        NOT NULL DEFAULT 0,
  fresh_tokens      INTEGER        NOT NULL DEFAULT 0,
  cache_hit_rate    DOUBLE         NOT NULL DEFAULT 0,
  cost_usd          DOUBLE         NOT NULL DEFAULT 0,
  duration_ms       INTEGER        NOT NULL DEFAULT 0,
  context_size      INTEGER        NOT NULL DEFAULT 0,
  context_delta     INTEGER        NOT NULL DEFAULT 0,
  tool_name         VARCHAR(128),
  is_context_spike  BOOLEAN        NOT NULL DEFAULT 0,
  child_spans_json  TEXT           NOT NULL DEFAULT '[]',
  PRIMARY KEY (story_key, span_id)
);

CREATE INDEX IF NOT EXISTS idx_turn_analysis_story ON turn_analysis (story_key, turn_number);

INSERT IGNORE INTO _schema_version (version, description) VALUES (2, 'Add turn_analysis table (Epic 27-4)');

-- ---------------------------------------------------------------------------
-- efficiency_scores
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS efficiency_scores (
  story_key                     VARCHAR(64)  NOT NULL,
  timestamp                     BIGINT       NOT NULL,
  composite_score               INTEGER      NOT NULL DEFAULT 0,
  cache_hit_sub_score           DOUBLE       NOT NULL DEFAULT 0,
  io_ratio_sub_score            DOUBLE       NOT NULL DEFAULT 0,
  context_management_sub_score  DOUBLE       NOT NULL DEFAULT 0,
  avg_cache_hit_rate            DOUBLE       NOT NULL DEFAULT 0,
  avg_io_ratio                  DOUBLE       NOT NULL DEFAULT 0,
  context_spike_count           INTEGER      NOT NULL DEFAULT 0,
  total_turns                   INTEGER      NOT NULL DEFAULT 0,
  per_model_json                TEXT         NOT NULL DEFAULT '[]',
  per_source_json               TEXT         NOT NULL DEFAULT '[]',
  PRIMARY KEY (story_key, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_efficiency_story ON efficiency_scores (story_key, timestamp DESC);

-- ---------------------------------------------------------------------------
-- recommendations (story 27-7)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recommendations (
  id                       VARCHAR(16)   NOT NULL,
  story_key                VARCHAR(64)   NOT NULL,
  sprint_id                VARCHAR(64),
  rule_id                  VARCHAR(64)   NOT NULL,
  severity                 VARCHAR(16)   NOT NULL,
  title                    TEXT          NOT NULL,
  description              TEXT          NOT NULL,
  potential_savings_tokens INTEGER,
  potential_savings_usd    DOUBLE,
  action_target            TEXT,
  generated_at             VARCHAR(32)   NOT NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_recommendations_story ON recommendations (story_key, severity);

-- ---------------------------------------------------------------------------
-- category_stats (story 27-5)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS category_stats (
  story_key          VARCHAR(100)   NOT NULL,
  category           VARCHAR(30)    NOT NULL,
  total_tokens       BIGINT         NOT NULL DEFAULT 0,
  percentage         DECIMAL(6,3)   NOT NULL DEFAULT 0,
  event_count        INTEGER        NOT NULL DEFAULT 0,
  avg_tokens_per_event DECIMAL(12,2) NOT NULL DEFAULT 0,
  trend              VARCHAR(10)    NOT NULL DEFAULT 'stable',
  PRIMARY KEY (story_key, category)
);

CREATE INDEX IF NOT EXISTS idx_category_stats_story ON category_stats (story_key, total_tokens);

-- ---------------------------------------------------------------------------
-- consumer_stats (story 27-5)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consumer_stats (
  story_key           VARCHAR(100)   NOT NULL,
  consumer_key        VARCHAR(300)   NOT NULL,
  category            VARCHAR(30)    NOT NULL,
  total_tokens        BIGINT         NOT NULL DEFAULT 0,
  percentage          DECIMAL(6,3)   NOT NULL DEFAULT 0,
  event_count         INTEGER        NOT NULL DEFAULT 0,
  top_invocations_json TEXT,
  PRIMARY KEY (story_key, consumer_key)
);

CREATE INDEX IF NOT EXISTS idx_consumer_stats_story ON consumer_stats (story_key, total_tokens);

INSERT IGNORE INTO _schema_version (version, description) VALUES (3, 'Add category_stats and consumer_stats tables (Epic 27-5)');
INSERT IGNORE INTO _schema_version (version, description) VALUES (4, 'Add recommendations table (Epic 27-7)');

-- ---------------------------------------------------------------------------
-- repo_map_symbols (story 28-2 / Epic 28)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repo_map_symbols (
  id          BIGINT AUTO_INCREMENT NOT NULL,
  file_path   VARCHAR(1000)         NOT NULL,
  symbol_name VARCHAR(500)          NOT NULL,
  symbol_kind VARCHAR(20)           NOT NULL,
  signature   TEXT,
  line_number INT                   NOT NULL DEFAULT 0,
  exported    TINYINT(1)            NOT NULL DEFAULT 0,
  file_hash     VARCHAR(64)           NOT NULL,
  dependencies  JSON,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_repo_map_symbols_file ON repo_map_symbols (file_path);
CREATE INDEX IF NOT EXISTS idx_repo_map_symbols_kind ON repo_map_symbols (symbol_kind);

-- ---------------------------------------------------------------------------
-- repo_map_meta (story 28-2 / Epic 28)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repo_map_meta (
  id          INT      NOT NULL DEFAULT 1,
  commit_sha  VARCHAR(64),
  updated_at  DATETIME,
  file_count  INT      NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);

INSERT IGNORE INTO _schema_version (version, description) VALUES (5, 'Add repo_map_symbols and repo_map_meta tables (Epic 28-2)');
INSERT IGNORE INTO _schema_version (version, description) VALUES (6, 'Add dependencies JSON column to repo_map_symbols (Epic 28-3)');

-- ---------------------------------------------------------------------------
-- wg_stories (Epic 31-1) — planning-level work graph story nodes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wg_stories (
  story_key    VARCHAR(20)   NOT NULL,
  epic         VARCHAR(20)   NOT NULL,
  title        VARCHAR(255),
  status       VARCHAR(30)   NOT NULL DEFAULT 'planned',
  spec_path    VARCHAR(500),
  created_at   DATETIME,
  updated_at   DATETIME,
  completed_at DATETIME,
  PRIMARY KEY (story_key)
);

CREATE INDEX IF NOT EXISTS idx_wg_stories_epic ON wg_stories (epic);

-- ---------------------------------------------------------------------------
-- story_dependencies (Epic 31-1) — directed dependency edges
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS story_dependencies (
  story_key       VARCHAR(50)   NOT NULL,
  depends_on      VARCHAR(50)   NOT NULL,
  dependency_type VARCHAR(50)   NOT NULL DEFAULT 'blocks',
  source          VARCHAR(50)   NOT NULL DEFAULT 'explicit',
  PRIMARY KEY (story_key, depends_on)
);

-- ---------------------------------------------------------------------------
-- ready_stories view (Epic 31-1)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW ready_stories AS
  SELECT s.* FROM wg_stories s
  WHERE s.status IN ('planned', 'ready')
    AND NOT EXISTS (
      SELECT 1 FROM story_dependencies d
      JOIN wg_stories dep ON dep.story_key = d.depends_on
      WHERE d.story_key = s.story_key
        AND d.dependency_type = 'blocks'
        AND dep.status <> 'complete'
    );

INSERT IGNORE INTO _schema_version (version, description) VALUES (7, 'Add wg_stories, story_dependencies tables and ready_stories view (Epic 31-1)');
