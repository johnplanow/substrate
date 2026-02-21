import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../persistence/migrations/index.js';
import { unlinkSync, existsSync } from 'fs';

const DB_PATH = '/tmp/smoke-test-epic9.db';

afterAll(() => { if (existsSync(DB_PATH)) unlinkSync(DB_PATH); });

describe('Epic 9 migration smoke test', () => {
  it('creates all expected decision store tables', () => {
    const db = new Database(DB_PATH);
    runMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((r: any) => r.name);
    db.close();

    const expected = ['decisions', 'requirements', 'constraints', 'artifacts', 'pipeline_runs'];
    for (const t of expected) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }
  });

  it('decisions table has all expected columns', () => {
    const db = new Database(DB_PATH);
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(decisions)").all()
      .map((r: any) => r.name);
    db.close();

    for (const col of ['id', 'phase', 'category', 'key', 'value', 'rationale', 'created_at', 'updated_at']) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });
});
