/**
 * Unit tests for `substrate metrics` command (Story 17-2).
 *
 * Coverage:
 *   - AC3: Metrics query command (list, compare, tag-baseline)
 *   - AC4: Baseline tagging
 *   - Error handling (missing DB, missing runs)
 *   - JSON output format
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { writeRunMetrics, writeStoryMetrics } from '../../../persistence/queries/metrics.js'
import { runMetricsAction } from '../metrics.js'
import type { MetricsOptions } from '../metrics.js'

// Mock the DB adapter factory so production code reuses the test's adapter
vi.mock('../../../persistence/adapter.js', () => {
  let mockAdapter: DatabaseAdapter | null = null
  return {
    createDatabaseAdapter: () => mockAdapter!,
    __setMockAdapter: (a: DatabaseAdapter) => {
      mockAdapter = a
    },
  }
})

vi.mock('../../../persistence/schema.js', () => ({
  initSchema: vi.fn().mockResolvedValue(undefined),
}))

// Import the real initSchema for test setup (the mock is only for production code paths)
const { initSchema: realInitSchema } = await vi.importActual<
  typeof import('../../../persistence/schema.js')
>('../../../persistence/schema.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureStdout(): { getOutput: () => string; restore: () => void } {
  const chunks: string[] = []
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof process.stdout.write
  return {
    getOutput: () => chunks.join(''),
    restore: () => {
      process.stdout.write = origWrite
    },
  }
}

function captureStderr(): { getOutput: () => string; restore: () => void } {
  const chunks: string[] = []
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof process.stderr.write
  return {
    getOutput: () => chunks.join(''),
    restore: () => {
      process.stderr.write = origWrite
    },
  }
}

/** Create a temp project with an initialized substrate DB adapter */
async function createTempProject(): Promise<{ projectRoot: string; adapter: DatabaseAdapter }> {
  const projectRoot = join(tmpdir(), `substrate-test-${randomUUID()}`)
  const dbDir = join(projectRoot, '.substrate')
  mkdirSync(dbDir, { recursive: true })

  // Create placeholder .dolt dir so existsSync(doltStateDir) passes in metrics.ts.
  const doltStateDir = join(dbDir, 'state', '.dolt')
  mkdirSync(doltStateDir, { recursive: true })

  const adapter = new InMemoryDatabaseAdapter()
  await realInitSchema(adapter)

  // Inject mock adapter so production code reuses the same DB
  const adapterModule = (await import('../../../persistence/adapter.js')) as {
    __setMockAdapter: (a: DatabaseAdapter) => void
  }
  adapterModule.__setMockAdapter(adapter)

  return { projectRoot, adapter }
}

async function seedRun(
  adapter: DatabaseAdapter,
  runId: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await writeRunMetrics(adapter, {
    run_id: runId,
    methodology: 'bmad',
    status: 'completed',
    started_at: '2026-01-15T00:00:00.000Z',
    completed_at: '2026-01-15T00:10:00.000Z',
    wall_clock_seconds: 600,
    total_input_tokens: 5000,
    total_output_tokens: 2000,
    total_cost_usd: 0.045,
    stories_attempted: 2,
    stories_succeeded: 2,
    total_review_cycles: 3,
    total_dispatches: 6,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Tests: List Mode (AC3)
// ---------------------------------------------------------------------------

describe('runMetricsAction — AC3: list mode', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>
  let projectRoot: string
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    stdoutCapture = captureStdout()
    const project = await createTempProject()
    projectRoot = project.projectRoot
    adapter = project.adapter
  })

  afterEach(async () => {
    stdoutCapture.restore()
    await adapter.close()
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true })
  })

  it('lists recent runs in human format', async () => {
    await seedRun(adapter, 'run-001')
    await seedRun(adapter, 'run-002', { started_at: '2026-01-16T00:00:00.000Z' })

    const exitCode = await runMetricsAction({ outputFormat: 'human', projectRoot })
    expect(exitCode).toBe(0)

    const output = stdoutCapture.getOutput()
    expect(output).toContain('run-001')
    expect(output).toContain('run-002')
    expect(output).toContain('Pipeline Run Metrics')
  })

  it('lists runs in JSON format', async () => {
    await seedRun(adapter, 'run-001')

    const exitCode = await runMetricsAction({ outputFormat: 'json', projectRoot })
    expect(exitCode).toBe(0)

    const output = stdoutCapture.getOutput()
    const parsed = JSON.parse(output)
    expect(parsed.success).toBe(true)
    expect(parsed.data.runs).toHaveLength(1)
    expect(parsed.data.runs[0].run_id).toBe('run-001')
  })

  it('respects --limit option', async () => {
    await seedRun(adapter, 'run-001')
    await seedRun(adapter, 'run-002', { started_at: '2026-01-16T00:00:00.000Z' })
    await seedRun(adapter, 'run-003', { started_at: '2026-01-17T00:00:00.000Z' })

    const exitCode = await runMetricsAction({ outputFormat: 'json', projectRoot, limit: 2 })
    expect(exitCode).toBe(0)

    const parsed = JSON.parse(stdoutCapture.getOutput())
    expect(parsed.data.runs).toHaveLength(2)
  })

  it('shows empty message when no runs exist', async () => {
    const exitCode = await runMetricsAction({ outputFormat: 'human', projectRoot })
    expect(exitCode).toBe(0)

    expect(stdoutCapture.getOutput()).toContain('No run metrics recorded yet')
  })
})

// ---------------------------------------------------------------------------
// Tests: Compare Mode (AC3)
// ---------------------------------------------------------------------------

describe('runMetricsAction — AC3: compare mode', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>
  let stderrCapture: ReturnType<typeof captureStderr>
  let projectRoot: string
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    stdoutCapture = captureStdout()
    stderrCapture = captureStderr()
    const project = await createTempProject()
    projectRoot = project.projectRoot
    adapter = project.adapter
  })

  afterEach(async () => {
    stdoutCapture.restore()
    stderrCapture.restore()
    await adapter.close()
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true })
  })

  it('compares two runs in human format', async () => {
    await seedRun(adapter, 'run-001', { total_input_tokens: 5000, total_cost_usd: 0.05 })
    await seedRun(adapter, 'run-002', { total_input_tokens: 8000, total_cost_usd: 0.08 })

    const exitCode = await runMetricsAction({
      outputFormat: 'human',
      projectRoot,
      compare: ['run-001', 'run-002'],
    })
    expect(exitCode).toBe(0)

    const output = stdoutCapture.getOutput()
    expect(output).toContain('Metrics Comparison')
    expect(output).toContain('Input tokens')
  })

  it('compares two runs in JSON format', async () => {
    await seedRun(adapter, 'run-001', { total_input_tokens: 5000, wall_clock_seconds: 600 })
    await seedRun(adapter, 'run-002', { total_input_tokens: 7500, wall_clock_seconds: 900 })

    const exitCode = await runMetricsAction({
      outputFormat: 'json',
      projectRoot,
      compare: ['run-001', 'run-002'],
    })
    expect(exitCode).toBe(0)

    const parsed = JSON.parse(stdoutCapture.getOutput())
    expect(parsed.success).toBe(true)
    expect(parsed.data.token_input_delta).toBe(2500)
    expect(parsed.data.wall_clock_delta_seconds).toBe(300)
  })

  it('returns error for missing run IDs', async () => {
    await seedRun(adapter, 'run-001')

    const exitCode = await runMetricsAction({
      outputFormat: 'human',
      projectRoot,
      compare: ['run-001', 'run-missing'],
    })
    expect(exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Tests: Tag Baseline (AC4)
// ---------------------------------------------------------------------------

describe('runMetricsAction — AC4: tag baseline', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>
  let stderrCapture: ReturnType<typeof captureStderr>
  let projectRoot: string
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    stdoutCapture = captureStdout()
    stderrCapture = captureStderr()
    const project = await createTempProject()
    projectRoot = project.projectRoot
    adapter = project.adapter
  })

  afterEach(async () => {
    stdoutCapture.restore()
    stderrCapture.restore()
    await adapter.close()
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true })
  })

  it('tags a run as baseline', async () => {
    await seedRun(adapter, 'run-001')

    const exitCode = await runMetricsAction({
      outputFormat: 'human',
      projectRoot,
      tagBaseline: 'run-001',
    })
    expect(exitCode).toBe(0)
    expect(stdoutCapture.getOutput()).toContain('Baseline tagged: run-001')
  })

  it('tags baseline in JSON format', async () => {
    await seedRun(adapter, 'run-001')

    const exitCode = await runMetricsAction({
      outputFormat: 'json',
      projectRoot,
      tagBaseline: 'run-001',
    })
    expect(exitCode).toBe(0)

    const parsed = JSON.parse(stdoutCapture.getOutput())
    expect(parsed.success).toBe(true)
    expect(parsed.data.tagged_baseline).toBe('run-001')
  })

  it('returns error when tagging non-existent run', async () => {
    const exitCode = await runMetricsAction({
      outputFormat: 'human',
      projectRoot,
      tagBaseline: 'run-missing',
    })
    expect(exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Tests: Error Handling
// ---------------------------------------------------------------------------

describe('runMetricsAction — error handling', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>

  beforeEach(() => {
    stdoutCapture = captureStdout()
  })

  afterEach(() => {
    stdoutCapture.restore()
  })

  it('returns 0 with message when no DB exists (human)', async () => {
    const fakeRoot = join(tmpdir(), `substrate-test-nodb-${randomUUID()}`)
    mkdirSync(fakeRoot, { recursive: true })

    try {
      const exitCode = await runMetricsAction({
        outputFormat: 'human',
        projectRoot: fakeRoot,
      })
      expect(exitCode).toBe(0)
      expect(stdoutCapture.getOutput()).toContain('No metrics yet')
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true })
    }
  })

  it('returns 0 with JSON when no DB exists', async () => {
    const fakeRoot = join(tmpdir(), `substrate-test-nodb-${randomUUID()}`)
    mkdirSync(fakeRoot, { recursive: true })

    try {
      const exitCode = await runMetricsAction({
        outputFormat: 'json',
        projectRoot: fakeRoot,
      })
      expect(exitCode).toBe(0)

      const parsed = JSON.parse(stdoutCapture.getOutput())
      expect(parsed.data.runs).toEqual([])
      expect(parsed.data.message).toContain('No metrics yet')
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: --analysis flag (AC5 of Story 17-3)
// ---------------------------------------------------------------------------

describe('runMetricsAction — AC5: --analysis flag', () => {
  let stdoutCapture: ReturnType<typeof captureStdout>
  let stderrCapture: ReturnType<typeof captureStderr>
  let projectRoot: string

  beforeEach(() => {
    stdoutCapture = captureStdout()
    stderrCapture = captureStderr()
    projectRoot = join(tmpdir(), `substrate-test-analysis-${randomUUID()}`)
    mkdirSync(projectRoot, { recursive: true })
  })

  afterEach(() => {
    stdoutCapture.restore()
    stderrCapture.restore()
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true })
  })

  function seedAnalysisReport(runId: string, data: Record<string, unknown> = {}): void {
    const dir = join(projectRoot, '_bmad-output', 'supervisor-reports')
    mkdirSync(dir, { recursive: true })
    const reportData = {
      run_id: runId,
      generated_at: new Date().toISOString(),
      findings: {},
      ...data,
    }
    writeFileSync(join(dir, `${runId}-analysis.json`), JSON.stringify(reportData, null, 2), 'utf-8')
    writeFileSync(join(dir, `${runId}-analysis.md`), `# Analysis: ${runId}\n`, 'utf-8')
  }

  it('returns JSON analysis report when --analysis run-id and JSON format', async () => {
    seedAnalysisReport('run-001', { findings: { token_efficiency: [] } })

    const exitCode = await runMetricsAction({
      outputFormat: 'json',
      projectRoot,
      analysis: 'run-001',
    })
    expect(exitCode).toBe(0)

    const output = stdoutCapture.getOutput()
    const parsed = JSON.parse(output)
    expect(parsed.success).toBe(true)
    expect(parsed.data.run_id).toBe('run-001')
  })

  it('returns markdown report when --analysis run-id and human format', async () => {
    seedAnalysisReport('run-001')

    const exitCode = await runMetricsAction({
      outputFormat: 'human',
      projectRoot,
      analysis: 'run-001',
    })
    expect(exitCode).toBe(0)
    expect(stdoutCapture.getOutput()).toContain('Analysis: run-001')
  })

  it('returns exit code 1 when analysis report not found (JSON format)', async () => {
    const exitCode = await runMetricsAction({
      outputFormat: 'json',
      projectRoot,
      analysis: 'run-missing',
    })
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(stdoutCapture.getOutput())
    expect(parsed.success).toBe(false)
  })

  it('returns exit code 1 when analysis report not found (human format)', async () => {
    const exitCode = await runMetricsAction({
      outputFormat: 'human',
      projectRoot,
      analysis: 'run-missing',
    })
    expect(exitCode).toBe(1)
    expect(stderrCapture.getOutput()).toContain('run-missing')
  })

  it('metrics command has --analysis option registered', async () => {
    const { registerMetricsCommand } = await import('../metrics.js')
    const { Command } = await import('commander')
    const program = new Command()
    registerMetricsCommand(program, '0.0.0', projectRoot)

    const metricsCmd = program.commands.find((c) => c.name() === 'metrics')!
    const optDefs = metricsCmd.options
    const analysisOpt = optDefs.find((o) => o.long === '--analysis')
    expect(analysisOpt).toBeDefined()
  })
})
