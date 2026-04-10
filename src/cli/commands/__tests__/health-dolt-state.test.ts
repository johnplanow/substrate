// @vitest-environment node
/**
 * Unit tests for `substrate health` — DoltStateInfo connectivity (Story 26-8, AC3).
 *
 * Verifies:
 * - DoltStateInfo interface fields (initialized, responsive, version?)
 * - dolt_state included in PipelineHealthOutput when backend=dolt
 * - dolt_state absent when backend is not dolt
 * - Human output shows Dolt state line when dolt_state present
 * - getAutoHealthData passes stateStore and stateStoreConfig through
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StateStore } from '../../../modules/state/index.js'
import type { DoltStateInfo, PipelineHealthOutput } from '../health.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/test-project'),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../../../persistence/adapter.js', () => ({
  createDatabaseAdapter: vi.fn(() => ({
    query: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('../../../persistence/schema.js', () => ({
  initSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: actual.readFileSync,
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoltStore(responsive: boolean): StateStore {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getStoryState: vi.fn().mockResolvedValue(undefined),
    setStoryState: vi.fn().mockResolvedValue(undefined),
    queryStories: vi.fn().mockResolvedValue([]),
    recordMetric: vi.fn().mockResolvedValue(undefined),
    queryMetrics: vi.fn().mockResolvedValue([]),
    getContracts: vi.fn().mockResolvedValue([]),
    setContracts: vi.fn().mockResolvedValue(undefined),
    queryContracts: vi.fn().mockResolvedValue([]),
    setContractVerification: vi.fn().mockResolvedValue(undefined),
    getContractVerification: vi.fn().mockResolvedValue([]),
    branchForStory: vi.fn().mockResolvedValue(undefined),
    mergeStory: vi.fn().mockResolvedValue(undefined),
    rollbackStory: vi.fn().mockResolvedValue(undefined),
    diffStory: vi.fn().mockResolvedValue({ storyKey: '', tables: [] }),
    getHistory: responsive
      ? vi
          .fn()
          .mockResolvedValue([
            { hash: 'abc1234', timestamp: '2026-03-08T10:00:00Z', storyKey: null, message: 'init' },
          ])
      : vi.fn().mockRejectedValue(new Error('connection refused')),
  } as unknown as StateStore
}

// ---------------------------------------------------------------------------
// Interface tests
// ---------------------------------------------------------------------------

describe('DoltStateInfo interface', () => {
  it('accepts minimal fields (initialized, responsive)', () => {
    const info: DoltStateInfo = { initialized: true, responsive: true }
    expect(info.initialized).toBe(true)
    expect(info.responsive).toBe(true)
    expect(info.version).toBeUndefined()
  })

  it('accepts optional version field', () => {
    const info: DoltStateInfo = { initialized: true, responsive: false, version: '1.2.3' }
    expect(info.version).toBe('1.2.3')
  })
})

describe('PipelineHealthOutput — dolt_state field', () => {
  it('dolt_state is optional in PipelineHealthOutput', () => {
    const output: PipelineHealthOutput = {
      verdict: 'NO_PIPELINE_RUNNING',
      run_id: null,
      status: null,
      current_phase: null,
      staleness_seconds: 0,
      last_activity: '',
      process: { orchestrator_pid: null, child_pids: [], zombies: [] },
      stories: { active: 0, completed: 0, escalated: 0, details: {} },
    }
    // dolt_state is absent — type allows it
    expect(output.dolt_state).toBeUndefined()
  })

  it('dolt_state can be set on PipelineHealthOutput', () => {
    const output: PipelineHealthOutput = {
      verdict: 'HEALTHY',
      run_id: 'test-run',
      status: 'running',
      current_phase: null,
      staleness_seconds: 10,
      last_activity: '',
      process: { orchestrator_pid: null, child_pids: [], zombies: [] },
      stories: { active: 0, completed: 0, escalated: 0, details: {} },
      dolt_state: { initialized: true, responsive: true, version: '1.44.0' },
    }
    expect(output.dolt_state?.initialized).toBe(true)
    expect(output.dolt_state?.version).toBe('1.44.0')
  })
})

// ---------------------------------------------------------------------------
// Tests: getAutoHealthData with dolt stateStore
// ---------------------------------------------------------------------------

describe('getAutoHealthData — dolt_state computation (AC3)', () => {
  it('dolt_state is absent when no stateStore provided', async () => {
    const { getAutoHealthData } = await import('../health.js')
    const health = await getAutoHealthData({ projectRoot: '/tmp/test-project' })
    expect(health.dolt_state).toBeUndefined()
  })

  it('dolt_state is absent when stateStoreConfig.backend is not dolt', async () => {
    const { getAutoHealthData } = await import('../health.js')
    const store = makeDoltStore(true)
    const health = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      stateStore: store,
      stateStoreConfig: { backend: 'file' },
    })
    expect(health.dolt_state).toBeUndefined()
  })

  it('dolt_state is present when backend=dolt and stateStore provided', async () => {
    const { existsSync } = await import('node:fs')
    // Make doltDirPath exist
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { getAutoHealthData } = await import('../health.js')
    const store = makeDoltStore(true)
    const health = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      stateStore: store,
      stateStoreConfig: { backend: 'dolt', basePath: '/tmp/test-project/.substrate/state' },
    })
    expect(health.dolt_state).toBeDefined()
    expect(health.dolt_state!.initialized).toBe(true)
    expect(health.dolt_state!.responsive).toBe(true)
  })

  it('dolt_state.responsive=false when stateStore.getHistory throws', async () => {
    const { existsSync } = await import('node:fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { getAutoHealthData } = await import('../health.js')
    const store = makeDoltStore(false)
    const health = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      stateStore: store,
      stateStoreConfig: { backend: 'dolt', basePath: '/tmp/test-project/.substrate/state' },
    })
    expect(health.dolt_state).toBeDefined()
    expect(health.dolt_state!.responsive).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: HealthOptions accepts new fields
// ---------------------------------------------------------------------------

describe('HealthOptions — new fields', () => {
  it('accepts stateStore field', () => {
    const store = makeDoltStore(true)
    const opts = {
      outputFormat: 'json' as const,
      projectRoot: '/tmp',
      stateStore: store,
    }
    expect(opts.stateStore).toBeDefined()
  })

  it('accepts stateStoreConfig field', () => {
    const opts = {
      outputFormat: 'json' as const,
      projectRoot: '/tmp',
      stateStoreConfig: { backend: 'dolt', basePath: '/tmp/.substrate/state' },
    }
    expect(opts.stateStoreConfig?.backend).toBe('dolt')
  })
})

// ---------------------------------------------------------------------------
// Tests: runHealthAction human output for dolt_state
// ---------------------------------------------------------------------------

describe('runHealthAction — human output dolt_state (AC3)', () => {
  let stdoutChunks: string[]
  const origStdout = process.stdout.write

  beforeEach(() => {
    stdoutChunks = []
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(chunk)
      return true
    }) as typeof process.stdout.write
  })

  afterEach(() => {
    process.stdout.write = origStdout
    vi.clearAllMocks()
  })

  it('human output includes Dolt State line when dolt_state present', async () => {
    const { existsSync } = await import('node:fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { runHealthAction } = await import('../health.js')
    const store = makeDoltStore(true)

    const exitCode = await runHealthAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      stateStore: store,
      stateStoreConfig: { backend: 'dolt', basePath: '/tmp/test-project/.substrate/state' },
    })
    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    expect(output).toContain('Pipeline Health:')
    // Dolt State line should appear even when no pipeline run is active (AC3)
    expect(output).toContain('Dolt State:')
  })

  it('JSON output includes dolt_state field when backend=dolt', async () => {
    const { existsSync } = await import('node:fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { runHealthAction } = await import('../health.js')
    const store = makeDoltStore(true)

    const exitCode = await runHealthAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      stateStore: store,
      stateStoreConfig: { backend: 'dolt', basePath: '/tmp/test-project/.substrate/state' },
    })
    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: PipelineHealthOutput }
    expect(parsed.success).toBe(true)
    expect(parsed.data.dolt_state).toBeDefined()
    expect(parsed.data.dolt_state!.responsive).toBe(true)
  })
})
