/**
 * Tests that supervisor's getTokenSnapshot and incrementRestarts resolve
 * the DB path via resolveMainRepoRoot (fixes worktree / dev-build divergence).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock resolveMainRepoRoot so we can verify it's called with projectRoot
vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/resolved/root'),
}))

// Mock DatabaseWrapper and aggregateTokenUsageForRun to avoid real DB access
vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    close: vi.fn(),
    db: {},
    getDb: vi.fn().mockReturnValue({}),
  })),
}))

vi.mock('../../../persistence/queries/metrics.js', () => ({
  aggregateTokenUsageForRun: vi.fn().mockReturnValue({ input: 42, output: 7, cost: 0.01 }),
  incrementRunRestarts: vi.fn(),
  getRunMetrics: vi.fn(),
  getBaselineRunMetrics: vi.fn(),
  getStoryMetricsForRun: vi.fn().mockReturnValue([]),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: vi.fn().mockReturnValue(true) }
})

import { resolveMainRepoRoot } from '../../../utils/git-root.js'
import { runSupervisorAction } from '../supervisor.js'
import type { SupervisorDeps, SupervisorOptions } from '../supervisor.js'
import type { PipelineHealthOutput } from '../health.js'

function makeTerminal(): PipelineHealthOutput {
  return {
    verdict: 'NO_PIPELINE_RUNNING',
    run_id: 'run-test',
    status: 'completed',
    current_phase: null,
    staleness_seconds: 0,
    last_activity: new Date().toISOString(),
    process: { orchestrator_pid: null, child_pids: [], zombies: [] },
    stories: { active: 0, completed: 1, escalated: 0, details: { '1-1': { phase: 'COMPLETE', review_cycles: 0 } } },
  }
}

function makeStalled(): PipelineHealthOutput {
  return {
    verdict: 'STALLED',
    run_id: 'run-test',
    status: 'running',
    current_phase: 'implementation',
    staleness_seconds: 700,
    last_activity: new Date().toISOString(),
    process: { orchestrator_pid: 999, child_pids: [], zombies: [] },
    stories: { active: 1, completed: 0, escalated: 0, details: { '1-1': { phase: 'IN_DEV', review_cycles: 0 } } },
  }
}

function captureStdout(): { getOutput: () => string; restore: () => void } {
  const chunks: string[] = []
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof process.stdout.write
  return { getOutput: () => chunks.join(''), restore: () => { process.stdout.write = origWrite } }
}

describe('supervisor DB path resolution via resolveMainRepoRoot', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>

  beforeEach(() => {
    vi.clearAllMocks()
    stdoutCapture = captureStdout()
  })

  afterEach(() => {
    stdoutCapture.restore()
  })

  it('getTokenSnapshot calls resolveMainRepoRoot with projectRoot', async () => {
    // Use default getTokenSnapshot (not overridden) — exercises the real implementation
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockResolvedValue(makeTerminal()),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      getAllDescendants: vi.fn().mockReturnValue([]),
      // getTokenSnapshot NOT provided — uses default which should call resolveMainRepoRoot
    }

    const opts: SupervisorOptions = {
      pollInterval: 1,
      stallThreshold: 600,
      maxRestarts: 3,
      outputFormat: 'json',
      projectRoot: '/worktree/path',
      pack: 'bmad',
    }

    await runSupervisorAction(opts, deps)

    expect(resolveMainRepoRoot).toHaveBeenCalledWith('/worktree/path')
  })

  it('incrementRestarts calls resolveMainRepoRoot with projectRoot', async () => {
    let callCount = 0
    const deps: Partial<SupervisorDeps> = {
      getHealth: vi.fn().mockImplementation(() => {
        callCount++
        // First call: stalled → triggers kill+restart; second call: terminal
        return Promise.resolve(callCount === 1 ? makeStalled() : makeTerminal())
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      resumePipeline: vi.fn().mockResolvedValue(0),
      killPid: vi.fn(),
      getAllDescendants: vi.fn().mockReturnValue([]),
      // incrementRestarts NOT provided — uses default which should call resolveMainRepoRoot
    }

    const opts: SupervisorOptions = {
      pollInterval: 1,
      stallThreshold: 600,
      maxRestarts: 3,
      outputFormat: 'json',
      projectRoot: '/worktree/path',
      pack: 'bmad',
    }

    await runSupervisorAction(opts, deps)

    // resolveMainRepoRoot should have been called for incrementRestarts
    // (in addition to getTokenSnapshot calls)
    const calls = vi.mocked(resolveMainRepoRoot).mock.calls
    const projectRootCalls = calls.filter((c) => c[0] === '/worktree/path')
    // At least 2: one for getTokenSnapshot on first poll, one for incrementRestarts during stall recovery
    expect(projectRootCalls.length).toBeGreaterThanOrEqual(2)
  })
})
