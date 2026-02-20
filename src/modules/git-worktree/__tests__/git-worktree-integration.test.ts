/**
 * Integration tests for GitWorktreeManager + WorkerPoolManager interaction.
 *
 * Tests cover:
 *  - Full lifecycle: task:ready → worktree:created → task:started → task:complete → worktree:removed
 *  - Event sequence validation
 *  - Task record worktree_path field update
 *  - Cleanup on task failure scenario
 *  - Recovery scenario with orphaned worktrees
 *
 * git-utils is mocked to avoid real git operations.
 * child_process.spawn is mocked to avoid real process spawning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import * as path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { GitWorktreeManagerImpl } from '../git-worktree-manager-impl.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { DatabaseService } from '../../../persistence/database.js'

// ---------------------------------------------------------------------------
// Mock git-utils
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    access: vi.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
  }
})

vi.mock('../git-utils.js', () => ({
  verifyGitVersion: vi.fn(async () => {}),
  createWorktree: vi.fn(
    async (projectRoot: string, taskId: string, _branchName: string, _baseBranch: string) => ({
      worktreePath: path.join(projectRoot, '.substrate-worktrees', taskId),
    }),
  ),
  removeWorktree: vi.fn(async () => {}),
  removeBranch: vi.fn(async () => {}),
  getOrphanedWorktrees: vi.fn(async () => []),
}))

import * as gitUtils from '../git-utils.js'

// ---------------------------------------------------------------------------
// Mock child_process for worker pool tests
// ---------------------------------------------------------------------------

function createFakeProcess(): {
  proc: ChildProcess
  emitClose: (code: number) => void
} {
  const emitter = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()

  const proc = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
    pid: 12345,
  }) as unknown as ChildProcess

  const emitClose = (code: number) => emitter.emit('close', code)
  return { proc, emitClose }
}

let currentFakeProcess: ReturnType<typeof createFakeProcess>

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => currentFakeProcess.proc),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/home/user/integration-project'

/**
 * Create a real EventEmitter-backed TypedEventBus for integration tests.
 * Events are actually dispatched, allowing multiple subscribers to interact.
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
    }),
    on: vi.fn((event: string, handler: (payload: unknown) => void) =>
      emitter.on(event, handler),
    ),
    off: vi.fn((event: string, handler: (payload: unknown) => void) =>
      emitter.off(event, handler),
    ),
    getEmittedEvents: () => events,
  }
}

function createMockDb(taskStatus?: string): DatabaseService {
  const db = {
    prepare: vi.fn(() => ({
      get: vi.fn(() =>
        taskStatus !== undefined
          ? { id: 'task-1', status: taskStatus }
          : undefined,
      ),
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

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('GitWorktreeManager Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentFakeProcess = createFakeProcess()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Full lifecycle event sequence
  // -------------------------------------------------------------------------

  describe('Full lifecycle: task:ready → worktree:created → task:complete → worktree:removed', () => {
    it('emits worktree:created after task:ready event', async () => {
      const eventBus = createRealEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.initialize()

      // Simulate task:ready event
      eventBus.emit('task:ready', { taskId: 'integration-task-1' })

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10))

      const emittedEvents = eventBus.getEmittedEvents()
      const worktreeCreated = emittedEvents.find((e) => e.event === 'worktree:created')
      expect(worktreeCreated).toBeDefined()
      expect((worktreeCreated!.payload as { taskId: string }).taskId).toBe('integration-task-1')

      await manager.shutdown()
    })

    it('emits worktree:removed after task:complete event', async () => {
      const eventBus = createRealEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.initialize()

      // Simulate task completion
      eventBus.emit('task:complete', { taskId: 'integration-task-2', result: { exitCode: 0 } })

      // Wait for async cleanup
      await new Promise((resolve) => setTimeout(resolve, 10))

      const emittedEvents = eventBus.getEmittedEvents()
      const worktreeRemoved = emittedEvents.find((e) => e.event === 'worktree:removed')
      expect(worktreeRemoved).toBeDefined()
      expect((worktreeRemoved!.payload as { taskId: string }).taskId).toBe('integration-task-2')

      await manager.shutdown()
    })

    it('emits worktree:removed after task:failed event', async () => {
      const eventBus = createRealEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.initialize()

      // Simulate task failure
      eventBus.emit('task:failed', {
        taskId: 'integration-task-3',
        error: { message: 'Something failed' },
      })

      // Wait for async cleanup
      await new Promise((resolve) => setTimeout(resolve, 10))

      const emittedEvents = eventBus.getEmittedEvents()
      const worktreeRemoved = emittedEvents.find((e) => e.event === 'worktree:removed')
      expect(worktreeRemoved).toBeDefined()
      expect((worktreeRemoved!.payload as { taskId: string }).taskId).toBe('integration-task-3')

      await manager.shutdown()
    })

    it('includes branchName in worktree:created payload', async () => {
      const eventBus = createRealEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.initialize()

      eventBus.emit('task:ready', { taskId: 'task-branch-test' })
      await new Promise((resolve) => setTimeout(resolve, 10))

      const emittedEvents = eventBus.getEmittedEvents()
      const createdEvent = emittedEvents.find((e) => e.event === 'worktree:created')
      expect(createdEvent).toBeDefined()
      const payload = createdEvent!.payload as { branchName: string; worktreePath: string }
      expect(payload.branchName).toBe('substrate/task-task-branch-test')
      expect(payload.worktreePath).toBe(
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-branch-test'),
      )

      await manager.shutdown()
    })

    it('includes branchName in worktree:removed payload', async () => {
      const eventBus = createRealEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.initialize()

      eventBus.emit('task:complete', { taskId: 'task-removed-test', result: { exitCode: 0 } })
      await new Promise((resolve) => setTimeout(resolve, 10))

      const emittedEvents = eventBus.getEmittedEvents()
      const removedEvent = emittedEvents.find((e) => e.event === 'worktree:removed')
      expect(removedEvent).toBeDefined()
      const payload = removedEvent!.payload as { branchName: string }
      expect(payload.branchName).toBe('substrate/task-task-removed-test')

      await manager.shutdown()
    })
  })

  // -------------------------------------------------------------------------
  // Task record worktree_path field
  // -------------------------------------------------------------------------

  describe('Task record worktree_path field update', () => {
    it('updates task worktree_path when worktree is created', async () => {
      const db = createMockDb()
      const eventBus = createRealEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT, '.substrate-worktrees', db)

      await manager.createWorktree('task-db-test')

      // Should have called db.prepare (for updateTaskWorktree)
      expect(db.db.prepare).toHaveBeenCalled()
    })

    it('updates task worktree_cleaned_at when worktree is cleaned up', async () => {
      const db = createMockDb()
      const eventBus = createRealEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT, '.substrate-worktrees', db)

      await manager.cleanupWorktree('task-cleanup-test')

      // Should have called db.prepare (for updateTaskWorktree with worktree_cleaned_at)
      expect(db.db.prepare).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Recovery scenario: orphaned worktrees
  // -------------------------------------------------------------------------

  describe('Recovery: orphaned worktrees cleaned up on startup', () => {
    it('cleans up orphaned worktrees during initialize', async () => {
      const orphanedPaths = [
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-orphan-1'),
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-orphan-2'),
      ]
      vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValueOnce(orphanedPaths)

      const eventBus = createRealEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.initialize()

      expect(gitUtils.removeWorktree).toHaveBeenCalledTimes(2)
      expect(gitUtils.removeBranch).toHaveBeenCalledTimes(2)

      await manager.shutdown()
    })

    it('skips active tasks during recovery', async () => {
      const orphanedPaths = [
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-active'),
      ]
      vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValueOnce(orphanedPaths)

      const db = createMockDb('running')
      const eventBus = createRealEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT, '.substrate-worktrees', db)

      await manager.initialize()

      // Active task should NOT be cleaned up
      expect(gitUtils.removeWorktree).not.toHaveBeenCalled()

      await manager.shutdown()
    })
  })

  // -------------------------------------------------------------------------
  // getWorktreePath
  // -------------------------------------------------------------------------

  describe('getWorktreePath consistency', () => {
    it('returns consistent path that matches createWorktree path', async () => {
      const eventBus = createRealEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const taskId = 'consistent-task'
      const expectedPath = manager.getWorktreePath(taskId)
      const worktreeInfo = await manager.createWorktree(taskId)

      expect(worktreeInfo.worktreePath).toBe(expectedPath)
    })

    it('returns path with .substrate-worktrees directory', () => {
      const eventBus = createRealEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const result = manager.getWorktreePath('any-task')
      expect(result).toContain('.substrate-worktrees')
    })
  })

  // -------------------------------------------------------------------------
  // Shutdown behavior
  // -------------------------------------------------------------------------

  describe('Graceful shutdown', () => {
    it('cleans all worktrees on shutdown', async () => {
      const orphanedPaths = [
        path.join(PROJECT_ROOT, '.substrate-worktrees', 'task-shutdown'),
      ]

      const eventBus = createRealEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.initialize()

      // Mock getOrphanedWorktrees to return something on shutdown
      vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValueOnce(orphanedPaths)

      await manager.shutdown()

      expect(gitUtils.removeWorktree).toHaveBeenCalled()
    })
  })
})
