// @vitest-environment node
/**
 * Tests for Story 31-5: substrate status shows Work Graph — blocked stories and why.
 *
 * Verifies:
 *   - workGraph field appears in JSON output when wg_stories is populated
 *   - workGraph is null when wg_stories is empty
 *   - blocked stories list the correct blockers (key, title, status)
 *   - ready stories appear in readyStories array
 *   - human output renders Work Graph section with correct counts
 *   - human output lists ready stories and blocked stories with blockers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWasmSqliteAdapter, WasmSqliteDatabaseAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import { createPipelineRun } from '../../../persistence/queries/decisions.js'
import { runStatusAction } from '../status.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { WorkGraphRepository } from '../../../modules/state/index.js'
import type { WgStory } from '../../../modules/state/index.js'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockResolveMainRepoRoot = vi.fn()
vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: (...args: unknown[]) => mockResolveMainRepoRoot(...args),
}))

const mockExistsSync = vi.fn()
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}))

// Override createDatabaseAdapter to inject our test adapter.
// The injected adapter is set in beforeEach before runStatusAction is called.
let _injectedAdapter: DatabaseAdapter | null = null

vi.mock('../../../persistence/adapter.js', () => {
  return {
    createDatabaseAdapter: () => _injectedAdapter!,
  }
})

// Do NOT mock schema.js — initSchema uses CREATE TABLE IF NOT EXISTS (idempotent).
// status.ts calls initSchema on the injected adapter which already has tables from createTestDb().

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<WasmSqliteDatabaseAdapter> {
  const adapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
  // Initialize all standard schema tables (pipeline_runs, decisions, etc.)
  await initSchema(adapter)
  // Create wg_stories and story_dependencies tables (work graph schema)
  await adapter.exec(`CREATE TABLE IF NOT EXISTS wg_stories (
    story_key    VARCHAR(20)   NOT NULL,
    epic         VARCHAR(20)   NOT NULL,
    title        VARCHAR(255),
    status       VARCHAR(30)   NOT NULL DEFAULT 'planned',
    spec_path    VARCHAR(500),
    created_at   DATETIME,
    updated_at   DATETIME,
    completed_at DATETIME,
    PRIMARY KEY (story_key)
  )`)
  await adapter.exec(`CREATE TABLE IF NOT EXISTS story_dependencies (
    story_key       VARCHAR(50)  NOT NULL,
    depends_on      VARCHAR(50)  NOT NULL,
    dependency_type VARCHAR(50)  NOT NULL DEFAULT 'blocks',
    source          VARCHAR(50)  NOT NULL DEFAULT 'explicit',
    created_at      DATETIME,
    PRIMARY KEY (story_key, depends_on)
  )`)
  return adapter
}

function makeStory(overrides: Partial<WgStory> = {}): WgStory {
  return {
    story_key: '31-1',
    epic: '31',
    status: 'planned',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Story 31-5: work graph in status command (JSON output)', () => {
  let adapter: WasmSqliteDatabaseAdapter
  let stdoutChunks: string[]

  beforeEach(async () => {
    adapter = await createTestDb()
    _injectedAdapter = adapter

    stdoutChunks = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString())
      return true
    })

    mockExistsSync.mockReturnValue(true)
    mockResolveMainRepoRoot.mockResolvedValue('/fake/project')
  })

  afterEach(async () => {
    await adapter.close()
    vi.restoreAllMocks()
  })

  it('workGraph is null when wg_stories is empty', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
      runId: run.id,
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { workGraph: null } }
    expect(parsed.success).toBe(true)
    expect(parsed.data.workGraph).toBeNull()
  })

  it('workGraph contains correct summary counts when work graph is populated', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    const repo = new WorkGraphRepository(adapter)

    // 1 in_progress, 1 ready (no deps), 1 blocked (dep not complete), 1 complete
    await repo.upsertStory(makeStory({ story_key: '31-1', status: 'in_progress', title: 'In Progress Story' }))
    await repo.upsertStory(makeStory({ story_key: '31-2', status: 'planned', title: 'Ready Story' }))
    await repo.upsertStory(makeStory({ story_key: '31-3', status: 'complete', title: 'Done Story' }))
    await repo.upsertStory(makeStory({ story_key: '31-4', status: 'planned', title: 'Blocked Story' }))
    // 31-4 depends on 31-1 which is in_progress → blocked
    await repo.addDependency({ story_key: '31-4', depends_on: '31-1', dependency_type: 'blocks', source: 'explicit' })

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
      runId: run.id,
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as {
      success: boolean
      data: {
        workGraph: {
          summary: { ready: number; blocked: number; inProgress: number; complete: number; escalated: number }
          readyStories: Array<{ key: string; title: string }>
          blockedStories: Array<{ key: string; title: string; blockers: Array<{ key: string; title: string; status: string }> }>
        }
      }
    }

    expect(parsed.success).toBe(true)
    const wg = parsed.data.workGraph
    expect(wg).not.toBeNull()
    expect(wg.summary.inProgress).toBe(1)
    expect(wg.summary.ready).toBe(1)
    expect(wg.summary.blocked).toBe(1)
    expect(wg.summary.complete).toBe(1)
    expect(wg.summary.escalated).toBe(0)
  })

  it('readyStories lists stories with no incomplete blocking deps', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    const repo = new WorkGraphRepository(adapter)

    await repo.upsertStory(makeStory({ story_key: '31-1', status: 'complete', title: 'Done' }))
    await repo.upsertStory(makeStory({ story_key: '31-2', status: 'planned', title: 'Ready Story' }))
    await repo.addDependency({ story_key: '31-2', depends_on: '31-1', dependency_type: 'blocks', source: 'explicit' })

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
      runId: run.id,
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { data: { workGraph: { readyStories: Array<{ key: string; title: string }> } } }
    const ready = parsed.data.workGraph.readyStories
    expect(ready).toHaveLength(1)
    expect(ready[0]!.key).toBe('31-2')
    expect(ready[0]!.title).toBe('Ready Story')
  })

  it('blockedStories includes correct blocker info (key, title, status)', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    const repo = new WorkGraphRepository(adapter)

    await repo.upsertStory(makeStory({ story_key: '31-1', status: 'in_progress', title: 'Blocker Story' }))
    await repo.upsertStory(makeStory({ story_key: '31-2', status: 'planned', title: 'Blocked Story' }))
    await repo.addDependency({ story_key: '31-2', depends_on: '31-1', dependency_type: 'blocks', source: 'explicit' })

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
      runId: run.id,
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as {
      data: {
        workGraph: {
          blockedStories: Array<{
            key: string
            title: string
            blockers: Array<{ key: string; title: string; status: string }>
          }>
        }
      }
    }
    const blocked = parsed.data.workGraph.blockedStories
    expect(blocked).toHaveLength(1)
    expect(blocked[0]!.key).toBe('31-2')
    expect(blocked[0]!.title).toBe('Blocked Story')
    expect(blocked[0]!.blockers).toHaveLength(1)
    expect(blocked[0]!.blockers[0]!.key).toBe('31-1')
    expect(blocked[0]!.blockers[0]!.title).toBe('Blocker Story')
    expect(blocked[0]!.blockers[0]!.status).toBe('in_progress')
  })

  it('blockedStories shows only incomplete blockers when story has mixed deps', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    const repo = new WorkGraphRepository(adapter)

    await repo.upsertStory(makeStory({ story_key: '31-1', status: 'complete', title: 'Done Dep' }))
    await repo.upsertStory(makeStory({ story_key: '31-2', status: 'planned', title: 'Pending Dep' }))
    await repo.upsertStory(makeStory({ story_key: '31-3', status: 'planned', title: 'Blocked Story' }))
    await repo.addDependency({ story_key: '31-3', depends_on: '31-1', dependency_type: 'blocks', source: 'explicit' })
    await repo.addDependency({ story_key: '31-3', depends_on: '31-2', dependency_type: 'blocks', source: 'explicit' })

    await runStatusAction({
      outputFormat: 'json',
      projectRoot: '/fake/project',
      runId: run.id,
    })

    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as {
      data: {
        workGraph: {
          blockedStories: Array<{ key: string; blockers: Array<{ key: string }> }>
        }
      }
    }
    const blocked = parsed.data.workGraph.blockedStories
    expect(blocked).toHaveLength(1)
    // Only the incomplete dep (31-2) should appear as a blocker
    expect(blocked[0]!.blockers).toHaveLength(1)
    expect(blocked[0]!.blockers[0]!.key).toBe('31-2')
  })

  it('swallows WorkGraphRepository errors — exit code 0, rest of output unaffected (AC6)', async () => {
    // Use a fresh adapter with only the standard schema (no wg_stories table)
    // so the work graph query throws a "table not found" error.
    const noWgAdapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
    await initSchema(noWgAdapter)
    const run = await createPipelineRun(noWgAdapter, { methodology: 'bmad' })
    _injectedAdapter = noWgAdapter

    let exitCode: number | undefined
    try {
      exitCode = await runStatusAction({
        outputFormat: 'json',
        projectRoot: '/fake/project',
        runId: run.id,
      })
    } finally {
      await noWgAdapter.close()
    }

    // Command must exit 0 (error was swallowed, not propagated)
    expect(exitCode).toBe(0)
    // Output must be valid JSON with success: true
    const output = stdoutChunks.join('')
    const parsed = JSON.parse(output) as { success: boolean; data: { workGraph: null } }
    expect(parsed.success).toBe(true)
    // workGraph should be null because the query failed and was swallowed
    expect(parsed.data.workGraph).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Human output tests
// ---------------------------------------------------------------------------

describe('Story 31-5: work graph in status command (human output)', () => {
  let adapter: WasmSqliteDatabaseAdapter
  let stdoutChunks: string[]
  let stderrChunks: string[]

  beforeEach(async () => {
    adapter = await createTestDb()
    _injectedAdapter = adapter

    stdoutChunks = []
    stderrChunks = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString())
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(chunk.toString())
      return true
    })

    mockExistsSync.mockReturnValue(true)
    mockResolveMainRepoRoot.mockResolvedValue('/fake/project')
  })

  afterEach(async () => {
    await adapter.close()
    vi.restoreAllMocks()
  })

  it('renders Work Graph section with summary counts when stories are populated', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    const repo = new WorkGraphRepository(adapter)

    await repo.upsertStory(makeStory({ story_key: '31-1', status: 'complete', title: 'Done' }))
    await repo.upsertStory(makeStory({ story_key: '31-2', status: 'planned', title: 'Ready Story' }))
    await repo.addDependency({ story_key: '31-2', depends_on: '31-1', dependency_type: 'blocks', source: 'explicit' })

    await runStatusAction({
      outputFormat: 'human',
      projectRoot: '/fake/project',
      runId: run.id,
    })

    const output = stdoutChunks.join('')
    expect(output).toContain('Work Graph')
    expect(output).toContain('ready')
    expect(output).toContain('complete')
  })

  it('lists ready stories under "Ready to dispatch" in human output', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    const repo = new WorkGraphRepository(adapter)

    await repo.upsertStory(makeStory({ story_key: '31-1', status: 'planned', title: 'My Ready Story' }))

    await runStatusAction({
      outputFormat: 'human',
      projectRoot: '/fake/project',
      runId: run.id,
    })

    const output = stdoutChunks.join('')
    expect(output).toContain('Ready to dispatch')
    expect(output).toContain('31-1')
    expect(output).toContain('My Ready Story')
  })

  it('lists blocked stories with "waiting on" blocker info in human output', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })
    const repo = new WorkGraphRepository(adapter)

    await repo.upsertStory(makeStory({ story_key: '31-1', status: 'in_progress', title: 'Blocker Story' }))
    await repo.upsertStory(makeStory({ story_key: '31-2', status: 'planned', title: 'Blocked Story' }))
    await repo.addDependency({ story_key: '31-2', depends_on: '31-1', dependency_type: 'blocks', source: 'explicit' })

    await runStatusAction({
      outputFormat: 'human',
      projectRoot: '/fake/project',
      runId: run.id,
    })

    const output = stdoutChunks.join('')
    expect(output).toContain('Blocked')
    expect(output).toContain('31-2')
    expect(output).toContain('waiting on')
    expect(output).toContain('31-1')
    expect(output).toContain('in_progress')
  })

  it('does not render Work Graph section when wg_stories is empty', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad' })

    await runStatusAction({
      outputFormat: 'human',
      projectRoot: '/fake/project',
      runId: run.id,
    })

    const output = stdoutChunks.join('')
    expect(output).not.toContain('Work Graph')
  })
})
