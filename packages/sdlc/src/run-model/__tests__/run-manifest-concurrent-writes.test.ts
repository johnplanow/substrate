/**
 * Regression tests for RunManifest concurrent write serialization — Story 57-1.
 *
 * Verifies that the `_writeChain` promise-queue prevents lost-update races
 * when multiple callers fire patchStoryState() concurrently without awaiting.
 *
 * Uses real filesystem I/O with os.tmpdir() temp dirs (same pattern as
 * run-manifest-write.test.ts) to exercise the full atomic write path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RunManifest } from '../run-manifest.js'
import type { RunManifestData } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return join(tmpdir(), `run-manifest-concurrent-${randomUUID()}`)
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RunManifest — concurrent write serialization (Story 57-1)', () => {
  let tempDir: string
  let runId: string

  beforeEach(async () => {
    tempDir = makeTempDir()
    runId = randomUUID()
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  // -------------------------------------------------------------------------
  // AC4: 100 concurrent patchStoryState calls produce zero lost fields
  // -------------------------------------------------------------------------

  it('AC4: 100 concurrent patchStoryState() calls preserve all three fields across 10 independent runs', async () => {
    const storyKey = 'test-story-1'

    for (let iteration = 0; iteration < 10; iteration++) {
      // Use a fresh runId and tempDir sub-directory per iteration
      const iterRunId = randomUUID()
      const iterDir = join(tempDir, `iter-${iteration}`)
      await fs.mkdir(iterDir, { recursive: true })

      const manifest = new RunManifest(iterRunId, iterDir)

      // Bootstrap the manifest first so all patches have a file to read
      await manifest.write({
        run_id: iterRunId,
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {},
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
        created_at: new Date().toISOString(),
      })

      // Fire 100+ concurrent patchStoryState calls, each setting one of three fields.
      // None are awaited before the next dispatch — intentionally concurrent.
      const promises: Promise<void>[] = []
      for (let i = 0; i < 100; i++) {
        if (i % 3 === 0) {
          promises.push(manifest.patchStoryState(storyKey, { status: 'complete' }))
        } else if (i % 3 === 1) {
          promises.push(manifest.patchStoryState(storyKey, { phase: 'DONE' }))
        } else {
          promises.push(manifest.patchStoryState(storyKey, { cost_usd: 0.01 }))
        }
      }

      // Wait for all to settle (not .all — we want all writes to finish even if one rejects)
      const results = await Promise.allSettled(promises)

      // All should have fulfilled (no errors expected)
      const rejected = results.filter((r) => r.status === 'rejected')
      expect(rejected).toHaveLength(0)

      // Read the final manifest and verify all three fields are present
      const final = await RunManifest.read(iterRunId, iterDir)
      const storyState = final.per_story_state[storyKey]

      expect(storyState).toBeDefined()
      expect(storyState?.status).toBe('complete')
      expect(storyState?.phase).toBe('DONE')
      expect(storyState?.cost_usd).toBe(0.01)
    }
  }, 30000) // 30s: 10 iterations × up to 100 real-fs atomic writes each

  // -------------------------------------------------------------------------
  // AC6: A failing write does not block subsequent writes
  // -------------------------------------------------------------------------

  it('AC6: one failed write does not permanently stall the write chain', async () => {
    const manifest = new RunManifest(runId, tempDir)

    // Bootstrap
    await manifest.write({
      run_id: runId,
      cli_flags: {},
      story_scope: [],
      supervisor_pid: null,
      supervisor_session_id: null,
      per_story_state: {},
      recovery_history: [],
      cost_accumulation: { per_story: {}, run_total: 0 },
      pending_proposals: [],
      created_at: new Date().toISOString(),
    })

    // Make fs.rename reject exactly once to simulate a mid-write failure
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      new Error('Simulated rename failure')
    )

    // This write should fail
    const failingWrite = manifest.patchStoryState('story-fail', { status: 'failed' })

    // Queue two more writes after the failing one
    const afterFail1 = manifest.patchStoryState('story-after-1', { status: 'complete', phase: 'DONE' })
    const afterFail2 = manifest.patchStoryState('story-after-2', { status: 'dispatched', phase: 'IN_DEV' })

    const results = await Promise.allSettled([failingWrite, afterFail1, afterFail2])

    // First write should have rejected
    expect(results[0]?.status).toBe('rejected')

    // Subsequent writes should have fulfilled
    expect(results[1]?.status).toBe('fulfilled')
    expect(results[2]?.status).toBe('fulfilled')

    // Verify the successful writes landed
    const final = await RunManifest.read(runId, tempDir)
    expect(final.per_story_state['story-after-1']?.status).toBe('complete')
    expect(final.per_story_state['story-after-2']?.status).toBe('dispatched')

    renameSpy.mockRestore()
  })

  // -------------------------------------------------------------------------
  // AC3: Returned promise resolves when that call's own work completes
  // -------------------------------------------------------------------------

  it('AC3: awaiting the returned promise waits only until that specific write finishes', async () => {
    const manifest = new RunManifest(runId, tempDir)

    // Bootstrap
    await manifest.write({
      run_id: runId,
      cli_flags: {},
      story_scope: [],
      supervisor_pid: null,
      supervisor_session_id: null,
      per_story_state: {},
      recovery_history: [],
      cost_accumulation: { per_story: {}, run_total: 0 },
      pending_proposals: [],
      created_at: new Date().toISOString(),
    })

    // Fire two sequential writes and confirm both resolve in order
    await manifest.patchStoryState('s1', { status: 'dispatched', phase: 'INIT' })
    await manifest.patchStoryState('s2', { status: 'complete', phase: 'DONE' })

    const final = await RunManifest.read(runId, tempDir)
    expect(final.per_story_state['s1']?.status).toBe('dispatched')
    expect(final.per_story_state['s2']?.status).toBe('complete')
  })

  // -------------------------------------------------------------------------
  // AC1: _writeChain is initialized on construction
  // -------------------------------------------------------------------------

  it('AC1: a new RunManifest instance can immediately accept enqueued writes (chain initialized)', async () => {
    // If _writeChain were not initialized, the first enqueue would throw/stall
    const manifest = new RunManifest(runId, tempDir)

    // Should not stall or throw
    await manifest.write({
      run_id: runId,
      cli_flags: {},
      story_scope: [],
      supervisor_pid: null,
      supervisor_session_id: null,
      per_story_state: {},
      recovery_history: [],
      cost_accumulation: { per_story: {}, run_total: 0 },
      pending_proposals: [],
      created_at: new Date().toISOString(),
    })

    const data = await RunManifest.read(runId, tempDir)
    expect(data.generation).toBe(1)
  })
})
