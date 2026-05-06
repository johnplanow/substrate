// @vitest-environment node
/**
 * Unit tests for reconcile-from-disk command — Story 69-1.
 *
 * Test cases:
 *   (a) discovery with auto-commit detection
 *   (b) discovery with working-tree-change detection
 *   (c) gate failure → no Dolt write + exit 1
 *   (d) operator decline → no Dolt write + exit 0
 *   (e) idempotency on already-reconciled run
 *   (f) --dry-run skips both gates and Dolt write
 *   (g) no active run → friendly error
 *
 * Design note: tests use the `_dbRoot` internal option to bypass
 * resolveMainRepoRoot and inject a known path without spawning git.
 * This avoids complex module-mock path resolution issues while keeping
 * the tests fast and deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be hoisted before any imports
// ---------------------------------------------------------------------------

const {
  mockSpawnSync,
  mockReadFile,
  mockAdapterTransaction,
  mockAdapterQuery,
  mockAdapterClose,
  mockAdapterInitSchema,
  mockReadCurrentRunId,
  mockResolveRunManifest,
  mockCreateInterface,
} = vi.hoisted(() => {
  const mockSpawnSync = vi.fn()
  const mockReadFile = vi.fn()
  const mockAdapterTransaction = vi.fn()
  const mockAdapterQuery = vi.fn().mockResolvedValue([])
  const mockAdapterClose = vi.fn().mockResolvedValue(undefined)
  const mockAdapterInitSchema = vi.fn().mockResolvedValue(undefined)
  const mockReadCurrentRunId = vi.fn().mockResolvedValue(null)
  const mockResolveRunManifest = vi.fn().mockResolvedValue({ manifest: null, runId: null })
  const mockCreateInterface = vi.fn()
  return {
    mockSpawnSync,
    mockReadFile,
    mockAdapterTransaction,
    mockAdapterQuery,
    mockAdapterClose,
    mockAdapterInitSchema,
    mockReadCurrentRunId,
    mockResolveRunManifest,
    mockCreateInterface,
  }
})

// ---------------------------------------------------------------------------
// vi.mock declarations (must appear before imports of mocked modules)
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawnSync: mockSpawnSync,
}))

vi.mock('node:readline', () => ({
  createInterface: mockCreateInterface,
}))

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}))

vi.mock('../../persistence/adapter.js', () => ({
  createDatabaseAdapter: vi.fn(() => ({
    query: mockAdapterQuery,
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: mockAdapterTransaction,
    close: mockAdapterClose,
    backendType: 'sqlite' as const,
  })),
}))

vi.mock('../../persistence/schema.js', () => ({
  initSchema: mockAdapterInitSchema,
}))

vi.mock('../../cli/commands/manifest-read.js', () => ({
  readCurrentRunId: mockReadCurrentRunId,
  resolveRunManifest: mockResolveRunManifest,
}))

vi.mock('../../utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// We also need to mock resolveMainRepoRoot, but since the tests use _dbRoot
// to bypass it, we just make it a passthrough to avoid any issues with
// the node:child_process mock removing 'spawn'.
vi.mock('../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockImplementation((cwd: string) => Promise.resolve(cwd ?? '/fake/dbroot')),
}))

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  runReconcileFromDiskAction,
  FEAT_COMMIT_PATTERN,
  detectAutoCommit,
  detectWorkingTreeChanges,
  runGateChain,
  tailWindow,
  readReconcileManifest,
  findRunEntry,
  type ReconcileManifest,
} from '../../cli/commands/reconcile-from-disk.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid ReconcileManifest fixture */
function makeManifest(overrides: Partial<ReconcileManifest> = {}): ReconcileManifest {
  return {
    version: 1,
    runs: [
      {
        runId: 'test-run-001',
        started_at: '2026-05-01T00:00:00Z',
        stories: [
          { storyKey: '69-1', status: 'dispatched' },
          { storyKey: '69-2', status: 'dispatched' },
        ],
      },
    ],
    ...overrides,
  }
}

/** Minimal spawnSync success result for mocking child_process.spawnSync */
function spawnOk(stdout = '') {
  return { status: 0, stdout, stderr: '', signal: null, pid: 123, output: [] }
}

/** Minimal spawnSync failure result for mocking child_process.spawnSync */
function spawnFail(stderr = 'build error') {
  return { status: 1, stdout: '', stderr, signal: null, pid: 123, output: [] }
}

// Test DB root — passed via _dbRoot to bypass resolveMainRepoRoot
const TEST_DB_ROOT = '/fake/project'

// ---------------------------------------------------------------------------
// Unit tests for FEAT_COMMIT_PATTERN
// ---------------------------------------------------------------------------

describe('FEAT_COMMIT_PATTERN', () => {
  it('matches feat(story-N-M) at start of line', () => {
    expect(FEAT_COMMIT_PATTERN.test('feat(story-69-1): implement reconcile')).toBe(true)
    expect(FEAT_COMMIT_PATTERN.test('feat(story-1-1): something')).toBe(true)
  })

  it('does not match non-feat commits', () => {
    expect(FEAT_COMMIT_PATTERN.test('chore: version bump')).toBe(false)
    expect(FEAT_COMMIT_PATTERN.test('fix: some bug')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unit tests for tailWindow
// ---------------------------------------------------------------------------

describe('tailWindow', () => {
  it('returns string as-is when below limit', () => {
    expect(tailWindow('hello')).toBe('hello')
  })

  it('truncates to last N bytes when above limit', () => {
    const bigStr = 'x'.repeat(70 * 1024) // 70KB
    const result = tailWindow(bigStr)
    expect(result.length).toBeLessThanOrEqual(64 * 1024)
  })

  it('returns empty string for empty input', () => {
    expect(tailWindow('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Unit tests for readReconcileManifest
// ---------------------------------------------------------------------------

describe('readReconcileManifest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns manifest when readFile succeeds with valid JSON', async () => {
    const manifest = makeManifest()
    mockReadFile.mockResolvedValue(JSON.stringify(manifest))
    const result = await readReconcileManifest(TEST_DB_ROOT)
    expect(result).not.toBeNull()
    expect(result?.runs[0]?.runId).toBe('test-run-001')
  })

  it('returns null when readFile throws (file not found)', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    const result = await readReconcileManifest(TEST_DB_ROOT)
    expect(result).toBeNull()
  })

  it('returns null when readFile returns invalid JSON', async () => {
    mockReadFile.mockResolvedValue('not valid json')
    const result = await readReconcileManifest(TEST_DB_ROOT)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Unit tests for findRunEntry
// ---------------------------------------------------------------------------

describe('findRunEntry', () => {
  const manifest = makeManifest()

  it('finds run by ID when specified', () => {
    const entry = findRunEntry(manifest, 'test-run-001')
    expect(entry?.runId).toBe('test-run-001')
  })

  it('returns last run when no ID specified', () => {
    const entry = findRunEntry(manifest)
    expect(entry?.runId).toBe('test-run-001')
  })

  it('returns null when specified ID not found', () => {
    const entry = findRunEntry(manifest, 'non-existent-run')
    expect(entry).toBeNull()
  })

  it('returns null for empty manifest', () => {
    const empty: ReconcileManifest = { version: 1, runs: [] }
    expect(findRunEntry(empty)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Unit tests for detectAutoCommit
// ---------------------------------------------------------------------------

describe('detectAutoCommit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('(a) detects auto-commit SHA from git log output', () => {
    mockSpawnSync.mockReturnValue(
      spawnOk('abc1234 feat(story-69-1): implement reconcile-from-disk\n'),
    )

    const sha = detectAutoCommit('69-1', '2026-05-01T00:00:00Z', '/fake/project')
    expect(sha).toBe('abc1234')
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        'log',
        '--oneline',
        '--since=2026-05-01T00:00:00Z',
        '--grep=feat(story-69-1)',
      ]),
      expect.objectContaining({ cwd: '/fake/project' }),
    )
  })

  it('returns undefined when no matching commits', () => {
    mockSpawnSync.mockReturnValue(spawnOk(''))

    const sha = detectAutoCommit('69-1', '2026-05-01T00:00:00Z', '/fake/project')
    expect(sha).toBeUndefined()
  })

  it('returns undefined when git command fails', () => {
    mockSpawnSync.mockReturnValue(spawnFail('not a git repository'))

    const sha = detectAutoCommit('69-1', '2026-05-01T00:00:00Z', '/fake/project')
    expect(sha).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Unit tests for detectWorkingTreeChanges
// ---------------------------------------------------------------------------

describe('detectWorkingTreeChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('(b) detects working-tree changes matching targetFiles', () => {
    // git status --porcelain: " M path" (space, status char, space, path)
    mockSpawnSync.mockReturnValue(spawnOk(' M src/cli/commands/reconcile-from-disk.ts\n'))

    const changed = detectWorkingTreeChanges(
      ['src/cli/commands/reconcile-from-disk.ts'],
      '/fake/project',
    )
    expect(changed).toContain('src/cli/commands/reconcile-from-disk.ts')
  })

  it('returns empty array when no targetFiles', () => {
    const changed = detectWorkingTreeChanges([], '/fake/project')
    expect(changed).toEqual([])
    expect(mockSpawnSync).not.toHaveBeenCalled()
  })

  it('returns empty array when git status fails', () => {
    mockSpawnSync.mockReturnValue(spawnFail())

    const changed = detectWorkingTreeChanges(['src/foo.ts'], '/fake/project')
    expect(changed).toEqual([])
  })

  it('returns empty array when no matching files', () => {
    mockSpawnSync.mockReturnValue(spawnOk(' M src/other-file.ts\n'))

    const changed = detectWorkingTreeChanges(['src/specific-file.ts'], '/fake/project')
    expect(changed).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Unit tests for runGateChain
// ---------------------------------------------------------------------------

describe('runGateChain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('(c) returns passed=false when build gate fails', () => {
    mockSpawnSync.mockReturnValue(spawnFail('TypeScript error'))

    const { passed, gateResults } = runGateChain('/fake/project')
    expect(passed).toBe(false)
    expect(gateResults[0]?.gate).toBe('build')
    expect(gateResults[0]?.passed).toBe(false)
  })

  it('halts gate chain at first failure — does not run subsequent gates', () => {
    mockSpawnSync.mockReturnValue(spawnFail())

    const { gateResults } = runGateChain('/fake/project')
    // Only 'build' ran; chain halted
    expect(gateResults.length).toBe(1)
  })

  it('returns passed=true when all gates pass', () => {
    mockSpawnSync.mockReturnValue(spawnOk())

    const { passed, gateResults } = runGateChain('/fake/project')
    expect(passed).toBe(true)
    expect(gateResults.length).toBe(4) // all 4 gates ran
    expect(gateResults.every((g) => g.passed)).toBe(true)
  })

  it('captures stderrTail from failing gate (64KB tail window)', () => {
    const bigStderr = 'e'.repeat(70 * 1024) // 70KB
    mockSpawnSync.mockReturnValue({ ...spawnFail(), stderr: bigStderr })

    const { gateResults } = runGateChain('/fake/project')
    const failedGate = gateResults[0]
    expect(failedGate?.stderrTail).toBeDefined()
    expect(Buffer.byteLength(failedGate?.stderrTail ?? '', 'utf-8')).toBeLessThanOrEqual(
      64 * 1024,
    )
  })
})

// ---------------------------------------------------------------------------
// Unit tests for runReconcileFromDiskAction (AC tests)
// ---------------------------------------------------------------------------

describe('runReconcileFromDiskAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: git log returns empty (no auto-commits) and git status empty
    mockSpawnSync.mockReturnValue(spawnOk(''))
    // Default: transaction succeeds
    mockAdapterTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({ query: vi.fn().mockResolvedValue([]) })
    })
    // Explicitly re-set adapter mocks since vi.clearAllMocks() may clear mockReturnValue/
    // mockResolvedValue implementations depending on Vitest internals.
    mockAdapterClose.mockResolvedValue(undefined)
    mockAdapterQuery.mockResolvedValue([])
    mockAdapterInitSchema.mockResolvedValue(undefined)
    // Default: readFile returns manifest
    mockReadFile.mockResolvedValue(JSON.stringify(makeManifest()))
    // Reset these to default null behavior
    mockReadCurrentRunId.mockResolvedValue(null)
    mockResolveRunManifest.mockResolvedValue({ manifest: null, runId: null })
    // Default readline: simulate operator pressing 'n' (operator decline)
    // Tests that use yes=true never reach this path, so this is a safe default.
    mockCreateInterface.mockReturnValue({
      question: (_q: string, cb: (a: string) => void) => {
        cb('n')
      },
      close: vi.fn(),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('(e) idempotency — all stories complete/cancelled → exit 0 with affectedStoryKeys: []', async () => {
    const manifest = makeManifest({
      runs: [
        {
          runId: 'test-run-001',
          started_at: '2026-05-01T00:00:00Z',
          stories: [
            { storyKey: '69-1', status: 'complete' },
            { storyKey: '69-2', status: 'cancelled' },
          ],
        },
      ],
    })
    mockReadFile.mockResolvedValue(JSON.stringify(manifest))

    const output: string[] = []
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s))
      return true
    })

    const exitCode = await runReconcileFromDiskAction({
      runId: 'test-run-001',
      outputFormat: 'json',
      projectRoot: '/fake/project',
      _dbRoot: TEST_DB_ROOT,
    })

    writeSpy.mockRestore()
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as { affectedStoryKeys: string[] }
    expect(parsed.affectedStoryKeys).toEqual([])
    // No gates should have run (transaction not called)
    expect(mockAdapterTransaction).not.toHaveBeenCalled()
  })

  it('(f) --dry-run skips both gates and Dolt write', async () => {
    const manifest = makeManifest()
    mockReadFile.mockResolvedValue(JSON.stringify(manifest))
    // Return auto-commit for story 69-1 on first spawnSync call, then empty
    mockSpawnSync
      .mockReturnValueOnce(spawnOk('abc1234 feat(story-69-1): ship\n'))
      .mockReturnValue(spawnOk(''))

    const output: string[] = []
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s))
      return true
    })

    const exitCode = await runReconcileFromDiskAction({
      runId: 'test-run-001',
      dryRun: true,
      outputFormat: 'json',
      projectRoot: '/fake/project',
      _dbRoot: TEST_DB_ROOT,
    })

    writeSpy.mockRestore()
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      candidates: Array<{ storyKey: string; reconcilable: boolean }>
      gateResults: unknown[]
      reconciled: boolean
    }
    expect(parsed.candidates.length).toBeGreaterThan(0)
    expect(parsed.gateResults).toEqual([]) // no gates in dry-run
    expect(parsed.reconciled).toBe(false)
    // No Dolt write
    expect(mockAdapterTransaction).not.toHaveBeenCalled()
  })

  it('(c) gate failure → no Dolt write + exit 1', async () => {
    const manifest = makeManifest()
    mockReadFile.mockResolvedValue(JSON.stringify(manifest))
    // Auto-commit exists for both stories, then build gate fails
    mockSpawnSync
      .mockReturnValueOnce(spawnOk('abc1234 feat(story-69-1): ship\n')) // git log for 69-1
      .mockReturnValueOnce(spawnOk('def5678 feat(story-69-2): ship\n')) // git log for 69-2
      .mockReturnValueOnce(spawnFail('build failed')) // build gate fails

    const output: string[] = []
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s))
      return true
    })

    const exitCode = await runReconcileFromDiskAction({
      runId: 'test-run-001',
      yes: true,
      outputFormat: 'json',
      projectRoot: '/fake/project',
      _dbRoot: TEST_DB_ROOT,
    })

    writeSpy.mockRestore()
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output.join('')) as {
      reconciled: boolean
      affectedStoryKeys: string[]
      gateResults: Array<{ passed: boolean }>
    }
    expect(parsed.reconciled).toBe(false)
    expect(parsed.affectedStoryKeys).toEqual([])
    expect(parsed.gateResults.some((g) => !g.passed)).toBe(true)
    // No Dolt write
    expect(mockAdapterTransaction).not.toHaveBeenCalled()
  })

  it('(d) operator decline → no Dolt write + exit 0', async () => {
    const manifest = makeManifest()
    mockReadFile.mockResolvedValue(JSON.stringify(manifest))
    // Auto-commits exist for both stories, then gates all pass
    mockSpawnSync
      .mockReturnValueOnce(spawnOk('abc1234 feat(story-69-1): ship\n'))
      .mockReturnValueOnce(spawnOk('def5678 feat(story-69-2): ship\n'))
      // Gates all pass (4 gates × 1 call each)
      .mockReturnValue(spawnOk())

    // mockCreateInterface is already set up in beforeEach to simulate pressing 'n'
    // (the default readline mock returns 'n' to promptOperator)

    const output: string[] = []
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s))
      return true
    })

    const exitCode = await runReconcileFromDiskAction({
      runId: 'test-run-001',
      yes: false,
      outputFormat: 'json',
      projectRoot: '/fake/project',
      _dbRoot: TEST_DB_ROOT,
    })

    writeSpy.mockRestore()

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      reconciled: boolean
      affectedStoryKeys: string[]
    }
    expect(parsed.reconciled).toBe(false)
    expect(parsed.affectedStoryKeys).toEqual([])
    expect(mockAdapterTransaction).not.toHaveBeenCalled()
  })

  it('(g) no active run → friendly error mentioning substrate metrics', async () => {
    // No manifest.json (readFile throws), no current-run-id
    mockReadFile.mockRejectedValue(new Error('ENOENT'))
    mockReadCurrentRunId.mockResolvedValue(null)
    mockResolveRunManifest.mockResolvedValue({ manifest: null, runId: null })

    const stderrOutput: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      stderrOutput.push(String(s))
      return true
    })

    const exitCode = await runReconcileFromDiskAction({
      outputFormat: 'human',
      projectRoot: '/fake/project',
      _dbRoot: TEST_DB_ROOT,
    })

    stderrSpy.mockRestore()
    expect(exitCode).toBe(1)
    const errorMsg = stderrOutput.join('')
    expect(errorMsg).toContain('substrate metrics --output-format json')
  })

  it('(a) discovery with auto-commit detection marks story reconcilable', async () => {
    const manifest: ReconcileManifest = {
      version: 1,
      runs: [
        {
          runId: 'test-run-001',
          started_at: '2026-05-01T00:00:00Z',
          stories: [{ storyKey: '69-1', status: 'dispatched' }],
        },
      ],
    }
    mockReadFile.mockResolvedValue(JSON.stringify(manifest))
    // Git log returns a feat commit for story 69-1, then all 4 gates pass
    mockSpawnSync
      .mockReturnValueOnce(spawnOk('abc1234 feat(story-69-1): implement\n')) // git log
      .mockReturnValue(spawnOk()) // all 4 gates pass

    const output: string[] = []
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s))
      return true
    })

    const exitCode = await runReconcileFromDiskAction({
      runId: 'test-run-001',
      yes: true,
      outputFormat: 'json',
      projectRoot: '/fake/project',
      _dbRoot: TEST_DB_ROOT,
    })

    writeSpy.mockRestore()
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      candidates: Array<{ storyKey: string; reconcilable: boolean; autoCommittedSha?: string }>
      reconciled: boolean
      affectedStoryKeys: string[]
    }
    const candidate = parsed.candidates.find((c) => c.storyKey === '69-1')
    expect(candidate?.reconcilable).toBe(true)
    expect(candidate?.autoCommittedSha).toBe('abc1234')
    expect(parsed.reconciled).toBe(true)
    expect(parsed.affectedStoryKeys).toContain('69-1')
  })

  it('(b) discovery with working-tree-change detection marks story reconcilable', async () => {
    const manifest: ReconcileManifest = {
      version: 1,
      runs: [
        {
          runId: 'test-run-002',
          started_at: '2026-05-01T00:00:00Z',
          stories: [
            {
              storyKey: '69-1',
              status: 'dispatched',
              targetFiles: ['src/cli/commands/reconcile-from-disk.ts'],
            },
          ],
        },
      ],
    }
    mockReadFile.mockResolvedValue(JSON.stringify(manifest))
    // No auto-commit, but working-tree change exists, then gates all pass
    mockSpawnSync
      .mockReturnValueOnce(spawnOk('')) // git log (no auto-commit)
      .mockReturnValueOnce(spawnOk(' M src/cli/commands/reconcile-from-disk.ts\n')) // git status
      .mockReturnValue(spawnOk()) // gates all pass

    const output: string[] = []
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s))
      return true
    })

    const exitCode = await runReconcileFromDiskAction({
      runId: 'test-run-002',
      yes: true,
      outputFormat: 'json',
      projectRoot: '/fake/project',
      _dbRoot: TEST_DB_ROOT,
    })

    writeSpy.mockRestore()
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      candidates: Array<{ storyKey: string; reconcilable: boolean; modifiedFiles: string[] }>
      reconciled: boolean
    }
    const candidate = parsed.candidates.find((c) => c.storyKey === '69-1')
    expect(candidate?.reconcilable).toBe(true)
    expect(candidate?.modifiedFiles.length).toBeGreaterThan(0)
    expect(parsed.reconciled).toBe(true)
  })
})
