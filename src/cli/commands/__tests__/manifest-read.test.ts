// @vitest-environment node
/**
 * Unit tests for manifest-read helper — Story 52-6.
 *
 * Uses real file I/O in os.tmpdir() to test the actual file-resolution logic.
 * All temp directories are cleaned up in afterEach.
 *
 * AC4: falls back gracefully (returns null) when no manifest exists
 * AC6: reads .substrate/current-run-id to obtain run ID
 */

import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { readCurrentRunId, resolveRunManifest } from '../manifest-read.js'
import { RunManifest } from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a valid run manifest file in the given runsDir using RunManifest.create().
 */
async function createTestManifest(runsDir: string, runId: string): Promise<void> {
  await RunManifest.create(
    runId,
    {
      run_id: runId,
      cli_flags: { stories: ['1-1', '1-2'] },
      story_scope: ['1-1', '1-2'],
      supervisor_pid: null,
      supervisor_session_id: null,
      per_story_state: {},
      recovery_history: [],
      cost_accumulation: { per_story: {}, run_total: 0 },
      pending_proposals: [],
    },
    runsDir
  )
}

// ---------------------------------------------------------------------------
// readCurrentRunId tests
// ---------------------------------------------------------------------------

describe('readCurrentRunId', () => {
  let tmpDir: string

  afterEach(() => {
    try {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('returns the trimmed run ID from current-run-id file', async () => {
    tmpDir = join(tmpdir(), `manifest-read-test-${Date.now()}`)
    const substrateDir = join(tmpDir, '.substrate')
    mkdirSync(substrateDir, { recursive: true })

    const runId = 'test-run-id-abc123'
    writeFileSync(join(substrateDir, 'current-run-id'), `  ${runId}  \n`)

    const result = await readCurrentRunId(tmpDir)
    expect(result).toBe(runId)
  })

  it('returns null when current-run-id file does not exist', async () => {
    tmpDir = join(tmpdir(), `manifest-read-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const result = await readCurrentRunId(tmpDir)
    expect(result).toBeNull()
  })

  it('returns null when current-run-id file is empty', async () => {
    tmpDir = join(tmpdir(), `manifest-read-test-${Date.now()}`)
    const substrateDir = join(tmpDir, '.substrate')
    mkdirSync(substrateDir, { recursive: true })
    writeFileSync(join(substrateDir, 'current-run-id'), '   \n')

    const result = await readCurrentRunId(tmpDir)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveRunManifest tests
// ---------------------------------------------------------------------------

describe('resolveRunManifest', () => {
  let tmpDir: string

  afterEach(() => {
    try {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('returns manifest when current-run-id and manifest file both exist (AC6)', async () => {
    tmpDir = join(tmpdir(), `manifest-read-test-${Date.now()}`)
    const substrateDir = join(tmpDir, '.substrate')
    const runsDir = join(substrateDir, 'runs')
    mkdirSync(runsDir, { recursive: true })

    const runId = 'test-run-id-456'
    writeFileSync(join(substrateDir, 'current-run-id'), runId)
    await createTestManifest(runsDir, runId)

    const result = await resolveRunManifest(tmpDir)
    expect(result.manifest).not.toBeNull()
    expect(result.runId).toBe(runId)
  })

  it('returns manifest when explicit runId is provided (skips current-run-id) (AC6)', async () => {
    tmpDir = join(tmpdir(), `manifest-read-test-${Date.now()}`)
    const substrateDir = join(tmpDir, '.substrate')
    const runsDir = join(substrateDir, 'runs')
    mkdirSync(runsDir, { recursive: true })

    const runId = 'explicit-run-id-789'
    // Do NOT write current-run-id — should use explicit runId
    await createTestManifest(runsDir, runId)

    const result = await resolveRunManifest(tmpDir, runId)
    expect(result.manifest).not.toBeNull()
    expect(result.runId).toBe(runId)
  })

  it('returns null manifest and null runId when current-run-id is absent (AC4)', async () => {
    tmpDir = join(tmpdir(), `manifest-read-test-${Date.now()}`)
    mkdirSync(join(tmpDir, '.substrate'), { recursive: true })
    // No current-run-id file, no manifest

    const result = await resolveRunManifest(tmpDir)
    expect(result.manifest).toBeNull()
    expect(result.runId).toBeNull()
  })

  it('returns null manifest (but non-null runId) when manifest JSON is missing even if current-run-id exists (AC4)', async () => {
    tmpDir = join(tmpdir(), `manifest-read-test-${Date.now()}`)
    const substrateDir = join(tmpDir, '.substrate')
    mkdirSync(join(substrateDir, 'runs'), { recursive: true })

    const runId = 'non-existent-manifest-run-id'
    writeFileSync(join(substrateDir, 'current-run-id'), runId)
    // Do NOT create the manifest file

    const result = await resolveRunManifest(tmpDir)
    expect(result.manifest).toBeNull()
    expect(result.runId).toBe(runId)
  })

  it('returns null manifest when manifest JSON is corrupt (AC4)', async () => {
    tmpDir = join(tmpdir(), `manifest-read-test-${Date.now()}`)
    const substrateDir = join(tmpDir, '.substrate')
    const runsDir = join(substrateDir, 'runs')
    mkdirSync(runsDir, { recursive: true })

    const runId = 'corrupt-manifest-run-id'
    writeFileSync(join(substrateDir, 'current-run-id'), runId)
    // Write intentionally corrupt JSON
    writeFileSync(join(runsDir, `${runId}.json`), 'this is not valid json {{{}')

    const result = await resolveRunManifest(tmpDir)
    expect(result.manifest).toBeNull()
    expect(result.runId).toBe(runId)
  })

  it('manifest.read() returns correct data after resolveRunManifest succeeds', async () => {
    tmpDir = join(tmpdir(), `manifest-read-test-${Date.now()}`)
    const substrateDir = join(tmpDir, '.substrate')
    const runsDir = join(substrateDir, 'runs')
    mkdirSync(runsDir, { recursive: true })

    const runId = 'data-verify-run-id'
    writeFileSync(join(substrateDir, 'current-run-id'), runId)
    await createTestManifest(runsDir, runId)

    const { manifest } = await resolveRunManifest(tmpDir)
    expect(manifest).not.toBeNull()

    const data = await manifest!.read()
    expect(data.run_id).toBe(runId)
    expect(data.cli_flags['stories']).toEqual(['1-1', '1-2'])
    expect(data.story_scope).toEqual(['1-1', '1-2'])
  })
})
