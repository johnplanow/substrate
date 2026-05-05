/**
 * Unit tests for CrossStoryConsistencyCheck — Story 68-1.
 *
 * Framework: Vitest (describe / it / expect — no Jest globals).
 * Uses vi.mock('child_process') to avoid requiring a real git repo.
 *
 * AC coverage:
 *   AC1    — CrossStoryConsistencyCheck class + runCrossStoryConsistencyCheck export
 *   AC4    — Layer 1 collision detection
 *   AC5    — Layer 2 diff validation: cross-story-concurrent-modification finding
 *   AC6    — DiffValidationCheck gated behind BuildCheck
 *   AC7    — ≥6 test cases including Epic 66 + Epic 67 reproduction fixtures
 *   AC8    — backward-compat: single-story context returns pass immediately
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import * as childProcess from 'child_process'

import {
  CrossStoryConsistencyCheck,
  runCrossStoryConsistencyCheck,
  computeCollisionPaths,
  diffContainsInterfaceOrConstChange,
} from '../../verification/checks/cross-story-consistency-check.js'
import { CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION } from '../../verification/findings.js'
import type { VerificationContext } from '../../verification/types.js'

// ---------------------------------------------------------------------------
// Mock child_process.execSync
// ---------------------------------------------------------------------------

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

const mockExecSync = childProcess.execSync as unknown as MockInstance

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    storyKey: 'test-story',
    workingDir: '/tmp/test-project',
    commitSha: 'abc123',
    timeout: 30_000,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper-function tests
// ---------------------------------------------------------------------------

describe('computeCollisionPaths', () => {
  it('returns empty array when priorStoryFiles and devStoryResult are absent', () => {
    const ctx = makeContext()
    expect(computeCollisionPaths(ctx)).toEqual([])
  })

  it('returns empty array when no overlap between current and prior files', () => {
    const ctx = makeContext({
      devStoryResult: { files_modified: ['src/foo.ts', 'src/bar.ts'] },
      priorStoryFiles: ['src/baz.ts', 'src/qux.ts'],
    })
    expect(computeCollisionPaths(ctx)).toEqual([])
  })

  it('returns overlapping paths when files intersect', () => {
    const ctx = makeContext({
      devStoryResult: { files_modified: ['src/shared.ts', 'src/foo.ts'] },
      priorStoryFiles: ['src/shared.ts', 'src/other.ts'],
    })
    expect(computeCollisionPaths(ctx)).toEqual(['src/shared.ts'])
  })

  it('uses _crossStoryConflictingFiles override when provided', () => {
    const ctx = makeContext({
      devStoryResult: { files_modified: ['src/foo.ts'] },
      priorStoryFiles: ['src/bar.ts'],
      _crossStoryConflictingFiles: ['src/override.ts'],
    })
    // Even though foo.ts and bar.ts don't overlap, the override wins
    expect(computeCollisionPaths(ctx)).toEqual(['src/override.ts'])
  })
})

describe('diffContainsInterfaceOrConstChange', () => {
  it('returns true for added export interface line', () => {
    const diff = `
+export interface Foo {
+  bar: string
+}
`
    expect(diffContainsInterfaceOrConstChange(diff)).toBe(true)
  })

  it('returns true for removed export type line', () => {
    const diff = `-export type Bar = string | number`
    expect(diffContainsInterfaceOrConstChange(diff)).toBe(true)
  })

  it('returns true for added const assignment', () => {
    const diff = `+const BUDGET_LIMIT = 32000`
    expect(diffContainsInterfaceOrConstChange(diff)).toBe(true)
  })

  it('returns true for export const', () => {
    const diff = `+export const BUDGET_LIMIT = 30000`
    expect(diffContainsInterfaceOrConstChange(diff)).toBe(true)
  })

  it('returns false for a diff with no type/const changes', () => {
    const diff = `
+  return result
-  return null
 // some comment
`
    expect(diffContainsInterfaceOrConstChange(diff)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Case 1: No overlap → pass, zero findings
// ---------------------------------------------------------------------------

describe('Case 1: no file overlap between concurrent stories', () => {
  it('returns pass with zero findings when priorStoryFiles and current files do not intersect', async () => {
    const ctx = makeContext({
      devStoryResult: { files_modified: ['src/foo.ts', 'src/bar.ts'] },
      priorStoryFiles: ['src/baz.ts', 'src/qux.ts'],
    })

    const result = await runCrossStoryConsistencyCheck(ctx)
    expect(result.status).toBe('pass')
    expect(result.findings ?? []).toHaveLength(0)
    expect(result.details).toContain('no file collisions')
  })
})

// ---------------------------------------------------------------------------
// Case 2: Layer 1 path collision → warn finding + event payload shape
// ---------------------------------------------------------------------------

describe('Case 2: Layer 1 path collision', () => {
  beforeEach(() => {
    // Layer 2: return empty diff so only Layer 1 fires
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('numstat')) return ''
      if (typeof cmd === 'string' && cmd.includes('diff')) return ''
      return ''
    })
  })

  it('returns warn and emits cross-story-file-collision payload shape when files overlap', async () => {
    const ctx = makeContext({
      devStoryResult: { files_modified: ['src/shared/config.ts', 'src/foo.ts'] },
      priorStoryFiles: ['src/shared/config.ts', 'src/other.ts'],
      buildCheckPassed: true,
    })

    const result = await runCrossStoryConsistencyCheck(ctx)
    expect(result.status).toBe('warn')

    const collisionFindings = (result.findings ?? []).filter(
      (f) => f.category === 'cross-story-file-collision',
    )
    expect(collisionFindings.length).toBeGreaterThanOrEqual(1)

    const finding = collisionFindings[0]!
    expect(finding.message).toContain('src/shared/config.ts')
    expect(finding.severity).toBe('warn')
  })
})

// ---------------------------------------------------------------------------
// Case 3: Same file, no interface conflict → no cross-story-concurrent-modification finding
// ---------------------------------------------------------------------------

describe('Case 3: shared file with no interface conflict', () => {
  beforeEach(() => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('numstat')) {
        return '5\t3\tsrc/shared/config.ts\n'
      }
      // Diff for shared file: only simple logic changes, no types/consts
      return `
diff --git a/src/shared/config.ts b/src/shared/config.ts
--- a/src/shared/config.ts
+++ b/src/shared/config.ts
-  return oldValue
+  return newValue
`
    })
  })

  it('does not emit cross-story-concurrent-modification finding when no type/const changes', async () => {
    const ctx = makeContext({
      devStoryResult: { files_modified: ['src/shared/config.ts'] },
      priorStoryFiles: ['src/shared/config.ts'],
      buildCheckPassed: true,
    })

    const result = await runCrossStoryConsistencyCheck(ctx)
    const layer2Findings = (result.findings ?? []).filter(
      (f) => f.category === CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION,
    )
    expect(layer2Findings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Case 4: Layer 2 interface conflict → cross-story-concurrent-modification finding
// ---------------------------------------------------------------------------

describe('Case 4: Layer 2 interface conflict (budget: number vs budget: string)', () => {
  beforeEach(() => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('numstat')) {
        return '10\t5\tsrc/shared/config.ts\n'
      }
      // Diff shows export interface change
      return `
diff --git a/src/shared/config.ts b/src/shared/config.ts
--- a/src/shared/config.ts
+++ b/src/shared/config.ts
-export interface Config {
-  budget: string
+export interface Config {
+  budget: number
`
    })
  })

  it('returns warn with cross-story-concurrent-modification finding on interface conflict', async () => {
    const ctx = makeContext({
      devStoryResult: { files_modified: ['src/shared/config.ts'] },
      priorStoryFiles: ['src/shared/config.ts'],
      buildCheckPassed: true,
    })

    const result = await runCrossStoryConsistencyCheck(ctx)
    expect(result.status).toBe('warn')

    const layer2Findings = (result.findings ?? []).filter(
      (f) => f.category === CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION,
    )
    expect(layer2Findings.length).toBeGreaterThanOrEqual(1)
    expect(layer2Findings[0]!.severity).toBe('warn')
    expect(layer2Findings[0]!.message).toContain('src/shared/config.ts')
  })
})

// ---------------------------------------------------------------------------
// Case 5: Epic 66 canonical reproduction
// Concurrent stories modifying methodology-pack.test.ts with conflicting
// budget constant assertions (30000 vs 32000)
// ---------------------------------------------------------------------------

describe('Case 5: Epic 66 canonical reproduction', () => {
  const SHARED_FILE = 'packages/sdlc/src/__tests__/methodology-pack.test.ts'

  beforeEach(() => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('numstat')) {
        return `3\t3\t${SHARED_FILE}\n`
      }
      // Story 66-1 bumped BUDGET_LIMIT from 30000 to 32000 in the test file
      return `
diff --git a/${SHARED_FILE} b/${SHARED_FILE}
--- a/${SHARED_FILE}
+++ b/${SHARED_FILE}
-const BUDGET_LIMIT = 30000
+const BUDGET_LIMIT = 32000
`
    })
  })

  it('Layer 1 fires collision and Layer 2 emits modification finding for methodology-pack.test.ts', async () => {
    const ctx = makeContext({
      storyKey: '66-2', // story 66-2 ran after 66-1 already touched the file
      devStoryResult: { files_modified: [SHARED_FILE] },
      priorStoryFiles: [SHARED_FILE],
      buildCheckPassed: true,
    })

    const result = await runCrossStoryConsistencyCheck(ctx)
    expect(result.status).toBe('warn')

    // Layer 1
    const collisionFindings = (result.findings ?? []).filter(
      (f) => f.category === 'cross-story-file-collision',
    )
    expect(collisionFindings.length).toBeGreaterThanOrEqual(1)
    expect(collisionFindings[0]!.message).toContain(SHARED_FILE)

    // Layer 2
    const layer2Findings = (result.findings ?? []).filter(
      (f) => f.category === CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION,
    )
    expect(layer2Findings.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Case 6: Epic 67 canonical reproduction
// Same file-collision scenario with different story keys — verifies event
// payload shape (storyKeys + collisionPaths)
// ---------------------------------------------------------------------------

describe('Case 6: Epic 67 canonical reproduction', () => {
  const SHARED_FILE = 'packages/sdlc/src/__tests__/methodology-pack.test.ts'

  beforeEach(() => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('numstat')) {
        return `2\t2\t${SHARED_FILE}\n`
      }
      return `
diff --git a/${SHARED_FILE} b/${SHARED_FILE}
--- a/${SHARED_FILE}
+++ b/${SHARED_FILE}
-export const METHODOLOGY_BUDGET = 30000
+export const METHODOLOGY_BUDGET = 32000
`
    })
  })

  it('cross-story-file-collision finding identifies correct storyKey and collision path', async () => {
    const ctx = makeContext({
      storyKey: '67-2', // the story that ran concurrently with 67-1
      _crossStoryConflictingFiles: [SHARED_FILE],
      buildCheckPassed: true,
    })

    const result = await runCrossStoryConsistencyCheck(ctx)
    expect(result.status).toBe('warn')

    const collisionFindings = (result.findings ?? []).filter(
      (f) => f.category === 'cross-story-file-collision',
    )
    expect(collisionFindings.length).toBeGreaterThanOrEqual(1)
    expect(collisionFindings[0]!.message).toContain(SHARED_FILE)
    expect(collisionFindings[0]!.message).toContain('67-2') // storyKey in message
  })
})

// ---------------------------------------------------------------------------
// Case 7: BuildCheck gate — Layer 2 does NOT run when buildCheckPassed=false
// ---------------------------------------------------------------------------

describe('Case 7: BuildCheck gate — Layer 2 skipped when build failed', () => {
  it('returns zero cross-story-concurrent-modification findings when buildCheckPassed=false', async () => {
    // execSync should NOT be called for Layer 2 when build failed
    mockExecSync.mockImplementation(() => {
      throw new Error('should not be called')
    })

    const ctx = makeContext({
      devStoryResult: { files_modified: ['src/shared/config.ts'] },
      priorStoryFiles: ['src/shared/config.ts'],
      buildCheckPassed: false,
    })

    const result = await runCrossStoryConsistencyCheck(ctx)

    const layer2Findings = (result.findings ?? []).filter(
      (f) => f.category === CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION,
    )
    expect(layer2Findings).toHaveLength(0)

    // Layer 1 collision finding may still be present (it runs unconditionally)
    // but no Layer 2 findings
    expect(result.status).not.toBe('fail')
  })
})

// ---------------------------------------------------------------------------
// Case 8: Backward-compat — single-story context → pass immediately
// ---------------------------------------------------------------------------

describe('Case 8: backward-compat — single-story context returns pass', () => {
  it('returns pass immediately when no priorStoryFiles and no test-hook override', async () => {
    // execSync should NOT be called at all
    mockExecSync.mockImplementation(() => {
      throw new Error('should not be called')
    })

    const ctx = makeContext({
      devStoryResult: { files_modified: ['src/foo.ts'] },
      // priorStoryFiles intentionally absent
    })

    const result = await runCrossStoryConsistencyCheck(ctx)
    expect(result.status).toBe('pass')
    expect(result.findings ?? []).toHaveLength(0)
    expect(result.details).toContain('priorStoryFiles absent')
  })

  it('class-based invocation returns same result as standalone function', async () => {
    mockExecSync.mockImplementation(() => '')

    const ctx = makeContext({
      devStoryResult: { files_modified: ['src/foo.ts'] },
    })

    const check = new CrossStoryConsistencyCheck()
    expect(check.name).toBe('cross-story-consistency')
    expect(check.tier).toBe('B')

    const result = await check.run(ctx)
    expect(result.status).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// Finding category constant test
// ---------------------------------------------------------------------------

describe('CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION', () => {
  it('has the expected stable string value', () => {
    expect(CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION).toBe(
      'cross-story-concurrent-modification',
    )
  })
})
