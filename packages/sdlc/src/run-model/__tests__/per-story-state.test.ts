/**
 * Unit tests for PerStoryState schema and RunManifest.patchStoryState — Story 52-4.
 *
 * Covers AC1 (PerStoryStateSchema), AC2 (RunManifestSchema.per_story_state),
 * AC3 (patchStoryState atomic upsert), and AC7 (backward compatibility).
 *
 * Uses real filesystem I/O with os.tmpdir() temp dirs so that the actual
 * atomic write path is exercised (not mocked).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { PerStoryStateSchema, PerStoryStatusSchema } from '../per-story-state.js'
import { RunManifestSchema } from '../schemas.js'
import { RunManifest } from '../run-manifest.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return join(tmpdir(), `per-story-state-${randomUUID()}`)
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('PerStoryState schema (AC1, AC7)', () => {
  // -------------------------------------------------------------------------
  // AC1: PerStoryStateSchema accepts fully-populated valid entry
  // -------------------------------------------------------------------------

  it('AC1: accepts a fully-populated valid entry', () => {
    const entry = {
      status: 'complete',
      phase: 'COMPLETE',
      started_at: '2026-04-06T00:00:00.000Z',
      completed_at: '2026-04-06T01:00:00.000Z',
      verification_result: { storyKey: '52-4', status: 'pass', checks: [], duration_ms: 100 },
      cost_usd: 1.23,
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(true)
  })

  // -------------------------------------------------------------------------
  // AC1, AC7: PerStoryStateSchema accepts optional fields as absent
  // -------------------------------------------------------------------------

  it('AC1, AC7: accepts entry with only required fields (optional fields absent)', () => {
    const entry = {
      status: 'dispatched',
      phase: 'IN_STORY_CREATION',
      started_at: '2026-04-06T00:00:00.000Z',
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.completed_at).toBeUndefined()
      expect(result.data.verification_result).toBeUndefined()
      expect(result.data.cost_usd).toBeUndefined()
    }
  })

  // -------------------------------------------------------------------------
  // AC1: PerStoryStateSchema rejects entry missing required fields
  // -------------------------------------------------------------------------

  it('AC1: rejects entry missing status', () => {
    const entry = {
      phase: 'IN_DEV',
      started_at: '2026-04-06T00:00:00.000Z',
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(false)
  })

  it('AC1: rejects entry missing started_at', () => {
    const entry = {
      status: 'dispatched',
      phase: 'IN_DEV',
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(false)
  })

  it('AC1: rejects entry missing phase', () => {
    const entry = {
      status: 'dispatched',
      started_at: '2026-04-06T00:00:00.000Z',
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(false)
  })

  // -------------------------------------------------------------------------
  // AC1, AC7: string fallback in PerStoryStatusSchema
  // -------------------------------------------------------------------------

  it('AC1, AC7: PerStoryStateSchema accepts unknown status string via fallback literal', () => {
    const entry = {
      status: 'some-future-status-not-yet-defined',
      phase: 'FUTURE_PHASE',
      started_at: '2026-04-06T00:00:00.000Z',
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe('some-future-status-not-yet-defined')
    }
  })

  it('AC1: PerStoryStatusSchema accepts all known literals', () => {
    const knownStatuses = [
      'pending',
      'dispatched',
      'in-review',
      'complete',
      'failed',
      'escalated',
      'recovered',
      'verification-failed',
      'gated',
      'skipped',
    ]
    for (const status of knownStatuses) {
      const result = PerStoryStatusSchema.safeParse(status)
      expect(result.success).toBe(true)
    }
  })

  it('AC1: cost_usd rejects negative numbers', () => {
    const entry = {
      status: 'complete',
      phase: 'COMPLETE',
      started_at: '2026-04-06T00:00:00.000Z',
      cost_usd: -1,
    }
    const result = PerStoryStateSchema.safeParse(entry)
    expect(result.success).toBe(false)
  })
})

describe('RunManifestSchema.per_story_state (AC2)', () => {
  // -------------------------------------------------------------------------
  // AC2: RunManifestSchema rejects per_story_state entry that fails PerStoryStateSchema
  // -------------------------------------------------------------------------

  it('AC2: rejects a per_story_state entry that fails PerStoryStateSchema validation', () => {
    const manifest = {
      run_id: 'test-run',
      cli_flags: {},
      story_scope: [],
      supervisor_pid: null,
      supervisor_session_id: null,
      per_story_state: {
        '52-1': {
          // Missing required 'status', 'phase', and 'started_at'
          some_unknown_field: 'value',
        },
      },
      recovery_history: [],
      cost_accumulation: { per_story: {}, run_total: 0 },
      pending_proposals: [],
      generation: 1,
      created_at: '2026-04-06T00:00:00.000Z',
      updated_at: '2026-04-06T00:00:00.000Z',
    }
    const result = RunManifestSchema.safeParse(manifest)
    expect(result.success).toBe(false)
  })

  it('AC2, AC7: accepts an empty per_story_state record without error', () => {
    const manifest = {
      run_id: 'test-run',
      cli_flags: {},
      story_scope: [],
      supervisor_pid: null,
      supervisor_session_id: null,
      per_story_state: {},
      recovery_history: [],
      cost_accumulation: { per_story: {}, run_total: 0 },
      pending_proposals: [],
      generation: 1,
      created_at: '2026-04-06T00:00:00.000Z',
      updated_at: '2026-04-06T00:00:00.000Z',
    }
    const result = RunManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
  })

  it('AC2, AC7: accepts per_story_state entry with unknown status via string fallback', () => {
    const manifest = {
      run_id: 'test-run',
      cli_flags: {},
      story_scope: [],
      supervisor_pid: null,
      supervisor_session_id: null,
      per_story_state: {
        '52-1': {
          status: 'legacy-unknown-status',
          phase: 'LEGACY_PHASE',
          started_at: '2026-04-06T00:00:00.000Z',
        },
      },
      recovery_history: [],
      cost_accumulation: { per_story: {}, run_total: 0 },
      pending_proposals: [],
      generation: 1,
      created_at: '2026-04-06T00:00:00.000Z',
      updated_at: '2026-04-06T00:00:00.000Z',
    }
    const result = RunManifestSchema.safeParse(manifest)
    expect(result.success).toBe(true)
  })
})

describe('RunManifest.patchStoryState (AC3)', () => {
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

  // -------------------------------------------------------------------------
  // AC3: patchStoryState creates new entry when absent
  // -------------------------------------------------------------------------

  it('AC3: creates a new per_story_state entry when storyKey is absent', async () => {
    // Create a manifest first
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
      tempDir
    )

    await manifest.patchStoryState('52-4', {
      status: 'dispatched',
      phase: 'IN_STORY_CREATION',
      started_at: '2026-04-06T10:00:00.000Z',
    })

    const data = await RunManifest.read(runId, tempDir)
    const entry = data.per_story_state['52-4']
    expect(entry).toBeDefined()
    expect(entry?.status).toBe('dispatched')
    expect(entry?.phase).toBe('IN_STORY_CREATION')
    expect(entry?.started_at).toBe('2026-04-06T10:00:00.000Z')
  })

  // -------------------------------------------------------------------------
  // AC3: patchStoryState merges updates without clearing other fields
  // -------------------------------------------------------------------------

  it('AC3: merges updates into existing entry without clearing unrelated fields', async () => {
    const manifest = await RunManifest.create(
      runId,
      {
        run_id: runId,
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {
          '52-4': {
            status: 'dispatched',
            phase: 'IN_STORY_CREATION',
            started_at: '2026-04-06T10:00:00.000Z',
          },
        },
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
      },
      tempDir
    )

    // Patch only the status and completed_at — started_at should remain unchanged
    await manifest.patchStoryState('52-4', {
      status: 'complete',
      phase: 'COMPLETE',
      completed_at: '2026-04-06T11:00:00.000Z',
      cost_usd: 0.5,
    })

    const data = await RunManifest.read(runId, tempDir)
    const entry = data.per_story_state['52-4']
    expect(entry).toBeDefined()
    expect(entry?.status).toBe('complete')
    expect(entry?.phase).toBe('COMPLETE')
    // started_at was on the original entry and should be preserved
    expect(entry?.started_at).toBe('2026-04-06T10:00:00.000Z')
    expect(entry?.completed_at).toBe('2026-04-06T11:00:00.000Z')
    expect(entry?.cost_usd).toBe(0.5)
  })

  // -------------------------------------------------------------------------
  // AC3: two sequential patchStoryState calls on different story keys
  // -------------------------------------------------------------------------

  it('AC3: two sequential patchStoryState calls on different keys both appear in final manifest', async () => {
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
      tempDir
    )

    await manifest.patchStoryState('52-4', {
      status: 'dispatched',
      phase: 'IN_STORY_CREATION',
      started_at: '2026-04-06T10:00:00.000Z',
    })

    await manifest.patchStoryState('52-5', {
      status: 'complete',
      phase: 'COMPLETE',
      started_at: '2026-04-06T09:00:00.000Z',
      completed_at: '2026-04-06T10:30:00.000Z',
    })

    const data = await RunManifest.read(runId, tempDir)
    expect(data.per_story_state['52-4']).toBeDefined()
    expect(data.per_story_state['52-4']?.status).toBe('dispatched')
    expect(data.per_story_state['52-5']).toBeDefined()
    expect(data.per_story_state['52-5']?.status).toBe('complete')
  })

  // -------------------------------------------------------------------------
  // AC3: patchStoryState creates manifest from scratch when no manifest exists
  // -------------------------------------------------------------------------

  it('AC3: creates a new manifest bootstrap when no manifest exists yet', async () => {
    // Do NOT call RunManifest.create() — start from scratch
    const manifest = new RunManifest(runId, tempDir)

    await manifest.patchStoryState('52-4', {
      status: 'dispatched',
      phase: 'IN_STORY_CREATION',
      started_at: '2026-04-06T10:00:00.000Z',
    })

    // Should have created the manifest and written the entry
    const data = await RunManifest.read(runId, tempDir)
    expect(data.run_id).toBe(runId)
    expect(data.per_story_state['52-4']?.status).toBe('dispatched')
  })
})
