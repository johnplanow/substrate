/**
 * Unit tests for StructuralValidator (Level 0 — Structural Output Validation).
 *
 * Covers all 12 required test cases from Story 33-2 AC7.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { StructuralValidator } from '../structural.js'
import type { ValidationContext } from '../../types.js'

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(result: unknown): ValidationContext {
  return {
    story: {
      story_key: 'test-33-2',
      story_file_path: '/tmp/story.md',
    } as ValidationContext['story'],
    result,
    attempt: 1,
    projectRoot: '/tmp',
  }
}

const validDevStoryResult = {
  result: 'success',
  ac_met: ['AC1', 'AC2'],
  ac_failures: [],
  files_modified: ['/tmp/foo.ts'],
  tests: 'pass',
}

const validCodeReviewResult = {
  verdict: 'SHIP_IT',
  issues: 0,
  issue_list: [],
  ac_checklist: [],
  notes: 'Looks good.',
}

const validCreateStoryResult = {
  result: 'success',
  story_file: '/tmp/new-story.md',
  story_key: '33-3',
  story_title: 'My New Story',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StructuralValidator', () => {
  const validator = new StructuralValidator()

  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true)
  })

  // Test 1: Valid DevStoryResult passes
  it('valid DevStoryResult passes with no failures', async () => {
    const result = await validator.run(makeCtx(validDevStoryResult))
    expect(result.passed).toBe(true)
    expect(result.failures.length).toBe(0)
  })

  // Test 2: Valid CodeReviewResult passes
  it('valid CodeReviewResult passes with no failures', async () => {
    const result = await validator.run(makeCtx(validCodeReviewResult))
    expect(result.passed).toBe(true)
    expect(result.failures.length).toBe(0)
  })

  // Test 3: Valid CreateStoryResult passes (existsSync mocked to true)
  it('valid CreateStoryResult passes with existsSync returning true', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const result = await validator.run(makeCtx(validCreateStoryResult))
    expect(result.passed).toBe(true)
    expect(result.failures.length).toBe(0)
  })

  // Test 4: Malformed dev-story result (missing `result` field) fails with schema errors
  it('malformed dev-story result (missing result field) fails with schema errors', async () => {
    const malformed = {
      ac_met: ['AC1'],
      ac_failures: [],
      files_modified: [],
      tests: 'pass',
      // missing `result` field
    }
    const result = await validator.run(makeCtx(malformed))
    expect(result.passed).toBe(false)
    expect(result.failures.length).toBeGreaterThan(0)
    expect(result.failures.some((f) => f.category === 'schema')).toBe(true)
  })

  // Test 5: LevelFailure has `location` (dotted path from ZodError) and `evidence` (error message)
  it('LevelFailure includes location (dotted path) and evidence (error message)', async () => {
    const malformed = {
      ac_met: ['AC1'],
      ac_failures: [],
      files_modified: [],
      tests: 'pass',
      // missing `result` field
    }
    const result = await validator.run(makeCtx(malformed))
    expect(result.passed).toBe(false)
    const failure = result.failures[0]
    expect(failure).toHaveProperty('location')
    expect(typeof failure.location).toBe('string')
    expect(failure).toHaveProperty('evidence')
    expect(typeof failure.evidence).toBe('string')
  })

  // Test 6: Missing file in files_modified produces failure with path as location
  it('missing file in files_modified produces failure with path as location', async () => {
    const missingPath = '/tmp/does-not-exist.ts'
    vi.mocked(existsSync).mockReturnValueOnce(false)
    const result = await validator.run(
      makeCtx({ ...validDevStoryResult, files_modified: [missingPath] }),
    )
    expect(result.passed).toBe(false)
    const failure = result.failures.find((f) => f.location === missingPath)
    expect(failure).toBeDefined()
    expect(failure?.evidence).toBe('existsSync returned false')
    expect(vi.mocked(existsSync)).toHaveBeenCalledWith(missingPath)
  })

  // Test 7: Empty files_modified array skips file checks even when existsSync returns false
  it('empty files_modified array skips file checks even when existsSync returns false', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const result = await validator.run(
      makeCtx({ ...validDevStoryResult, files_modified: [] }),
    )
    // existsSync should NOT be called for file-check (only for schema validation path)
    // The key assertion: no file-check failures
    const fileFailures = result.failures.filter((f) => f.evidence === 'existsSync returned false')
    expect(fileFailures.length).toBe(0)
  })

  // Test 8: Create-story result with story_file that does not exist → failure
  it('create-story result with missing story_file produces failure with story_file as location', async () => {
    vi.mocked(existsSync).mockReturnValueOnce(false)
    const result = await validator.run(makeCtx(validCreateStoryResult))
    expect(result.passed).toBe(false)
    const failure = result.failures.find((f) => f.location === validCreateStoryResult.story_file)
    expect(failure).toBeDefined()
    expect(failure?.evidence).toBe('Story file not found on disk')
  })

  // Test 9: Create-story result without story_file → no story-file failure
  it('create-story result without story_file field produces no story-file failure', async () => {
    const noStoryFile = {
      result: 'success',
      story_key: '33-3',
      story_title: 'My New Story',
    }
    const result = await validator.run(makeCtx(noStoryFile))
    expect(result.passed).toBe(true)
    expect(result.failures.length).toBe(0)
  })

  // Test 10: Unknown result shape produces non-auto-remediable failure
  it('unknown result shape produces failed LevelResult with canAutoRemediate: false', async () => {
    const result = await validator.run(makeCtx({ foo: 'bar' }))
    expect(result.passed).toBe(false)
    expect(result.canAutoRemediate).toBe(false)
    expect(result.failures.length).toBe(1)
    expect(result.failures[0].description).toBe('Unable to determine task type from result shape')
  })

  // Test 11: Schema failure → canAutoRemediate true; unknown-type failure → canAutoRemediate false
  it('schema failure has canAutoRemediate: true; unknown-type failure has canAutoRemediate: false', async () => {
    // Schema failure
    const malformed = {
      ac_met: ['AC1'],
      ac_failures: [],
      files_modified: [],
      tests: 'pass',
    }
    const schemaFailResult = await validator.run(makeCtx(malformed))
    expect(schemaFailResult.passed).toBe(false)
    expect(schemaFailResult.canAutoRemediate).toBe(true)

    // Unknown-type failure
    const unknownResult = await validator.run(makeCtx({ foo: 'bar' }))
    expect(unknownResult.passed).toBe(false)
    expect(unknownResult.canAutoRemediate).toBe(false)
  })

  // Test 12: Execution time < 150ms (CI-buffered)
  it('execution time is under 150ms for any valid or invalid input', async () => {
    const before = Date.now()
    await validator.run(makeCtx(validDevStoryResult))
    const elapsed = Date.now() - before
    expect(elapsed).toBeLessThan(150)
  })
})
