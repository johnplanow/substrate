/**
 * Tests for runExportAction: JSON output format (T13 / AC7).
 *
 * Isolated in its own file so that vi.mock('../../../utils/git-root.js') does
 * not bleed into the T11/T12 integration tests (which call renderers and
 * seedMethodologyContext directly and should not have git-root stubbed at the
 * module level).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import {
  createDecision,
  createPipelineRun,
} from '../../../persistence/queries/decisions.js'
import { runExportAction } from '../../../cli/commands/export.js'

// ---------------------------------------------------------------------------
// Mock resolveMainRepoRoot so runExportAction uses the temp dir as repo root.
// Hoisted to module scope so it applies consistently across all T13 tests.
// ---------------------------------------------------------------------------

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockImplementation((root: string) => Promise.resolve(root)),
}))

// Mock createDatabaseAdapter to open the seeded SQLite file via SqliteDatabaseAdapter.
// The production code calls createDatabaseAdapter({ backend: 'auto', basePath }) which
// would fall back to InMemoryDatabaseAdapter in tests (no Dolt). This mock ensures the
// seeded SQLite data is accessible.
const { mockCreateDatabaseAdapter } = vi.hoisted(() => {
  const mockCreateDatabaseAdapter = vi.fn()
  return { mockCreateDatabaseAdapter }
})

vi.mock('../../../persistence/adapter.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    createDatabaseAdapter: mockCreateDatabaseAdapter,
  }
})

// initSchema is NOT mocked here — the test setup needs the real implementation
// to create tables before seeding data. initSchema uses CREATE TABLE IF NOT EXISTS,
// so it's idempotent when runExportAction calls it again on the reopened adapter.

// ---------------------------------------------------------------------------
// T13: runExportAction --output-format json (AC7)
// ---------------------------------------------------------------------------

describe('T13: runExportAction --output-format json', () => {
  let tempProjectRoot: string
  let runId: string
  let stdoutOutput: string[]
  let originalWrite: typeof process.stdout.write
  let seededAdapter: import('../../../persistence/adapter.js').DatabaseAdapter

  beforeEach(async () => {
    // Create a real temp project root with a .substrate directory
    tempProjectRoot = join(tmpdir(), `substrate-export-json-test-${randomUUID()}`)
    const substrateDir = join(tempProjectRoot, '.substrate')
    mkdirSync(substrateDir, { recursive: true })

    // Create a WASM in-memory adapter and seed it with decisions
    seededAdapter = new InMemoryDatabaseAdapter()
    await initSchema(seededAdapter)

    const run = await createPipelineRun(seededAdapter, { methodology: 'bmad' })
    runId = run.id

    // Insert decisions for all three phases so all 5 files are written
    await createDecision(seededAdapter, {
      pipeline_run_id: runId,
      phase: 'analysis',
      category: 'product-brief',
      key: 'problem_statement',
      value: 'Test problem statement for JSON export',
      rationale: null,
    })
    await createDecision(seededAdapter, {
      pipeline_run_id: runId,
      phase: 'planning',
      category: 'classification',
      key: 'type',
      value: 'saas-product',
      rationale: null,
    })
    await createDecision(seededAdapter, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: 'language',
      value: 'TypeScript',
      rationale: null,
    })
    await createDecision(seededAdapter, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'epics',
      key: 'epic-1',
      value: JSON.stringify({ title: 'Core', description: 'Core functionality' }),
      rationale: null,
    })
    await createDecision(seededAdapter, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'stories',
      key: '1-1',
      value: JSON.stringify({
        key: '1-1',
        title: 'Init story',
        description: 'Initialize project',
        acceptance_criteria: ['Works'],
        priority: 'must',
      }),
      rationale: null,
    })
    await createDecision(seededAdapter, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'readiness-findings',
      key: 'f-1',
      value: JSON.stringify({
        category: 'general',
        severity: 'minor',
        description: 'All systems nominal',
        affected_items: [],
      }),
      rationale: null,
    })

    // Create a placeholder file so export.ts's existsSync(dbPath) check passes
    const dbPath = join(substrateDir, 'substrate.db')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(dbPath, '')

    // Configure the mock to return the pre-seeded WASM adapter
    mockCreateDatabaseAdapter.mockReturnValue(seededAdapter)

    // Capture process.stdout.write output
    stdoutOutput = []
    originalWrite = process.stdout.write.bind(process.stdout)
    // Use proper Node.js WritableStream.write overload signatures
    process.stdout.write = function (
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean {
      stdoutOutput.push(typeof chunk === 'string' ? chunk : chunk.toString())
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb
      if (callback) callback()
      return true
    } as typeof process.stdout.write
  })

  afterEach(async () => {
    // Restore process.stdout.write
    process.stdout.write = originalWrite

    // Close adapter (no-op if runExportAction already closed it)
    await seededAdapter.close()

    if (existsSync(tempProjectRoot)) {
      rmSync(tempProjectRoot, { recursive: true, force: true })
    }
  })

  it('T13a: emits { files_written, run_id, phases_exported } JSON to stdout', async () => {
    const outputDir = join(tempProjectRoot, 'artifacts')

    const exitCode = await runExportAction({
      runId,
      outputDir,
      projectRoot: tempProjectRoot,
      outputFormat: 'json',
    })

    expect(exitCode).toBe(0)

    // Only one JSON line should have been written to stdout
    expect(stdoutOutput.length).toBe(1)

    const parsed = JSON.parse(stdoutOutput[0]!) as {
      files_written: string[]
      run_id: string
      phases_exported: string[]
    }

    // Verify the three required fields of the ExportResult contract (AC7)
    expect(parsed).toHaveProperty('files_written')
    expect(parsed).toHaveProperty('run_id')
    expect(parsed).toHaveProperty('phases_exported')

    // run_id must match the seeded run
    expect(parsed.run_id).toBe(runId)

    // All three phases had data → all three should be in phases_exported
    expect(parsed.phases_exported).toContain('analysis')
    expect(parsed.phases_exported).toContain('planning')
    expect(parsed.phases_exported).toContain('solutioning')

    // All 5 output files should have been written
    expect(parsed.files_written.length).toBe(5)
    const filenames = parsed.files_written.map((p) => p.split('/').pop())
    expect(filenames).toContain('product-brief.md')
    expect(filenames).toContain('prd.md')
    expect(filenames).toContain('architecture.md')
    expect(filenames).toContain('epics.md')
    expect(filenames).toContain('readiness-report.md')

    // All reported files must actually exist on disk
    for (const filePath of parsed.files_written) {
      expect(existsSync(filePath), `${filePath} should exist on disk`).toBe(true)
    }
  })

  it('T13c: exports operational-findings.md and experiments.md when decisions exist', async () => {
    // Add operational-finding and experiment-result decisions to the seeded adapter
    await createDecision(seededAdapter, {
      pipeline_run_id: runId,
      phase: 'supervisor',
      category: 'operational-finding',
      key: `stall:1-1:1700000000000`,
      value: JSON.stringify({
        phase: 'IN_DEV',
        staleness_secs: 700,
        attempt: 1,
        outcome: 'recovered',
      }),
      rationale: 'Stall recovery test',
    })
    await createDecision(seededAdapter, {
      pipeline_run_id: runId,
      phase: 'supervisor',
      category: 'operational-finding',
      key: `run-summary:${runId}`,
      value: JSON.stringify({
        succeeded: ['1-1'],
        failed: [],
        escalated: [],
        total_restarts: 1,
        elapsed_seconds: 120,
        total_input_tokens: 5000,
        total_output_tokens: 1500,
      }),
      rationale: 'Run summary test',
    })
    await createDecision(seededAdapter, {
      pipeline_run_id: runId,
      phase: 'supervisor',
      category: 'experiment-result',
      key: `experiment:${runId}:1700000000000`,
      value: JSON.stringify({
        target_metric: 'token_regression',
        before: 8200,
        after: 6500,
        verdict: 'IMPROVED',
        branch_name: 'supervisor/experiment/test-branch',
      }),
      rationale: 'Experiment test',
    })

    const outputDir = join(tempProjectRoot, 'artifacts-operational')

    const exitCode = await runExportAction({
      runId,
      outputDir,
      projectRoot: tempProjectRoot,
      outputFormat: 'json',
    })

    expect(exitCode).toBe(0)
    expect(stdoutOutput.length).toBe(1)

    const parsed = JSON.parse(stdoutOutput[0]!) as {
      files_written: string[]
      run_id: string
      phases_exported: string[]
    }

    // Verify operational files were written
    const filenames = parsed.files_written.map((p) => p.split('/').pop())
    expect(filenames).toContain('operational-findings.md')
    expect(filenames).toContain('experiments.md')

    // Verify 'operational' phase is reported
    expect(parsed.phases_exported).toContain('operational')

    // Verify files exist on disk and have content
    const opFindingsPath = parsed.files_written.find((p) => p.endsWith('operational-findings.md'))!
    const experimentsPath = parsed.files_written.find((p) => p.endsWith('experiments.md'))!
    expect(existsSync(opFindingsPath)).toBe(true)
    expect(existsSync(experimentsPath)).toBe(true)

    // Verify rendered content
    const { readFileSync } = await import('node:fs')
    const opContent = readFileSync(opFindingsPath, 'utf-8')
    expect(opContent).toContain('Operational Findings')
    expect(opContent).toContain('stall:1-1:1700000000000')

    const expContent = readFileSync(experimentsPath, 'utf-8')
    expect(expContent).toContain('Experiments')
    expect(expContent).toContain('IMPROVED')
  })

  it('T13b: returns error JSON when DB does not exist', async () => {
    const missingRoot = join(tmpdir(), `substrate-missing-${randomUUID()}`)
    mkdirSync(missingRoot, { recursive: true })
    let exitCode: number

    try {
      exitCode = await runExportAction({
        outputDir: join(missingRoot, 'out'),
        projectRoot: missingRoot,
        outputFormat: 'json',
      })

      expect(exitCode).toBe(1)
      expect(stdoutOutput.length).toBe(1)

      const parsed = JSON.parse(stdoutOutput[0]!) as { error: string }
      expect(parsed).toHaveProperty('error')
      expect(parsed.error).toMatch(/not initialized|Run.*init/i)
    } finally {
      rmSync(missingRoot, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Shared adapter injection tests (dual-adapter bug fix)
// ---------------------------------------------------------------------------

describe('runExportAction with injected adapter', () => {
  let tempProjectRoot: string
  let stdoutOutput: string[]
  let originalWrite: typeof process.stdout.write

  beforeEach(() => {
    tempProjectRoot = join(tmpdir(), `substrate-export-shared-adapter-${randomUUID()}`)
    mkdirSync(tempProjectRoot, { recursive: true })

    stdoutOutput = []
    originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = function (
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean {
      stdoutOutput.push(typeof chunk === 'string' ? chunk : chunk.toString())
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb
      if (callback) callback()
      return true
    } as typeof process.stdout.write
  })

  afterEach(() => {
    process.stdout.write = originalWrite
    if (existsSync(tempProjectRoot)) {
      rmSync(tempProjectRoot, { recursive: true, force: true })
    }
  })

  it('exports artifacts using the injected adapter without creating its own', async () => {
    // Simulate the exact scenario from the bug: pipeline creates an InMemoryDatabaseAdapter,
    // writes decisions to it, then calls runExportAction. Without the adapter injection fix,
    // export creates a SECOND InMemoryDatabaseAdapter that has no data → writes zero files.
    const pipelineAdapter = new InMemoryDatabaseAdapter()
    await initSchema(pipelineAdapter)

    const run = await createPipelineRun(pipelineAdapter, { methodology: 'bmad' })

    await createDecision(pipelineAdapter, {
      pipeline_run_id: run.id,
      phase: 'analysis',
      category: 'product-brief',
      key: 'problem_statement',
      value: 'Test problem from shared adapter',
      rationale: null,
    })

    // The mock for createDatabaseAdapter should NOT be called when adapter is injected
    mockCreateDatabaseAdapter.mockClear()

    const outputDir = join(tempProjectRoot, 'artifacts')
    const exitCode = await runExportAction({
      runId: run.id,
      outputDir,
      projectRoot: tempProjectRoot,
      outputFormat: 'json',
      adapter: pipelineAdapter,
    })

    expect(exitCode).toBe(0)

    // createDatabaseAdapter should NOT have been called — we injected the adapter
    expect(mockCreateDatabaseAdapter).not.toHaveBeenCalled()

    const parsed = JSON.parse(stdoutOutput[0]!) as {
      files_written: string[]
      run_id: string
      phases_exported: string[]
    }

    // Product brief should have been exported from the shared adapter's data
    expect(parsed.phases_exported).toContain('analysis')
    expect(parsed.files_written.length).toBeGreaterThanOrEqual(1)

    const briefPath = parsed.files_written.find((p) => p.endsWith('product-brief.md'))
    expect(briefPath).toBeDefined()
    expect(existsSync(briefPath!)).toBe(true)

    const { readFileSync } = await import('node:fs')
    const content = readFileSync(briefPath!, 'utf-8')
    expect(content).toContain('Test problem from shared adapter')
  })

  it('does not close the injected adapter (caller owns lifecycle)', async () => {
    const pipelineAdapter = new InMemoryDatabaseAdapter()
    await initSchema(pipelineAdapter)

    const run = await createPipelineRun(pipelineAdapter, { methodology: 'bmad' })
    await createDecision(pipelineAdapter, {
      pipeline_run_id: run.id,
      phase: 'analysis',
      category: 'product-brief',
      key: 'problem_statement',
      value: 'Lifecycle test',
      rationale: null,
    })

    const outputDir = join(tempProjectRoot, 'artifacts-lifecycle')
    await runExportAction({
      runId: run.id,
      outputDir,
      projectRoot: tempProjectRoot,
      outputFormat: 'json',
      adapter: pipelineAdapter,
    })

    // The adapter should still be usable after runExportAction returns
    // (proves it was not closed by the export action)
    const rows = await pipelineAdapter.query<{ id: string }>(
      'SELECT id FROM pipeline_runs WHERE id = ?',
      [run.id],
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.id).toBe(run.id)
  })
})
