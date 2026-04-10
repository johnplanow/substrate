// @vitest-environment node
/**
 * Tests for Story 39-3: Fix Status Endpoint to Track Current Run
 *
 * Verifies:
 *   - AC2: Status reads from .substrate/current-run-id when file exists
 *   - AC3: Status falls back to getLatestRun() when file doesn't exist
 *   - AC5: Cross-run transition — status shows run B data after run B starts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import { createPipelineRun } from '../../../persistence/queries/decisions.js'
import { runStatusAction } from '../status.js'
import { getAutoHealthData } from '../health.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockResolveMainRepoRoot = vi.fn()
vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: (...args: unknown[]) => mockResolveMainRepoRoot(...args),
}))

const mockExistsSync = vi.fn()
const mockReadFileSync = vi.fn()
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}))

// node:fs is used by health.ts — mock it separately
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}))

let _injectedAdapter: DatabaseAdapter | null = null
vi.mock('../../../persistence/adapter.js', () => ({
  createDatabaseAdapter: () => _injectedAdapter!,
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<InMemoryDatabaseAdapter> {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return adapter
}

// ---------------------------------------------------------------------------
// Status command — current-run-id integration tests
// ---------------------------------------------------------------------------

describe('Story 39-3: current-run-id file for status command', () => {
  let adapter: InMemoryDatabaseAdapter
  let stdoutChunks: string[]

  beforeEach(async () => {
    adapter = await createTestDb()
    _injectedAdapter = adapter

    stdoutChunks = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString())
      return true
    })

    // Default: DB files exist, no current-run-id file
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file')
    })
    mockResolveMainRepoRoot.mockResolvedValue('/fake/project')
  })

  afterEach(async () => {
    await adapter.close()
    vi.restoreAllMocks()
  })

  it('AC3: falls back to getLatestRun() when no current-run-id file exists', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { run_id: string } }
    expect(parsed.success).toBe(true)
    // Falls back to latest run
    expect(parsed.data.run_id).toBe(run.id)
  })

  it('AC2: uses run ID from current-run-id file when it exists', async () => {
    // Create run A (will be returned by getLatestRun since it's newer unless we also have run B)
    const runA = await createPipelineRun(adapter, { methodology: 'bmad' })
    // Create run B
    const runB = await createPipelineRun(adapter, { methodology: 'bmad' })

    // Simulate current-run-id pointing to run B
    mockReadFileSync.mockReturnValue(runB.id)

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { run_id: string } }
    expect(parsed.success).toBe(true)
    expect(parsed.data.run_id).toBe(runB.id)
    // Explicitly confirm we're NOT showing run A
    expect(parsed.data.run_id).not.toBe(runA.id)
  })

  it('AC5: cross-run transition — shows run B data after run B starts', async () => {
    // Run A completed
    const runA = await createPipelineRun(adapter, { methodology: 'bmad' })
    await adapter.query(`UPDATE pipeline_runs SET status = 'completed' WHERE id = ?`, [runA.id])

    // Run B just started
    const runB = await createPipelineRun(adapter, { methodology: 'bmad' })

    // current-run-id points to run B
    mockReadFileSync.mockReturnValue(runB.id)

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { run_id: string } }
    expect(parsed.success).toBe(true)
    // Must show run B, not run A
    expect(parsed.data.run_id).toBe(runB.id)
    expect(parsed.data.run_id).not.toBe(runA.id)
  })

  it('AC3: falls back to getLatestRun() when current-run-id file has only whitespace', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })

    // Simulate file with only whitespace
    mockReadFileSync.mockReturnValue('   \n')

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { run_id: string } }
    expect(parsed.success).toBe(true)
    expect(parsed.data.run_id).toBe(run.id)
  })

  it('AC3: falls back to getLatestRun() when run ID from file does not exist in DB', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })

    // Use a valid UUID format that passes regex validation but does not exist in the DB.
    // This exercises the DB-miss fallback path (getPipelineRunById returns undefined → getLatestRun).
    mockReadFileSync.mockReturnValue('00000000-0000-0000-0000-000000000000')

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { run_id: string } }
    expect(parsed.success).toBe(true)
    // Falls back to the latest actual run because the UUID was not found in the DB
    expect(parsed.data.run_id).toBe(run.id)
  })

  it('explicit --run-id option overrides current-run-id file', async () => {
    const runA = await createPipelineRun(adapter, { methodology: 'bmad' })
    const runB = await createPipelineRun(adapter, { methodology: 'bmad' })

    // current-run-id points to run B
    mockReadFileSync.mockReturnValue(runB.id)

    // But user explicitly requests run A
    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
      runId: runA.id,
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { run_id: string } }
    expect(parsed.success).toBe(true)
    expect(parsed.data.run_id).toBe(runA.id)
  })
})

// ---------------------------------------------------------------------------
// Health command — current-run-id integration tests
// ---------------------------------------------------------------------------

describe('Story 39-3: current-run-id file for health command', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await createTestDb()
    _injectedAdapter = adapter

    // Default: DB files exist, no current-run-id file
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file')
    })
    mockResolveMainRepoRoot.mockResolvedValue('/fake/project')
  })

  afterEach(async () => {
    await adapter.close()
    vi.restoreAllMocks()
  })

  it('AC3: health falls back to getLatestRun() when no current-run-id file exists', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    await adapter.query(`UPDATE pipeline_runs SET status = 'running' WHERE id = ?`, [run.id])

    const health = await getAutoHealthData({ projectRoot: '/fake/project' })

    expect(health.run_id).toBe(run.id)
  })

  it('AC2: health uses run ID from current-run-id file when it exists', async () => {
    const runA = await createPipelineRun(adapter, { methodology: 'bmad' })
    await adapter.query(`UPDATE pipeline_runs SET status = 'completed' WHERE id = ?`, [runA.id])

    const runB = await createPipelineRun(adapter, { methodology: 'bmad' })
    await adapter.query(`UPDATE pipeline_runs SET status = 'running' WHERE id = ?`, [runB.id])

    // current-run-id points to run B
    mockReadFileSync.mockReturnValue(runB.id)

    const health = await getAutoHealthData({ projectRoot: '/fake/project' })

    expect(health.run_id).toBe(runB.id)
    expect(health.run_id).not.toBe(runA.id)
  })
})
