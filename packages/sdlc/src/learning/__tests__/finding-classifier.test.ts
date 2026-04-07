/**
 * Integration tests for persistFinding and classifyAndPersist.
 *
 * Story 53-5: Root Cause Taxonomy and Failure Classification
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { persistFinding } from '../finding-store.js'
import { classifyAndPersist } from '../finding-classifier.js'
import { buildFinding } from '../failure-classifier.js'
import type { DatabaseAdapter } from '@substrate-ai/core'
import type { StoryFailureContext } from '../types.js'

// ---------------------------------------------------------------------------
// Mock DatabaseAdapter factory
// ---------------------------------------------------------------------------

function makeMockDb(overrides?: Partial<DatabaseAdapter>): DatabaseAdapter {
  return {
    backendType: 'memory',
    query: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(async (fn) => fn({ backendType: 'memory', query: vi.fn().mockResolvedValue([]), exec: vi.fn(), transaction: vi.fn(), close: vi.fn(), queryReadyStories: vi.fn().mockResolvedValue([]) } as unknown as DatabaseAdapter)),
    close: vi.fn().mockResolvedValue(undefined),
    queryReadyStories: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as DatabaseAdapter
}

// ---------------------------------------------------------------------------
// persistFinding tests
// ---------------------------------------------------------------------------

describe('persistFinding', () => {
  let mockDb: DatabaseAdapter

  beforeEach(() => {
    mockDb = makeMockDb()
  })

  it('calls db.query with INSERT INTO decisions and correct arguments', async () => {
    const ctx: StoryFailureContext = { storyKey: '53-5', runId: 'run-abc' }
    const finding = buildFinding({ ...ctx, buildFailed: true }, 'build-failure', ctx.runId)

    await persistFinding(finding, mockDb)

    expect(mockDb.query).toHaveBeenCalled()
    const [sql, params] = (mockDb.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO decisions')
    // params: [id, pipeline_run_id, phase, category, key, value, rationale]
    expect(params).toContain('finding') // category = LEARNING_FINDING
    expect(params).toContain('53-5:run-abc') // key = storyKey:runId
  })

  it('encodes the full finding as JSON in the value parameter', async () => {
    const ctx: StoryFailureContext = { storyKey: '53-5', runId: 'run-abc' }
    const finding = buildFinding({ ...ctx, testsFailed: true }, 'test-failure', ctx.runId)

    await persistFinding(finding, mockDb)

    const [, params] = (mockDb.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]]
    const valueParam = params.find((p) => typeof p === 'string' && p.startsWith('{'))
    expect(valueParam).toBeDefined()
    const parsed = JSON.parse(valueParam as string) as Record<string, unknown>
    expect(parsed.root_cause).toBe('test-failure')
    expect(parsed.confidence).toBe('high')
  })
})

// ---------------------------------------------------------------------------
// classifyAndPersist tests
// ---------------------------------------------------------------------------

describe('classifyAndPersist', () => {
  const ctx: StoryFailureContext = { storyKey: '53-5', runId: 'run-abc', buildFailed: true }

  it('resolves with a Finding with expected fields', async () => {
    const mockDb = makeMockDb()
    const finding = await classifyAndPersist(ctx, mockDb)

    expect(finding.root_cause).toBe('build-failure')
    expect(finding.confidence).toBe('high')
    expect(finding.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(finding.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('still resolves with a Finding when db is null', async () => {
    const finding = await classifyAndPersist(ctx, null)
    expect(finding).toBeDefined()
    expect(finding.root_cause).toBe('build-failure')
  })

  it('still resolves (no throw) when db.query rejects', async () => {
    const failingDb = makeMockDb({
      query: vi.fn().mockRejectedValue(new Error('DB unavailable')),
    })

    const finding = await expect(classifyAndPersist(ctx, failingDb)).resolves.toBeDefined()
    void finding // suppress unused warning
  })

  it('returns Finding even on a rejecting db', async () => {
    const failingDb = makeMockDb({
      query: vi.fn().mockRejectedValue(new Error('DB unavailable')),
    })

    const finding = await classifyAndPersist(ctx, failingDb)
    expect(finding.root_cause).toBe('build-failure')
  })
})
