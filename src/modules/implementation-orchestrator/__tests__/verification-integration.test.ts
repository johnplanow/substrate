/**
 * Unit tests for Story 51-5: verification-integration module.
 *
 * Covers:
 *   - assembleVerificationContext: context assembly with correct fields
 *   - assembleVerificationContext: commitSha from mocked execSync return value
 *   - assembleVerificationContext: commitSha falls back to 'unknown' on execSync error
 *   - assembleVerificationContext: reviewResult and outputTokenCount forwarded when provided
 *   - assembleVerificationContext: reviewResult and outputTokenCount are undefined when omitted
 *   - VerificationStore.set/get: round-trip stores and retrieves summary by storyKey
 *   - VerificationStore.getAll: returns a ReadonlyMap with all set entries
 *   - VerificationStore.get: returns undefined for unknown storyKey
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({ execSync: vi.fn() }))

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock() calls
// ---------------------------------------------------------------------------

import { execSync } from 'node:child_process'
import { assembleVerificationContext, VerificationStore } from '../verification-integration.js'
import type { VerificationSummary, ReviewSignals } from '@substrate-ai/sdlc'

const mockExecSync = vi.mocked(execSync)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVerificationSummary(storyKey: string, status: 'pass' | 'warn' | 'fail' = 'pass'): VerificationSummary {
  return {
    storyKey,
    checks: [],
    status,
    duration_ms: 42,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assembleVerificationContext', () => {
  beforeEach(() => {
    mockExecSync.mockReset()
  })

  it('should include storyKey, workingDir, and timeout in returned context', () => {
    mockExecSync.mockReturnValue('abc123\n' as unknown as Buffer)

    const ctx = assembleVerificationContext({
      storyKey: '51-5',
      workingDir: '/tmp/project',
    })

    expect(ctx.storyKey).toBe('51-5')
    expect(ctx.workingDir).toBe('/tmp/project')
    expect(ctx.timeout).toBe(60_000)
  })

  it('should set commitSha from mocked execSync return value', () => {
    mockExecSync.mockReturnValue('deadbeef123456\n' as unknown as Buffer)

    const ctx = assembleVerificationContext({
      storyKey: '51-5',
      workingDir: '/tmp/project',
    })

    expect(ctx.commitSha).toBe('deadbeef123456')
  })

  it('should fall back commitSha to "unknown" when execSync throws', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('git not found')
    })

    const ctx = assembleVerificationContext({
      storyKey: '51-5',
      workingDir: '/tmp/project',
    })

    expect(ctx.commitSha).toBe('unknown')
  })

  it('should forward reviewResult and outputTokenCount when provided', () => {
    mockExecSync.mockReturnValue('sha1\n' as unknown as Buffer)

    const reviewResult: ReviewSignals = {
      dispatchFailed: false,
      error: undefined,
      rawOutput: 'some output',
    }

    const ctx = assembleVerificationContext({
      storyKey: '51-5',
      workingDir: '/tmp/project',
      reviewResult,
      outputTokenCount: 1234,
    })

    expect(ctx.reviewResult).toEqual(reviewResult)
    expect(ctx.outputTokenCount).toBe(1234)
  })

  it('should leave reviewResult and outputTokenCount as undefined when omitted', () => {
    mockExecSync.mockReturnValue('sha1\n' as unknown as Buffer)

    const ctx = assembleVerificationContext({
      storyKey: '51-5',
      workingDir: '/tmp/project',
    })

    expect(ctx.reviewResult).toBeUndefined()
    expect(ctx.outputTokenCount).toBeUndefined()
  })
})

describe('VerificationStore', () => {
  it('should store and retrieve a summary by storyKey (round-trip)', () => {
    const store = new VerificationStore()
    const summary = makeVerificationSummary('51-5', 'pass')

    store.set('51-5', summary)

    expect(store.get('51-5')).toBe(summary)
  })

  it('should return a ReadonlyMap with all set entries via getAll()', () => {
    const store = new VerificationStore()
    const s1 = makeVerificationSummary('51-1', 'pass')
    const s2 = makeVerificationSummary('51-2', 'warn')

    store.set('51-1', s1)
    store.set('51-2', s2)

    const all = store.getAll()
    expect(all.size).toBe(2)
    expect(all.get('51-1')).toBe(s1)
    expect(all.get('51-2')).toBe(s2)
  })

  it('should return undefined for an unknown storyKey', () => {
    const store = new VerificationStore()

    expect(store.get('nonexistent-key')).toBeUndefined()
  })
})
