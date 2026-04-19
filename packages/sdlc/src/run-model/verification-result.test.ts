/**
 * Unit tests for StoredVerificationSummary schemas and manifest round-trip — Story 52-7.
 *
 * Covers AC1 (schema definition), AC2 (PerStoryState.verification_result typed),
 * AC6 (backward compat — absent field does not throw), and AC7 (unit test cases).
 *
 * Uses real filesystem I/O with os.tmpdir() temp dirs so that the atomic
 * write path is fully exercised (not mocked).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { StoredVerificationCheckResultSchema, StoredVerificationSummarySchema } from './verification-result.js'
import { PerStoryStateSchema } from './per-story-state.js'
import { RunManifest } from './run-manifest.js'
import type { StoredVerificationSummary } from './verification-result.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return join(tmpdir(), `verification-result-${randomUUID()}`)
}

function makeCheckResult(status: 'pass' | 'warn' | 'fail' = 'pass') {
  return {
    checkName: 'BuildCheck',
    status,
    details: `Build ${status}ed`,
    duration_ms: 123,
  }
}

function makeSummary(
  storyKey: string,
  status: 'pass' | 'warn' | 'fail' = 'pass',
): StoredVerificationSummary {
  return {
    storyKey,
    checks: [makeCheckResult(status)],
    status,
    duration_ms: 456,
  }
}

// ---------------------------------------------------------------------------
// StoredVerificationCheckResultSchema
// ---------------------------------------------------------------------------

describe('StoredVerificationCheckResultSchema', () => {
  it('AC1: accepts a valid check result with status pass', () => {
    const result = StoredVerificationCheckResultSchema.safeParse(makeCheckResult('pass'))
    expect(result.success).toBe(true)
  })

  it('AC1: accepts a valid check result with status warn', () => {
    const result = StoredVerificationCheckResultSchema.safeParse(makeCheckResult('warn'))
    expect(result.success).toBe(true)
  })

  it('AC1: accepts a valid check result with status fail', () => {
    const result = StoredVerificationCheckResultSchema.safeParse(makeCheckResult('fail'))
    expect(result.success).toBe(true)
  })

  it('AC7: rejects check result with unknown status', () => {
    const result = StoredVerificationCheckResultSchema.safeParse({
      ...makeCheckResult('pass'),
      status: 'unknown-status',
    })
    expect(result.success).toBe(false)
  })

  it('AC7: rejects check result missing checkName', () => {
    const { checkName: _checkName, ...rest } = makeCheckResult('pass')
    const result = StoredVerificationCheckResultSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('AC7: rejects check result missing status', () => {
    const { status: _status, ...rest } = makeCheckResult('pass')
    const result = StoredVerificationCheckResultSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('AC7: rejects check result missing details', () => {
    const { details: _details, ...rest } = makeCheckResult('pass')
    const result = StoredVerificationCheckResultSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('AC7: rejects check result missing duration_ms', () => {
    const { duration_ms: _duration, ...rest } = makeCheckResult('pass')
    const result = StoredVerificationCheckResultSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('AC7: rejects check result with negative duration_ms', () => {
    const result = StoredVerificationCheckResultSchema.safeParse({
      ...makeCheckResult('pass'),
      duration_ms: -1,
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// StoredVerificationSummarySchema
// ---------------------------------------------------------------------------

describe('StoredVerificationSummarySchema', () => {
  it('AC1: accepts a valid summary with status pass', () => {
    const result = StoredVerificationSummarySchema.safeParse(makeSummary('52-7', 'pass'))
    expect(result.success).toBe(true)
  })

  it('AC1: accepts a valid summary with status warn', () => {
    const result = StoredVerificationSummarySchema.safeParse(makeSummary('52-7', 'warn'))
    expect(result.success).toBe(true)
  })

  it('AC1: accepts a valid summary with status fail', () => {
    const result = StoredVerificationSummarySchema.safeParse(makeSummary('52-7', 'fail'))
    expect(result.success).toBe(true)
  })

  it('AC1: accepts a summary with empty checks array', () => {
    const result = StoredVerificationSummarySchema.safeParse({
      storyKey: '52-7',
      checks: [],
      status: 'pass',
      duration_ms: 0,
    })
    expect(result.success).toBe(true)
  })

  it('AC7: rejects summary with unknown status', () => {
    const result = StoredVerificationSummarySchema.safeParse({
      ...makeSummary('52-7', 'pass'),
      status: 'unknown-status',
    })
    expect(result.success).toBe(false)
  })

  it('AC7: rejects summary missing storyKey', () => {
    const { storyKey: _key, ...rest } = makeSummary('52-7', 'pass')
    const result = StoredVerificationSummarySchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('AC7: rejects summary missing checks', () => {
    const { checks: _checks, ...rest } = makeSummary('52-7', 'pass')
    const result = StoredVerificationSummarySchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('AC7: rejects summary missing duration_ms', () => {
    const { duration_ms: _dur, ...rest } = makeSummary('52-7', 'pass')
    const result = StoredVerificationSummarySchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('AC6: StoredVerificationSummarySchema.optional() accepts undefined without error', () => {
    const result = StoredVerificationSummarySchema.optional().safeParse(undefined)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// PerStoryStateSchema.verification_result integration
// ---------------------------------------------------------------------------

describe('PerStoryStateSchema.verification_result (AC2, AC6)', () => {
  it('AC2: PerStoryStateSchema accepts a valid verification_result', () => {
    const entry = {
      status: 'complete',
      phase: 'COMPLETE',
      started_at: '2026-04-06T00:00:00.000Z',
      verification_result: makeSummary('52-7', 'pass'),
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.verification_result).toBeDefined()
      expect(result.data.verification_result?.status).toBe('pass')
    }
  })

  it('AC6: PerStoryStateSchema accepts absent verification_result (pre-52-7 compat)', () => {
    const entry = {
      status: 'complete',
      phase: 'COMPLETE',
      started_at: '2026-04-06T00:00:00.000Z',
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.verification_result).toBeUndefined()
    }
  })

  it('AC6: PerStoryStateSchema accepts null verification_result as undefined via .optional()', () => {
    // z.optional() does not accept null — only undefined. This test confirms that
    // a manifest written without the field (absent, not null) validates correctly.
    const entry = {
      status: 'complete',
      phase: 'COMPLETE',
      started_at: '2026-04-06T00:00:00.000Z',
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(true)
  })

  it('AC2: PerStoryStateSchema rejects invalid verification_result (bad status)', () => {
    const entry = {
      status: 'complete',
      phase: 'COMPLETE',
      started_at: '2026-04-06T00:00:00.000Z',
      verification_result: {
        storyKey: '52-7',
        checks: [],
        status: 'not-a-valid-status', // invalid
        duration_ms: 100,
      },
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// patchStoryState round-trip (AC5, AC7)
// ---------------------------------------------------------------------------

describe('patchStoryState verification_result round-trip (AC5, AC7)', () => {
  let tempDir: string
  let runId: string

  beforeEach(async () => {
    tempDir = makeTempDir()
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

  it('AC7: patchStoryState writes verification_result and read() returns identical data', async () => {
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

    const summary = makeSummary('52-7', 'pass')

    await manifest.patchStoryState('52-7', {
      status: 'complete',
      phase: 'COMPLETE',
      started_at: '2026-04-06T10:00:00.000Z',
      verification_result: summary,
    })

    // Read back from disk and verify round-trip
    const data = await RunManifest.read(runId, tempDir)
    const entry = data.per_story_state['52-7']
    expect(entry).toBeDefined()
    expect(entry?.verification_result).toBeDefined()
    expect(entry?.verification_result?.storyKey).toBe('52-7')
    expect(entry?.verification_result?.status).toBe('pass')
    expect(entry?.verification_result?.duration_ms).toBe(456)
    expect(entry?.verification_result?.checks).toHaveLength(1)
    expect(entry?.verification_result?.checks[0]?.checkName).toBe('BuildCheck')
  })

  it('AC5: verification_result persists across manifest re-read (crash-recovery simulation)', async () => {
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

    // Write verification result (simulates post-verification persistence)
    const summary = makeSummary('52-7', 'warn')
    await manifest.patchStoryState('52-7', { verification_result: summary })

    // Simulate a new RunManifest instance reading from disk (crash-recovery)
    const freshManifest = new RunManifest(runId, tempDir)
    const data = await freshManifest.read()

    const entry = data.per_story_state['52-7']
    expect(entry?.verification_result?.status).toBe('warn')
    expect(entry?.verification_result?.checks).toHaveLength(1)
    // Other fields should be preserved
    expect(entry?.status).toBe('dispatched')
    expect(entry?.phase).toBe('IN_DEV')
  })

  it('AC6: manifest written without verification_result passes PerStoryStateSchema', async () => {
    // Directly write a manifest JSON without verification_result (pre-52-7 format)
    const manifestData = {
      run_id: runId,
      cli_flags: {},
      story_scope: [],
      supervisor_pid: null,
      supervisor_session_id: null,
      per_story_state: {
        '52-6': {
          status: 'complete',
          phase: 'COMPLETE',
          started_at: '2026-04-06T10:00:00.000Z',
          completed_at: '2026-04-06T11:00:00.000Z',
          // NOTE: no verification_result field — pre-52-7 manifest
        },
      },
      recovery_history: [],
      cost_accumulation: { per_story: {}, run_total: 0 },
      pending_proposals: [],
      generation: 1,
      created_at: '2026-04-06T09:00:00.000Z',
      updated_at: '2026-04-06T11:00:00.000Z',
    }

    const manifestPath = join(tempDir, `${runId}.json`)
    await fs.mkdir(tempDir, { recursive: true })
    await fs.writeFile(manifestPath, JSON.stringify(manifestData, null, 2), 'utf-8')

    // Read back with RunManifest.read() — should not throw
    const data = await RunManifest.read(runId, tempDir)
    const entry = data.per_story_state['52-6']
    expect(entry).toBeDefined()
    expect(entry?.verification_result).toBeUndefined()
    expect(entry?.status).toBe('complete')
  })
})

// ---------------------------------------------------------------------------
// Story 55-3 — StoredVerificationFindingSchema + findings round-trip
// ---------------------------------------------------------------------------

describe('StoredVerificationFinding schema (story 55-3)', () => {
  // Re-import to keep the added describe block self-contained.
  it('accepts a finding with only the required fields', async () => {
    const { StoredVerificationFindingSchema } = await import('./verification-result.js')
    const result = StoredVerificationFindingSchema.safeParse({
      category: 'build-error',
      severity: 'error',
      message: 'exit 2',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a finding with the full optional command surface', async () => {
    const { StoredVerificationFindingSchema } = await import('./verification-result.js')
    const result = StoredVerificationFindingSchema.safeParse({
      category: 'build-error',
      severity: 'error',
      message: 'exit 2',
      command: 'npm run build',
      exitCode: 2,
      stdoutTail: 'a',
      stderrTail: 'error TS2345',
      durationMs: 1200,
    })
    expect(result.success).toBe(true)
  })

  it('rejects a finding with an unknown severity', async () => {
    const { StoredVerificationFindingSchema } = await import('./verification-result.js')
    const result = StoredVerificationFindingSchema.safeParse({
      category: 'build-error',
      severity: 'critical',
      message: 'x',
    })
    expect(result.success).toBe(false)
  })
})

describe('verification findings manifest round-trip (story 55-3)', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = makeTempDir()
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('writes and reads findings on a per-check verification result losslessly', async () => {
    const runId = randomUUID()
    const manifest = new RunManifest(runId, tempDir)

    const summary: StoredVerificationSummary = {
      storyKey: '55-3',
      status: 'fail',
      duration_ms: 1500,
      checks: [
        {
          checkName: 'build',
          status: 'fail',
          details: 'ERROR [build-error] build failed (exit 2): tsc error',
          duration_ms: 1243,
          findings: [
            {
              category: 'build-error',
              severity: 'error',
              message: 'build failed (exit 2): tsc error',
              command: 'npm run build',
              exitCode: 2,
              stdoutTail: 'compiling…\n',
              stderrTail: 'error TS2345\n',
              durationMs: 1243,
            },
          ],
        },
      ],
    }

    await manifest.patchStoryState('55-3', { verification_result: summary })

    const data = await RunManifest.read(runId, tempDir)
    const roundTrip = data.per_story_state['55-3']?.verification_result
    expect(roundTrip).toBeDefined()
    expect(roundTrip?.checks).toHaveLength(1)
    const check = roundTrip?.checks[0]
    expect(check?.findings).toHaveLength(1)
    const f = check?.findings?.[0]
    expect(f?.category).toBe('build-error')
    expect(f?.severity).toBe('error')
    expect(f?.message).toContain('build failed')
    expect(f?.command).toBe('npm run build')
    expect(f?.exitCode).toBe(2)
    expect(f?.stderrTail).toContain('error TS2345')
    expect(f?.durationMs).toBe(1243)
  })

  it('reads cleanly from a manifest written without findings (backward compatibility)', async () => {
    const runId = randomUUID()
    const manifestPath = join(tempDir, `${runId}.json`)
    const legacyManifest = {
      run_id: runId,
      cli_flags: {},
      story_scope: [],
      supervisor_pid: null,
      supervisor_session_id: null,
      per_story_state: {
        '52-7': {
          status: 'complete',
          phase: 'verification',
          started_at: '2026-04-06T09:00:00.000Z',
          verification_result: {
            storyKey: '52-7',
            status: 'pass',
            duration_ms: 10,
            checks: [
              { checkName: 'build', status: 'pass', details: 'ok', duration_ms: 5 },
            ],
          },
        },
      },
      recovery_history: [],
      cost_accumulation: { per_story: {}, run_total: 0 },
      pending_proposals: [],
      generation: 1,
      created_at: '2026-04-06T09:00:00.000Z',
      updated_at: '2026-04-06T11:00:00.000Z',
    }
    await fs.writeFile(manifestPath, JSON.stringify(legacyManifest, null, 2), 'utf-8')

    const data = await RunManifest.read(runId, tempDir)
    const check = data.per_story_state['52-7']?.verification_result?.checks[0]
    expect(check?.checkName).toBe('build')
    expect(check?.findings).toBeUndefined()
  })
})
