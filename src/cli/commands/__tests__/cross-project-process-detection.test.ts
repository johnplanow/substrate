/**
 * Tests for Story 23-6: Process Detection Cross-Project Fix
 *
 * Covers:
 *   AC1: Orchestrator PID detected even without `--project-root` in command line
 *   AC2: Child PIDs detected after PID-file based orchestrator detection
 *   AC3: Process detection not tied to project-specific path matching
 *   AC4: Health verdict is NOT NO_PIPELINE_RUNNING when run.status='running' and orchestrator active
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { createWasmSqliteAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import { createPipelineRun } from '../../../persistence/queries/decisions.js'
import type { PipelineRun } from '../../../persistence/queries/decisions.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import {
  inspectProcessTree,
  getAutoHealthData,
} from '../health.js'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../../persistence/database.js', () => {
  let mockAdapter: DatabaseAdapter | null = null
  return {
    DatabaseWrapper: class {
      open() { /* noop */ }
      close() { /* noop */ }
      get adapter() {
        return mockAdapter!
      }
      get isOpen() { return true }
    },
    __setMockAdapter: (a: DatabaseAdapter) => { mockAdapter = a },
  }
})

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/cross-project-test'),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
  }
})

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<DatabaseAdapter> {
  const adapter = await createWasmSqliteAdapter()
  await initSchema(adapter)
  return adapter
}

async function createTestRun(
  adapter: DatabaseAdapter,
  overrides: {
    status?: string
    current_phase?: string
    token_usage_json?: string
    updated_at?: string
  } = {},
): Promise<PipelineRun> {
  const run = await createPipelineRun(adapter, {
    methodology: 'bmad',
    start_phase: 'implementation',
    config_json: null,
  })
  if (overrides.status !== undefined) {
    await adapter.query(`UPDATE pipeline_runs SET status = ? WHERE id = ?`, [overrides.status, run.id])
  }
  if (overrides.current_phase !== undefined) {
    await adapter.query(`UPDATE pipeline_runs SET current_phase = ? WHERE id = ?`, [overrides.current_phase, run.id])
  }
  if (overrides.token_usage_json !== undefined) {
    await adapter.query(`UPDATE pipeline_runs SET token_usage_json = ? WHERE id = ?`, [overrides.token_usage_json, run.id])
  }
  if (overrides.updated_at !== undefined) {
    await adapter.query(`UPDATE pipeline_runs SET updated_at = ? WHERE id = ?`, [overrides.updated_at, run.id])
  }
  const rows = await adapter.query<PipelineRun>('SELECT * FROM pipeline_runs WHERE id = ?', [run.id])
  return rows[0]!
}

// ---------------------------------------------------------------------------
// AC1 + AC3: PID-file based detection without --project-root in command line
// ---------------------------------------------------------------------------

describe('inspectProcessTree — PID-file based cross-project detection (AC1, AC3)', () => {
  /**
   * The cross-project scenario: substrate is invoked from the target project
   * directory (CWD = /other/project) without --project-root in the command
   * line. The command appears as just `substrate run --events` in ps output.
   * The project root path does NOT appear in the command line.
   *
   * With the old code, isOrchestratorProcessLine(line, '/other/project')
   * returned false because '/other/project' was not in the command string.
   * The fix: read the PID from orchestrator.pid and verify it is alive.
   */

  const PID = 12345
  const CHILD_PID = 12346
  const SUBSTRATE_DIR = '/other/project/.substrate'

  // ps output: orchestrator has NO project path in its command line
  const psOutput = [
    'PID  PPID STAT COMMAND',
    `${PID} 12344 S    substrate run --events --stories 4-1`,
    `${CHILD_PID} ${PID} S    claude -p some-workflow`,
    '1     0 Ss   /sbin/init',
  ].join('\n')

  it('detects orchestrator PID via PID file even when project path is absent from cmdline', () => {
    const mockReadFileSync = vi.fn().mockReturnValue(`${PID}\n`)
    const mockExecFileSync = vi.fn().mockReturnValue(psOutput)

    const result = inspectProcessTree({
      projectRoot: '/other/project',   // not in the command line
      substrateDirPath: SUBSTRATE_DIR,
      execFileSync: mockExecFileSync,
      readFileSync: mockReadFileSync,
    })

    // AC1: orchestrator PID must be non-null and correct
    expect(result.orchestrator_pid).toBe(PID)
    expect(mockReadFileSync).toHaveBeenCalledWith(
      join(SUBSTRATE_DIR, 'orchestrator.pid'),
      'utf-8',
    )
  })

  it('detects child PIDs after PID-file orchestrator detection (AC2)', () => {
    const mockReadFileSync = vi.fn().mockReturnValue(`${PID}\n`)
    const mockExecFileSync = vi.fn().mockReturnValue(psOutput)

    const result = inspectProcessTree({
      projectRoot: '/other/project',
      substrateDirPath: SUBSTRATE_DIR,
      execFileSync: mockExecFileSync,
      readFileSync: mockReadFileSync,
    })

    // AC2: child PIDs must be found
    expect(result.child_pids).toContain(CHILD_PID)
    expect(result.zombies).toHaveLength(0)
  })

  it('works with any project root path — not tied to substrate install path (AC3)', () => {
    // Simulate a completely arbitrary project path
    const arbitraryProjectDir = '/Users/alice/code/my-kotlin-backend/.substrate'
    const mockReadFileSync = vi.fn().mockReturnValue(`${PID}\n`)
    const mockExecFileSync = vi.fn().mockReturnValue(psOutput)

    const result = inspectProcessTree({
      projectRoot: '/Users/alice/code/my-kotlin-backend',
      substrateDirPath: arbitraryProjectDir,
      execFileSync: mockExecFileSync,
      readFileSync: mockReadFileSync,
    })

    // AC3: detection works regardless of project root
    expect(result.orchestrator_pid).toBe(PID)
    expect(result.child_pids).toContain(CHILD_PID)
  })

  it('rejects PID from file if process is a zombie', () => {
    const zombiePsOutput = [
      'PID  PPID STAT COMMAND',
      `${PID} 12344 Z    substrate run --events`,
      `${CHILD_PID} ${PID} S    claude -p some-workflow`,
    ].join('\n')

    const mockReadFileSync = vi.fn().mockReturnValue(`${PID}\n`)
    const mockExecFileSync = vi.fn().mockReturnValue(zombiePsOutput)

    const result = inspectProcessTree({
      projectRoot: '/other/project',
      substrateDirPath: SUBSTRATE_DIR,
      execFileSync: mockExecFileSync,
      readFileSync: mockReadFileSync,
    })

    // A zombie orchestrator should not count as alive
    expect(result.orchestrator_pid).toBeNull()
  })

  it('rejects PID from file if process is not found in ps output (crashed without cleanup)', () => {
    const emptyPsOutput = [
      'PID  PPID STAT COMMAND',
      '1     0 Ss   /sbin/init',
    ].join('\n')

    const mockReadFileSync = vi.fn().mockReturnValue(`${PID}\n`)
    const mockExecFileSync = vi.fn().mockReturnValue(emptyPsOutput)

    const result = inspectProcessTree({
      projectRoot: '/other/project',
      substrateDirPath: SUBSTRATE_DIR,
      execFileSync: mockExecFileSync,
      readFileSync: mockReadFileSync,
    })

    // PID file exists but process is gone — treated as dead
    expect(result.orchestrator_pid).toBeNull()
  })

  it('falls back to command-line matching when PID file does not exist', () => {
    // readFileSync throws ENOENT (file not found)
    const mockReadFileSync = vi.fn().mockImplementation(() => {
      const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })
    const mockExecFileSync = vi.fn().mockReturnValue([
      'PID  PPID STAT COMMAND',
      `${PID} 12344 S    substrate run --events --stories 4-1`,
      `${CHILD_PID} ${PID} S    claude -p worker`,
    ].join('\n'))

    const result = inspectProcessTree({
      substrateDirPath: SUBSTRATE_DIR,
      execFileSync: mockExecFileSync,
      readFileSync: mockReadFileSync,
      // No projectRoot — command-line fallback with no path filter
    })

    // Falls back to command-line matching — still finds the orchestrator
    expect(result.orchestrator_pid).toBe(PID)
    expect(result.child_pids).toContain(CHILD_PID)
  })

  it('falls back to command-line matching when substrateDirPath is not provided', () => {
    // No substrateDirPath → skip PID file check entirely → use cmdline matching
    const mockExecFileSync = vi.fn().mockReturnValue([
      'PID  PPID STAT COMMAND',
      `${PID} 12344 S    substrate run --events`,
      `${CHILD_PID} ${PID} S    node worker.js`,
    ].join('\n'))

    const result = inspectProcessTree({
      execFileSync: mockExecFileSync,
      // no substrateDirPath, no readFileSync
    })

    expect(result.orchestrator_pid).toBe(PID)
    expect(result.child_pids).toContain(CHILD_PID)
  })

  it('PID file detection takes priority over command-line matching for a different project', () => {
    // Two orchestrators running: one for project-a (PID=11111), one for project-b (PID=22222).
    // PID file says project-a's orchestrator is PID 11111.
    // Even if command-line matching could find project-b's orchestrator, PID file wins.
    const twoOrchestratorPs = [
      'PID  PPID STAT COMMAND',
      `11111 11110 S    substrate run --project-root /project-a --events`,
      `11112 11111 S    claude -p worker-a`,
      `22222 22221 S    substrate run --project-root /project-b --events`,
      `22223 22222 S    claude -p worker-b`,
    ].join('\n')

    const mockReadFileSync = vi.fn().mockReturnValue('11111\n')
    const mockExecFileSync = vi.fn().mockReturnValue(twoOrchestratorPs)

    const result = inspectProcessTree({
      projectRoot: '/project-a',
      substrateDirPath: '/project-a/.substrate',
      execFileSync: mockExecFileSync,
      readFileSync: mockReadFileSync,
    })

    expect(result.orchestrator_pid).toBe(11111)
    expect(result.child_pids).toContain(11112)
    expect(result.child_pids).not.toContain(22223)
  })

  it('zombie detection still works when orchestrator is found via PID file (AC2)', () => {
    const zombieChildPs = [
      'PID  PPID STAT COMMAND',
      `${PID} 12344 S    substrate run --events`,
      `${CHILD_PID} ${PID} Z    claude -p zombie-worker`,
    ].join('\n')

    const mockReadFileSync = vi.fn().mockReturnValue(`${PID}\n`)
    const mockExecFileSync = vi.fn().mockReturnValue(zombieChildPs)

    const result = inspectProcessTree({
      substrateDirPath: SUBSTRATE_DIR,
      execFileSync: mockExecFileSync,
      readFileSync: mockReadFileSync,
    })

    expect(result.orchestrator_pid).toBe(PID)
    expect(result.child_pids).toContain(CHILD_PID)
    expect(result.zombies).toContain(CHILD_PID)
  })
})

// ---------------------------------------------------------------------------
// AC4: Health verdict correctness — NO_PIPELINE_RUNNING must not be returned
// when run.status='running' and orchestrator is active
// ---------------------------------------------------------------------------

describe('getAutoHealthData — AC4: verdict correctness for running pipeline', () => {
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
    const dbModule = await import('../../../persistence/database.js') as { __setMockAdapter: (a: DatabaseAdapter) => void }
    dbModule.__setMockAdapter(adapter)
  })

  afterEach(async () => {
    await adapter.close()
    vi.clearAllMocks()
  })

  it('does NOT return NO_PIPELINE_RUNNING when run.status=running and recent activity', async () => {
    // The bug: process detection failing (null PID) + completed > 0 + active = 0
    // caused NO_PIPELINE_RUNNING even while pipeline was actively running
    const storyState = JSON.stringify({
      stories: {
        '4-1': { phase: 'COMPLETE', reviewCycles: 1 },
        '4-2': { phase: 'PENDING', reviewCycles: 0 },
      },
    })
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      token_usage_json: storyState,
      updated_at: new Date().toISOString(),  // fresh
    })

    const result = await getAutoHealthData({ projectRoot: '/tmp/cross-project-test' })

    // AC4: must NOT be NO_PIPELINE_RUNNING when DB says running
    expect(result.verdict).not.toBe('NO_PIPELINE_RUNNING')
    expect(result.status).toBe('running')
  })

  it('does NOT return NO_PIPELINE_RUNNING when run.status=running even with no active stories', async () => {
    // Edge case: all stories are COMPLETE but the run status is still 'running'
    // (orchestrator hasn't updated DB yet). Should be HEALTHY not NO_PIPELINE_RUNNING.
    const storyState = JSON.stringify({
      stories: {
        '4-1': { phase: 'COMPLETE', reviewCycles: 0 },
        '4-2': { phase: 'COMPLETE', reviewCycles: 0 },
      },
    })
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      token_usage_json: storyState,
      updated_at: new Date().toISOString(),
    })

    const result = await getAutoHealthData({ projectRoot: '/tmp/cross-project-test' })

    // AC4: DB says 'running' → must NOT be NO_PIPELINE_RUNNING
    expect(result.verdict).not.toBe('NO_PIPELINE_RUNNING')
  })

  it('returns NO_PIPELINE_RUNNING correctly when run.status=completed', async () => {
    await createTestRun(adapter, {
      status: 'completed',
      current_phase: 'implementation',
    })

    const result = await getAutoHealthData({ projectRoot: '/tmp/cross-project-test' })
    expect(result.verdict).toBe('NO_PIPELINE_RUNNING')
  })

  it('returns NO_PIPELINE_RUNNING correctly when run.status=failed', async () => {
    await createTestRun(adapter, {
      status: 'failed',
      current_phase: 'implementation',
    })

    const result = await getAutoHealthData({ projectRoot: '/tmp/cross-project-test' })
    expect(result.verdict).toBe('NO_PIPELINE_RUNNING')
  })

  it('returns STALLED when run is stale and no active processes found (AC4 compatible)', async () => {
    const staleTime = new Date(Date.now() - 700_000).toISOString()  // 11+ minutes ago
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: staleTime,
    })

    const result = await getAutoHealthData({ projectRoot: '/tmp/cross-project-test' })

    // Stale pipeline with no processes → STALLED (not NO_PIPELINE_RUNNING)
    expect(result.verdict).toBe('STALLED')
    expect(result.status).toBe('running')
  })

  it('returns HEALTHY when pipeline is running with fresh DB update and no processes found', async () => {
    // Fresh pipeline, no stale detection, no process found in test env → HEALTHY
    await createTestRun(adapter, {
      status: 'running',
      current_phase: 'implementation',
      updated_at: new Date().toISOString(),
    })

    const result = await getAutoHealthData({ projectRoot: '/tmp/cross-project-test' })

    // Fresh update → not stale → should be HEALTHY
    expect(result.verdict).toBe('HEALTHY')
    expect(result.status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// AC3: inspectProcessTree with cross-project substrateDirPath does not
// interfere with existing command-line scoped tests
// ---------------------------------------------------------------------------

describe('inspectProcessTree — substrateDirPath option is backward-compatible', () => {
  it('works exactly like before when neither substrateDirPath nor projectRoot is given', () => {
    const psOutput = [
      '1     0 Ss   /sbin/init',
      '99999 99998 S    substrate run --events',
      '100000 99999 S   node worker.js',
    ].join('\n')

    const mockExec = vi.fn().mockReturnValue(psOutput)
    const result = inspectProcessTree({ execFileSync: mockExec })

    expect(result.orchestrator_pid).toBe(99999)
    expect(result.child_pids).toContain(100000)
  })

  it('project-scoped cmdline matching still works when no PID file exists', () => {
    const projectA = '/Users/test/project-a'
    const projectB = '/Users/test/project-b'
    const psOutput = [
      `36604 36602 S    substrate run --stories 1-1 --project-root ${projectA}`,
      `38654 38634 S    substrate run --stories 2-1 --project-root ${projectB}`,
    ].join('\n')

    const mockExec = vi.fn().mockReturnValue(psOutput)
    // PID file missing (throws ENOENT)
    const mockReadFile = vi.fn().mockImplementation(() => { throw new Error('ENOENT') })

    const resultA = inspectProcessTree({
      projectRoot: projectA,
      substrateDirPath: `${projectA}/.substrate`,
      execFileSync: mockExec,
      readFileSync: mockReadFile,
    })
    expect(resultA.orchestrator_pid).toBe(36604)

    const resultB = inspectProcessTree({
      projectRoot: projectB,
      substrateDirPath: `${projectB}/.substrate`,
      execFileSync: mockExec,
      readFileSync: mockReadFile,
    })
    expect(resultB.orchestrator_pid).toBe(38654)
  })
})
