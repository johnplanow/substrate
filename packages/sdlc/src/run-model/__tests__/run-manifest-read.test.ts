/**
 * Unit tests for RunManifest read path and fallback — Story 52-1.
 *
 * Tests AC3 (multi-tier fallback), AC4 (generation tiebreak),
 * AC6 (Zod validation triggers fallback).
 *
 * Uses real filesystem I/O with os.tmpdir() temp dirs.
 * Dolt adapter is mocked via injected interface (not global import mock).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { RunManifest } from '../run-manifest.js'
import { ManifestReadError } from '../schemas.js'
import type { RunManifestData, CostAccumulation } from '../types.js'
import type { IDoltAdapter } from '../run-manifest.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return join(tmpdir(), `run-manifest-read-${randomUUID()}`)
}

function makeValidManifest(runId: string, generation: number = 1): RunManifestData {
  const cost: CostAccumulation = { per_story: {}, run_total: 0 }
  return {
    run_id: runId,
    cli_flags: {},
    story_scope: [],
    supervisor_pid: null,
    supervisor_session_id: null,
    per_story_state: {},
    recovery_history: [],
    cost_accumulation: cost,
    pending_proposals: [],
    generation,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

async function writeFile(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf-8')
}

function primaryPath(baseDir: string, runId: string): string {
  return join(baseDir, `${runId}.json`)
}

function bakPath(baseDir: string, runId: string): string {
  return join(baseDir, `${runId}.json.bak`)
}

function tmpPath(baseDir: string, runId: string): string {
  return join(baseDir, `${runId}.json.tmp`)
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RunManifest — read path and fallback', () => {
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
  // AC3: basic happy path
  // -------------------------------------------------------------------------

  it('AC3: read() returns data when primary file is valid', async () => {
    const data = makeValidManifest(runId, 3)
    await writeFile(primaryPath(tempDir, runId), JSON.stringify(data))

    const result = await RunManifest.read(runId, tempDir)
    expect(result.run_id).toBe(runId)
    expect(result.generation).toBe(3)
  })

  // -------------------------------------------------------------------------
  // AC3: falls back to .bak when primary is missing
  // -------------------------------------------------------------------------

  it('AC3: read() falls back to .bak when primary file is missing', async () => {
    const bakData = makeValidManifest(runId, 2)
    await writeFile(bakPath(tempDir, runId), JSON.stringify(bakData))

    // No primary file
    const result = await RunManifest.read(runId, tempDir)
    expect(result.run_id).toBe(runId)
    expect(result.generation).toBe(2)
  })

  // -------------------------------------------------------------------------
  // AC6: falls back to .bak when primary fails Zod validation
  // -------------------------------------------------------------------------

  it('AC6: read() falls back to .bak when primary fails Zod validation', async () => {
    // Write invalid primary (schema-invalid JSON object)
    await writeFile(
      primaryPath(tempDir, runId),
      JSON.stringify({ invalid_field: true, run_id: runId })
    )
    const bakData = makeValidManifest(runId, 5)
    await writeFile(bakPath(tempDir, runId), JSON.stringify(bakData))

    const result = await RunManifest.read(runId, tempDir)
    expect(result.generation).toBe(5)
  })

  // -------------------------------------------------------------------------
  // AC3: falls back to .tmp when primary and .bak are invalid
  // -------------------------------------------------------------------------

  it('AC3: read() falls back to .tmp when both primary and .bak are invalid', async () => {
    // Both primary and bak are corrupt
    await writeFile(primaryPath(tempDir, runId), 'not valid json at all')
    await writeFile(bakPath(tempDir, runId), '{"incomplete":true}')

    const tmpData = makeValidManifest(runId, 7)
    await writeFile(tmpPath(tempDir, runId), JSON.stringify(tmpData))

    const result = await RunManifest.read(runId, tempDir)
    expect(result.generation).toBe(7)
  })

  // -------------------------------------------------------------------------
  // AC3: falls back to Dolt degraded mode
  // -------------------------------------------------------------------------

  it('AC3: read() falls back to Dolt degraded mode when all file sources fail', async () => {
    // No files exist in tempDir

    const mockDolt: IDoltAdapter = {
      query: vi.fn().mockResolvedValue([
        {
          id: runId,
          config_json: JSON.stringify({ stories: ['52-1'] }),
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ]),
    }

    const result = await RunManifest.read(runId, tempDir, mockDolt)
    expect(result.run_id).toBe(runId)
    expect(result.generation).toBe(0)
    expect(result.per_story_state).toEqual({})
    expect(result.recovery_history).toEqual([])
    expect(result.cli_flags).toEqual({ stories: ['52-1'] })

    // Query should have been called with the run ID
    expect(mockDolt.query).toHaveBeenCalledWith(expect.stringContaining('pipeline_runs'), [runId])
  })

  // -------------------------------------------------------------------------
  // AC4: generation tiebreak — prefers .bak when it has higher generation
  // -------------------------------------------------------------------------

  it('AC4: read() prefers .bak over primary when .bak has higher generation', async () => {
    const primaryData = makeValidManifest(runId, 3) // older
    const bakData = makeValidManifest(runId, 4) // newer (survived mid-rename crash)

    await writeFile(primaryPath(tempDir, runId), JSON.stringify(primaryData))
    await writeFile(bakPath(tempDir, runId), JSON.stringify(bakData))

    const result = await RunManifest.read(runId, tempDir)
    expect(result.generation).toBe(4) // .bak preferred
  })

  it('AC4: read() uses primary when primary has higher or equal generation than .bak', async () => {
    const primaryData = makeValidManifest(runId, 5)
    const bakData = makeValidManifest(runId, 4)

    await writeFile(primaryPath(tempDir, runId), JSON.stringify(primaryData))
    await writeFile(bakPath(tempDir, runId), JSON.stringify(bakData))

    const result = await RunManifest.read(runId, tempDir)
    expect(result.generation).toBe(5) // primary preferred
  })

  // -------------------------------------------------------------------------
  // AC3: throws ManifestReadError listing all sources when everything fails
  // -------------------------------------------------------------------------

  it('AC3: read() throws ManifestReadError with attempted_sources when all sources fail', async () => {
    // No files, no Dolt adapter
    await expect(RunManifest.read(runId, tempDir, null)).rejects.toThrow(ManifestReadError)

    try {
      await RunManifest.read(runId, tempDir, null)
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestReadError)
      const manifestErr = err as ManifestReadError
      expect(manifestErr.attempted_sources).toContain(primaryPath(tempDir, runId))
      expect(manifestErr.attempted_sources).toContain(bakPath(tempDir, runId))
      expect(manifestErr.attempted_sources).toContain(tmpPath(tempDir, runId))
    }
  })

  it('AC3: ManifestReadError lists dolt source when dolt adapter returns no rows', async () => {
    // No files
    const mockDolt: IDoltAdapter = {
      query: vi.fn().mockResolvedValue([]), // no rows in pipeline_runs
    }

    await expect(RunManifest.read(runId, tempDir, mockDolt)).rejects.toThrow(ManifestReadError)

    try {
      await RunManifest.read(runId, tempDir, mockDolt)
    } catch (err) {
      const manifestErr = err as ManifestReadError
      expect(manifestErr.attempted_sources).toContain('dolt:pipeline_runs')
    }
  })

  // -------------------------------------------------------------------------
  // AC6: Zod validation on read — schema-invalid JSON triggers fallback
  // -------------------------------------------------------------------------

  it('AC6: Zod safeParse rejects schema-invalid object and triggers fallback (not unhandled exception)', async () => {
    // Primary has valid JSON but invalid schema (missing required fields)
    await writeFile(
      primaryPath(tempDir, runId),
      JSON.stringify({
        run_id: runId,
        // missing generation, created_at, updated_at, etc.
        some_field: 'garbage',
      })
    )

    // Bak has valid data
    const bakData = makeValidManifest(runId, 1)
    await writeFile(bakPath(tempDir, runId), JSON.stringify(bakData))

    // Should not throw — should fall back to bak
    const result = await RunManifest.read(runId, tempDir)
    expect(result.generation).toBe(1)
  })

  it('AC6: completely corrupt primary (not valid JSON) triggers fallback', async () => {
    await writeFile(primaryPath(tempDir, runId), 'this is not json {{{')
    const bakData = makeValidManifest(runId, 2)
    await writeFile(bakPath(tempDir, runId), JSON.stringify(bakData))

    const result = await RunManifest.read(runId, tempDir)
    expect(result.generation).toBe(2)
  })
})
