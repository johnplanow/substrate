/**
 * Unit tests for checkSchemaVersion() runtime function (Story 40-13).
 *
 * Covers all four decision branches:
 *   - null storedVersion (no row for schemaName)   → action: 'incompatible'
 *   - storedVersion === expectedVersion             → action: 'ok'
 *   - storedVersion < expectedVersion              → action: 'migrate'
 *   - storedVersion > expectedVersion              → action: 'incompatible'
 */

import { describe, it, expect } from 'vitest'
import type { DatabaseAdapter } from '@substrate-ai/core'
import { checkSchemaVersion, CORE_SCHEMA_NAME, type SchemaVersionRecord } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// Minimal DatabaseAdapter mock — only `query` is needed by checkSchemaVersion
// ---------------------------------------------------------------------------

function makeMockAdapter(rows: SchemaVersionRecord[]): DatabaseAdapter {
  return {
    query: async <T>(_sql: string, _params?: unknown[]): Promise<T[]> => rows as unknown as T[],
    exec: async (_sql: string): Promise<void> => {},
    transaction: async <T>(fn: (a: DatabaseAdapter) => Promise<T>) => fn(makeMockAdapter(rows)),
    close: async () => {},
    queryReadyStories: async () => [],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkSchemaVersion', () => {
  it('returns incompatible when no row exists for schemaName (storedVersion = null)', async () => {
    const adapter = makeMockAdapter([])
    const result = await checkSchemaVersion(adapter, CORE_SCHEMA_NAME, 3)

    expect(result.action).toBe('incompatible')
    expect(result.compatible).toBe(false)
    expect(result.storedVersion).toBeNull()
    expect(result.expectedVersion).toBe(3)
  })

  it('returns ok when storedVersion equals expectedVersion', async () => {
    const adapter = makeMockAdapter([
      { schema_name: CORE_SCHEMA_NAME, version: 3, applied_at: '2026-01-01T00:00:00Z' },
    ])
    const result = await checkSchemaVersion(adapter, CORE_SCHEMA_NAME, 3)

    expect(result.action).toBe('ok')
    expect(result.compatible).toBe(true)
    expect(result.storedVersion).toBe(3)
    expect(result.expectedVersion).toBe(3)
  })

  it('returns migrate when storedVersion is less than expectedVersion', async () => {
    const adapter = makeMockAdapter([
      { schema_name: CORE_SCHEMA_NAME, version: 1, applied_at: '2026-01-01T00:00:00Z' },
    ])
    const result = await checkSchemaVersion(adapter, CORE_SCHEMA_NAME, 3)

    expect(result.action).toBe('migrate')
    expect(result.compatible).toBe(false)
    expect(result.storedVersion).toBe(1)
    expect(result.expectedVersion).toBe(3)
  })

  it('returns incompatible when storedVersion is greater than expectedVersion', async () => {
    const adapter = makeMockAdapter([
      { schema_name: CORE_SCHEMA_NAME, version: 5, applied_at: '2026-01-01T00:00:00Z' },
    ])
    const result = await checkSchemaVersion(adapter, CORE_SCHEMA_NAME, 3)

    expect(result.action).toBe('incompatible')
    expect(result.compatible).toBe(false)
    expect(result.storedVersion).toBe(5)
    expect(result.expectedVersion).toBe(3)
  })
})
