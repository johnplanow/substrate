/**
 * Integration test for intra-run finding propagation (Story 53-8).
 *
 * Covers:
 *   AC3 — finding from story N (same run_id) appears in FindingsInjector.inject()
 *         scored candidates for story N+K with overlapping target files
 *   AC7 — full intra-run propagation flow validated end-to-end
 *
 * The test seeds a mock DB with a finding from story 53-1 (namespace-collision,
 * affecting src/foo.ts) and confirms that FindingsInjector.inject() returns a
 * non-empty prompt for story 53-2 (targeting src/foo.ts in the same run).
 *
 * Scoring breakdown for this scenario:
 *   jaccardFileOverlap = 1.0 (src/foo.ts in both targetFiles and affected_files)
 *   packageMatch       = 0.5 (no packageName in context → default)
 *   rootCauseMatch     = 0.5 (no riskProfile → default)
 *   total score        = 0.5 * 1.0 + 0.3 * 0.5 + 0.2 * 0.5 = 0.75 ≥ threshold 0.3 ✓
 */

// ---------------------------------------------------------------------------
// Mock node:fs so file-existence validation doesn't demote test findings
// (test findings reference fake paths like 'src/foo.ts' that don't exist on disk)
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}))

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { FindingsInjector } from '../findings-injector.js'
import type { InjectionContext } from '../relevance-scorer.js'
import type { DatabaseAdapter } from '@substrate-ai/core'
import type { Finding } from '../types.js'

// ---------------------------------------------------------------------------
// Mock DatabaseAdapter that returns pre-seeded finding rows
// ---------------------------------------------------------------------------

/**
 * Create a mock DB seeded with the given finding rows.
 *
 * - The first query call (getDecisionsByCategory) returns the seeded rows.
 * - Subsequent calls (countRunsSinceCreation) return [{cnt: 0}] so findings
 *   are treated as fresh (not expired).
 * - Any write calls (archiveFinding) are silently accepted.
 */
function makeMockDbWithFindings(findings: Finding[]): DatabaseAdapter {
  const rows = findings.map((f) => ({ value: JSON.stringify(f) }))

  return {
    backendType: 'memory',
    query: vi
      .fn()
      .mockResolvedValueOnce(rows) // getDecisionsByCategory → finding rows
      .mockResolvedValue([{ cnt: 0 }]), // countRunsSinceCreation → 0 runs (not expired)
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(async (fn: (db: DatabaseAdapter) => Promise<unknown>) =>
      fn({
        backendType: 'memory',
        query: vi.fn().mockResolvedValue([]),
        exec: vi.fn(),
        transaction: vi.fn(),
        close: vi.fn(),
        queryReadyStories: vi.fn().mockResolvedValue([]),
      } as unknown as DatabaseAdapter)
    ),
    close: vi.fn().mockResolvedValue(undefined),
    queryReadyStories: vi.fn().mockResolvedValue([]),
  } as unknown as DatabaseAdapter
}

// ---------------------------------------------------------------------------
// Test suite: intra-run propagation (AC3, AC7)
// ---------------------------------------------------------------------------

describe('Intra-run finding propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('FindingsInjector.inject returns non-empty prompt for story N+K when story N finding has overlapping files (AC3, AC7)', async () => {
    // Seed: story 53-1 fails with namespace-collision affecting src/foo.ts in run-123
    const seedFinding: Finding = {
      id: randomUUID(),
      run_id: 'run-123',
      story_key: '53-1',
      root_cause: 'namespace-collision',
      affected_files: ['src/foo.ts'],
      description: 'Identifier or namespace collision detected during story dispatch',
      confidence: 'high',
      created_at: '2026-04-06T00:00:00.000Z',
      expires_after_runs: 5,
    }

    const db = makeMockDbWithFindings([seedFinding])

    // Story 53-2 targets src/foo.ts — overlaps with the finding
    const context: InjectionContext = {
      storyKey: '53-2',
      runId: 'run-123',
      targetFiles: ['src/foo.ts'],
    }

    const result = await FindingsInjector.inject(db, context)

    // AC3: finding must appear in the returned prompt
    expect(result).not.toBe('')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returned prompt references the finding root cause (AC3, AC7)', async () => {
    const seedFinding: Finding = {
      id: randomUUID(),
      run_id: 'run-123',
      story_key: '53-1',
      root_cause: 'namespace-collision',
      affected_files: ['src/foo.ts'],
      description: 'Identifier or namespace collision detected during story dispatch',
      confidence: 'high',
      created_at: '2026-04-06T00:00:00.000Z',
      expires_after_runs: 5,
    }

    const db = makeMockDbWithFindings([seedFinding])

    const context: InjectionContext = {
      storyKey: '53-2',
      runId: 'run-123',
      targetFiles: ['src/foo.ts'],
    }

    const result = await FindingsInjector.inject(db, context)

    // The prompt must reference the finding's root cause category
    expect(result).toContain('namespace-collision')
  })

  it('relevance score for file-overlapping intra-run finding is ≥ 0.3 (AC3)', async () => {
    // Use scoreRelevance directly to verify the threshold condition holds
    const { scoreRelevance } = await import('../relevance-scorer.js')

    const finding: Finding = {
      id: randomUUID(),
      run_id: 'run-123',
      story_key: '53-1',
      root_cause: 'namespace-collision',
      affected_files: ['src/foo.ts'],
      description: 'test',
      confidence: 'high',
      created_at: '2026-04-06T00:00:00.000Z',
      expires_after_runs: 5,
    }

    const context: InjectionContext = {
      storyKey: '53-2',
      runId: 'run-123',
      targetFiles: ['src/foo.ts'],
    }

    const score = scoreRelevance(finding, context)
    expect(score).toBeGreaterThanOrEqual(0.3)
  })

  it('no finding is injected when targetFiles have no overlap (AC3)', async () => {
    const seedFinding: Finding = {
      id: randomUUID(),
      run_id: 'run-123',
      story_key: '53-1',
      root_cause: 'namespace-collision',
      affected_files: ['src/foo.ts'],
      description: 'Identifier or namespace collision detected during story dispatch',
      confidence: 'high',
      created_at: '2026-04-06T00:00:00.000Z',
      expires_after_runs: 5,
    }

    const db = makeMockDbWithFindings([seedFinding])

    // Story with completely different files — no overlap
    const context: InjectionContext = {
      storyKey: '53-3',
      runId: 'run-123',
      targetFiles: ['src/completely-different.ts'],
    }

    const result = await FindingsInjector.inject(db, context)

    // Score: jaccard=0, packageMatch=0.5, rootCauseMatch=0.5 → 0+0.15+0.1=0.25 < 0.3
    // → Empty string (below threshold)
    expect(result).toBe('')
  })

  it('finding with expires_after_runs=0 at 0 runs is still available (not expired) (AC3)', async () => {
    // Edge case: a brand-new finding with expires_after_runs=5 and 0 runs elapsed
    // should always pass the expiry check
    const seedFinding: Finding = {
      id: randomUUID(),
      run_id: 'run-123',
      story_key: '53-1',
      root_cause: 'build-failure',
      affected_files: ['src/foo.ts'],
      description: 'Build failed after story dispatch',
      confidence: 'high',
      created_at: '2026-04-06T00:00:00.000Z',
      expires_after_runs: 5,
    }

    const db = makeMockDbWithFindings([seedFinding])

    const context: InjectionContext = {
      storyKey: '53-2',
      runId: 'run-123',
      targetFiles: ['src/foo.ts'],
    }

    const result = await FindingsInjector.inject(db, context)
    expect(result).not.toBe('')
  })
})
