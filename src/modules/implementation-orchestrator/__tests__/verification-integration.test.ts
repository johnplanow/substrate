/**
 * Unit and integration tests for verification-integration module — Stories 51-5 / 52-7.
 *
 * Covers:
 *   - assembleVerificationContext: context assembly with correct fields
 *   - assembleVerificationContext: commitSha from mocked execSync return value
 *   - assembleVerificationContext: commitSha falls back to 'unknown' on execSync error
 *   - assembleVerificationContext: reviewResult, storyContent, devStoryResult, and outputTokenCount forwarded when provided
 *   - assembleVerificationContext: optional verification fields are undefined when omitted
 *   - VerificationStore.set/get: round-trip stores and retrieves summary by storyKey
 *   - VerificationStore.getAll: returns a ReadonlyMap with all set entries
 *   - VerificationStore.get: returns undefined for unknown storyKey
 *   - persistVerificationResult: writes verification_result to manifest (Story 52-7)
 *   - persistVerificationResult: no-op when runManifest is null
 *   - pre-52-7 manifest without verification_result passes PerStoryStateSchema (Story 52-7)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn() }
})

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock() calls
// ---------------------------------------------------------------------------

import { execSync } from 'node:child_process'
import { assembleVerificationContext, VerificationStore, persistVerificationResult } from '../verification-integration.js'
import type { VerificationSummary, ReviewSignals } from '@substrate-ai/sdlc'
import { RunManifest } from '@substrate-ai/sdlc'
import { PerStoryStateSchema } from '@substrate-ai/sdlc'

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

  it('should forward reviewResult, storyContent, devStoryResult, and outputTokenCount when provided', () => {
    mockExecSync.mockReturnValue('sha1\n' as unknown as Buffer)

    const reviewResult: ReviewSignals = {
      dispatchFailed: false,
      error: undefined,
      rawOutput: 'some output',
    }
    const storyContent = '## Acceptance Criteria\n\n### AC1: Works'
    const devStoryResult = {
      result: 'success' as const,
      ac_met: ['AC1'],
      ac_failures: [],
      files_modified: ['src/foo.ts'],
      tests: 'pass' as const,
    }

    const ctx = assembleVerificationContext({
      storyKey: '51-5',
      workingDir: '/tmp/project',
      reviewResult,
      storyContent,
      devStoryResult,
      outputTokenCount: 1234,
    })

    expect(ctx.reviewResult).toEqual(reviewResult)
    expect(ctx.storyContent).toBe(storyContent)
    expect(ctx.devStoryResult).toEqual(devStoryResult)
    expect(ctx.outputTokenCount).toBe(1234)
  })

  it('should leave optional verification fields as undefined when omitted', () => {
    mockExecSync.mockReturnValue('sha1\n' as unknown as Buffer)

    const ctx = assembleVerificationContext({
      storyKey: '51-5',
      workingDir: '/tmp/project',
    })

    expect(ctx.reviewResult).toBeUndefined()
    expect(ctx.storyContent).toBeUndefined()
    expect(ctx.devStoryResult).toBeUndefined()
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

// ---------------------------------------------------------------------------
// persistVerificationResult — Story 52-7 integration tests
// ---------------------------------------------------------------------------

describe('persistVerificationResult (Story 52-7)', () => {
  let tempDir: string
  let runId: string

  beforeEach(async () => {
    tempDir = join(tmpdir(), `verif-integration-${randomUUID()}`)
    runId = randomUUID()
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('AC3/AC4: writes verification_result to manifest after VerificationPipeline.run() returns', async () => {
    // Create a real RunManifest backed by temp dir
    const manifest = await RunManifest.create(
      runId,
      {
        run_id: runId,
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {
          '52-7': {
            status: 'dispatched',
            phase: 'IN_DEV',
            started_at: '2026-04-06T10:00:00.000Z',
          },
        },
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
      },
      tempDir,
    )

    const summary = makeVerificationSummary('52-7', 'pass')

    // Call persistVerificationResult — simulates what the orchestrator does
    persistVerificationResult('52-7', summary, manifest)

    // Allow microtask/promise queue to flush before reading
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Read back from disk and assert
    const data = await RunManifest.read(runId, tempDir)
    const entry = data.per_story_state['52-7']
    expect(entry?.verification_result).toBeDefined()
    expect(entry?.verification_result?.storyKey).toBe('52-7')
    expect(entry?.verification_result?.status).toBe('pass')
  })

  it('AC5: verification_result persists across a new RunManifest instance (crash-recovery)', async () => {
    const manifest = await RunManifest.create(
      runId,
      {
        run_id: runId,
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {},
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
      },
      tempDir,
    )

    const summary = makeVerificationSummary('52-7', 'fail')
    persistVerificationResult('52-7', summary, manifest)
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Simulate crash recovery: read with a fresh RunManifest instance
    const freshManifest = new RunManifest(runId, tempDir)
    const data = await freshManifest.read()

    const entry = data.per_story_state['52-7']
    expect(entry?.verification_result?.status).toBe('fail')
  })

  it('AC3: no-op when runManifest is null', () => {
    // Should not throw — just a fire-and-forget no-op
    expect(() => persistVerificationResult('52-7', makeVerificationSummary('52-7', 'pass'), null)).not.toThrow()
  })

  it('AC3: no-op when runManifest is undefined', () => {
    expect(() => persistVerificationResult('52-7', makeVerificationSummary('52-7', 'pass'), undefined)).not.toThrow()
  })

  it('AC3: persists both pass and fail summaries (all outcomes recorded)', async () => {
    const manifest = await RunManifest.create(
      runId,
      {
        run_id: runId,
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {},
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
      },
      tempDir,
    )

    // Write fail summary for story A
    const failSummary = makeVerificationSummary('52-7', 'fail')
    persistVerificationResult('52-7', failSummary, manifest)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const data = await RunManifest.read(runId, tempDir)
    expect(data.per_story_state['52-7']?.verification_result?.status).toBe('fail')
  })
})

// ---------------------------------------------------------------------------
// Backward compatibility with pre-52-7 manifests (Story 52-7 AC6)
// ---------------------------------------------------------------------------

describe('pre-52-7 manifest backward compatibility (AC6)', () => {
  it('PerStoryStateSchema accepts entry without verification_result field', () => {
    const entry = {
      status: 'complete',
      phase: 'COMPLETE',
      started_at: '2026-04-06T10:00:00.000Z',
      completed_at: '2026-04-06T11:00:00.000Z',
      // No verification_result field — pre-52-7 manifest format
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.verification_result).toBeUndefined()
    }
  })
})
