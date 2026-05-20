// @vitest-environment node
/**
 * Unit tests for `substrate health` — DoltStateInfo connectivity.
 *
 * Post-Ship-1: HealthOptions takes `doltReader: DoltOperatorReader` (renamed
 * from `stateStore`) and `doltReaderConfig: { basePath?: string }` (renamed
 * from `stateStoreConfig`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DoltOperatorReader } from '../../../modules/state/index.js'
import type { DoltStateInfo, PipelineHealthOutput } from '../health.js'

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

function makeDoltReader(responsive: boolean): DoltOperatorReader {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    setMetric: vi.fn().mockResolvedValue(undefined),
    getMetric: vi.fn().mockResolvedValue(undefined),
    getHistory: responsive
      ? vi.fn().mockResolvedValue([{ hash: 'abc1234', timestamp: '2026-03-08T10:00:00Z', storyKey: null, message: 'init' }])
      : vi.fn().mockRejectedValue(new Error('connection refused')),
  }
}

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

describe('getAutoHealthData — dolt_state computation', () => {
  it('dolt_state is absent when no doltReader provided', async () => {
    const { getAutoHealthData } = await import('../health.js')
    const health = await getAutoHealthData({ projectRoot: '/tmp/test-project' })
    expect(health.dolt_state).toBeUndefined()
  })

  it('dolt_state is absent when no doltReaderConfig basePath provided', async () => {
    const { getAutoHealthData } = await import('../health.js')
    const doltReader = makeDoltReader(true)
    const health = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      doltReader,
    })
    expect(health.dolt_state).toBeUndefined()
  })

  it('dolt_state is present when doltReader + doltReaderConfig.basePath provided', async () => {
    const { existsSync } = await import('node:fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { getAutoHealthData } = await import('../health.js')
    const doltReader = makeDoltReader(true)
    const health = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      doltReader,
      doltReaderConfig: { basePath: '/tmp/test-project/.substrate/state' },
    })
    expect(health.dolt_state).toBeDefined()
    expect(health.dolt_state!.initialized).toBe(true)
    expect(health.dolt_state!.responsive).toBe(true)
  })

  it('dolt_state.responsive=false when getHistory throws', async () => {
    const { existsSync } = await import('node:fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { getAutoHealthData } = await import('../health.js')
    const doltReader = makeDoltReader(false)
    const health = await getAutoHealthData({
      projectRoot: '/tmp/test-project',
      doltReader,
      doltReaderConfig: { basePath: '/tmp/test-project/.substrate/state' },
    })
    expect(health.dolt_state).toBeDefined()
    expect(health.dolt_state!.responsive).toBe(false)
  })
})

describe('runHealthAction — output integration', () => {
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
    const doltReader = makeDoltReader(true)

    const exitCode = await runHealthAction({
      outputFormat: 'human',
      projectRoot: '/tmp/test-project',
      doltReader,
      doltReaderConfig: { basePath: '/tmp/test-project/.substrate/state' },
    })
    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    expect(output).toContain('Pipeline Health:')
    expect(output).toContain('Dolt State:')
  })

  it('JSON output includes dolt_state field', async () => {
    const { existsSync } = await import('node:fs')
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('.dolt'))

    const { runHealthAction } = await import('../health.js')
    const doltReader = makeDoltReader(true)

    const exitCode = await runHealthAction({
      outputFormat: 'json',
      projectRoot: '/tmp/test-project',
      doltReader,
      doltReaderConfig: { basePath: '/tmp/test-project/.substrate/state' },
    })
    expect(exitCode).toBe(0)
    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: PipelineHealthOutput }
    expect(parsed.success).toBe(true)
    expect(parsed.data.dolt_state).toBeDefined()
    expect(parsed.data.dolt_state!.responsive).toBe(true)
  })
})
