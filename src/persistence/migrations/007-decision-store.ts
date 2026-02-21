/**
 * Migration 007: Decision Store schema.
 *
 * Creates tables for tracking decisions, requirements, constraints, artifacts,
 * pipeline runs, and token usage across pipeline execution phases.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { Migration } from './index.js'

export const migration007DecisionStore: Migration = {
  version: 7,
  name: '007-decision-store',
  up(db: BetterSqlite3Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id            TEXT PRIMARY KEY,
        methodology   TEXT NOT NULL,
        current_phase TEXT,
        status        TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','paused','completed','failed')),
        config_json   TEXT,
        token_usage_json TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);

      CREATE TABLE IF NOT EXISTS decisions (
        id              TEXT PRIMARY KEY,
        pipeline_run_id TEXT REFERENCES pipeline_runs(id),
        phase           TEXT NOT NULL,
        category        TEXT NOT NULL,
        key             TEXT NOT NULL,
        value           TEXT NOT NULL,
        rationale       TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_phase ON decisions(phase);
      CREATE INDEX IF NOT EXISTS idx_decisions_key ON decisions(phase, key);

      CREATE TABLE IF NOT EXISTS requirements (
        id              TEXT PRIMARY KEY,
        pipeline_run_id TEXT REFERENCES pipeline_runs(id),
        source          TEXT NOT NULL,
        type            TEXT NOT NULL CHECK(type IN ('functional','non_functional','constraint')),
        description     TEXT NOT NULL,
        priority        TEXT NOT NULL CHECK(priority IN ('must','should','could','wont')),
        status          TEXT NOT NULL DEFAULT 'active',
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_requirements_type ON requirements(type);
      CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements(status);

      CREATE TABLE IF NOT EXISTS constraints (
        id              TEXT PRIMARY KEY,
        pipeline_run_id TEXT REFERENCES pipeline_runs(id),
        category        TEXT NOT NULL,
        description     TEXT NOT NULL,
        source          TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id              TEXT PRIMARY KEY,
        pipeline_run_id TEXT REFERENCES pipeline_runs(id),
        phase           TEXT NOT NULL,
        type            TEXT NOT NULL,
        path            TEXT NOT NULL,
        content_hash    TEXT,
        summary         TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_phase ON artifacts(phase);

      CREATE TABLE IF NOT EXISTS token_usage (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_run_id TEXT REFERENCES pipeline_runs(id),
        phase           TEXT NOT NULL,
        agent           TEXT NOT NULL,
        input_tokens    INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0,
        cost_usd        REAL NOT NULL DEFAULT 0.0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_token_usage_run ON token_usage(pipeline_run_id);
    `)
  },
}
