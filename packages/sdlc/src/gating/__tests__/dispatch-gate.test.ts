/**
 * Unit tests for DispatchGate.
 *
 * Story 53-9: Dispatch Pre-Condition Gating (AC3, AC4, AC5, AC6, AC7)
 *
 * Tests:
 *   - no overlap → proceed
 *   - file overlap, no collision → warn
 *   - namespace collision, resolvable → block with modifiedPrompt
 *   - namespace collision, empty storyContent → gated
 *   - learning pre-emption with high-confidence finding → block
 *   - DB error during learning query → proceed (AC7 non-fatal)
 */

// Mock declarations FIRST (vitest hoists vi.mock() calls)

vi.mock('@substrate-ai/core', () => ({
  getDecisionsByCategory: vi.fn(),
  LEARNING_FINDING: 'finding',
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { getDecisionsByCategory } from '@substrate-ai/core'
import type { DatabaseAdapter } from '@substrate-ai/core'
import { DispatchGate } from '../dispatch-gate.js'
import type { DispatchGateOptions } from '../types.js'
import type { Finding } from '../../learning/types.js'

const mockReadFile = vi.mocked(readFile)
const mockGetDecisionsByCategory = vi.mocked(getDecisionsByCategory)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDb(): DatabaseAdapter {
  return {
    backendType: 'memory',
    query: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    queryReadyStories: vi.fn().mockResolvedValue([]),
  } as unknown as DatabaseAdapter
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: randomUUID(),
    run_id: 'run-test',
    story_key: '53-9',
    root_cause: 'namespace-collision',
    affected_files: ['packages/sdlc/src/gating/conflict-detector.ts'],
    description: 'ConflictDetector already exists in the codebase',
    confidence: 'high',
    created_at: '2026-04-06T00:00:00.000Z',
    expires_after_runs: 5,
    ...overrides,
  }
}

function makeDecisionRow(finding: Finding): { value: string } {
  return { value: JSON.stringify(finding) }
}

function makeGateOptions(overrides: Partial<DispatchGateOptions> = {}): DispatchGateOptions {
  return {
    storyKey: '53-9',
    storyContent: '# Story 53-9\nexport class ConflictDetector { }',
    pendingFiles: ['packages/sdlc/src/gating/conflict-detector.ts'],
    completedStories: [],
    db: makeMockDb(),
    projectRoot: '/project',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DispatchGate.check', () => {
  beforeEach(() => {
    mockReadFile.mockReset()
    mockGetDecisionsByCategory.mockReset()
    // Default: no learning findings
    mockGetDecisionsByCategory.mockResolvedValue([])
  })

  // -------------------------------------------------------------------------
  // AC7 — No overlap → proceed
  // -------------------------------------------------------------------------

  it('returns proceed when there are no completed stories (AC7 — no conflict)', async () => {
    const result = await DispatchGate.check(
      makeGateOptions({
        completedStories: [],
      })
    )

    expect(result.decision).toBe('proceed')
  })

  it('returns proceed when completed stories have no file overlap', async () => {
    const result = await DispatchGate.check(
      makeGateOptions({
        pendingFiles: ['packages/sdlc/src/gating/types.ts'],
        completedStories: [{ key: '53-8', modifiedFiles: ['packages/sdlc/src/learning/types.ts'] }],
      })
    )

    expect(result.decision).toBe('proceed')
  })

  // -------------------------------------------------------------------------
  // AC2 — File overlap, no collision → warn
  // -------------------------------------------------------------------------

  it('returns warn when files overlap but no namespace collision is found (AC2)', async () => {
    mockReadFile.mockResolvedValue('export class OtherClass { }' as unknown as Buffer)

    const result = await DispatchGate.check(
      makeGateOptions({
        storyContent: 'export class DispatchGate { }',
        pendingFiles: ['packages/sdlc/src/gating/dispatch-gate.ts'],
        completedStories: [
          {
            key: '53-8',
            modifiedFiles: ['packages/sdlc/src/gating/dispatch-gate.ts'],
          },
        ],
      })
    )

    expect(result.decision).toBe('warn')
    expect(result.conflictType).toBe('file-overlap')
    expect(result.completedStoryKey).toBe('53-8')
    expect(result.overlappingFiles).toContain('packages/sdlc/src/gating/dispatch-gate.ts')
  })

  // -------------------------------------------------------------------------
  // AC3 + AC4 — Namespace collision, resolvable → block
  // -------------------------------------------------------------------------

  it('returns block with modifiedPrompt when namespace collision is auto-resolved (AC3/AC4)', async () => {
    // File contains the symbol
    mockReadFile.mockResolvedValue('export class ConflictDetector { }' as unknown as Buffer)

    const storyContent = 'export class ConflictDetector { detect() { } }'
    const result = await DispatchGate.check(
      makeGateOptions({
        storyContent,
        pendingFiles: ['packages/sdlc/src/gating/conflict-detector.ts'],
        completedStories: [
          {
            key: '53-8',
            modifiedFiles: ['packages/sdlc/src/gating/conflict-detector.ts'],
          },
        ],
      })
    )

    expect(result.decision).toBe('block')
    expect(result.conflictType).toBe('namespace-collision')
    expect(result.modifiedPrompt).toBeDefined()
    expect(result.modifiedPrompt).toContain('ConflictDetector')
    expect(result.modifiedPrompt).toContain('already exists in')
    expect(result.modifiedPrompt).toContain('Extend the existing implementation')
  })

  // -------------------------------------------------------------------------
  // AC5 — Namespace collision, empty storyContent → gated
  // -------------------------------------------------------------------------

  it('returns gated when storyContent is empty and collision exists (AC5)', async () => {
    mockReadFile.mockResolvedValue('export class ConflictDetector { }' as unknown as Buffer)

    const result = await DispatchGate.check(
      makeGateOptions({
        storyContent: '', // empty content → auto-resolution fails
        pendingFiles: ['packages/sdlc/src/gating/conflict-detector.ts'],
        completedStories: [
          {
            key: '53-8',
            modifiedFiles: ['packages/sdlc/src/gating/conflict-detector.ts'],
          },
        ],
      })
    )

    expect(result.decision).toBe('gated')
    expect(result.conflictType).toBe('namespace-collision')
    expect(result.completedStoryKey).toBe('53-8')
  })

  // -------------------------------------------------------------------------
  // AC6 — Learning pre-emption with high-confidence finding → block
  // -------------------------------------------------------------------------

  it('returns block for learning pre-emption with high-confidence namespace-collision finding (AC6)', async () => {
    const finding = makeFinding({
      root_cause: 'namespace-collision',
      confidence: 'high',
      affected_files: ['packages/sdlc/src/gating/conflict-detector.ts'],
    })

    mockGetDecisionsByCategory.mockResolvedValue([makeDecisionRow(finding)] as ReturnType<
      typeof getDecisionsByCategory
    > extends Promise<infer T>
      ? T
      : never)

    const result = await DispatchGate.check(
      makeGateOptions({
        storyContent: 'export class ConflictDetector { }',
        pendingFiles: ['packages/sdlc/src/gating/conflict-detector.ts'],
        completedStories: [], // no completed story overlap — pre-emption is from learning store only
      })
    )

    expect(result.decision).toBe('block')
    expect(result.conflictType).toBe('learning-preemption')
    expect(result.modifiedPrompt).toBeDefined()
    expect(result.modifiedPrompt).toContain('Extend the existing implementation')
  })

  it('does NOT pre-empt when finding has low confidence (AC6)', async () => {
    const finding = makeFinding({
      root_cause: 'namespace-collision',
      confidence: 'low', // low confidence → skip
      affected_files: ['packages/sdlc/src/gating/conflict-detector.ts'],
    })

    mockGetDecisionsByCategory.mockResolvedValue([makeDecisionRow(finding)] as ReturnType<
      typeof getDecisionsByCategory
    > extends Promise<infer T>
      ? T
      : never)

    const result = await DispatchGate.check(
      makeGateOptions({
        pendingFiles: ['packages/sdlc/src/gating/conflict-detector.ts'],
        completedStories: [],
      })
    )

    // Low confidence → not pre-empted → proceed (no other collisions)
    expect(result.decision).toBe('proceed')
  })

  it('does NOT pre-empt when finding root_cause is not namespace-collision (AC6)', async () => {
    const finding = makeFinding({
      root_cause: 'build-failure',
      confidence: 'high',
      affected_files: ['packages/sdlc/src/gating/conflict-detector.ts'],
    })

    mockGetDecisionsByCategory.mockResolvedValue([makeDecisionRow(finding)] as ReturnType<
      typeof getDecisionsByCategory
    > extends Promise<infer T>
      ? T
      : never)

    const result = await DispatchGate.check(
      makeGateOptions({
        pendingFiles: ['packages/sdlc/src/gating/conflict-detector.ts'],
        completedStories: [],
      })
    )

    expect(result.decision).toBe('proceed')
  })

  it('skips tombstoned (contradicted) findings during pre-emption (AC6)', async () => {
    const finding = makeFinding({
      root_cause: 'namespace-collision',
      confidence: 'high',
      affected_files: ['packages/sdlc/src/gating/conflict-detector.ts'],
      contradicted_by: 'run-prev', // tombstoned
    })

    mockGetDecisionsByCategory.mockResolvedValue([makeDecisionRow(finding)] as ReturnType<
      typeof getDecisionsByCategory
    > extends Promise<infer T>
      ? T
      : never)

    const result = await DispatchGate.check(
      makeGateOptions({
        pendingFiles: ['packages/sdlc/src/gating/conflict-detector.ts'],
        completedStories: [],
      })
    )

    expect(result.decision).toBe('proceed')
  })

  // -------------------------------------------------------------------------
  // AC7 — DB error → proceed (non-fatal)
  // -------------------------------------------------------------------------

  it('returns proceed when DB throws during learning query (AC7 non-fatal)', async () => {
    mockGetDecisionsByCategory.mockRejectedValue(new Error('DB connection failed'))

    const result = await DispatchGate.check(
      makeGateOptions({
        pendingFiles: ['packages/sdlc/src/gating/conflict-detector.ts'],
        completedStories: [],
      })
    )

    expect(result.decision).toBe('proceed')
  })

  it('returns proceed when an unexpected error is thrown (AC7 outer catch)', async () => {
    // Make db.query throw to simulate unexpected error
    const db = {
      ...makeMockDb(),
      query: vi.fn().mockRejectedValue(new Error('unexpected')),
    } as unknown as DatabaseAdapter

    // Also throw from getDecisionsByCategory
    mockGetDecisionsByCategory.mockRejectedValue(new Error('unexpected'))

    const result = await DispatchGate.check(makeGateOptions({ db }))
    expect(result.decision).toBe('proceed')
  })

  // -------------------------------------------------------------------------
  // Edge: malformed DB row is skipped gracefully
  // -------------------------------------------------------------------------

  it('skips malformed finding rows from DB without error (AC7)', async () => {
    // Return a row with invalid JSON
    mockGetDecisionsByCategory.mockResolvedValue([{ value: 'not-valid-json' }] as ReturnType<
      typeof getDecisionsByCategory
    > extends Promise<infer T>
      ? T
      : never)

    const result = await DispatchGate.check(
      makeGateOptions({
        pendingFiles: ['packages/sdlc/src/gating/conflict-detector.ts'],
        completedStories: [],
      })
    )

    expect(result.decision).toBe('proceed')
  })
})
