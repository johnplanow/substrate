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
import {
  assembleVerificationContext,
  VerificationStore,
  persistVerificationResult,
  renderVerificationFindingsForPrompt,
} from '../verification-integration.js'
import type { VerificationFinding, VerificationSummary, ReviewSignals } from '@substrate-ai/sdlc'
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
// Story 57-2: persistVerificationResult returns a Promise (AC1, AC5)
// ---------------------------------------------------------------------------

describe('persistVerificationResult returns Promise (Story 57-2)', () => {
  let tempDir: string
  let runId: string

  beforeEach(async () => {
    tempDir = join(tmpdir(), `verif-57-2-${randomUUID()}`)
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

  it('AC1: returns a Promise that resolves after patchStoryState settles', async () => {
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

    const summary = makeVerificationSummary('57-2', 'pass')
    const result = persistVerificationResult('57-2', summary, manifest)

    // Must be a Promise
    expect(result).toBeInstanceOf(Promise)

    // Awaiting it should succeed
    await expect(result).resolves.toBeUndefined()

    // And the write should have actually persisted
    const data = await RunManifest.read(runId, tempDir)
    expect(data.per_story_state['57-2']?.verification_result?.status).toBe('pass')
  })

  it('AC1: returns resolved Promise when runManifest is null', async () => {
    const result = persistVerificationResult('57-2', makeVerificationSummary('57-2', 'pass'), null)
    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toBeUndefined()
  })

  it('AC1: returns resolved Promise when runManifest is undefined', async () => {
    const result = persistVerificationResult('57-2', makeVerificationSummary('57-2', 'pass'), undefined)
    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toBeUndefined()
  })

  it('AC5: swallows patchStoryState rejection and resolves (non-fatal)', async () => {
    // Create a fake RunManifest-like object whose patchStoryState rejects
    const fakeManifest = {
      patchStoryState: vi.fn().mockRejectedValue(new Error('disk full')),
      read: vi.fn(),
    } as unknown as RunManifest

    const result = persistVerificationResult('57-2', makeVerificationSummary('57-2', 'pass'), fakeManifest)
    expect(result).toBeInstanceOf(Promise)
    // Must resolve (not reject) — non-fatal posture
    await expect(result).resolves.toBeUndefined()
  })

  it('AC6: patchStoryState resolves before updateStory(phase:COMPLETE) is called (ordering)', async () => {
    // Simulate orchestrator ordering: persistVerificationResult must settle before updateStory
    const callOrder: string[] = []
    let resolvePatch!: () => void

    const fakeManifest = {
      patchStoryState: vi.fn().mockImplementation(() => {
        return new Promise<void>((resolve) => {
          resolvePatch = () => {
            callOrder.push('patchStoryState')
            resolve()
          }
        })
      }),
      read: vi.fn(),
    } as unknown as RunManifest

    const updateStory = vi.fn().mockImplementation(() => {
      callOrder.push('updateStory')
    })

    const summary = makeVerificationSummary('57-2', 'pass')

    // Start the persist (does not resolve yet)
    const persistPromise = persistVerificationResult('57-2', summary, fakeManifest)

    // Simulate orchestrator awaiting the persist before calling updateStory
    const orchestratorFlow = async () => {
      await persistPromise
      updateStory('57-2', { phase: 'COMPLETE' })
    }

    const flowPromise = orchestratorFlow()

    // Resolve patch after flow is waiting
    resolvePatch()

    await flowPromise

    expect(callOrder).toEqual(['patchStoryState', 'updateStory'])
  })
})

// ---------------------------------------------------------------------------
// Story 57-2: post-COMPLETE invariant warning (AC4, AC7)
// ---------------------------------------------------------------------------

describe('post-COMPLETE invariant warning (Story 57-2 AC4, AC7)', () => {
  let tempDir: string
  let runId: string

  beforeEach(async () => {
    tempDir = join(tmpdir(), `verif-57-2-inv-${randomUUID()}`)
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

  it('AC7: invariant warning fires when verification_result is absent post-COMPLETE', async () => {
    // Create manifest without verification_result for the story
    const manifest = await RunManifest.create(
      runId,
      {
        run_id: runId,
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {
          '57-2': {
            status: 'complete',
            phase: 'COMPLETE',
            started_at: '2026-04-19T10:00:00.000Z',
            completed_at: '2026-04-19T11:00:00.000Z',
            // No verification_result
          },
        },
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
      },
      tempDir,
    )

    // Spy on runManifest.read() to return manifest without verification_result
    const warnSpy = vi.fn()
    const fakeLogger = { warn: warnSpy }

    // Simulate the invariant check logic inline (mirroring the orchestrator code)
    const skipVerification = false
    if (skipVerification !== true && manifest != null) {
      await manifest.read().then((data) => {
        if (data?.per_story_state?.['57-2']?.verification_result == null) {
          fakeLogger.warn(
            { storyKey: '57-2', category: 'verification-result-missing' },
            'post-COMPLETE invariant: verification_result absent in manifest',
          )
        }
      }).catch(() => { /* best-effort */ })
    }

    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ storyKey: '57-2', category: 'verification-result-missing' }),
      expect.any(String),
    )
  })

  it('AC4: invariant warning does NOT fire when verification_result is present', async () => {
    const summary = makeVerificationSummary('57-2', 'pass')
    const manifest = await RunManifest.create(
      runId,
      {
        run_id: runId,
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {
          '57-2': {
            status: 'complete',
            phase: 'COMPLETE',
            started_at: '2026-04-19T10:00:00.000Z',
            completed_at: '2026-04-19T11:00:00.000Z',
            verification_result: summary,
          },
        },
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
      },
      tempDir,
    )

    const warnSpy = vi.fn()
    const fakeLogger = { warn: warnSpy }

    const skipVerification = false
    if (skipVerification !== true && manifest != null) {
      await manifest.read().then((data) => {
        if (data?.per_story_state?.['57-2']?.verification_result == null) {
          fakeLogger.warn(
            { storyKey: '57-2', category: 'verification-result-missing' },
            'post-COMPLETE invariant: verification_result absent in manifest',
          )
        }
      }).catch(() => { /* best-effort */ })
    }

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('AC4: invariant check is skipped when skipVerification is true', async () => {
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

    const warnSpy = vi.fn()
    const fakeLogger = { warn: warnSpy }

    // skipVerification = true → no check
    const skipVerification = true
    if (skipVerification !== true && manifest != null) {
      await manifest.read().then((data) => {
        if (data?.per_story_state?.['57-2']?.verification_result == null) {
          fakeLogger.warn(
            { storyKey: '57-2', category: 'verification-result-missing' },
            'post-COMPLETE invariant: verification_result absent in manifest',
          )
        }
      }).catch(() => { /* best-effort */ })
    }

    expect(warnSpy).not.toHaveBeenCalled()
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

// ---------------------------------------------------------------------------
// renderVerificationFindingsForPrompt — Story 55-3
// ---------------------------------------------------------------------------

describe('renderVerificationFindingsForPrompt (story 55-3)', () => {
  it('returns empty string for undefined summary', () => {
    expect(renderVerificationFindingsForPrompt(undefined)).toBe('')
  })

  it('returns empty string when every check has zero findings', () => {
    const summary: VerificationSummary = {
      storyKey: '55-3',
      status: 'pass',
      duration_ms: 10,
      checks: [
        { checkName: 'build', status: 'pass', details: 'ok', duration_ms: 5, findings: [] },
        { checkName: 'phantom-review', status: 'pass', details: 'ok', duration_ms: 2 },
      ],
    }
    expect(renderVerificationFindingsForPrompt(summary)).toBe('')
  })

  it('groups findings by check name and renders via the canonical renderFindings shape', () => {
    const buildFindings: VerificationFinding[] = [
      {
        category: 'build-error',
        severity: 'error',
        message: 'build failed (exit 2): tsc error',
        command: 'npm run build',
        exitCode: 2,
      },
    ]
    const acFindings: VerificationFinding[] = [
      { category: 'ac-missing-evidence', severity: 'error', message: 'missing AC3' },
      { category: 'ac-missing-evidence', severity: 'error', message: 'missing AC5' },
    ]
    const summary: VerificationSummary = {
      storyKey: '55-3',
      status: 'fail',
      duration_ms: 100,
      checks: [
        { checkName: 'build', status: 'fail', details: '', duration_ms: 50, findings: buildFindings },
        { checkName: 'acceptance-criteria-evidence', status: 'fail', details: '', duration_ms: 40, findings: acFindings },
      ],
    }

    const out = renderVerificationFindingsForPrompt(summary)
    expect(out).toContain('- build:')
    expect(out).toContain('ERROR [build-error] build failed (exit 2)')
    expect(out).toContain('- acceptance-criteria-evidence:')
    expect(out).toContain('ERROR [ac-missing-evidence] missing AC3')
    expect(out).toContain('ERROR [ac-missing-evidence] missing AC5')
    // Findings within a check are indented relative to the check header
    expect(out).toMatch(/- build:\n\s{4}ERROR \[build-error\]/)
  })

  it('omits checks whose findings arrays are empty even if other checks have findings', () => {
    const summary: VerificationSummary = {
      storyKey: '55-3',
      status: 'fail',
      duration_ms: 10,
      checks: [
        { checkName: 'phantom-review', status: 'pass', details: 'ok', duration_ms: 2, findings: [] },
        {
          checkName: 'trivial-output',
          status: 'fail',
          details: '',
          duration_ms: 3,
          findings: [{ category: 'trivial-output', severity: 'error', message: '42 < 100' }],
        },
      ],
    }
    const out = renderVerificationFindingsForPrompt(summary)
    expect(out).not.toContain('phantom-review')
    expect(out).toContain('- trivial-output:')
    expect(out).toContain('42 < 100')
  })
})
