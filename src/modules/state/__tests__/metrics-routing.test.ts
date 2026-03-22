// @vitest-environment node
/**
 * Unit tests for metrics routing — StateStore MetricRecord extended fields,
 * MetricFilter new fields, DoltStateStore queryMetrics filter routing,
 * and FileStateStore filter routing.
 *
 * Story 26-5, AC7.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DoltStateStore } from '../dolt-store.js'
import { FileStateStore } from '../file-store.js'
import type { DoltClient } from '../dolt-client.js'
import type { MetricRecord, MetricFilter } from '../types.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: vi.fn(),
  }
})

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(queryResults: Map<string, unknown[]> = new Map()): DoltClient {
  return {
    repoPath: '/tmp/testrepo',
    socketPath: '/tmp/testrepo/.dolt/dolt.sock',
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation(async (sql: string) => {
      for (const [key, value] of queryResults) {
        if (sql.includes(key)) return value
      }
      return []
    }),
  } as unknown as DoltClient
}

function makeDoltStore(client?: DoltClient): DoltStateStore {
  return new DoltStateStore({
    repoPath: '/tmp/testrepo',
    client: client ?? makeClient(),
  })
}

// ---------------------------------------------------------------------------
// MetricRecord extended fields
// ---------------------------------------------------------------------------

describe('MetricRecord extended fields', () => {
  it('sprint field is accepted in MetricRecord', () => {
    const record: MetricRecord = {
      storyKey: '26-1',
      taskType: 'dev-story',
      sprint: 'sprint-1',
    }
    expect(record.sprint).toBe('sprint-1')
  })

  it('timestamp field is accepted in MetricRecord', () => {
    const record: MetricRecord = {
      storyKey: '26-1',
      taskType: 'dev-story',
      timestamp: '2026-03-08T10:00:00.000Z',
    }
    expect(record.timestamp).toBe('2026-03-08T10:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// MetricFilter new fields
// ---------------------------------------------------------------------------

describe('MetricFilter extended fields', () => {
  it('story_key alias is accepted', () => {
    const filter: MetricFilter = { story_key: '26-1' }
    expect(filter.story_key).toBe('26-1')
  })

  it('task_type alias is accepted', () => {
    const filter: MetricFilter = { task_type: 'dev-story' }
    expect(filter.task_type).toBe('dev-story')
  })

  it('since field is accepted', () => {
    const filter: MetricFilter = { since: '2026-03-01T00:00:00.000Z' }
    expect(filter.since).toBe('2026-03-01T00:00:00.000Z')
  })

  it('aggregate flag is accepted', () => {
    const filter: MetricFilter = { aggregate: true }
    expect(filter.aggregate).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// DoltStateStore.queryMetrics — filter routing
// ---------------------------------------------------------------------------

describe('DoltStateStore.queryMetrics filter routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds WHERE sprint = ? when sprint filter provided', async () => {
    const client = makeClient()
    const store = makeDoltStore(client)
    await store.queryMetrics({ sprint: 'sprint-2' })
    const calls = vi.mocked(client.query).mock.calls
    const selectCall = calls.find(([sql]) => String(sql).includes('FROM metrics'))!
    expect(String(selectCall[0])).toContain('sprint = ?')
    expect(selectCall[1]).toContain('sprint-2')
  })

  it('uses story_key alias when storyKey is not provided', async () => {
    const client = makeClient()
    const store = makeDoltStore(client)
    await store.queryMetrics({ story_key: '26-3' })
    const calls = vi.mocked(client.query).mock.calls
    const selectCall = calls.find(([sql]) => String(sql).includes('FROM metrics'))!
    expect(String(selectCall[0])).toContain('story_key = ?')
    expect(selectCall[1]).toContain('26-3')
  })

  it('uses task_type alias when taskType is not provided', async () => {
    const client = makeClient()
    const store = makeDoltStore(client)
    await store.queryMetrics({ task_type: 'code-review' })
    const calls = vi.mocked(client.query).mock.calls
    const selectCall = calls.find(([sql]) => String(sql).includes('FROM metrics'))!
    expect(String(selectCall[0])).toContain('task_type = ?')
    expect(selectCall[1]).toContain('code-review')
  })

  it('builds WHERE recorded_at >= ? for since filter', async () => {
    const client = makeClient()
    const store = makeDoltStore(client)
    await store.queryMetrics({ since: '2026-03-01T00:00:00.000Z' })
    const calls = vi.mocked(client.query).mock.calls
    const selectCall = calls.find(([sql]) => String(sql).includes('FROM metrics'))!
    expect(String(selectCall[0])).toContain('recorded_at >= ?')
    expect(selectCall[1]).toContain('2026-03-01T00:00:00.000Z')
  })

  it('builds GROUP BY aggregate query when aggregate=true', async () => {
    const client = makeClient()
    const store = makeDoltStore(client)
    await store.queryMetrics({ aggregate: true })
    const calls = vi.mocked(client.query).mock.calls
    const selectCall = calls.find(([sql]) => String(sql).includes('FROM metrics'))!
    expect(String(selectCall[0])).toContain('GROUP BY task_type')
    expect(String(selectCall[0])).toContain('AVG(cost_usd)')
  })

  it('maps sprint field from row to MetricRecord', async () => {
    const client = makeClient(
      new Map([
        [
          'FROM metrics',
          [
            {
              story_key: '26-1',
              task_type: 'dev-story',
              model: null,
              tokens_in: 500,
              tokens_out: 200,
              cache_read_tokens: null,
              cost_usd: null,
              wall_clock_ms: 5000,
              review_cycles: 1,
              stall_count: null,
              result: 'success',
              recorded_at: '2026-03-08T10:00:00.000Z',
              sprint: 'sprint-1',
              timestamp: null,
            },
          ],
        ],
      ]),
    )
    const store = makeDoltStore(client)
    const results = await store.queryMetrics({})
    expect(results).toHaveLength(1)
    expect(results[0].sprint).toBe('sprint-1')
    expect(results[0].timestamp).toBe('2026-03-08T10:00:00.000Z')
  })

  it('inserts sprint column in recordMetric', async () => {
    const client = makeClient()
    const store = makeDoltStore(client)
    await store.recordMetric({
      storyKey: '26-1',
      taskType: 'dev-story',
      sprint: 'sprint-1',
    })
    const calls = vi.mocked(client.query).mock.calls
    const insertCall = calls.find(([sql]) => String(sql).includes('INSERT INTO metrics'))!
    expect(String(insertCall[0])).toContain('sprint')
    const params = insertCall[1] as unknown[]
    expect(params[params.length - 1]).toBe('sprint-1')
  })
})

// ---------------------------------------------------------------------------
// FileStateStore.queryMetrics — filter routing
// ---------------------------------------------------------------------------

describe('FileStateStore.queryMetrics filter routing', () => {
  it('filters by story_key alias', async () => {
    const store = new FileStateStore()
    await store.recordMetric({ storyKey: '26-1', taskType: 'dev-story' })
    await store.recordMetric({ storyKey: '26-2', taskType: 'dev-story' })
    const results = await store.queryMetrics({ story_key: '26-1' })
    expect(results).toHaveLength(1)
    expect(results[0].storyKey).toBe('26-1')
  })

  it('filters by task_type alias', async () => {
    const store = new FileStateStore()
    await store.recordMetric({ storyKey: '26-1', taskType: 'dev-story' })
    await store.recordMetric({ storyKey: '26-1', taskType: 'code-review' })
    const results = await store.queryMetrics({ task_type: 'code-review' })
    expect(results).toHaveLength(1)
    expect(results[0].taskType).toBe('code-review')
  })

  it('filters by sprint field', async () => {
    const store = new FileStateStore()
    await store.recordMetric({ storyKey: '26-1', taskType: 'dev-story', sprint: 'sprint-1' })
    await store.recordMetric({ storyKey: '26-2', taskType: 'dev-story', sprint: 'sprint-2' })
    const results = await store.queryMetrics({ sprint: 'sprint-1' })
    expect(results).toHaveLength(1)
    expect(results[0].sprint).toBe('sprint-1')
  })

  it('filters by since field', async () => {
    const store = new FileStateStore()
    await store.recordMetric({
      storyKey: '26-1',
      taskType: 'dev-story',
      recordedAt: '2026-02-01T00:00:00.000Z',
    })
    await store.recordMetric({
      storyKey: '26-2',
      taskType: 'dev-story',
      recordedAt: '2026-03-08T00:00:00.000Z',
    })
    const results = await store.queryMetrics({ since: '2026-03-01T00:00:00.000Z' })
    expect(results).toHaveLength(1)
    expect(results[0].storyKey).toBe('26-2')
  })

  it('returns all records when no filter provided', async () => {
    const store = new FileStateStore()
    await store.recordMetric({ storyKey: '26-1', taskType: 'dev-story' })
    await store.recordMetric({ storyKey: '26-2', taskType: 'code-review' })
    const results = await store.queryMetrics({})
    expect(results).toHaveLength(2)
  })
})
