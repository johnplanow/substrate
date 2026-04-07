/**
 * Unit tests for FindingLifecycleManager.
 *
 * Story 53-7: Finding Validation, Deduplication, and Expiry (AC7)
 *
 * Covers:
 *   - validateFiles (AC1)
 *   - deduplicate (AC2)
 *   - isExpired, countRunsSinceCreation (AC3)
 *   - FindingsInjector.inject lifecycle integration (AC6)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Mock node:fs BEFORE importing FindingLifecycleManager
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}))

import * as fsModule from 'node:fs'
import { FindingLifecycleManager } from '../finding-lifecycle.js'
import { FindingsInjector } from '../findings-injector.js'
import type { Finding } from '../types.js'
import type { DatabaseAdapter } from '@substrate-ai/core'
import type { InjectionContext } from '../relevance-scorer.js'

// ---------------------------------------------------------------------------
// Finding factory
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: randomUUID(),
    run_id: 'run-1',
    story_key: '53-7',
    root_cause: 'build-failure',
    affected_files: ['packages/sdlc/src/foo.ts'],
    description: 'Build failed after story dispatch',
    confidence: 'high',
    created_at: '2026-04-06T00:00:00.000Z',
    expires_after_runs: 5,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock DatabaseAdapter factory
// ---------------------------------------------------------------------------

function makeMockDb(rows: Array<{ value: string }> = []): DatabaseAdapter {
  return {
    backendType: 'memory',
    query: vi.fn().mockResolvedValue(rows),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(async (fn: (db: DatabaseAdapter) => Promise<unknown>) =>
      fn({
        backendType: 'memory',
        query: vi.fn().mockResolvedValue([]),
        exec: vi.fn(),
        transaction: vi.fn(),
        close: vi.fn(),
        queryReadyStories: vi.fn().mockResolvedValue([]),
      } as unknown as DatabaseAdapter),
    ),
    close: vi.fn().mockResolvedValue(undefined),
    queryReadyStories: vi.fn().mockResolvedValue([]),
  } as unknown as DatabaseAdapter
}

// ---------------------------------------------------------------------------
// validateFiles tests (AC1, AC7)
// ---------------------------------------------------------------------------

describe('FindingLifecycleManager.validateFiles', () => {
  const projectRoot = '/project'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns finding unchanged when all files exist', () => {
    vi.mocked(fsModule.existsSync).mockReturnValue(true)

    const finding = makeFinding({
      affected_files: ['packages/sdlc/src/foo.ts', 'packages/sdlc/src/bar.ts'],
      confidence: 'high',
    })
    const result = FindingLifecycleManager.validateFiles(finding, projectRoot)

    expect(result).toStrictEqual(finding)
    expect(result.confidence).toBe('high')
    expect(result.contradicted_by).toBeUndefined()
  })

  it('returns finding unchanged when affected_files is empty', () => {
    const finding = makeFinding({ affected_files: [] })
    const result = FindingLifecycleManager.validateFiles(finding, projectRoot)

    expect(result).toStrictEqual(finding)
    // fs.existsSync should NOT be called
    expect(fsModule.existsSync).not.toHaveBeenCalled()
  })

  it('returns confidence: low when some (but not all) files are missing', () => {
    // First file exists, second file is missing
    vi.mocked(fsModule.existsSync)
      .mockReturnValueOnce(true)  // foo.ts exists
      .mockReturnValueOnce(false) // bar.ts missing

    const finding = makeFinding({
      affected_files: ['packages/sdlc/src/foo.ts', 'packages/sdlc/src/bar.ts'],
      confidence: 'high',
    })
    const result = FindingLifecycleManager.validateFiles(finding, projectRoot)

    expect(result.confidence).toBe('low')
    expect(result.contradicted_by).toBeUndefined()
    // All other fields preserved
    expect(result.id).toBe(finding.id)
    expect(result.description).toBe(finding.description)
  })

  it('returns confidence: low + contradicted_by: all-files-deleted when all files are missing', () => {
    vi.mocked(fsModule.existsSync).mockReturnValue(false)

    const finding = makeFinding({
      affected_files: ['packages/sdlc/src/foo.ts', 'packages/sdlc/src/bar.ts'],
      confidence: 'high',
    })
    const result = FindingLifecycleManager.validateFiles(finding, projectRoot)

    expect(result.confidence).toBe('low')
    expect(result.contradicted_by).toBe('all-files-deleted')
  })

  it('preserves existing confidence: low when it was already low before all-files-deleted case', () => {
    vi.mocked(fsModule.existsSync).mockReturnValue(false)

    const finding = makeFinding({
      affected_files: ['packages/sdlc/src/foo.ts'],
      confidence: 'low',
    })
    const result = FindingLifecycleManager.validateFiles(finding, projectRoot)

    expect(result.confidence).toBe('low')
    expect(result.contradicted_by).toBe('all-files-deleted')
  })

  it('calls existsSync with path.join(projectRoot, file) for each affected file', () => {
    vi.mocked(fsModule.existsSync).mockReturnValue(true)

    const finding = makeFinding({
      affected_files: ['packages/sdlc/src/foo.ts'],
    })
    FindingLifecycleManager.validateFiles(finding, '/my-project')

    expect(fsModule.existsSync).toHaveBeenCalledWith('/my-project/packages/sdlc/src/foo.ts')
  })
})

// ---------------------------------------------------------------------------
// deduplicate tests (AC2, AC7)
// ---------------------------------------------------------------------------

describe('FindingLifecycleManager.deduplicate', () => {
  it('returns empty array for empty input', () => {
    expect(FindingLifecycleManager.deduplicate([])).toEqual([])
  })

  it('returns single finding as-is', () => {
    const finding = makeFinding()
    const result = FindingLifecycleManager.deduplicate([finding])
    expect(result).toHaveLength(1)
    expect(result[0]).toStrictEqual(finding)
  })

  it('keeps only the most recent when two findings share fingerprint (older first)', () => {
    const older = makeFinding({
      root_cause: 'build-failure',
      affected_files: ['packages/sdlc/src/foo.ts'],
      created_at: '2026-04-01T00:00:00.000Z',
    })
    const newer = makeFinding({
      root_cause: 'build-failure',
      affected_files: ['packages/sdlc/src/foo.ts'],
      created_at: '2026-04-06T00:00:00.000Z',
    })

    const result = FindingLifecycleManager.deduplicate([older, newer])

    expect(result).toHaveLength(1)
    expect(result[0]?.created_at).toBe('2026-04-06T00:00:00.000Z')
  })

  it('keeps only the most recent when two findings share fingerprint (newer first)', () => {
    const newer = makeFinding({
      root_cause: 'build-failure',
      affected_files: ['packages/sdlc/src/foo.ts'],
      created_at: '2026-04-06T00:00:00.000Z',
    })
    const older = makeFinding({
      root_cause: 'build-failure',
      affected_files: ['packages/sdlc/src/foo.ts'],
      created_at: '2026-04-01T00:00:00.000Z',
    })

    const result = FindingLifecycleManager.deduplicate([newer, older])

    expect(result).toHaveLength(1)
    expect(result[0]?.created_at).toBe('2026-04-06T00:00:00.000Z')
  })

  it('returns two findings when three share two fingerprints (2 + 1)', () => {
    const dup1 = makeFinding({
      root_cause: 'build-failure',
      affected_files: ['packages/sdlc/src/foo.ts'],
      created_at: '2026-04-01T00:00:00.000Z',
    })
    const dup2 = makeFinding({
      root_cause: 'build-failure',
      affected_files: ['packages/sdlc/src/foo.ts'],
      created_at: '2026-04-06T00:00:00.000Z',
    })
    const unique = makeFinding({
      root_cause: 'test-failure',
      affected_files: ['packages/sdlc/src/bar.ts'],
      created_at: '2026-04-03T00:00:00.000Z',
    })

    const result = FindingLifecycleManager.deduplicate([dup1, dup2, unique])

    expect(result).toHaveLength(2)
    const retained = result.find((f) => f.root_cause === 'build-failure')
    expect(retained?.created_at).toBe('2026-04-06T00:00:00.000Z')
    expect(result.find((f) => f.root_cause === 'test-failure')).toBeDefined()
  })

  it('treats affected_files order as irrelevant for fingerprint (b.ts, a.ts vs a.ts, b.ts)', () => {
    const findingA = makeFinding({
      root_cause: 'build-failure',
      affected_files: ['b.ts', 'a.ts'],
      created_at: '2026-04-01T00:00:00.000Z',
    })
    const findingB = makeFinding({
      root_cause: 'build-failure',
      affected_files: ['a.ts', 'b.ts'],
      created_at: '2026-04-06T00:00:00.000Z',
    })

    const result = FindingLifecycleManager.deduplicate([findingA, findingB])

    // Both have the same fingerprint (sorted: a.ts,b.ts) → deduplicated to 1
    expect(result).toHaveLength(1)
    expect(result[0]?.created_at).toBe('2026-04-06T00:00:00.000Z')
  })

  it('preserves unique findings unchanged', () => {
    const f1 = makeFinding({ root_cause: 'build-failure', affected_files: ['a.ts'] })
    const f2 = makeFinding({ root_cause: 'test-failure', affected_files: ['b.ts'] })
    const f3 = makeFinding({ root_cause: 'namespace-collision', affected_files: ['c.ts'] })

    const result = FindingLifecycleManager.deduplicate([f1, f2, f3])

    expect(result).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// isExpired tests (AC3, AC7)
// ---------------------------------------------------------------------------

describe('FindingLifecycleManager.isExpired', () => {
  const finding5 = makeFinding({ expires_after_runs: 5 })

  it('returns false when runCount is 0', () => {
    expect(FindingLifecycleManager.isExpired(finding5, 0)).toBe(false)
  })

  it('returns false when runCount is 4 (expires_after_runs=5)', () => {
    expect(FindingLifecycleManager.isExpired(finding5, 4)).toBe(false)
  })

  it('returns true when runCount equals expires_after_runs (5)', () => {
    expect(FindingLifecycleManager.isExpired(finding5, 5)).toBe(true)
  })

  it('returns true when runCount exceeds expires_after_runs (10 > 5)', () => {
    expect(FindingLifecycleManager.isExpired(finding5, 10)).toBe(true)
  })

  it('returns true for custom expires_after_runs=2 with count 2', () => {
    const finding2 = makeFinding({ expires_after_runs: 2 })
    expect(FindingLifecycleManager.isExpired(finding2, 2)).toBe(true)
  })

  it('returns false for custom expires_after_runs=2 with count 1', () => {
    const finding2 = makeFinding({ expires_after_runs: 2 })
    expect(FindingLifecycleManager.isExpired(finding2, 1)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// countRunsSinceCreation tests (AC3, AC7)
// ---------------------------------------------------------------------------

describe('FindingLifecycleManager.countRunsSinceCreation', () => {
  it('returns count from DB when query succeeds (cnt as string "2")', async () => {
    const db = {
      query: vi.fn().mockResolvedValue([{ cnt: '2' }]),
    } as unknown as DatabaseAdapter

    const finding = makeFinding({ created_at: '2026-04-01T00:00:00.000Z', run_id: 'run-abc' })
    const result = await FindingLifecycleManager.countRunsSinceCreation(finding, db)

    expect(result).toBe(2)
  })

  it('returns count from DB when query succeeds (cnt as number 0)', async () => {
    const db = {
      query: vi.fn().mockResolvedValue([{ cnt: 0 }]),
    } as unknown as DatabaseAdapter

    const finding = makeFinding()
    const result = await FindingLifecycleManager.countRunsSinceCreation(finding, db)

    expect(result).toBe(0)
  })

  it('returns 0 when DB query throws (non-fatal)', async () => {
    const db = {
      query: vi.fn().mockRejectedValue(new Error('DB error')),
    } as unknown as DatabaseAdapter

    const finding = makeFinding()
    const result = await FindingLifecycleManager.countRunsSinceCreation(finding, db)

    expect(result).toBe(0)
  })

  it('queries with correct SQL parameters', async () => {
    const db = {
      query: vi.fn().mockResolvedValue([{ cnt: '3' }]),
    } as unknown as DatabaseAdapter

    const finding = makeFinding({ created_at: '2026-04-01T00:00:00.000Z', run_id: 'my-run' })
    await FindingLifecycleManager.countRunsSinceCreation(finding, db)

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('COUNT(DISTINCT pipeline_run_id)'),
      ['2026-04-01T00:00:00.000Z', 'my-run'],
    )
  })
})

// ---------------------------------------------------------------------------
// Integration test: FindingsInjector.inject filters contradicted_by (AC6, AC7)
// ---------------------------------------------------------------------------

describe('FindingsInjector.inject — lifecycle integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // All files "exist" by default for lifecycle integration tests
    vi.mocked(fsModule.existsSync).mockReturnValue(true)
  })

  it('excludes a finding with contradicted_by already set — returns empty string', async () => {
    const contradictedFinding = makeFinding({
      root_cause: 'build-failure',
      affected_files: ['packages/sdlc/src/foo.ts'],
      confidence: 'high',
      contradicted_by: 'some-prior-run',
    })

    // Mock DB to return the contradicted finding
    // Also mock the expiry count query to return 0 (no runs since creation)
    const db = {
      backendType: 'memory' as const,
      // First call: getDecisionsByCategory returns the finding row
      // Subsequent calls: expiry query returns 0
      query: vi.fn().mockResolvedValue([{ value: JSON.stringify(contradictedFinding) }]),
      exec: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      queryReadyStories: vi.fn().mockResolvedValue([]),
    } as unknown as DatabaseAdapter

    const context: InjectionContext = {
      storyKey: '53-7',
      runId: 'run-current',
      targetFiles: ['packages/sdlc/src/foo.ts'],
      packageName: 'sdlc',
      riskProfile: ['build-failure'],
    }

    const result = await FindingsInjector.inject(db, context)
    expect(result).toBe('')
  })

  it('includes a finding with contradicted_by undefined and high relevance score', async () => {
    const validFinding = makeFinding({
      root_cause: 'build-failure',
      affected_files: ['packages/sdlc/src/foo.ts'],
      confidence: 'high',
      contradicted_by: undefined,
    })

    // DB responses:
    // - First query (getDecisionsByCategory): returns the finding row
    // - Second query (countRunsSinceCreation): returns 0 runs (not expired)
    const db = {
      backendType: 'memory' as const,
      query: vi.fn()
        .mockResolvedValueOnce([{ value: JSON.stringify(validFinding) }]) // getDecisionsByCategory
        .mockResolvedValueOnce([{ cnt: '0' }]), // countRunsSinceCreation
      exec: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      queryReadyStories: vi.fn().mockResolvedValue([]),
    } as unknown as DatabaseAdapter

    const context: InjectionContext = {
      storyKey: '53-7',
      runId: 'run-current',
      targetFiles: ['packages/sdlc/src/foo.ts'],
      packageName: 'sdlc',
      riskProfile: ['build-failure'],
    }

    const result = await FindingsInjector.inject(db, context)
    expect(result).toContain('Directive: Build failed after story dispatch')
  })
})
