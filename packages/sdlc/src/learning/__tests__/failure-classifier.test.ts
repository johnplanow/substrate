/**
 * Unit tests for classifyFailure and buildFinding.
 *
 * Story 53-5: Root Cause Taxonomy and Failure Classification
 */

import { describe, it, expect } from 'vitest'
import { classifyFailure, buildFinding } from '../failure-classifier.js'
import type { StoryFailureContext } from '../types.js'

// ---------------------------------------------------------------------------
// classifyFailure — rule chain tests
// ---------------------------------------------------------------------------

describe('classifyFailure', () => {
  const base: Pick<StoryFailureContext, 'storyKey' | 'runId'> = { storyKey: 'x', runId: 'r' }

  it('returns namespace-collision when error includes "already exists"', () => {
    expect(classifyFailure({ ...base, error: 'already exists' })).toBe('namespace-collision')
  })

  it('returns dependency-ordering when error includes "depends on"', () => {
    expect(classifyFailure({ ...base, error: 'depends on foo' })).toBe('dependency-ordering')
  })

  it('returns dependency-ordering when error includes "not found"', () => {
    expect(classifyFailure({ ...base, error: 'module not found' })).toBe('dependency-ordering')
  })

  it('returns resource-exhaustion when outputTokens is 50 (< 100)', () => {
    expect(classifyFailure({ ...base, outputTokens: 50 })).toBe('resource-exhaustion')
  })

  it('returns unclassified when outputTokens is exactly 100 (boundary: NOT < 100)', () => {
    expect(classifyFailure({ ...base, outputTokens: 100 })).toBe('unclassified')
  })

  it('returns build-failure when buildFailed is true', () => {
    expect(classifyFailure({ ...base, buildFailed: true })).toBe('build-failure')
  })

  it('returns test-failure when testsFailed is true', () => {
    expect(classifyFailure({ ...base, testsFailed: true })).toBe('test-failure')
  })

  it('returns adapter-format when adapterError is true', () => {
    expect(classifyFailure({ ...base, adapterError: true })).toBe('adapter-format')
  })

  it('returns infrastructure for "heap out of memory"', () => {
    expect(classifyFailure({ ...base, error: 'heap out of memory' })).toBe('infrastructure')
  })

  it('returns infrastructure for "ENOSPC no space left"', () => {
    expect(classifyFailure({ ...base, error: 'ENOSPC no space left' })).toBe('infrastructure')
  })

  it('returns infrastructure for "EACCES permission denied"', () => {
    expect(classifyFailure({ ...base, error: 'EACCES permission denied' })).toBe('infrastructure')
  })

  it('returns infrastructure for "Process received SIGKILL"', () => {
    expect(classifyFailure({ ...base, error: 'Process received SIGKILL' })).toBe('infrastructure')
  })

  it('returns unclassified when no fields match', () => {
    expect(classifyFailure({ ...base })).toBe('unclassified')
  })

  // Priority tests — first matching rule wins
  it('returns namespace-collision (rule 1) over resource-exhaustion and build-failure', () => {
    expect(
      classifyFailure({ ...base, error: 'already exists', outputTokens: 5, buildFailed: true })
    ).toBe('namespace-collision')
  })

  it('returns resource-exhaustion (rule 3) over build-failure (rule 4)', () => {
    expect(classifyFailure({ ...base, outputTokens: 5, buildFailed: true })).toBe(
      'resource-exhaustion'
    )
  })
})

// ---------------------------------------------------------------------------
// buildFinding — confidence and description tests
// ---------------------------------------------------------------------------

describe('buildFinding', () => {
  const ctx: StoryFailureContext = { storyKey: '53-5', runId: 'run-abc' }

  it('sets confidence to "low" for unclassified root cause', () => {
    const finding = buildFinding(ctx, 'unclassified', ctx.runId)
    expect(finding.confidence).toBe('low')
  })

  it('sets confidence to "high" for build-failure', () => {
    const finding = buildFinding(ctx, 'build-failure', ctx.runId)
    expect(finding.confidence).toBe('high')
  })

  it('sets description to ctx.error for unclassified with an error', () => {
    const finding = buildFinding({ ...ctx, error: 'some error' }, 'unclassified', ctx.runId)
    expect(finding.description).toContain('some error')
  })

  it('sets description to "No error text available" for unclassified with no error', () => {
    const finding = buildFinding(ctx, 'unclassified', ctx.runId)
    expect(finding.description).toBe('No error text available')
  })

  it('produces a valid UUID for the id field', () => {
    const finding = buildFinding(ctx, 'build-failure', ctx.runId)
    expect(finding.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('sets created_at to a valid ISO string', () => {
    const finding = buildFinding(ctx, 'test-failure', ctx.runId)
    expect(() => new Date(finding.created_at)).not.toThrow()
    expect(new Date(finding.created_at).toISOString()).toBe(finding.created_at)
  })

  it('sets expires_after_runs to 5', () => {
    const finding = buildFinding(ctx, 'build-failure', ctx.runId)
    expect(finding.expires_after_runs).toBe(5)
  })

  it('sets affected_files from ctx.affectedFiles when provided', () => {
    const finding = buildFinding(
      { ...ctx, affectedFiles: ['src/foo.ts'] },
      'build-failure',
      ctx.runId
    )
    expect(finding.affected_files).toEqual(['src/foo.ts'])
  })

  it('sets affected_files to [] when ctx.affectedFiles is absent', () => {
    const finding = buildFinding(ctx, 'build-failure', ctx.runId)
    expect(finding.affected_files).toEqual([])
  })

  it('sets story_key and run_id from ctx and runId argument', () => {
    const finding = buildFinding(ctx, 'build-failure', 'run-xyz')
    expect(finding.story_key).toBe('53-5')
    expect(finding.run_id).toBe('run-xyz')
  })
})
