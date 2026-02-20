/**
 * Integration tests for Story 3.2: Conflict Detection & Merge Operations
 *
 * Tests cover:
 *  - Full flow: Conflict Detection → Merge (no real git, mocked git-utils)
 *  - Scenario 1: No conflicts, merge succeeds
 *  - Scenario 2: Merge conflicts detected, reported to user
 *  - Scenario 3: Multiple tasks, mixed conflicts and successes
 *  - CLI integration: mergeTask() and mergeAll() exported functions
 *
 * All git operations are mocked via git-utils to avoid requiring a real git repo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { TypedEventBus } from '../../core/event-bus.js'
import { GitWorktreeManagerImpl } from '../../modules/git-worktree/git-worktree-manager-impl.js'
import { mergeTask, mergeAll, MERGE_EXIT_SUCCESS, MERGE_EXIT_CONFLICT, MERGE_EXIT_ERROR } from '../../cli/commands/merge.js'

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    access: vi.fn(async () => undefined), // Default: worktree exists
  }
})

import * as fsp from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Mock git-utils
// ---------------------------------------------------------------------------

vi.mock(import('../../modules/git-worktree/git-utils.js'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    verifyGitVersion: vi.fn(async () => {}),
    createWorktree: vi.fn(async () => ({ worktreePath: '/tmp/worktree' })),
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

function createMockEventBus(): TypedEventBus {
  const emitter = new EventEmitter()
  return {
    emit: vi.fn((event: string, payload: unknown) => emitter.emit(event, payload)),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => emitter.on(event, handler)),
    off: vi.fn((event: string, handler: (payload: unknown) => void) => emitter.off(event, handler)),
  } as unknown as TypedEventBus
}

const PROJECT_ROOT = '/home/user/testproject'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Merge Integration — GitWorktreeManagerImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fsp.access).mockResolvedValue(undefined)
    vi.mocked(gitUtils.simulateMerge).mockResolvedValue(true)
    vi.mocked(gitUtils.getConflictingFiles).mockResolvedValue([])
    vi.mocked(gitUtils.abortMerge).mockResolvedValue(undefined)
    vi.mocked(gitUtils.performMerge).mockResolvedValue(true)
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValue([])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Scenario 1: No conflicts, merge succeeds
  // -------------------------------------------------------------------------

  describe('Scenario 1: No conflicts — merge succeeds', () => {
    it('detectConflicts returns clean report', async () => {
      vi.mocked(gitUtils.simulateMerge).mockResolvedValue(true)

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const report = await manager.detectConflicts('task-1', 'main')

      expect(report.hasConflicts).toBe(false)
      expect(report.conflictingFiles).toHaveLength(0)
      expect(report.taskId).toBe('task-1')
    })

    it('mergeWorktree succeeds and returns file list', async () => {
      vi.mocked(gitUtils.simulateMerge).mockResolvedValue(true)
      vi.mocked(gitUtils.getMergedFiles).mockResolvedValue(['src/feature.ts', 'tests/feature.test.ts'])

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const result = await manager.mergeWorktree('task-1', 'main')

      expect(result.success).toBe(true)
      expect(result.mergedFiles).toEqual(['src/feature.ts', 'tests/feature.test.ts'])
    })

    it('emits worktree:merged event on successful merge', async () => {
      vi.mocked(gitUtils.simulateMerge).mockResolvedValue(true)
      vi.mocked(gitUtils.getMergedFiles).mockResolvedValue(['src/feature.ts'])

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.mergeWorktree('task-1', 'main')

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const mergedCall = calls.find(([event]) => event === 'worktree:merged')

      expect(mergedCall).toBeDefined()
      expect((mergedCall![1] as Record<string, unknown>).taskId).toBe('task-1')
      expect((mergedCall![1] as Record<string, unknown>).mergedFiles).toEqual(['src/feature.ts'])
    })
  })

  // -------------------------------------------------------------------------
  // Scenario 2: Merge conflicts detected, reported to user
  // -------------------------------------------------------------------------

  describe('Scenario 2: Merge conflicts — reported without auto-resolution', () => {
    it('detectConflicts returns conflict report with files', async () => {
      vi.mocked(gitUtils.simulateMerge).mockResolvedValue(false)
      vi.mocked(gitUtils.getConflictingFiles).mockResolvedValue([
        'src/shared/utils.ts',
        'src/config.ts',
      ])

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const report = await manager.detectConflicts('task-2', 'main')

      expect(report.hasConflicts).toBe(true)
      expect(report.conflictingFiles).toEqual(['src/shared/utils.ts', 'src/config.ts'])
    })

    it('mergeWorktree returns failure with conflict details', async () => {
      vi.mocked(gitUtils.simulateMerge).mockResolvedValue(false)
      vi.mocked(gitUtils.getConflictingFiles).mockResolvedValue(['src/api.ts'])

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      const result = await manager.mergeWorktree('task-2', 'main')

      expect(result.success).toBe(false)
      expect(result.conflicts).toBeDefined()
      expect(result.conflicts!.conflictingFiles).toEqual(['src/api.ts'])
    })

    it('does not auto-resolve conflicts (performMerge not called)', async () => {
      vi.mocked(gitUtils.simulateMerge).mockResolvedValue(false)
      vi.mocked(gitUtils.getConflictingFiles).mockResolvedValue(['src/main.ts'])

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.mergeWorktree('task-2', 'main')

      expect(gitUtils.performMerge).not.toHaveBeenCalled()
    })

    it('emits worktree:conflict event', async () => {
      vi.mocked(gitUtils.simulateMerge).mockResolvedValue(false)
      vi.mocked(gitUtils.getConflictingFiles).mockResolvedValue(['README.md'])

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      await manager.mergeWorktree('task-2', 'main')

      const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
      const calls = emitMock.mock.calls as Array<[string, unknown]>
      const conflictCalls = calls.filter(([event]) => event === 'worktree:conflict')

      expect(conflictCalls).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // Scenario 3: Multiple tasks, mixed conflicts and successes
  // -------------------------------------------------------------------------

  describe('Scenario 3: Multiple tasks — mixed results', () => {
    it('handles multiple tasks independently', async () => {
      // task-a: clean merge
      // task-b: conflict
      // task-c: clean merge

      const eventBus = createMockEventBus()
      const manager = new GitWorktreeManagerImpl(eventBus, PROJECT_ROOT)

      // Setup: task-a is clean
      vi.mocked(gitUtils.simulateMerge).mockResolvedValueOnce(true)
      vi.mocked(gitUtils.getMergedFiles).mockResolvedValueOnce(['a.ts'])

      // task-b has conflicts
      vi.mocked(gitUtils.simulateMerge).mockResolvedValueOnce(false)
      vi.mocked(gitUtils.getConflictingFiles).mockResolvedValueOnce(['shared.ts'])

      // task-c is clean
      vi.mocked(gitUtils.simulateMerge).mockResolvedValueOnce(true)
      vi.mocked(gitUtils.getMergedFiles).mockResolvedValueOnce(['c.ts'])

      const resultA = await manager.mergeWorktree('task-a', 'main')
      const resultB = await manager.mergeWorktree('task-b', 'main')
      const resultC = await manager.mergeWorktree('task-c', 'main')

      expect(resultA.success).toBe(true)
      expect(resultB.success).toBe(false)
      expect(resultC.success).toBe(true)

      expect(resultA.mergedFiles).toEqual(['a.ts'])
      expect(resultB.conflicts!.conflictingFiles).toEqual(['shared.ts'])
      expect(resultC.mergedFiles).toEqual(['c.ts'])
    })
  })
})

// ---------------------------------------------------------------------------
// CLI Integration: mergeTask() and mergeAll()
// ---------------------------------------------------------------------------

describe('CLI Integration — mergeTask()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fsp.access).mockResolvedValue(undefined)
    vi.mocked(gitUtils.simulateMerge).mockResolvedValue(true)
    vi.mocked(gitUtils.getConflictingFiles).mockResolvedValue([])
    vi.mocked(gitUtils.abortMerge).mockResolvedValue(undefined)
    vi.mocked(gitUtils.performMerge).mockResolvedValue(true)
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValue([])
    vi.mocked(gitUtils.verifyGitVersion).mockResolvedValue(undefined)
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([])
  })

  it('returns MERGE_EXIT_SUCCESS when merge is clean', async () => {
    vi.mocked(gitUtils.simulateMerge).mockResolvedValue(true)
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValue(['src/feature.ts'])

    const exitCode = await mergeTask('task-clean', 'main', PROJECT_ROOT)

    expect(exitCode).toBe(MERGE_EXIT_SUCCESS)
  })

  it('returns MERGE_EXIT_CONFLICT when conflicts are detected', async () => {
    vi.mocked(gitUtils.simulateMerge).mockResolvedValue(false)
    vi.mocked(gitUtils.getConflictingFiles).mockResolvedValue(['src/conflict.ts'])

    const exitCode = await mergeTask('task-conflict', 'main', PROJECT_ROOT)

    expect(exitCode).toBe(MERGE_EXIT_CONFLICT)
  })

  it('returns MERGE_EXIT_ERROR when worktree is missing', async () => {
    vi.mocked(fsp.access).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    )

    const exitCode = await mergeTask('missing-task', 'main', PROJECT_ROOT)

    expect(exitCode).toBe(MERGE_EXIT_ERROR)
  })
})

describe('CLI Integration — mergeAll()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fsp.access).mockResolvedValue(undefined)
    vi.mocked(gitUtils.simulateMerge).mockResolvedValue(true)
    vi.mocked(gitUtils.getConflictingFiles).mockResolvedValue([])
    vi.mocked(gitUtils.abortMerge).mockResolvedValue(undefined)
    vi.mocked(gitUtils.performMerge).mockResolvedValue(true)
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValue([])
    vi.mocked(gitUtils.verifyGitVersion).mockResolvedValue(undefined)
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([])
  })

  it('returns MERGE_EXIT_SUCCESS with empty task list', async () => {
    const exitCode = await mergeAll('main', PROJECT_ROOT, [])

    expect(exitCode).toBe(MERGE_EXIT_SUCCESS)
  })

  it('returns MERGE_EXIT_SUCCESS when all tasks merge cleanly', async () => {
    vi.mocked(gitUtils.simulateMerge).mockResolvedValue(true)
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValue(['file.ts'])

    const exitCode = await mergeAll('main', PROJECT_ROOT, ['task-1', 'task-2'])

    expect(exitCode).toBe(MERGE_EXIT_SUCCESS)
  })

  it('returns MERGE_EXIT_CONFLICT when any task has conflicts', async () => {
    // task-1 is clean, task-2 has conflicts
    vi.mocked(gitUtils.simulateMerge)
      .mockResolvedValueOnce(true)  // task-1 detect
      .mockResolvedValueOnce(false) // task-2 detect

    vi.mocked(gitUtils.getConflictingFiles).mockResolvedValue(['conflict.ts'])

    const exitCode = await mergeAll('main', PROJECT_ROOT, ['task-1', 'task-2'])

    expect(exitCode).toBe(MERGE_EXIT_CONFLICT)
  })

  it('processes all tasks and aggregates results', async () => {
    // 3 tasks: clean, conflict, clean
    vi.mocked(gitUtils.simulateMerge)
      .mockResolvedValueOnce(true)   // task-1
      .mockResolvedValueOnce(false)  // task-2 has conflict
      .mockResolvedValueOnce(true)   // task-3

    vi.mocked(gitUtils.getConflictingFiles).mockResolvedValue(['conflict.ts'])
    vi.mocked(gitUtils.getMergedFiles).mockResolvedValue(['merged.ts'])

    const exitCode = await mergeAll('main', PROJECT_ROOT, ['task-1', 'task-2', 'task-3'])

    // Since task-2 has conflicts, exit code should be 1
    expect(exitCode).toBe(MERGE_EXIT_CONFLICT)
  })
})
