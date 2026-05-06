/**
 * Unit tests for cross-story race recovery — Story 70-1.
 *
 * Framework: Vitest (describe / it / expect — no Jest globals).
 * Uses vi.mock() to avoid requiring a real git repo or filesystem.
 *
 * AC coverage:
 *   AC1    — detectStaleVerifications and runStaleVerificationRecovery exports
 *   AC7    — detection heuristic: t.committedAt > s.verifiedAt AND file overlap
 *   AC8    — idempotency: no stale → { noStale: true }
 *   AC9(a) — detection: no race → empty result
 *   AC9(b) — detection: race detected → correct story marked stale
 *   AC9(c) — recovery: fresh verification passes → status complete
 *   AC9(d) — recovery: fresh verification fails → status failed with verification_re_run concept
 *   AC9(e) — idempotency on no-stale runs
 *   AC9(f) — edge case: story with no modifiedFiles falls back to verificationResultFiles
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import * as childProcess from 'node:child_process'

import {
  detectStaleVerifications,
  runStaleVerificationRecovery,
  CommittedAtResolver,
} from '../../verification/cross-story-race-recovery.js'
import type { BatchEntry, StaleVerificationRecoveryInput } from '../../verification/cross-story-race-recovery.js'

// ---------------------------------------------------------------------------
// Mock child_process.execSync for CommittedAtResolver and git HEAD
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

const mockExecSync = childProcess.execSync as unknown as MockInstance

// ---------------------------------------------------------------------------
// Mock verification pipeline so tests don't require a real build
// ---------------------------------------------------------------------------

const mockPipelineRun = vi.fn()

vi.mock('../../verification/verification-pipeline.js', () => ({
  createDefaultVerificationPipeline: vi.fn(() => ({
    run: mockPipelineRun,
    register: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBatch(entries: Partial<BatchEntry>[]): BatchEntry[] {
  return entries.map((e) => ({
    storyKey: e.storyKey ?? 'unknown',
    ...e,
  }))
}

function makeManifestMock() {
  return {
    read: vi.fn().mockResolvedValue({
      per_story_state: {},
      run_id: 'test-run',
    }),
    patchStoryState: vi.fn().mockResolvedValue(undefined),
  }
}

function makeBusMock() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

function makeAdapterMock() {
  return {
    query: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    backendType: 'memory' as const,
  }
}

// ---------------------------------------------------------------------------
// detectStaleVerifications — pure function tests
// ---------------------------------------------------------------------------

describe('detectStaleVerifications', () => {
  // Case (a): No race — t.committedAt < s.verifiedAt — returns empty array
  it('(a) returns empty array when t.committedAt < s.verifiedAt (no race)', () => {
    const batch = makeBatch([
      {
        storyKey: 'A',
        verifiedAt: '2026-01-01T10:05:00Z',
        modifiedFiles: ['src/foo.ts'],
        testFiles: [],
      },
      {
        storyKey: 'B',
        committedAt: '2026-01-01T10:00:00Z', // B committed BEFORE A verified → no race
        modifiedFiles: ['src/foo.ts'],
      },
    ])

    const stale = detectStaleVerifications(batch, {})
    expect(stale).toHaveLength(0)
  })

  // Case (b): Race detected — t.committedAt > s.verifiedAt — marks correct story stale
  it('(b) marks story A stale when B committed after A verified and they share files', () => {
    const batch = makeBatch([
      {
        storyKey: 'A',
        verifiedAt: '2026-01-01T09:55:00Z', // A verified BEFORE B committed → stale
        modifiedFiles: ['src/shared.ts'],
        testFiles: ['src/__tests__/shared.test.ts'],
      },
      {
        storyKey: 'B',
        committedAt: '2026-01-01T10:00:00Z', // B committed AFTER A verified → race
        modifiedFiles: ['src/shared.ts'],
      },
    ])

    const stale = detectStaleVerifications(batch, {})
    expect(stale).toContain('A')
    expect(stale).not.toContain('B')
  })

  // No overlap → no stale
  it('returns empty when stories share no files despite timing race', () => {
    const batch = makeBatch([
      {
        storyKey: 'A',
        verifiedAt: '2026-01-01T09:55:00Z',
        modifiedFiles: ['src/a.ts'],
        testFiles: [],
      },
      {
        storyKey: 'B',
        committedAt: '2026-01-01T10:00:00Z',
        modifiedFiles: ['src/b.ts'], // different file — no overlap
      },
    ])

    const stale = detectStaleVerifications(batch, {})
    expect(stale).toHaveLength(0)
  })

  // Only testFiles overlap
  it('marks stale when file overlap is only in testFiles', () => {
    const batch = makeBatch([
      {
        storyKey: 'A',
        verifiedAt: '2026-01-01T09:55:00Z',
        modifiedFiles: ['src/a.ts'],
        testFiles: ['src/__tests__/shared.test.ts'],
      },
      {
        storyKey: 'B',
        committedAt: '2026-01-01T10:00:00Z',
        modifiedFiles: ['src/__tests__/shared.test.ts'], // overlaps A's testFiles
      },
    ])

    const stale = detectStaleVerifications(batch, {})
    expect(stale).toContain('A')
  })

  // Case (f): Edge case — story with no modifiedFiles falls back to verificationResultFiles
  it('(f) falls back to verificationResultFiles when modifiedFiles absent', () => {
    const batch = makeBatch([
      {
        storyKey: 'A',
        verifiedAt: '2026-01-01T09:55:00Z',
        // modifiedFiles intentionally absent
        verificationResultFiles: ['src/shared.ts'], // fallback
        testFiles: [],
      },
      {
        storyKey: 'B',
        committedAt: '2026-01-01T10:00:00Z',
        modifiedFiles: ['src/shared.ts'],
      },
    ])

    const stale = detectStaleVerifications(batch, {})
    expect(stale).toContain('A')
  })

  // Fewer than 2 stories → no race possible
  it('returns empty for single-story batch', () => {
    const batch = makeBatch([
      { storyKey: 'A', verifiedAt: '2026-01-01T10:00:00Z', modifiedFiles: ['src/foo.ts'] },
    ])
    const stale = detectStaleVerifications(batch, {})
    expect(stale).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// runStaleVerificationRecovery — action handler tests
// ---------------------------------------------------------------------------

describe('runStaleVerificationRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default: execSync for CommittedAtResolver returns empty → no committedAt
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse HEAD')) {
        return 'abc123def456\n'
      }
      return '' // no commit found for story
    })
  })

  // Case (e): Idempotency — no stale stories → noStale = true, no Dolt writes
  it('(e) returns noStale=true and performs no manifest writes when no stale verifications', async () => {
    const manifest = makeManifestMock()
    manifest.read.mockResolvedValue({
      per_story_state: {
        'A': {
          status: 'complete',
          phase: 'DONE',
          started_at: '2026-01-01T09:00:00Z',
          completed_at: '2026-01-01T10:05:00Z', // A completed after B would commit
          dev_story_signals: { files_modified: ['src/foo.ts'] },
        },
      },
      run_id: 'test-run',
    })

    // B has no committedAt (no matching git log entry) → no race detected
    const batch = makeBatch([
      { storyKey: 'A' },
      { storyKey: 'B' },
    ])

    const input: StaleVerificationRecoveryInput = {
      runId: 'test-run',
      batch,
      workingDir: '/tmp/test',
      bus: makeBusMock() as never,
      manifest: manifest as never,
      adapter: makeAdapterMock() as never,
    }

    const result = await runStaleVerificationRecovery(input)
    expect(result.noStale).toBe(true)
    expect(result.recovered).toHaveLength(0)
    expect(result.stillFailed).toHaveLength(0)

    // No manifest writes should have occurred for story state transitions
    expect(manifest.patchStoryState).not.toHaveBeenCalledWith('A', { status: 'verification-stale' })
  })

  // Case (c): Fresh verification passes → status complete, race-recovered event emitted
  it('(c) transitions to complete and emits pipeline:cross-story-race-recovered on pass', async () => {
    const manifest = makeManifestMock()
    manifest.read.mockResolvedValue({
      per_story_state: {
        'A': {
          status: 'complete',
          phase: 'DONE',
          started_at: '2026-01-01T09:00:00Z',
          completed_at: '2026-01-01T09:55:00Z', // A verified at 09:55
          dev_story_signals: { files_modified: ['src/shared.ts'] },
          verification_result: {
            storyKey: 'A',
            checks: [{ checkName: 'BuildCheck', status: 'pass', details: 'ok', duration_ms: 100 }],
            status: 'pass',
            duration_ms: 100,
          },
        },
      },
      run_id: 'test-run',
    })

    // B committed at 10:00 (after A verified at 09:55)
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse HEAD')) return 'abc123\n'
      if (typeof cmd === 'string' && cmd.includes('feat(story-B):')) return '2026-01-01T10:00:00Z\n'
      return ''
    })

    mockPipelineRun.mockResolvedValue({
      storyKey: 'A',
      checks: [{ checkName: 'BuildCheck', status: 'pass', details: 'ok', duration_ms: 50 }],
      status: 'pass',
      duration_ms: 50,
    })

    const bus = makeBusMock()
    const batch = makeBatch([
      { storyKey: 'A', modifiedFiles: ['src/shared.ts'] },
      { storyKey: 'B', modifiedFiles: ['src/shared.ts'] },
    ])

    const input: StaleVerificationRecoveryInput = {
      runId: 'test-run',
      batch,
      workingDir: '/tmp/test',
      bus: bus as never,
      manifest: manifest as never,
      adapter: makeAdapterMock() as never,
    }

    const result = await runStaleVerificationRecovery(input)
    expect(result.noStale).toBe(false)
    expect(result.recovered).toContain('A')
    expect(result.stillFailed).toHaveLength(0)

    // Must transition to verification-stale first
    expect(manifest.patchStoryState).toHaveBeenCalledWith('A', { status: 'verification-stale' })

    // Then transition to complete
    expect(manifest.patchStoryState).toHaveBeenCalledWith(
      'A',
      expect.objectContaining({ status: 'complete' }),
    )

    // Must emit pipeline:cross-story-race-recovered
    expect(bus.emit).toHaveBeenCalledWith(
      'pipeline:cross-story-race-recovered',
      expect.objectContaining({ runId: 'test-run', storyKey: 'A' }),
    )
  })

  // Case (d): Fresh verification fails → status failed, race-still-failed event emitted
  it('(d) transitions to failed and emits pipeline:cross-story-race-still-failed on fail', async () => {
    const manifest = makeManifestMock()
    manifest.read.mockResolvedValue({
      per_story_state: {
        'A': {
          status: 'complete',
          phase: 'DONE',
          started_at: '2026-01-01T09:00:00Z',
          completed_at: '2026-01-01T09:55:00Z',
          dev_story_signals: { files_modified: ['src/shared.ts'] },
        },
      },
      run_id: 'test-run',
    })

    // B committed at 10:00 (after A verified at 09:55)
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('rev-parse HEAD')) return 'abc123\n'
      if (typeof cmd === 'string' && cmd.includes('feat(story-B):')) return '2026-01-01T10:00:00Z\n'
      return ''
    })

    // Fresh verification fails
    mockPipelineRun.mockResolvedValue({
      storyKey: 'A',
      checks: [{ checkName: 'BuildCheck', status: 'fail', details: 'build failed', duration_ms: 50 }],
      status: 'fail',
      duration_ms: 50,
    })

    const bus = makeBusMock()
    const batch = makeBatch([
      { storyKey: 'A', modifiedFiles: ['src/shared.ts'] },
      { storyKey: 'B', modifiedFiles: ['src/shared.ts'] },
    ])

    const input: StaleVerificationRecoveryInput = {
      runId: 'test-run',
      batch,
      workingDir: '/tmp/test',
      bus: bus as never,
      manifest: manifest as never,
      adapter: makeAdapterMock() as never,
    }

    const result = await runStaleVerificationRecovery(input)
    expect(result.noStale).toBe(false)
    expect(result.stillFailed).toContain('A')
    expect(result.recovered).toHaveLength(0)

    // Must transition to verification-stale first
    expect(manifest.patchStoryState).toHaveBeenCalledWith('A', { status: 'verification-stale' })

    // Then transition to failed with verification_re_run: true (AC9-d)
    expect(manifest.patchStoryState).toHaveBeenCalledWith(
      'A',
      expect.objectContaining({ status: 'failed', verification_re_run: true }),
    )

    // Must emit pipeline:cross-story-race-still-failed
    expect(bus.emit).toHaveBeenCalledWith(
      'pipeline:cross-story-race-still-failed',
      expect.objectContaining({ runId: 'test-run', storyKey: 'A' }),
    )
  })
})

// ---------------------------------------------------------------------------
// CommittedAtResolver unit tests
// ---------------------------------------------------------------------------

describe('CommittedAtResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ISO timestamp when git log finds the commit', () => {
    mockExecSync.mockReturnValue('2026-01-01T10:00:00Z\n')
    const result = CommittedAtResolver('70-1', '/tmp/repo')
    expect(result).toBe('2026-01-01T10:00:00Z')
  })

  it('returns undefined when git log returns empty string', () => {
    mockExecSync.mockReturnValue('')
    const result = CommittedAtResolver('70-1', '/tmp/repo')
    expect(result).toBeUndefined()
  })

  it('returns undefined when execSync throws', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo') })
    const result = CommittedAtResolver('70-1', '/tmp/repo')
    expect(result).toBeUndefined()
  })
})
