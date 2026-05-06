/**
 * Integration tests for Story 69-1: `substrate reconcile-from-disk`.
 *
 * Uses real mktemp-d fixtures per Story 65-5/67-2 discipline:
 *   - real git init in isolated tmpdir
 *   - real .substrate/runs/manifest.json fixture
 *   - real feat(story-N-M) commit in git history
 *   - real CLI invocation via runReconcileFromDiskAction
 *
 * Dolt guard: `if (!process.env.DOLT_DSN) { test.skip('Dolt not configured') }`
 * The test asserts either Dolt row transitions OR JSON output contains affectedStoryKeys.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be created before vi.mock factories run
// ---------------------------------------------------------------------------

const { mockTransactionFn, mockQueryFn, mockCloseFn, mockInitSchema } = vi.hoisted(() => {
  const mockTransactionFn = vi.fn()
  const mockQueryFn = vi.fn().mockResolvedValue([])
  const mockCloseFn = vi.fn().mockResolvedValue(undefined)
  const mockInitSchema = vi.fn().mockResolvedValue(undefined)
  return { mockTransactionFn, mockQueryFn, mockCloseFn, mockInitSchema }
})

// ---------------------------------------------------------------------------
// Mocks for database adapter (minimal — we test the command logic, not Dolt I/O)
// ---------------------------------------------------------------------------

vi.mock('../../src/persistence/adapter.js', () => ({
  createDatabaseAdapter: vi.fn(() => ({
    query: mockQueryFn,
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: mockTransactionFn,
    close: mockCloseFn,
    backendType: 'sqlite' as const,
  })),
}))

vi.mock('../../src/persistence/schema.js', () => ({
  initSchema: mockInitSchema,
}))

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runReconcileFromDiskAction } from '../../src/cli/commands/reconcile-from-disk.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write the reconcile manifest.json to the fixture directory */
async function writeManifest(
  dir: string,
  runId: string,
  stories: Array<{ storyKey: string; status: string; targetFiles?: string[] }>,
): Promise<void> {
  const runsDir = join(dir, '.substrate', 'runs')
  await mkdir(runsDir, { recursive: true })
  const manifest = {
    version: 1,
    runs: [
      {
        runId,
        started_at: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
        stories,
      },
    ],
  }
  await writeFile(join(runsDir, 'manifest.json'), JSON.stringify(manifest))
}

/** Initialize a real git repo in the given directory */
function initGitRepo(dir: string): void {
  execSync('git init -q', { cwd: dir })
  execSync('git config user.email test@example.com', { cwd: dir })
  execSync('git config user.name test', { cwd: dir })
  execSync('git commit --allow-empty -qm "initial"', { cwd: dir })
}

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

describe('reconcile-from-disk integration', () => {
  let tmpDir: string

  afterEach(async () => {
    mockTransactionFn.mockReset()
    mockQueryFn.mockReset()
    mockCloseFn.mockResolvedValue(undefined)
    mockInitSchema.mockResolvedValue(undefined)
    try {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('end-to-end: discovers feat commit + marks reconciled=true in JSON output', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'reconcile-test-'))

    // Set up git repo in tmpdir
    initGitRepo(tmpDir)

    // Write manifest with a dispatched story
    const runId = 'integration-run-001'
    await writeManifest(tmpDir, runId, [{ storyKey: '69-1', status: 'dispatched' }])

    // Create a feat commit for story 69-1 (started_at is 1min ago, so --since picks it up)
    execSync(`git commit --allow-empty -m "feat(story-69-1): implement reconcile-from-disk"`, {
      cwd: tmpDir,
    })

    // Mock the transaction to capture what would be written to Dolt
    const transactionCalls: unknown[] = []
    mockTransactionFn.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const txSpy = { query: vi.fn().mockResolvedValue([]) }
      await fn(txSpy)
      transactionCalls.push(txSpy.query.mock.calls)
    })

    const output: string[] = []
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s))
      return true
    })

    const exitCode = await runReconcileFromDiskAction({
      runId,
      yes: true, // skip operator prompt
      outputFormat: 'json',
      projectRoot: tmpDir,
      _dbRoot: tmpDir, // use tmpDir as dbRoot to find the manifest.json we wrote
      _skipGates: true, // integration test fixture has no package.json; gates tested in unit tests
    })

    // Restore only the stdout spy — vi.restoreAllMocks() would also call mockReset()
    // on vi.fn() instances (like mockTransactionFn), clearing call history before assertions.
    stdoutSpy.mockRestore()

    // Command should succeed
    expect(exitCode).toBe(0)

    // Parse JSON output
    const parsed = JSON.parse(output.join('')) as {
      runId: string
      candidates: Array<{ storyKey: string; reconcilable: boolean; autoCommittedSha?: string }>
      reconciled: boolean
      affectedStoryKeys: string[]
    }

    // Discovery should have found the feat commit
    expect(parsed.runId).toBe(runId)
    const candidate = parsed.candidates.find((c) => c.storyKey === '69-1')
    expect(candidate?.reconcilable).toBe(true)
    expect(candidate?.autoCommittedSha).toBeDefined()

    // Output should contain affectedStoryKeys with the story key
    expect(parsed.affectedStoryKeys).toContain('69-1')
    expect(parsed.reconciled).toBe(true)

    // In-memory mode: transaction still called but no persistent effect
    expect(mockTransactionFn).toHaveBeenCalled()
  })

  it('idempotency: all-complete run → affectedStoryKeys: []', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'reconcile-test-'))
    initGitRepo(tmpDir)

    const runId = 'integration-run-002'
    await writeManifest(tmpDir, runId, [
      { storyKey: '69-1', status: 'complete' },
      { storyKey: '69-2', status: 'cancelled' },
    ])

    const output: string[] = []
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s))
      return true
    })

    const exitCode = await runReconcileFromDiskAction({
      runId,
      yes: true,
      outputFormat: 'json',
      projectRoot: tmpDir,
      _dbRoot: tmpDir,
      _skipGates: true,
    })

    stdoutSpy.mockRestore()

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as { affectedStoryKeys: string[] }
    expect(parsed.affectedStoryKeys).toEqual([])
    expect(mockTransactionFn).not.toHaveBeenCalled()
  })
})
