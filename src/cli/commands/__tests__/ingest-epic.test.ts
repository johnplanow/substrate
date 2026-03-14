// @vitest-environment node
/**
 * Integration tests for the `substrate ingest-epic` CLI command.
 *
 * Story 31-2: Epic Doc Ingestion (AC5, AC6, AC7)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FIXTURE_EPIC_DOC = `
# Epic 31 — Dolt Work Graph

#### Story Map

**Sprint 1 — Foundation:**
- 31-1: Schema and Dolt init (P0, Small)
- 31-2: Epic doc ingestion (P0, Medium)

**Dependency chain**: 31-1 → 31-2
`

const FIXTURE_NO_STORY_MAP = `
# Epic 42

This document has no story map section.
`

// ---------------------------------------------------------------------------
// Mocks (must be declared before imports via vi.hoisted)
// ---------------------------------------------------------------------------

const {
  mockExistsSync,
  mockReadFileSync,
  mockAdapterExec,
  mockAdapterQuery,
  mockAdapterTransaction,
  mockAdapterClose,
  mockCreateDatabaseAdapter,
  mockIngest,
} = vi.hoisted(() => {
  const mockAdapterExec = vi.fn().mockResolvedValue(undefined)
  const mockAdapterClose = vi.fn().mockResolvedValue(undefined)
  const mockAdapterQuery = vi.fn().mockResolvedValue([])

  // transaction calls the callback with the adapter immediately
  const mockAdapterTransaction = vi.fn().mockImplementation(
    async (fn: (adapter: unknown) => Promise<unknown>) => {
      return fn({
        exec: mockAdapterExec,
        query: mockAdapterQuery,
        transaction: vi.fn(),
        close: mockAdapterClose,
      })
    },
  )

  const mockCreateDatabaseAdapter = vi.fn(() => ({
    exec: mockAdapterExec,
    query: mockAdapterQuery,
    transaction: mockAdapterTransaction,
    close: mockAdapterClose,
  }))

  const mockIngest = vi.fn()

  return {
    mockExistsSync: vi.fn<() => boolean>(),
    mockReadFileSync: vi.fn<() => string>(),
    mockAdapterExec,
    mockAdapterQuery,
    mockAdapterTransaction,
    mockAdapterClose,
    mockCreateDatabaseAdapter,
    mockIngest,
  }
})

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}))

vi.mock('../../../persistence/adapter.js', () => ({
  createDatabaseAdapter: mockCreateDatabaseAdapter,
}))

// Import after mocks are set up
import { registerIngestEpicCommand } from '../ingest-epic.js'
import { CyclicDependencyError } from '../../../modules/work-graph/errors.js'
import { EpicIngester } from '../../../modules/work-graph/epic-ingester.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createProgram(): Command {
  const program = new Command()
  program.exitOverride()
  registerIngestEpicCommand(program)
  return program
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ingest-epic command', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    process.exitCode = 0

    // Default: file exists, adapter returns no existing rows
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(FIXTURE_EPIC_DOC)
    mockAdapterQuery.mockResolvedValue([])
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    process.exitCode = 0
  })

  // -------------------------------------------------------------------------
  // AC5: Successful run
  // -------------------------------------------------------------------------

  it('exits 0 and prints summary on valid input', async () => {
    const program = createProgram()
    await program.parseAsync(['node', 'substrate', 'ingest-epic', 'epic-31.md'])

    expect(process.exitCode).not.toBe(1)

    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(output).toMatch(/Ingested \d+ stories and \d+ dependencies from epic 31/)
  })

  it('prints the correct epic number in the summary line', async () => {
    const program = createProgram()
    await program.parseAsync(['node', 'substrate', 'ingest-epic', 'epic-31.md'])

    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(output).toContain('from epic 31')
  })

  it('closes the adapter after a successful run', async () => {
    const program = createProgram()
    await program.parseAsync(['node', 'substrate', 'ingest-epic', 'epic-31.md'])

    expect(mockAdapterClose).toHaveBeenCalledOnce()
  })

  it('creates the database adapter with backend=auto', async () => {
    const program = createProgram()
    await program.parseAsync(['node', 'substrate', 'ingest-epic', 'epic-31.md'])

    expect(mockCreateDatabaseAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'auto' }),
    )
  })

  // -------------------------------------------------------------------------
  // AC7: File not found error
  // -------------------------------------------------------------------------

  it('exits 1 and prints error when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false)

    const program = createProgram()
    await program.parseAsync(['node', 'substrate', 'ingest-epic', 'missing-file.md'])

    expect(process.exitCode).toBe(1)

    const errOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(errOutput).toContain('Error:')
    expect(errOutput).toContain('missing-file.md')
    process.exitCode = 0
  })

  // -------------------------------------------------------------------------
  // AC7: Malformed doc error
  // -------------------------------------------------------------------------

  it('exits 1 and prints error when file content has no story map section', async () => {
    mockReadFileSync.mockReturnValue(FIXTURE_NO_STORY_MAP)

    const program = createProgram()
    await program.parseAsync(['node', 'substrate', 'ingest-epic', 'epic-42.md'])

    expect(process.exitCode).toBe(1)

    const errOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(errOutput).toMatch(/Error:.*No story map section/i)
    process.exitCode = 0
  })

  it('exits 1 and prints error when story map section has no valid story lines', async () => {
    mockReadFileSync.mockReturnValue(`
#### Story Map

This section exists but has no valid story lines.
    `)

    const program = createProgram()
    await program.parseAsync(['node', 'substrate', 'ingest-epic', 'epic-99.md'])

    expect(process.exitCode).toBe(1)

    const errOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(errOutput).toContain('Error:')
    process.exitCode = 0
  })

  // -------------------------------------------------------------------------
  // AC7: Cyclic dependency error
  // -------------------------------------------------------------------------

  it('exits 1 and prints "Cyclic dependency detected" to stderr when ingester throws CyclicDependencyError', async () => {
    vi.spyOn(EpicIngester.prototype, 'ingest').mockRejectedValueOnce(
      new CyclicDependencyError(['31-A', '31-B', '31-A']),
    )

    const program = createProgram()
    await program.parseAsync(['node', 'substrate', 'ingest-epic', 'epic-31.md'])

    expect(process.exitCode).toBe(1)

    const errOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(errOutput).toContain('Cyclic dependency detected')
    process.exitCode = 0
  })

  // -------------------------------------------------------------------------
  // AC6: Idempotent invocation
  // -------------------------------------------------------------------------

  it('exits 0 on second invocation with unchanged doc (idempotent)', async () => {
    // Simulate that stories already exist by returning a row from SELECT
    mockAdapterQuery.mockImplementation(async (sql: string) => {
      if (/SELECT\s+status/i.test(sql)) {
        return [{ status: 'planned' }]
      }
      return []
    })

    const program = createProgram()
    await program.parseAsync(['node', 'substrate', 'ingest-epic', 'epic-31.md'])

    expect(process.exitCode).not.toBe(1)

    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
    // Should succeed even when stories already exist
    expect(output).toContain('from epic 31')
  })
})
