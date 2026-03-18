import { describe, it, expect } from 'vitest';
import { InMemoryDatabaseAdapter } from '../persistence/memory-adapter.js';
import { initSchema } from '../persistence/schema.js';

describe('Schema smoke test', () => {
  it('creates all expected decision store tables', async () => {
    const adapter = new InMemoryDatabaseAdapter();
    await initSchema(adapter);
    const tables = (await adapter.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"))
      .map((r) => r.name);
    await adapter.close();

    const expected = ['decisions', 'requirements', 'constraints', 'artifacts', 'pipeline_runs'];
    for (const t of expected) {
      expect(tables, `missing table: ${t}`).toContain(t);
    }
  });

  it('decisions table has all expected columns', async () => {
    const adapter = new InMemoryDatabaseAdapter();
    await initSchema(adapter);
    const cols = (await adapter.query<{ name: string }>("PRAGMA table_info(decisions)"))
      .map((r) => r.name);
    await adapter.close();

    for (const col of ['id', 'phase', 'category', 'key', 'value', 'rationale', 'created_at', 'updated_at']) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });
});
