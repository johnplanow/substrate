/**
 * Unit tests for checkSchemaVersion() in @substrate-ai/core.
 *
 * Covers all four decision branches:
 *   1. No row for schemaName  → action: 'incompatible', storedVersion: null
 *   2. storedVersion === expectedVersion → action: 'ok', compatible: true
 *   3. storedVersion <  expectedVersion → action: 'migrate', compatible: false
 *   4. storedVersion >  expectedVersion → action: 'incompatible', compatible: false
 */

import { describe, it, expect, vi } from 'vitest'
import type { DatabaseAdapter } from '@substrate-ai/core'
import { checkSchemaVersion } from '@substrate-ai/core'
import type { SchemaVersionRecord } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal DatabaseAdapter mock whose `query` method returns `rows`.
 * All other methods are no-ops — only `query` is exercised by checkSchemaVersion.
 */
function makeAdapter(rows: SchemaVersionRecord[]): DatabaseAdapter {
  return {
    query: vi.fn().mockResolvedValue(rows),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    queryReadyStories: vi.fn().mockResolvedValue([]),
  }
}

// ---------------------------------------------------------------------------
// checkSchemaVersion tests
// ---------------------------------------------------------------------------

describe('checkSchemaVersion', () => {
  const SCHEMA = 'core'
  const EXPECTED = 3

  it('returns incompatible when no row exists for the schema (storedVersion is null)', async () => {
    const adapter = makeAdapter([])

    const result = await checkSchemaVersion(adapter, SCHEMA, EXPECTED)

    expect(result).toEqual({
      compatible: false,
      storedVersion: null,
      expectedVersion: EXPECTED,
      action: 'incompatible',
    })
  })

  it('returns ok when storedVersion equals expectedVersion', async () => {
    const adapter = makeAdapter([
      { schema_name: SCHEMA, version: EXPECTED, applied_at: '2026-01-01T00:00:00Z' },
    ])

    const result = await checkSchemaVersion(adapter, SCHEMA, EXPECTED)

    expect(result).toEqual({
      compatible: true,
      storedVersion: EXPECTED,
      expectedVersion: EXPECTED,
      action: 'ok',
    })
  })

  it('returns migrate when storedVersion is less than expectedVersion', async () => {
    const storedVersion = EXPECTED - 1
    const adapter = makeAdapter([
      { schema_name: SCHEMA, version: storedVersion, applied_at: '2026-01-01T00:00:00Z' },
    ])

    const result = await checkSchemaVersion(adapter, SCHEMA, EXPECTED)

    expect(result).toEqual({
      compatible: false,
      storedVersion,
      expectedVersion: EXPECTED,
      action: 'migrate',
    })
  })

  it('returns incompatible when storedVersion is greater than expectedVersion', async () => {
    const storedVersion = EXPECTED + 1
    const adapter = makeAdapter([
      { schema_name: SCHEMA, version: storedVersion, applied_at: '2026-01-01T00:00:00Z' },
    ])

    const result = await checkSchemaVersion(adapter, SCHEMA, EXPECTED)

    expect(result).toEqual({
      compatible: false,
      storedVersion,
      expectedVersion: EXPECTED,
      action: 'incompatible',
    })
  })

  it('queries the schema_version table with the correct schema name parameter', async () => {
    const adapter = makeAdapter([])

    await checkSchemaVersion(adapter, SCHEMA, EXPECTED)

    expect(adapter.query).toHaveBeenCalledOnce()
    expect(adapter.query).toHaveBeenCalledWith(
      expect.stringContaining('schema_version'),
      [SCHEMA]
    )
  })
})
