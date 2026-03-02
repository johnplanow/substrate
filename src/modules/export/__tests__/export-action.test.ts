/**
 * Tests for runExportAction: JSON output format (T13 / AC7).
 *
 * Isolated in its own file so that vi.mock('../../../utils/git-root.js') does
 * not bleed into the T11/T12 integration tests (which call renderers and
 * seedMethodologyContext directly and should not have git-root stubbed at the
 * module level).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../../../persistence/migrations/index.js'
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

// ---------------------------------------------------------------------------
// T13: runExportAction --output-format json (AC7)
// ---------------------------------------------------------------------------

describe('T13: runExportAction --output-format json', () => {
  let tempProjectRoot: string
  let runId: string
  let stdoutOutput: string[]
  let originalWrite: typeof process.stdout.write

  beforeEach(() => {
    // Create a real temp project root with a .substrate directory
    tempProjectRoot = join(tmpdir(), `substrate-export-json-test-${randomUUID()}`)
    const substrateDir = join(tempProjectRoot, '.substrate')
    mkdirSync(substrateDir, { recursive: true })

    // Create a real SQLite database file and seed it with decisions
    const dbPath = join(substrateDir, 'substrate.db')
    const db = new BetterSqlite3(dbPath)
    db.pragma('foreign_keys = ON')
    runMigrations(db)

    const run = createPipelineRun(db, { methodology: 'bmad' })
    runId = run.id

    // Insert decisions for all three phases so all 5 files are written
    createDecision(db, {
      pipeline_run_id: runId,
      phase: 'analysis',
      category: 'product-brief',
      key: 'problem_statement',
      value: 'Test problem statement for JSON export',
      rationale: null,
    })
    createDecision(db, {
      pipeline_run_id: runId,
      phase: 'planning',
      category: 'classification',
      key: 'type',
      value: 'saas-product',
      rationale: null,
    })
    createDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: 'language',
      value: 'TypeScript',
      rationale: null,
    })
    createDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'epics',
      key: 'epic-1',
      value: JSON.stringify({ title: 'Core', description: 'Core functionality' }),
      rationale: null,
    })
    createDecision(db, {
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
    createDecision(db, {
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

    // Close the file DB so DatabaseWrapper can reopen it
    db.close()

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

  afterEach(() => {
    // Restore process.stdout.write
    process.stdout.write = originalWrite

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
