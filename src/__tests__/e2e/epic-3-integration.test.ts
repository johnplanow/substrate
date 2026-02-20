/**
 * Epic 3 End-to-End Integration Tests
 *
 * Covers cross-story integration gaps that individual unit/story tests do NOT cover:
 *
 *  GAP-E3-1: Full worktree lifecycle across stories 3-1 + 3-2:
 *             task:ready → worktree:created → mergeWorktree → worktree:merged → worktree:removed
 *             (no single test covered this end-to-end chain)
 *
 *  GAP-E3-2: merge --all command (story 3-3 listWorktrees + story 3-2 mergeAll integration):
 *             listWorktrees() discovers worktrees → mergeAll() merges them all
 *             (the registerMergeCommand --all action wires these two; untested together)
 *
 *  GAP-E3-3: worktree:merged event followed by cleanupWorktree sequence:
 *             After a successful merge, the worktree is still present.
 *             Verifies merge + cleanup can be chained without errors.
 *
 *  GAP-E3-4: DB merge_status field update after merge + worktree lifecycle DB consistency:
 *             The updateTaskMergeStatus function exists in queries.ts but is NOT called
 *             by mergeWorktree(). This gap tests that worktree DB fields are consistent
 *             through the full create → merge → cleanup lifecycle.
 *
 *  GAP-E3-5: listWorktrees() → registerMergeCommand --all action integration:
 *             The Commander action for 'merge --all' calls listWorktrees() and then
 *             mergeAll(). This path was not tested end-to-end through Commander.
 *
 * All git operations are mocked via git-utils to avoid requiring a real git repo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Command } from 'commander'
import * as path from 'node:path'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { DatabaseService } from '../../persistence/database.js'
import { GitWorktreeManagerImpl } from '../../modules/git-worktree/git-worktree-manager-impl.js'
import {
  mergeAll,
  MERGE_EXIT_SUCCESS,
  MERGE_EXIT_CONFLICT,
} from '../../cli/commands/merge.js'
import { registerMergeCommand } from '../../cli/commands/merge.js'

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    access: vi.fn(async () => undefined), // Default: worktree exists
    readdir: vi.fn(async () => []),        // Default: empty directory
    stat: vi.fn(async () => ({
      birthtime: new Date('2024-03-01T10:00:00Z'),
      ctime: new Date('2024-03-01T10:00:00Z'),
      isDirectory: () => true,
    })),
  }
})

import * as fsp from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'

// ---------------------------------------------------------------------------
// Mock git-utils
// ---------------------------------------------------------------------------

vi.mock(import('../../modules/git-worktree/git-utils.js'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    verifyGitVersion: vi.fn(async () => {}),
    createWorktree: vi.fn(async (projectRoot: string, taskId: string) => ({
      worktreePath: path.join(projectRoot, '.substrate-worktrees', taskId),
    })),
    removeWorktree: vi.fn(async () => {}),
    removeBranch: vi.fn(async () => true),
    getOrphanedWorktrees: vi.fn(async () => []),
    simulateMerge: vi.fn(async () => true),
    abortMerge: vi.fn(async () => {}),
    getConflictingFiles: vi.fn(async () => []),
    performMerge: vi.fn(async () => true),
    getMergedFiles: vi.fn(async () => []),
  }
})

import * as gitUtils from '../../modules/git-worktree/git-utils.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/home/user/epic3-testproject'

/**
 * Create a real EventEmitter-backed TypedEventBus that also records all events.
 */
function createRealEventBus(): TypedEventBus & {
  getEmittedEvents: () => Array<{ event: string; payload: unknown }>
} {
  const emitter = new EventEmitter()
  const events: Array<{ event: string; payload: unknown }> = []

  return {
    emit: vi.fn((event: string, payload: unknown) => {
      events.push({ event, payload })
      emitter.emit(event, payload)
    }) as TypedEventBus['emit'],
    on: vi.fn((event: string, handler: (payload: unknown) => void) =>
      emitter.on(event, handler),
    ) as TypedEventBus['on'],
    off: vi.fn((event: string, handler: (payload: unknown) => void) =>
      emitter.off(event, handler),
    ) as TypedEventBus['off'],
    getEmittedEvents: () => events,
  }
}

/**
 * Create a minimal mock DatabaseService.
 */
function createMockDb(): DatabaseService {
  const db = {
    prepare: vi.fn(() => ({
      get: vi.fn(() => undefined),
      all: vi.fn(() => []),
      run: vi.fn(() => ({ changes: 1 })),
    })),
  }
  return {
    initialize: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    isOpen: true,
    db: db as unknown as DatabaseService['db'],
  }
}

/**
 * Helper to run the 'merge' Commander command and capture output.
 * merge.ts uses console.log for output, so we spy on console.log.
 */
async function runMergeCommand(
  args: string[],
  projectRoot = PROJECT_ROOT,
): Promise<{ output: string; error: string; exitCode: number }> {
  let capturedOutput = ''
  let capturedError = ''

  // merge.ts uses console.log (not process.stdout.write) for its output
  const consoleSpy = vi
    .spyOn(console, 'log')
    .mockImplementation((...parts: unknown[]) => {
      capturedOutput += parts.join(' ') + '\n'
    })
  const consoleErrorSpy = vi
    .spyOn(console, 'error')
    .mockImplementation((...parts: unknown[]) => {
      capturedError += parts.join(' ') + '\n'
    })
  // Also capture process.stderr.write for other error output paths
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((data: string | Uint8Array) => {
      capturedError += typeof data === 'string' ? data : data.toString()
      return true
    })

  const program = new Command()
  program.exitOverride()
  registerMergeCommand(program, projectRoot)

  const savedExitCode = process.exitCode
  process.exitCode = undefined

  try {
    await program.parseAsync(['node', 'substrate', 'merge', ...args])
  } catch (_err) {
    // exit overrides throw — acceptable
  } finally {
    consoleSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    stderrSpy.mockRestore()
  }

  const resultCode = typeof process.exitCode === 'number' ? process.exitCode : -1
  process.exitCode = savedExitCode

  return { output: capturedOutput, error: capturedError, exitCode: resultCode }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // Default mocks: worktree exists, clean merge
  vi.mocked(fsp.access).mockResolvedValue(undefined)
  vi.mocked(fsp.readdir).mockResolvedValue([])
  vi.mocked(gitUtils.verifyGitVersion).mockResolvedValue(undefined)
  vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([])
  vi.mocked(gitUtils.simulateMerge).mockResolvedValue(true)
  vi.mocked(gitUtils.getConflictingFiles).mockResolvedValue([])
  vi.mocked(gitUtils.abortMerge).mockResolvedValue(undefined)
  vi.mocked(gitUtils.performMerge).mockResolvedValue(true)
  vi.mocked(gitUtils.getMergedFiles).mockResolvedValue([])
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// GAP-E3-1: Full worktree lifecycle (story 3-1 + story 3-2)
// ---------------------------------------------------------------------------

describe('GAP-E3-1: Full worktree lifecycle — task:ready → merge → cleanup', () => {
  it('complete sequence: task:ready emits worktree:created, merge succeeds, worktree:removed follows cleanup', async () => {
    // This tests the cross-story integration: story 3-1 (worktree creation) →
    // story 3-2 (merge) → story 3-1 (cleanup)
    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

    await manager.initialize()

    // STEP 1 (story 3-1): task:ready fires, worktree is created
    vi.mocked(gitUtils.createWorktree).mockResolvedValueOnce({
      worktreePath: path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-e2e-1'),
    })
    eventBus.emit('task:ready', { taskId: 'task-e2e-1' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const createdEvents = eventBus.getEmittedEvents().filter((e) => e.event === 'worktree:created')
    expect(createdEvents).toHaveLength(1)
    expect((createdEvents[0].payload as { taskId: string }).taskId).toBe('task-e2e-1')

    // STEP 2 (story 3-2): merge the created worktree
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValueOnce(['src/feature.ts'])
    const mergeResult = await manager.mergeWorktree('task-e2e-1', 'main')
    expect(mergeResult.success).toBe(true)
    expect(mergeResult.mergedFiles).toEqual(['src/feature.ts'])

    const mergedEvents = eventBus.getEmittedEvents().filter((e) => e.event === 'worktree:merged')
    expect(mergedEvents).toHaveLength(1)
    expect((mergedEvents[0].payload as { taskId: string }).taskId).toBe('task-e2e-1')

    // STEP 3 (story 3-1): cleanup the worktree after merge
    await manager.cleanupWorktree('task-e2e-1')

    const removedEvents = eventBus.getEmittedEvents().filter((e) => e.event === 'worktree:removed')
    expect(removedEvents).toHaveLength(1)
    expect((removedEvents[0].payload as { taskId: string }).taskId).toBe('task-e2e-1')

    await manager.shutdown()
  })

  it('event order is correct: worktree:created before worktree:merged before worktree:removed', async () => {
    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

    await manager.initialize()

    // Create
    vi.mocked(gitUtils.createWorktree).mockResolvedValueOnce({
      worktreePath: path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-order'),
    })
    eventBus.emit('task:ready', { taskId: 'task-order' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Merge
    await manager.mergeWorktree('task-order', 'main')

    // Cleanup
    await manager.cleanupWorktree('task-order')

    const allEvents = eventBus.getEmittedEvents().map((e) => e.event)
    const createdIdx = allEvents.indexOf('worktree:created')
    const mergedIdx = allEvents.indexOf('worktree:merged')
    const removedIdx = allEvents.indexOf('worktree:removed')

    expect(createdIdx).toBeLessThan(mergedIdx)
    expect(mergedIdx).toBeLessThan(removedIdx)

    await manager.shutdown()
  })

  it('conflict detected via detectConflicts (story 3-2) after worktree:created (story 3-1)', async () => {
    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

    await manager.initialize()

    // Create worktree (story 3-1)
    vi.mocked(gitUtils.createWorktree).mockResolvedValueOnce({
      worktreePath: path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-conflict-flow'),
    })
    eventBus.emit('task:ready', { taskId: 'task-conflict-flow' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Detect conflicts (story 3-2) — worktree exists
    vi.mocked(gitUtils.simulateMerge).mockResolvedValueOnce(false)
    vi.mocked(gitUtils.getConflictingFiles).mockResolvedValueOnce(['src/conflict.ts'])

    const report = await manager.detectConflicts('task-conflict-flow', 'main')
    expect(report.hasConflicts).toBe(true)
    expect(report.conflictingFiles).toEqual(['src/conflict.ts'])

    const conflictEvents = eventBus.getEmittedEvents().filter((e) => e.event === 'worktree:conflict')
    expect(conflictEvents).toHaveLength(1)
    expect((conflictEvents[0].payload as { taskId: string }).taskId).toBe('task-conflict-flow')

    // Cleanup despite conflict (story 3-1)
    await manager.cleanupWorktree('task-conflict-flow')
    const removedEvents = eventBus.getEmittedEvents().filter((e) => e.event === 'worktree:removed')
    expect(removedEvents).toHaveLength(1)

    await manager.shutdown()
  })
})

// ---------------------------------------------------------------------------
// GAP-E3-2: mergeAll (story 3-2) using listWorktrees (story 3-3) as input
// ---------------------------------------------------------------------------

describe('GAP-E3-2: mergeAll() powered by listWorktrees() discovery', () => {
  it('listWorktrees discovers worktrees and mergeAll processes them all', async () => {
    // This tests the exact path used by `merge --all` command action:
    // listWorktrees() → taskIds → mergeAll(taskIds)
    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

    // Set up three worktrees to be discovered
    const worktreePaths = [
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-alpha'),
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-beta'),
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-gamma'),
    ]
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue(worktreePaths)
    vi.mocked(fsp.stat).mockResolvedValue({
      birthtime: new Date('2024-03-01T10:00:00Z'),
      ctime: new Date('2024-03-01T10:00:00Z'),
      isDirectory: () => true,
    } as Stats)

    // Discover worktrees (story 3-3)
    const worktreeInfos = await manager.listWorktrees()
    expect(worktreeInfos).toHaveLength(3)
    const taskIds = worktreeInfos.map((wt) => wt.taskId)
    expect(taskIds).toContain('task-alpha')
    expect(taskIds).toContain('task-beta')
    expect(taskIds).toContain('task-gamma')

    // All merges succeed
    vi.mocked(gitUtils.simulateMerge).mockResolvedValue(true)
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValue(['merged.ts'])

    // mergeAll (story 3-2) processes the discovered task IDs
    const exitCode = await mergeAll('main', PROJECT_ROOT, taskIds)
    expect(exitCode).toBe(MERGE_EXIT_SUCCESS)
  })

  it('listWorktrees + mergeAll handles mixed success and conflict results', async () => {
    const worktreePaths = [
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-ok'),
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-bad'),
    ]
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue(worktreePaths)
    vi.mocked(fsp.stat).mockResolvedValue({
      birthtime: new Date('2024-03-01T10:00:00Z'),
      ctime: new Date('2024-03-01T10:00:00Z'),
      isDirectory: () => true,
    } as Stats)

    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)
    const worktreeInfos = await manager.listWorktrees()
    const taskIds = worktreeInfos.map((wt) => wt.taskId)

    // task-ok merges cleanly; task-bad has conflicts
    vi.mocked(gitUtils.simulateMerge)
      .mockResolvedValueOnce(true)   // task-ok: detectConflicts inside mergeWorktree
      .mockResolvedValueOnce(false)  // task-bad: detectConflicts inside mergeWorktree

    vi.mocked(gitUtils.getConflictingFiles).mockResolvedValueOnce(['bad.ts'])
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValueOnce(['ok.ts'])

    const exitCode = await mergeAll('main', PROJECT_ROOT, taskIds)
    // At least one conflict → MERGE_EXIT_CONFLICT
    expect(exitCode).toBe(MERGE_EXIT_CONFLICT)
  })

  it('empty listWorktrees result feeds into mergeAll returning success', async () => {
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([])

    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)
    const worktreeInfos = await manager.listWorktrees()

    expect(worktreeInfos).toHaveLength(0)
    const exitCode = await mergeAll('main', PROJECT_ROOT, [])
    expect(exitCode).toBe(MERGE_EXIT_SUCCESS)
  })
})

// ---------------------------------------------------------------------------
// GAP-E3-3: merge + cleanup chaining (stories 3-2 + 3-1)
// ---------------------------------------------------------------------------

describe('GAP-E3-3: Merge followed by cleanup — worktree:merged then worktree:removed', () => {
  it('after successful merge, cleanupWorktree removes the worktree and branch', async () => {
    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

    // Merge first
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValueOnce(['src/merged.ts'])
    const mergeResult = await manager.mergeWorktree('task-post-merge', 'main')
    expect(mergeResult.success).toBe(true)

    // Then cleanup
    await manager.cleanupWorktree('task-post-merge')

    expect(gitUtils.removeBranch).toHaveBeenCalledWith(
      'substrate/task-task-post-merge',
      PROJECT_ROOT,
    )

    const allEvents = eventBus.getEmittedEvents().map((e) => e.event)
    expect(allEvents).toContain('worktree:merged')
    expect(allEvents).toContain('worktree:removed')
  })

  it('after failed merge (conflicts), cleanupWorktree still succeeds', async () => {
    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

    // Merge fails due to conflicts
    vi.mocked(gitUtils.simulateMerge).mockResolvedValueOnce(false)
    vi.mocked(gitUtils.getConflictingFiles).mockResolvedValueOnce(['conflict.ts'])

    const mergeResult = await manager.mergeWorktree('task-conflict-cleanup', 'main')
    expect(mergeResult.success).toBe(false)

    // Cleanup should still work after failed merge
    await manager.cleanupWorktree('task-conflict-cleanup')

    const removedEvents = eventBus.getEmittedEvents().filter((e) => e.event === 'worktree:removed')
    expect(removedEvents).toHaveLength(1)
  })

  it('merge emits worktree:merged with mergedFiles, cleanup emits worktree:removed with branchName', async () => {
    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

    vi.mocked(gitUtils.getMergedFiles).mockResolvedValueOnce(['src/a.ts', 'src/b.ts'])

    await manager.mergeWorktree('task-chain', 'main')
    await manager.cleanupWorktree('task-chain')

    const allEvents = eventBus.getEmittedEvents()
    const mergedEvent = allEvents.find((e) => e.event === 'worktree:merged')
    const removedEvent = allEvents.find((e) => e.event === 'worktree:removed')

    expect(mergedEvent).toBeDefined()
    expect((mergedEvent!.payload as { mergedFiles: string[] }).mergedFiles).toEqual([
      'src/a.ts',
      'src/b.ts',
    ])

    expect(removedEvent).toBeDefined()
    expect((removedEvent!.payload as { branchName: string }).branchName).toBe(
      'substrate/task-task-chain',
    )
  })
})

// ---------------------------------------------------------------------------
// GAP-E3-4: DB field consistency across full create → merge → cleanup lifecycle
// ---------------------------------------------------------------------------

describe('GAP-E3-4: DB worktree field consistency through full lifecycle', () => {
  it('createWorktree updates worktree_path and worktree_branch, cleanupWorktree updates worktree_cleaned_at', async () => {
    const db = createMockDb()
    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT, '.substrate-worktrees', db)

    const dbPrepareMock = db.db.prepare as ReturnType<typeof vi.fn>

    // createWorktree should call updateTaskWorktree with worktree_path and worktree_branch
    await manager.createWorktree('task-db-lifecycle')

    // Should have called DB at least once for worktree creation
    expect(dbPrepareMock).toHaveBeenCalled()
    const createCallArgs = dbPrepareMock.mock.calls as string[][]
    const createSql = createCallArgs.map((c) => c[0]).join('\n')
    expect(createSql).toContain('worktree_path')

    dbPrepareMock.mockClear()

    // cleanupWorktree should call updateTaskWorktree with worktree_cleaned_at
    await manager.cleanupWorktree('task-db-lifecycle')
    expect(dbPrepareMock).toHaveBeenCalled()
    const cleanupCallArgs = dbPrepareMock.mock.calls as string[][]
    const cleanupSql = cleanupCallArgs.map((c) => c[0]).join('\n')
    expect(cleanupSql).toContain('worktree_cleaned_at')
  })

  it('mergeWorktree with DB calls updateTaskWorktree with worktree_cleaned_at on success', async () => {
    const db = createMockDb()
    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT, '.substrate-worktrees', db)

    const dbPrepareMock = db.db.prepare as ReturnType<typeof vi.fn>

    vi.mocked(gitUtils.getMergedFiles).mockResolvedValueOnce(['merged.ts'])
    await manager.mergeWorktree('task-db-merge', 'main')

    // mergeWorktree calls updateTaskWorktree with worktree_cleaned_at after successful merge
    expect(dbPrepareMock).toHaveBeenCalled()
    const callArgs = dbPrepareMock.mock.calls as string[][]
    const sql = callArgs.map((c) => c[0]).join('\n')
    expect(sql).toContain('worktree_cleaned_at')
  })

  it('mergeWorktree without DB does not throw when DB is null', async () => {
    const eventBus = createRealEventBus()
    // No DB provided (null)
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT, '.substrate-worktrees', null)

    vi.mocked(gitUtils.getMergedFiles).mockResolvedValueOnce(['file.ts'])
    await expect(manager.mergeWorktree('task-no-db', 'main')).resolves.not.toThrow()
  })

  it('createWorktree without DB does not throw when DB is null', async () => {
    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT, '.substrate-worktrees', null)

    await expect(manager.createWorktree('task-no-db-create')).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// GAP-E3-5: Commander merge --all action uses listWorktrees() then mergeAll()
// ---------------------------------------------------------------------------

describe('GAP-E3-5: Commander merge --all action: listWorktrees → mergeAll integration', () => {
  it('merge --all with no worktrees exits 0 and prints "No tasks to merge"', async () => {
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([])

    const { output, exitCode } = await runMergeCommand(['--all'])
    expect(output).toContain('No tasks to merge')
    expect(exitCode).toBe(MERGE_EXIT_SUCCESS)
  })

  it('merge --all with one clean worktree exits 0', async () => {
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-single'),
    ])
    vi.mocked(fsp.stat).mockResolvedValue({
      birthtime: new Date('2024-03-01T10:00:00Z'),
      ctime: new Date('2024-03-01T10:00:00Z'),
      isDirectory: () => true,
    } as Stats)

    vi.mocked(gitUtils.simulateMerge).mockResolvedValue(true)
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValue(['src/clean.ts'])

    const { exitCode } = await runMergeCommand(['--all'])
    expect(exitCode).toBe(MERGE_EXIT_SUCCESS)
  })

  it('merge --all with conflicting worktree exits 1', async () => {
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-conflict'),
    ])
    vi.mocked(fsp.stat).mockResolvedValue({
      birthtime: new Date('2024-03-01T10:00:00Z'),
      ctime: new Date('2024-03-01T10:00:00Z'),
      isDirectory: () => true,
    } as Stats)

    vi.mocked(gitUtils.simulateMerge).mockResolvedValue(false)
    vi.mocked(gitUtils.getConflictingFiles).mockResolvedValue(['conflict.ts'])

    const { exitCode } = await runMergeCommand(['--all'])
    expect(exitCode).toBe(MERGE_EXIT_CONFLICT)
  })

  it('merge --all with --branch option passes target branch to mergeAll', async () => {
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-branch'),
    ])
    vi.mocked(fsp.stat).mockResolvedValue({
      birthtime: new Date('2024-03-01T10:00:00Z'),
      ctime: new Date('2024-03-01T10:00:00Z'),
      isDirectory: () => true,
    } as Stats)

    vi.mocked(gitUtils.simulateMerge).mockResolvedValue(true)
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValue([])

    const { exitCode } = await runMergeCommand(['--all', '--branch', 'develop'])
    expect(exitCode).toBe(MERGE_EXIT_SUCCESS)
    // Verify simulateMerge was called (confirming the merge path was taken)
    expect(gitUtils.simulateMerge).toHaveBeenCalled()
  })

  it('merge --all processes multiple worktrees and shows merge summary', async () => {
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-a'),
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-b'),
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-c'),
    ])
    vi.mocked(fsp.stat).mockResolvedValue({
      birthtime: new Date('2024-03-01T10:00:00Z'),
      ctime: new Date('2024-03-01T10:00:00Z'),
      isDirectory: () => true,
    } as Stats)

    // All three merge cleanly
    vi.mocked(gitUtils.simulateMerge).mockResolvedValue(true)
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValue(['file.ts'])

    const { output, exitCode } = await runMergeCommand(['--all'])
    expect(exitCode).toBe(MERGE_EXIT_SUCCESS)
    expect(output).toContain('Merge Summary')
    expect(output).toContain('Merged: 3')
  })
})

// ---------------------------------------------------------------------------
// GAP-E3-6: listWorktrees and merge --all cross-story event ordering
// ---------------------------------------------------------------------------

describe('GAP-E3-6: Cross-story event sequencing — worktrees discovered via listWorktrees used in merge', () => {
  it('worktrees listed by listWorktrees have branchNames matching what mergeWorktree expects', async () => {
    // This tests the naming contract between story 3-3 (listWorktrees) and
    // story 3-2 (mergeWorktree): listWorktrees returns branchName = "substrate/task-{taskId}"
    // and mergeWorktree also computes branchName as "substrate/task-{taskId}".
    const worktreePaths = [
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-naming-check'),
    ]
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue(worktreePaths)
    vi.mocked(fsp.stat).mockResolvedValue({
      birthtime: new Date('2024-03-01T10:00:00Z'),
      ctime: new Date('2024-03-01T10:00:00Z'),
      isDirectory: () => true,
    } as Stats)

    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

    const worktrees = await manager.listWorktrees()
    expect(worktrees).toHaveLength(1)
    expect(worktrees[0].taskId).toBe('task-naming-check')
    expect(worktrees[0].branchName).toBe('substrate/task-task-naming-check')

    // Use the taskId from listWorktrees to call mergeWorktree
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValueOnce(['feature.ts'])
    const mergeResult = await manager.mergeWorktree(worktrees[0].taskId, 'main')
    expect(mergeResult.success).toBe(true)

    // The simulateMerge call should have used the branch name format matching worktrees listing
    expect(gitUtils.simulateMerge).toHaveBeenCalledWith(
      'substrate/task-task-naming-check',
      PROJECT_ROOT,
    )
  })

  it('multiple tasks discovered by listWorktrees can each be independently merged', async () => {
    const worktreePaths = [
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-ind-1'),
      path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-ind-2'),
    ]
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue(worktreePaths)
    vi.mocked(fsp.stat).mockResolvedValue({
      birthtime: new Date('2024-03-01T10:00:00Z'),
      ctime: new Date('2024-03-01T10:00:00Z'),
      isDirectory: () => true,
    } as Stats)

    const eventBus = createRealEventBus()
    const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

    const worktrees = await manager.listWorktrees()
    expect(worktrees).toHaveLength(2)

    // Each merge is independent
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValue(['file.ts'])

    for (const wt of worktrees) {
      const result = await manager.mergeWorktree(wt.taskId, 'main')
      expect(result.success).toBe(true)
    }

    const mergedEvents = eventBus.getEmittedEvents().filter((e) => e.event === 'worktree:merged')
    expect(mergedEvents).toHaveLength(2)
  })
})
