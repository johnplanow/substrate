/**
 * Unit tests for RunManifest.appendRecoveryEntry() — Story 52-8.
 *
 * Tests AC4 (atomic append and cost update), AC6 (crash survival via real
 * filesystem I/O), and AC7 (backward compat with pre-existing empty history).
 *
 * Uses real os.tmpdir() temp dirs — no fs/promises mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RunManifest } from '../run-manifest.js'
import type { RecoveryEntry } from '../recovery-history.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return join(tmpdir(), `recovery-history-manifest-${randomUUID()}`)
}

function makeEntry(overrides?: Partial<RecoveryEntry>): RecoveryEntry {
  return {
    story_key: '52-8',
    attempt_number: 1,
    strategy: 'retry-with-context',
    root_cause: 'NEEDS_MAJOR_REWORK',
    outcome: 'retried',
    cost_usd: 0.05,
    timestamp: new Date().toISOString(),
    ...overrides,
  }
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
// Test suite
// ---------------------------------------------------------------------------

describe('RunManifest.appendRecoveryEntry() (AC4, AC6, AC7)', () => {
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
  // AC4, AC6: append adds entry and it is readable on re-read
  // -------------------------------------------------------------------------

  it('AC4, AC6: appendRecoveryEntry adds entry to recovery_history and it is readable on re-read', async () => {
    const manifest = await createManifest(tempDir, runId)
    const entry = makeEntry()

    await manifest.appendRecoveryEntry(entry)

    // Re-read from disk (simulating process restart — no in-memory cache)
    const readBack = await RunManifest.read(runId, tempDir)
    expect(readBack.recovery_history).toHaveLength(1)
    expect(readBack.recovery_history[0]).toMatchObject({
      story_key: '52-8',
      attempt_number: 1,
      strategy: 'retry-with-context',
      outcome: 'retried',
      cost_usd: 0.05,
    })
  })

  // -------------------------------------------------------------------------
  // AC4: sets per_story cost on first call for a story
  // -------------------------------------------------------------------------

  it('AC4: sets cost_accumulation.per_story[storyKey] to entry.cost_usd on first call', async () => {
    const manifest = await createManifest(tempDir, runId)
    const entry = makeEntry({ cost_usd: 0.07 })

    await manifest.appendRecoveryEntry(entry)

    const readBack = await RunManifest.read(runId, tempDir)
    expect(readBack.cost_accumulation.per_story['52-8']).toBe(0.07)
    expect(readBack.cost_accumulation.run_total).toBe(0.07)
  })

  // -------------------------------------------------------------------------
  // AC4: two sequential calls for same story accumulate per_story and run_total
  // -------------------------------------------------------------------------

  it('AC4: two sequential calls for the same story accumulate per_story and run_total', async () => {
    const manifest = await createManifest(tempDir, runId)

    await manifest.appendRecoveryEntry(makeEntry({ cost_usd: 0.05, attempt_number: 1 }))
    await manifest.appendRecoveryEntry(makeEntry({ cost_usd: 0.03, attempt_number: 2 }))

    const readBack = await RunManifest.read(runId, tempDir)
    expect(readBack.recovery_history).toHaveLength(2)
    expect(readBack.cost_accumulation.per_story['52-8']).toBeCloseTo(0.08, 10)
    expect(readBack.cost_accumulation.run_total).toBeCloseTo(0.08, 10)
  })

  // -------------------------------------------------------------------------
  // AC4: two sequential calls for different stories accumulate run_total as sum
  // -------------------------------------------------------------------------

  it('AC4: two calls for different stories accumulate run_total as the sum of both entries', async () => {
    const manifest = await createManifest(tempDir, runId)

    await manifest.appendRecoveryEntry(makeEntry({ story_key: '52-8', cost_usd: 0.05 }))
    await manifest.appendRecoveryEntry(makeEntry({ story_key: '52-1', cost_usd: 0.03 }))

    const readBack = await RunManifest.read(runId, tempDir)
    expect(readBack.recovery_history).toHaveLength(2)
    expect(readBack.cost_accumulation.per_story['52-8']).toBeCloseTo(0.05, 10)
    expect(readBack.cost_accumulation.per_story['52-1']).toBeCloseTo(0.03, 10)
    expect(readBack.cost_accumulation.run_total).toBeCloseTo(0.08, 10)
  })

  // -------------------------------------------------------------------------
  // AC7: append on manifest with pre-existing empty recovery_history works
  // -------------------------------------------------------------------------

  it('AC7: appendRecoveryEntry on manifest with pre-existing recovery_history: [] appends without error', async () => {
    const manifest = await createManifest(tempDir, runId)

    // Manifest was created with recovery_history: [] — appending should work
    await expect(manifest.appendRecoveryEntry(makeEntry())).resolves.toBeUndefined()

    const readBack = await RunManifest.read(runId, tempDir)
    expect(readBack.recovery_history).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // AC6: real file I/O — entry is persisted to .json file (no mocking)
  // -------------------------------------------------------------------------

  it('AC6: entry is persisted to .json file — confirmed by reading file directly (no in-memory cache)', async () => {
    const manifest = await createManifest(tempDir, runId)
    const entry = makeEntry({ cost_usd: 0.12, timestamp: '2026-04-06T15:00:00.000Z' })

    await manifest.appendRecoveryEntry(entry)

    // Read raw JSON from the file directly (bypassing RunManifest abstraction)
    const primaryPath = join(tempDir, `${runId}.json`)
    const rawJson = await fs.readFile(primaryPath, 'utf-8')
    const parsed = JSON.parse(rawJson) as {
      recovery_history: Array<{ story_key: string; cost_usd: number; timestamp: string }>
      cost_accumulation: { per_story: Record<string, number>; run_total: number }
    }

    expect(parsed.recovery_history).toHaveLength(1)
    expect(parsed.recovery_history[0]?.story_key).toBe('52-8')
    expect(parsed.recovery_history[0]?.cost_usd).toBe(0.12)
    expect(parsed.recovery_history[0]?.timestamp).toBe('2026-04-06T15:00:00.000Z')
    expect(parsed.cost_accumulation.run_total).toBe(0.12)
    expect(parsed.cost_accumulation.per_story['52-8']).toBe(0.12)
  })

  // -------------------------------------------------------------------------
  // AC4: no other manifest fields are affected by appendRecoveryEntry
  // -------------------------------------------------------------------------

  it('AC4: appendRecoveryEntry does not modify other manifest fields', async () => {
    const manifest = await createManifest(tempDir, runId)

    // Read initial state
    const before = await RunManifest.read(runId, tempDir)
    const beforeStoryScope = before.story_scope
    const beforeCliFlags = before.cli_flags
    const beforePendingProposals = before.pending_proposals
    const beforePerStoryState = before.per_story_state

    await manifest.appendRecoveryEntry(makeEntry())

    const after = await RunManifest.read(runId, tempDir)
    expect(after.story_scope).toEqual(beforeStoryScope)
    expect(after.cli_flags).toEqual(beforeCliFlags)
    expect(after.pending_proposals).toEqual(beforePendingProposals)
    expect(after.per_story_state).toEqual(beforePerStoryState)
    expect(after.run_id).toBe(runId)
  })
})
