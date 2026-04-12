/**
 * Unit tests for RunManifest.recordSelfEval() — Epic 55-4.
 *
 * Tests atomic self-eval recording, multi-attempt history,
 * backward compat with pre-Epic-55 manifests, and bootstrapping
 * from no existing manifest.
 *
 * Uses real os.tmpdir() temp dirs — no fs/promises mocking.
 */

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RunManifest } from '../run-manifest.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return join(tmpdir(), `self-eval-manifest-${randomUUID()}`)
}

async function createManifest(tempDir: string, runId: string): Promise<RunManifest> {
  return RunManifest.create(
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunManifest.recordSelfEval (Epic 55-4)', () => {
  it('records a self-eval entry for a phase', async () => {
    const tempDir = makeTempDir()
    const runId = randomUUID()
    const manifest = await createManifest(tempDir, runId)

    await manifest.recordSelfEval({
      phase: 'analysis',
      score: 0.82,
      pass: true,
      retry_index: 0,
    })

    const data = await RunManifest.read(runId, tempDir)
    expect(data.self_eval_history).toBeDefined()
    expect(data.self_eval_history!.analysis).toHaveLength(1)
    expect(data.self_eval_history!.analysis[0].score).toBe(0.82)
    expect(data.self_eval_history!.analysis[0].pass).toBe(true)
    expect(data.self_eval_history!.analysis[0].retry_index).toBe(0)
    expect(data.self_eval_history!.analysis[0].timestamp).toBeDefined()
  })

  it('appends multiple attempts for the same phase (retry history)', async () => {
    const tempDir = makeTempDir()
    const runId = randomUUID()
    const manifest = await createManifest(tempDir, runId)

    await manifest.recordSelfEval({
      phase: 'analysis',
      score: 0.55,
      pass: false,
      retry_index: 0,
      feedback: 'user_specificity too vague',
    })
    await manifest.recordSelfEval({
      phase: 'analysis',
      score: 0.78,
      pass: true,
      retry_index: 1,
    })

    const data = await RunManifest.read(runId, tempDir)
    expect(data.self_eval_history!.analysis).toHaveLength(2)
    expect(data.self_eval_history!.analysis[0].score).toBe(0.55)
    expect(data.self_eval_history!.analysis[0].feedback).toBe('user_specificity too vague')
    expect(data.self_eval_history!.analysis[1].score).toBe(0.78)
    expect(data.self_eval_history!.analysis[1].retry_index).toBe(1)
  })

  it('records entries for different phases independently', async () => {
    const tempDir = makeTempDir()
    const runId = randomUUID()
    const manifest = await createManifest(tempDir, runId)

    await manifest.recordSelfEval({ phase: 'analysis', score: 0.80, pass: true, retry_index: 0 })
    await manifest.recordSelfEval({ phase: 'planning', score: 0.90, pass: true, retry_index: 0 })

    const data = await RunManifest.read(runId, tempDir)
    expect(Object.keys(data.self_eval_history!)).toEqual(
      expect.arrayContaining(['analysis', 'planning']),
    )
    expect(data.self_eval_history!.analysis).toHaveLength(1)
    expect(data.self_eval_history!.planning).toHaveLength(1)
  })

  it('backward compat: pre-Epic-55 manifest without self_eval_history reads cleanly', async () => {
    const tempDir = makeTempDir()
    const runId = randomUUID()
    // Create a manifest without self_eval_history (pre-Epic-55)
    const manifest = await createManifest(tempDir, runId)

    const data = await RunManifest.read(runId, tempDir)
    // self_eval_history should be undefined (optional field)
    expect(data.self_eval_history).toBeUndefined()
  })

  it('bootstraps from no existing manifest', async () => {
    const tempDir = makeTempDir()
    const runId = randomUUID()
    // Don't create a manifest first — recordSelfEval should bootstrap
    const manifest = RunManifest.open(runId, tempDir)

    await manifest.recordSelfEval({
      phase: 'analysis',
      score: 0.70,
      pass: true,
      retry_index: 0,
    })

    const data = await RunManifest.read(runId, tempDir)
    expect(data.self_eval_history!.analysis).toHaveLength(1)
    expect(data.run_id).toBe(runId)
  })
})
