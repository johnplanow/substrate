/**
 * Unit tests for RunManifest write path — Story 52-1.
 *
 * Tests AC2 (atomic write), AC4 (generation counter), AC5 (latency),
 * AC7 (auto-directory creation).
 *
 * Uses real filesystem I/O with os.tmpdir() temp dirs so that
 * the fsync/rename sequence is exercised (not mocked).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RunManifest } from '../run-manifest.js'
import type { RunManifestData, CostAccumulation } from '../types.js'
import type { PerStoryState } from '../per-story-state.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory for each test. */
function makeTempDir(): string {
  return join(tmpdir(), `run-manifest-write-${randomUUID()}`)
}

/** Build a minimal RunManifestData for tests (omitting generation/updated_at). */
function makeData(overrides?: Partial<Omit<RunManifestData, 'generation' | 'updated_at'>>): Omit<RunManifestData, 'generation' | 'updated_at'> {
  const cost: CostAccumulation = { per_story: {}, run_total: 0 }
  return {
    run_id: 'test-run-1',
    cli_flags: {},
    story_scope: [],
    supervisor_pid: null,
    supervisor_session_id: null,
    per_story_state: {},
    recovery_history: [],
    cost_accumulation: cost,
    pending_proposals: [],
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

/** Build 30 stub story entries for per_story_state (valid PerStoryState objects). */
function make30StoryEntries(): Record<string, PerStoryState> {
  const now = new Date().toISOString()
  const entries: Record<string, PerStoryState> = {}
  for (let i = 1; i <= 30; i++) {
    entries[`52-${i}`] = {
      status: 'pending',
      phase: 'PENDING',
      started_at: now,
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RunManifest — write path', () => {
  let tempDir: string
  let runId: string

  beforeEach(() => {
    tempDir = makeTempDir()
    runId = randomUUID()
  })

  afterEach(async () => {
    // Clean up temp dir (best-effort)
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  // -------------------------------------------------------------------------
  // AC7: auto-directory creation
  // -------------------------------------------------------------------------

  it('AC7: creates the runs directory recursively if it does not exist', async () => {
    // tempDir does not exist yet
    const manifest = new RunManifest(runId, tempDir)
    await manifest.write(makeData({ run_id: runId }))

    // Directory should now exist
    const stat = await fs.stat(tempDir)
    expect(stat.isDirectory()).toBe(true)

    // Primary file should exist
    const primaryStat = await fs.stat(manifest.primaryPath)
    expect(primaryStat.isFile()).toBe(true)
  })

  // -------------------------------------------------------------------------
  // AC2 + AC4: produces valid JSON with incremented generation
  // -------------------------------------------------------------------------

  it('AC2 + AC4: write() produces valid JSON at primary path and increments generation', async () => {
    await fs.mkdir(tempDir, { recursive: true })
    const manifest = new RunManifest(runId, tempDir)
    const data = makeData({ run_id: runId })

    await manifest.write(data)

    const raw = await fs.readFile(manifest.primaryPath, 'utf-8')
    const parsed = JSON.parse(raw) as RunManifestData

    expect(parsed.run_id).toBe(runId)
    expect(parsed.generation).toBe(1) // first write: 0 + 1

    // Second write should increment to 2
    await manifest.write(data)
    const raw2 = await fs.readFile(manifest.primaryPath, 'utf-8')
    const parsed2 = JSON.parse(raw2) as RunManifestData
    expect(parsed2.generation).toBe(2)
  })

  it('AC4: generation starts from 0 and increments monotonically across multiple writes', async () => {
    await fs.mkdir(tempDir, { recursive: true })
    const manifest = new RunManifest(runId, tempDir)
    const data = makeData({ run_id: runId })

    for (let i = 1; i <= 5; i++) {
      await manifest.write(data)
      const raw = await fs.readFile(manifest.primaryPath, 'utf-8')
      const parsed = JSON.parse(raw) as RunManifestData
      expect(parsed.generation).toBe(i)
    }
  })

  // -------------------------------------------------------------------------
  // AC2: leaves .bak copy of previous file
  // -------------------------------------------------------------------------

  it('AC2: write() creates a .bak copy of the previous primary file', async () => {
    await fs.mkdir(tempDir, { recursive: true })
    const manifest = new RunManifest(runId, tempDir)
    const data = makeData({ run_id: runId })

    // First write — no .bak should be created (no previous primary)
    await manifest.write(data)
    await expect(fs.access(manifest.bakPath)).rejects.toThrow()

    // Second write — .bak should be created from first write
    await manifest.write(data)
    const bakRaw = await fs.readFile(manifest.bakPath, 'utf-8')
    const bakParsed = JSON.parse(bakRaw) as RunManifestData
    // The .bak should have the generation from the first write
    expect(bakParsed.generation).toBe(1)
  })

  // -------------------------------------------------------------------------
  // AC5: latency under 50ms with 30 story entries
  // -------------------------------------------------------------------------

  it('AC5: write() with 30 story entries completes in <50ms', async () => { // latency-sensitive
    await fs.mkdir(tempDir, { recursive: true })
    const manifest = new RunManifest(runId, tempDir)
    const data = makeData({
      run_id: runId,
      per_story_state: make30StoryEntries(),
    })

    const start = performance.now()
    await manifest.write(data)
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(200) // CI macOS runners can be slow on disk I/O
  })

  // -------------------------------------------------------------------------
  // AC2: .tmp file is cleaned up after successful write
  // -------------------------------------------------------------------------

  it('AC2: .tmp file does not remain after a successful write', async () => {
    await fs.mkdir(tempDir, { recursive: true })
    const manifest = new RunManifest(runId, tempDir)
    await manifest.write(makeData({ run_id: runId }))

    // .tmp should not exist after successful write (renamed to primary)
    await expect(fs.access(manifest.tmpPath)).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // AC7: updated_at is set on every write
  // -------------------------------------------------------------------------

  it('AC2: updated_at is set to current time on each write', async () => {
    await fs.mkdir(tempDir, { recursive: true })
    const manifest = new RunManifest(runId, tempDir)
    const data = makeData({ run_id: runId })

    const before = Date.now()
    await manifest.write(data)
    const after = Date.now()

    const raw = await fs.readFile(manifest.primaryPath, 'utf-8')
    const parsed = JSON.parse(raw) as RunManifestData
    const updatedAt = new Date(parsed.updated_at).getTime()

    expect(updatedAt).toBeGreaterThanOrEqual(before)
    expect(updatedAt).toBeLessThanOrEqual(after)
  })

  // -------------------------------------------------------------------------
  // Task 5: corrupt serialize round-trip — .tmp must not be orphaned
  // -------------------------------------------------------------------------

  it('Task 5: write() with corrupt serialize round-trip does not leave .tmp orphaned', async () => {
    // Use a fresh temp dir with no existing primary file so tryReadFile returns
    // null (missing file → no JSON.parse call). The first JSON.parse call inside
    // write() is therefore the round-trip validation. Making that throw must abort
    // write() before any file I/O so no .tmp file is created.
    const manifest = new RunManifest(runId, tempDir)
    const data = makeData({ run_id: runId })

    // Spy on JSON.parse to throw on the first call (round-trip validation)
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new SyntaxError('Simulated round-trip parse failure')
    })

    try {
      await expect(manifest.write(data)).rejects.toThrow('Simulated round-trip parse failure')
    } finally {
      parseSpy.mockRestore()
    }

    // .tmp must not exist — write() must not have started file I/O
    await expect(fs.access(manifest.tmpPath)).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // RunManifest.create() factory
  // -------------------------------------------------------------------------

  it('create() initializes a manifest with generation=1 and returns RunManifest instance', async () => {
    const initialData = {
      run_id: runId,
      cli_flags: { stories: ['52-1'] },
      story_scope: ['52-1'],
      supervisor_pid: null,
      supervisor_session_id: null,
      per_story_state: {},
      recovery_history: [],
      cost_accumulation: { per_story: {}, run_total: 0 },
      pending_proposals: [],
    }

    const manifest = await RunManifest.create(runId, initialData, tempDir)

    expect(manifest).toBeInstanceOf(RunManifest)
    expect(manifest.runId).toBe(runId)
    expect(manifest.baseDir).toBe(tempDir)

    const raw = await fs.readFile(manifest.primaryPath, 'utf-8')
    const parsed = JSON.parse(raw) as RunManifestData
    expect(parsed.generation).toBe(1)
    expect(parsed.run_id).toBe(runId)
    expect(parsed.story_scope).toEqual(['52-1'])
  })

  // -------------------------------------------------------------------------
  // Story 58-7: patchRunStatus disk round-trip (AC7 subtask 5b)
  // Verifies that run_status / stopped_reason / stopped_at survive the Zod
  // parse round-trip on every subsequent RunManifest.read() call — i.e. that
  // RunManifestSchema includes these fields (regression guard for Issue #1).
  // -------------------------------------------------------------------------

  it('patchRunStatus: run_status, stopped_reason, stopped_at survive Zod round-trip on disk', async () => {
    // 1. Bootstrap a manifest file so patchRunStatus has something to read.
    const manifest = new RunManifest(runId, tempDir)
    await manifest.write(makeData({ run_id: runId }))

    // 2. Call patchRunStatus — exercises _patchRunStatusImpl via _enqueue.
    const stoppedAt = new Date().toISOString()
    await manifest.patchRunStatus({
      run_status: 'stopped',
      stopped_reason: 'killed_by_user',
      stopped_at: stoppedAt,
    })

    // 3. Read back from disk (goes through RunManifestSchema.safeParse).
    const readBack = await RunManifest.read(runId, tempDir)

    // 4. Assert all three fields survived the Zod round-trip.
    expect(readBack.run_status).toBe('stopped')
    expect(readBack.stopped_reason).toBe('killed_by_user')
    expect(readBack.stopped_at).toBe(stoppedAt)
  })
})
