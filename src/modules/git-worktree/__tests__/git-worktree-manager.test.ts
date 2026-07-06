/**
 * Unit tests for GitWorktreeManagerImpl
 *
 * Tests cover:
 *  - AC1: createWorktree() creates branch and worktree, emits worktree:created
 *  - AC2: Created worktree path matches expected pattern
 *  - AC3: cleanupWorktree() calls git worktree remove and git branch -D, emits worktree:removed
 *  - AC4: cleanupAllWorktrees() finds and removes orphaned worktrees, returns correct count
 *  - AC5: verifyGitVersion() validates git >= 2.20
 *  - AC6: getWorktreePath() returns correct path
 *  - Cross-platform path tests
 *
 * git-utils is mocked to avoid real git operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import * as path from 'node:path'
import type { TypedEventBus } from '../../../core/event-bus.js'
import { GitWorktreeManagerImpl } from '../git-worktree-manager-impl.js'
import type { LegacyDbLike } from '../git-worktree-manager-impl.js'

// ---------------------------------------------------------------------------
// Mock node:fs/promises so access() can be controlled per test.
// Default: access rejects (worktree path does not exist).
// Tests that need removeWorktree to be called can override with mockResolvedValue.
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    access: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
  }
})

import * as fsp from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Mock git-utils — target the core package's git-utils directly so that
// GitWorktreeManagerImpl (which imports ./git-utils.js internally) sees the mock.
// ---------------------------------------------------------------------------

vi.mock('../../../../packages/core/src/git/git-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../packages/core/src/git/git-utils.js')>()
  return {
    ...actual,
    verifyGitVersion: vi.fn(async () => {}),
    createWorktree: vi.fn(async (_projectRoot: string, taskId: string, _branchName: string, _baseBranch: string, _copyFiles?: readonly string[]) => ({
      worktreePath: path.join(_projectRoot, '.substrate-worktrees', taskId),
    })),
    removeWorktree: vi.fn(async () => {}),
    removeBranch: vi.fn(async () => {}),
    getOrphanedWorktrees: vi.fn(async () => []),
    // H0.3: default = safe to remove; dirty-guard tests override.
    inspectWorktreeRemovalSafety: vi.fn(async () => ({ safe: true, reasons: [] })),
  }
})

// Import mocked module via the core path to get the spy references
import * as gitUtils from '../../../../packages/core/src/git/git-utils.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEventBus(): TypedEventBus {
  const emitter = new EventEmitter()
  return {
    emit: vi.fn((event: string, payload: unknown) => emitter.emit(event, payload)),
    on: vi.fn((event: string, handler: (payload: unknown) => void) =>
      emitter.on(event, handler),
    ),
    off: vi.fn((event: string, handler: (payload: unknown) => void) =>
      emitter.off(event, handler),
    ),
  } as unknown as TypedEventBus
}

function createMockDb(): LegacyDbLike {
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
    db,
  }
}

const PROJECT_ROOT = '/home/user/myproject'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitWorktreeManagerImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // AC5: verifyGitVersion
  // -------------------------------------------------------------------------

  describe('AC5: verifyGitVersion()', () => {
    it('calls gitUtils.verifyGitVersion and resolves when git is valid', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await expect(manager.verifyGitVersion()).resolves.toBeUndefined()
      expect(gitUtils.verifyGitVersion).toHaveBeenCalledOnce()
    })

    it('throws with context when git verification fails', async () => {
      vi.mocked(gitUtils.verifyGitVersion).mockRejectedValueOnce(
        new Error('git is not installed'),
      )

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await expect(manager.verifyGitVersion()).rejects.toThrow('GitWorktreeManager: git version check failed')
    })
  })

  // -------------------------------------------------------------------------
  // AC6: getWorktreePath
  // -------------------------------------------------------------------------

  describe('AC6: getWorktreePath()', () => {
    it('returns correct path for given taskId', () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const taskId = 'abc123'
      const result = manager.getWorktreePath(taskId)

      expect(result).toBe(path.join(PROJECT_ROOT, '.substrate-worktrees', taskId))
    })

    it('returns path relative to project root', () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const result = manager.getWorktreePath('my-task')
      expect(result).toContain(PROJECT_ROOT)
    })

    it('uses custom baseDirectory when provided', () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT, '.custom-worktrees')

      const result = manager.getWorktreePath('task-x')
      expect(result).toBe(path.join(PROJECT_ROOT, '.custom-worktrees', 'task-x'))
    })

    it('uses path.join for cross-platform compatibility', () => {
      const eventBus = createMockEventBus()
      // Test with different path separators — path.join handles them
      const manager = new GitWorktreeManagerImpl(eventBus, '/project/root')
      const result = manager.getWorktreePath('task-1')
      // path.join returns OS-appropriate separators
      expect(result).toBe(path.join('/project/root', '.substrate-worktrees', 'task-1'))
    })
  })

  // -------------------------------------------------------------------------
  // AC1: createWorktree
  // -------------------------------------------------------------------------

  describe('AC1: createWorktree()', () => {
    it('creates worktree with correct branch name and path', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const result = await manager.createWorktree('task-abc')

      expect(result.taskId).toBe('task-abc')
      expect(result.branchName).toBe('substrate/story-task-abc')
      expect(result.worktreePath).toBe(
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-abc'),
      )
      expect(result.createdAt).toBeInstanceOf(Date)
    })

    it('uses "main" as default base branch', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.createWorktree('task-abc')

      expect(gitUtils.createWorktree).toHaveBeenCalledWith(
        PROJECT_ROOT,
        'task-abc',
        'substrate/story-task-abc',
        'main',
        // v0.20.109: copyFiles defaults to empty; H1.1 always appends the
        // project profile so worktree consumers see the real stack.
        ['.substrate/project-profile.yaml'],
      )
    })

    it('uses provided base branch', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.createWorktree('task-xyz', 'develop')

      expect(gitUtils.createWorktree).toHaveBeenCalledWith(
        PROJECT_ROOT,
        'task-xyz',
        'substrate/story-task-xyz',
        'develop',
        ['.substrate/project-profile.yaml'], // H1.1: profile always appended
      )
    })

    it('v0.20.109: forwards copyFiles config to gitUtils.createWorktree', async () => {
      const eventBus = createMockEventBus()
      const copyFiles = ['.env', '.env.local']
      const manager = new GitWorktreeManagerImpl(
        eventBus,
        PROJECT_ROOT,
        '.substrate-worktrees',
        null,
        undefined,
        copyFiles,
      )

      await manager.createWorktree('task-with-env')

      expect(gitUtils.createWorktree).toHaveBeenCalledWith(
        PROJECT_ROOT,
        'task-with-env',
        'substrate/story-task-with-env',
        'main',
        [...copyFiles, '.substrate/project-profile.yaml'], // H1.1: profile appended after configured files
      )
    })

    it('v0.20.109: createGitWorktreeManager threads copyFiles through factory', async () => {
      const { createGitWorktreeManager } = await import('../git-worktree-manager-impl.js')
      const eventBus = createMockEventBus()
      const copyFiles = ['.env.test']
      const manager = createGitWorktreeManager({ eventBus, projectRoot: PROJECT_ROOT, copyFiles })

      await manager.createWorktree('task-factory')

      expect(gitUtils.createWorktree).toHaveBeenCalledWith(
        PROJECT_ROOT,
        'task-factory',
        'substrate/story-task-factory',
        'main',
        [...copyFiles, '.substrate/project-profile.yaml'], // H1.1: profile appended
      )
    })

    it('emits worktree:created event with correct payload', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.createWorktree('task-abc')

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const createdCall = calls.find(([event]) => event === 'worktree:created')

      expect(createdCall).toBeDefined()
      expect(createdCall![1]).toMatchObject({
        taskId: 'task-abc',
        branchName: 'substrate/story-task-abc',
        worktreePath: path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-abc'),
      })
    })

    it('throws if taskId is empty', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await expect(manager.createWorktree('')).rejects.toThrow(
        'createWorktree: taskId must be a non-empty string',
      )
    })

    it('throws if taskId is whitespace only', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await expect(manager.createWorktree('   ')).rejects.toThrow()
    })

    it('does not update Task record when DB is provided (task-graph tracking removed)', async () => {
      const eventBus = createMockEventBus()
      const db = createMockDb()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT, '.substrate-worktrees', db)

      await manager.createWorktree('task-db')

      // Task record tracking was removed — DB should NOT be called
      const dbPrepare = db.db.prepare as ReturnType<typeof vi.fn>
      expect(dbPrepare).not.toHaveBeenCalled()
    })

    it('proceeds without error even if DB update fails', async () => {
      const eventBus = createMockEventBus()
      const db = createMockDb()
      // Make DB prepare throw
      ;(db.db.prepare as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('DB error')
      })
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT, '.substrate-worktrees', db)

      // Should not throw — DB update failure is logged as warning
      await expect(manager.createWorktree('task-db-fail')).resolves.toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Worktree path pattern
  // -------------------------------------------------------------------------

  describe('AC2: Worktree path follows expected pattern', () => {
    it('worktree path is {projectRoot}/.substrate-worktrees/{taskId}', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const result = await manager.createWorktree('my-task-id')

      expect(result.worktreePath).toBe(
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'my-task-id'),
      )
    })
  })

  // -------------------------------------------------------------------------
  // H0.3: dirty-guard on removal (field findings #17/#19)
  // -------------------------------------------------------------------------

  describe('H0.3: cleanupWorktree() dirty-guard', () => {
    it('refuses removal when the safety inspection reports unsafe, with named reasons', async () => {
      vi.mocked(gitUtils.inspectWorktreeRemovalSafety).mockResolvedValueOnce({
        safe: false,
        reasons: ['the worktree has 3 uncommitted change(s) that removal would destroy: a.py, b.py, c.py'],
      })
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await expect(manager.cleanupWorktree('task-dirty')).rejects.toThrow(/uncommitted change/)
      expect(gitUtils.removeWorktree).not.toHaveBeenCalled()
      expect(gitUtils.removeBranch).not.toHaveBeenCalled()
    })

    it('force: true skips the safety inspection and removes', async () => {
      vi.mocked(fsp.access).mockResolvedValueOnce(undefined)
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.cleanupWorktree('task-dirty', { force: true })

      expect(gitUtils.inspectWorktreeRemovalSafety).not.toHaveBeenCalled()
      expect(gitUtils.removeWorktree).toHaveBeenCalled()
      expect(gitUtils.removeBranch).toHaveBeenCalled()
    })

    it('protects unmerged branch commits (wip checkpoints) even when the worktree is clean', async () => {
      vi.mocked(gitUtils.inspectWorktreeRemovalSafety).mockResolvedValueOnce({
        safe: false,
        reasons: ['branch substrate/story-task-wip carries 2 commit(s) not reachable from the current HEAD — deleting the branch would destroy them'],
      })
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await expect(manager.cleanupWorktree('task-wip')).rejects.toThrow(/not reachable from the current HEAD/)
      expect(gitUtils.removeBranch).not.toHaveBeenCalled()
    })

    it('cleanupAllWorktrees skips unsafe orphans and cleans the safe ones', async () => {
      vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValueOnce([
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'orphan-safe'),
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'orphan-dirty'),
      ])
      vi.mocked(gitUtils.inspectWorktreeRemovalSafety)
        .mockResolvedValueOnce({ safe: true, reasons: [] })
        .mockResolvedValueOnce({ safe: false, reasons: ['the worktree has 1 uncommitted change(s) that removal would destroy: x.py'] })
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const cleaned = await manager.cleanupAllWorktrees()

      expect(cleaned).toBe(1)
      expect(gitUtils.removeWorktree).toHaveBeenCalledTimes(1)
      expect(gitUtils.removeWorktree).toHaveBeenCalledWith(
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'orphan-safe'),
        PROJECT_ROOT,
      )
    })

    it('cleanupAllWorktrees with force removes everything without inspection', async () => {
      vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValueOnce([
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'orphan-a'),
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'orphan-b'),
      ])
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const cleaned = await manager.cleanupAllWorktrees({ force: true })

      expect(cleaned).toBe(2)
      expect(gitUtils.inspectWorktreeRemovalSafety).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // AC3: cleanupWorktree
  // -------------------------------------------------------------------------

  describe('AC3: cleanupWorktree()', () => {
    it('calls removeWorktree with correct path', async () => {
      // Simulate worktree directory existing so the idempotency guard passes
      vi.mocked(fsp.access).mockResolvedValueOnce(undefined)

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.cleanupWorktree('task-cleanup')

      expect(gitUtils.removeWorktree).toHaveBeenCalledWith(
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-cleanup'),
        PROJECT_ROOT,
      )
    })

    it('calls removeBranch with correct branch name (git branch -D)', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.cleanupWorktree('task-cleanup')

      expect(gitUtils.removeBranch).toHaveBeenCalledWith(
        'substrate/story-task-cleanup',
        PROJECT_ROOT,
      )
    })

    it('emits worktree:removed event with taskId and branchName', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.cleanupWorktree('task-done')

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const removedCall = calls.find(([event]) => event === 'worktree:removed')

      expect(removedCall).toBeDefined()
      expect(removedCall![1]).toMatchObject({
        taskId: 'task-done',
        branchName: 'substrate/story-task-done',
      })
    })

    it('does not throw even if removeWorktree fails', async () => {
      // Simulate worktree directory existing so removeWorktree is attempted
      vi.mocked(fsp.access).mockResolvedValueOnce(undefined)
      vi.mocked(gitUtils.removeWorktree).mockRejectedValueOnce(new Error('remove failed'))
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      // Should not throw
      await expect(manager.cleanupWorktree('task-fail')).resolves.toBeUndefined()
    })

    it('still emits worktree:removed even if removeWorktree fails', async () => {
      // Simulate worktree directory existing so removeWorktree is attempted
      vi.mocked(fsp.access).mockResolvedValueOnce(undefined)
      vi.mocked(gitUtils.removeWorktree).mockRejectedValueOnce(new Error('remove failed'))
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.cleanupWorktree('task-fail')

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const removedCall = calls.find(([event]) => event === 'worktree:removed')
      expect(removedCall).toBeDefined()
    })

    it('does not update task record when DB is provided (task-graph tracking removed)', async () => {
      const eventBus = createMockEventBus()
      const db = createMockDb()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT, '.substrate-worktrees', db)

      await manager.cleanupWorktree('task-db-cleanup')

      // Task record tracking was removed — DB should NOT be called
      const dbPrepare = db.db.prepare as ReturnType<typeof vi.fn>
      expect(dbPrepare).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // AC4: cleanupAllWorktrees
  // -------------------------------------------------------------------------

  describe('AC4: cleanupAllWorktrees()', () => {
    it('returns 0 when no orphaned worktrees exist', async () => {
      vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValueOnce([])

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const count = await manager.cleanupAllWorktrees()
      expect(count).toBe(0)
    })

    it('cleans up orphaned worktrees and returns correct count', async () => {
      const orphanedPaths = [
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-old-1'),
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-old-2'),
      ]
      vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValueOnce(orphanedPaths)

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const count = await manager.cleanupAllWorktrees()
      expect(count).toBe(2)
    })

    it('calls removeWorktree for each orphaned worktree', async () => {
      const orphanedPaths = [
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-orphan-1'),
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-orphan-2'),
      ]
      vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValueOnce(orphanedPaths)

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.cleanupAllWorktrees()

      expect(gitUtils.removeWorktree).toHaveBeenCalledTimes(2)
    })

    it('calls removeBranch for each orphaned worktree', async () => {
      const orphanedPaths = [
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-orphan-1'),
      ]
      vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValueOnce(orphanedPaths)

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.cleanupAllWorktrees()

      expect(gitUtils.removeBranch).toHaveBeenCalledWith(
        'substrate/story-task-orphan-1',
        PROJECT_ROOT,
      )
    })

    it('cleans up all orphaned worktrees regardless of DB (task status check removed)', async () => {
      const orphanedPaths = [
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-running'),
      ]
      vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValueOnce(orphanedPaths)

      const eventBus = createMockEventBus()
      const db = createMockDb()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT, '.substrate-worktrees', db)

      const count = await manager.cleanupAllWorktrees()

      // Task status check was removed — all orphaned worktrees are cleaned up
      expect(count).toBe(1)
      expect(gitUtils.removeWorktree).toHaveBeenCalledOnce()
    })

    it('removes worktrees for non-running tasks when DB is provided', async () => {
      const orphanedPaths = [
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-completed'),
      ]
      vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValueOnce(orphanedPaths)

      const eventBus = createMockEventBus()
      const db = createMockDb()
      // Mock DB to return a completed task
      ;(db.db.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn(() => ({ id: 'task-completed', status: 'completed' })),
        all: vi.fn(() => []),
        run: vi.fn(() => ({ changes: 1 })),
      })
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT, '.substrate-worktrees', db)

      const count = await manager.cleanupAllWorktrees()

      expect(count).toBe(1)
      expect(gitUtils.removeWorktree).toHaveBeenCalledOnce()
    })

    it('continues cleaning other worktrees if one fails', async () => {
      const orphanedPaths = [
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-fail'),
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-ok'),
      ]
      vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValueOnce(orphanedPaths)
      vi.mocked(gitUtils.removeWorktree)
        .mockRejectedValueOnce(new Error('remove failed'))
        .mockResolvedValueOnce(undefined)

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      // First worktree removal fails; second succeeds. Only successful removals are counted.
      const count = await manager.cleanupAllWorktrees()
      expect(count).toBe(1) // Only the successful removal is counted
    })
  })

  // -------------------------------------------------------------------------
  // Lifecycle: initialize() and shutdown()
  // -------------------------------------------------------------------------

  describe('initialize() and shutdown()', () => {
    it('verifies git version on initialize', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.initialize()

      expect(gitUtils.verifyGitVersion).toHaveBeenCalledOnce()
    })

    it('calls cleanupAllWorktrees on initialize', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)
      const cleanupSpy = vi.spyOn(manager, 'cleanupAllWorktrees')

      await manager.initialize()

      expect(cleanupSpy).toHaveBeenCalledOnce()
    })

    it('subscribes to task:ready, task:complete, task:failed on initialize', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.initialize()

      const onMock = eventBus.on as ReturnType<typeof vi.fn>
      const events = onMock.mock.calls.map(([event]: [string]) => event) as string[]

      expect(events).toContain('task:ready')
      expect(events).toContain('task:complete')
      expect(events).toContain('task:failed')
    })

    it('unsubscribes from events on shutdown', async () => {
      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.initialize()
      await manager.shutdown()

      const offMock = eventBus.off as ReturnType<typeof vi.fn>
      const events = offMock.mock.calls.map(([event]: [string]) => event) as string[]

      expect(events).toContain('task:ready')
      expect(events).toContain('task:complete')
      expect(events).toContain('task:failed')
    })

    it('throws if git version check fails during initialize', async () => {
      vi.mocked(gitUtils.verifyGitVersion).mockRejectedValueOnce(
        new Error('git not found'),
      )

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await expect(manager.initialize()).rejects.toThrow()
    })

    it('creates worktree when task:ready event fires after initialize', async () => {
      const eventBus = createMockEventBus()
      // Need real EventEmitter for this test
      const realEmitter = new EventEmitter()
      const realEventBus: TypedEventBus = {
        emit: vi.fn((event: string, payload: unknown) => realEmitter.emit(event, payload)),
        on: vi.fn((event: string, handler: (payload: unknown) => void) =>
          realEmitter.on(event, handler),
        ),
        off: vi.fn((event: string, handler: (payload: unknown) => void) =>
          realEmitter.off(event, handler),
        ),
      } as unknown as TypedEventBus

      const manager = new GitWorktreeManagerImpl(realEventBus, PROJECT_ROOT)
      const createWorktreeSpy = vi.spyOn(manager, 'createWorktree')

      await manager.initialize()

      // Simulate task:ready event
      realEmitter.emit('task:ready', { taskId: 'test-task' })

      // Since createWorktree is async, give it a tick
      await Promise.resolve()
      await Promise.resolve()

      expect(createWorktreeSpy).toHaveBeenCalledWith('test-task')
    })
  })
})

// ---------------------------------------------------------------------------
// git-utils unit tests
// ---------------------------------------------------------------------------

describe('git-utils helpers (unit)', () => {
  describe('parseGitVersion', () => {
    it('parses "2.42.0" correctly', async () => {
      const { parseGitVersion } = await import('../git-utils.js')
      const result = parseGitVersion('2.42.0')
      expect(result).toEqual({ major: 2, minor: 42, patch: 0 })
    })

    it('parses "2.20" (no patch) correctly', async () => {
      const { parseGitVersion } = await import('../git-utils.js')
      const result = parseGitVersion('2.20')
      expect(result).toEqual({ major: 2, minor: 20, patch: 0 })
    })

    it('parses "1.9.5" correctly', async () => {
      const { parseGitVersion } = await import('../git-utils.js')
      const result = parseGitVersion('1.9.5')
      expect(result).toEqual({ major: 1, minor: 9, patch: 5 })
    })
  })

  describe('isGitVersionSupported', () => {
    it('returns true for git 2.20.0', async () => {
      const { isGitVersionSupported } = await import('../git-utils.js')
      expect(isGitVersionSupported('2.20.0')).toBe(true)
    })

    it('returns true for git 2.42.0', async () => {
      const { isGitVersionSupported } = await import('../git-utils.js')
      expect(isGitVersionSupported('2.42.0')).toBe(true)
    })

    it('returns true for git 3.0.0', async () => {
      const { isGitVersionSupported } = await import('../git-utils.js')
      expect(isGitVersionSupported('3.0.0')).toBe(true)
    })

    it('returns false for git 2.19.9', async () => {
      const { isGitVersionSupported } = await import('../git-utils.js')
      expect(isGitVersionSupported('2.19.9')).toBe(false)
    })

    it('returns false for git 1.9.5', async () => {
      const { isGitVersionSupported } = await import('../git-utils.js')
      expect(isGitVersionSupported('1.9.5')).toBe(false)
    })

    it('returns false for git 2.0.0', async () => {
      const { isGitVersionSupported } = await import('../git-utils.js')
      expect(isGitVersionSupported('2.0.0')).toBe(false)
    })
  })
})
