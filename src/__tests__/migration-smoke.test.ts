import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../persistence/schema.js';
import { createAdapterFromSyncDb } from '../persistence/wasm-sqlite-adapter.js';

describe('Schema smoke test', () => {
  it('creates all expected decision store tables', async () => {
    const db = new Database(':memory:');
    await initSchema(createAdapterFromSyncDb(db));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((r: any) => r.name);
    db.close();

    const expected = ['decisions', 'requirements', 'constraints', 'artifacts', 'pipeline_runs'];
    for (const t of expected) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }
  });

  it('decisions table has all expected columns', async () => {
    const db = new Database(':memory:');
    await initSchema(createAdapterFromSyncDb(db));
    const cols = db.prepare("PRAGMA table_info(decisions)").all()
      .map((r: any) => r.name);
    db.close();

    for (const col of ['id', 'phase', 'category', 'key', 'value', 'rationale', 'created_at', 'updated_at']) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });
});
