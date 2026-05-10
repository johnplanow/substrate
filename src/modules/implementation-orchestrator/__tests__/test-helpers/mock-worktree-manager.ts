/**
 * Test helper: createMockWorktreeManager
 *
 * Returns a vi.fn()-based stub satisfying the GitWorktreeManager interface
 * for use in orchestrator unit tests and in stories 75-1, 75-2, 75-3.
 *
 * Defaults:
 *  - createWorktree resolves with a synthetic WorktreeInfo whose worktreePath
 *    is `/tmp/mock-worktrees/story-${taskId}` (tests can assert on this value
 *    without touching the real filesystem).
 *  - cleanupWorktree resolves void (idempotent no-op).
 *  - All other methods return safe empty/default values.
 *
 * Usage:
 *   const mgr = createMockWorktreeManager()
 *   expect(mgr.createWorktree).toHaveBeenCalledWith('75-1')
 *   expect(mgr.cleanupWorktree).toHaveBeenCalled()
 */

import { vi } from 'vitest'
import type {
  GitWorktreeManager,
  WorktreeInfo,
  ConflictReport,
  MergeResult,
} from '../../../git-worktree/git-worktree-manager.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MockWorktreeManagerOpts {
  /**
   * Override the worktree path returned by createWorktree / getWorktreePath.
   * When omitted, defaults to `/tmp/mock-worktrees/story-<taskId>`.
   */
  worktreePath?: string | ((taskId: string) => string)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a mock GitWorktreeManager stub suitable for unit tests.
 *
 * The returned object uses vi.fn() for every method so callers can assert
 * with `expect(mgr.createWorktree).toHaveBeenCalledWith(...)` etc.
 */
export function createMockWorktreeManager(
  opts: MockWorktreeManagerOpts = {},
): GitWorktreeManager {
  /**
   * Resolve the synthetic worktree path for a given taskId.
   * Used by both createWorktree and getWorktreePath so they return
   * consistent values, enabling tests to cross-reference the path.
   */
  function resolveWorktreePath(taskId: string): string {
    if (typeof opts.worktreePath === 'function') {
      return opts.worktreePath(taskId)
    }
    if (typeof opts.worktreePath === 'string') {
      return opts.worktreePath
    }
    return `/tmp/mock-worktrees/story-${taskId}`
  }

  return {
    // IBaseService lifecycle — GitWorktreeManager extends IBaseService (packages/core/src/types.ts)
    // which declares initialize(): Promise<void> and shutdown(): Promise<void>.
    // These stubs satisfy the full interface contract so TypeScript accepts the mock
    // as a GitWorktreeManager wherever one is required by type.
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),

    // Worktree creation — resolves with a synthetic WorktreeInfo
    createWorktree: vi.fn().mockImplementation(
      (taskId: string, _baseBranch?: string): Promise<WorktreeInfo> =>
        Promise.resolve({
          taskId,
          branchName: `substrate/task-${taskId}`,
          worktreePath: resolveWorktreePath(taskId),
          createdAt: new Date(),
        }),
    ),

    // Worktree removal — idempotent no-op
    cleanupWorktree: vi.fn().mockResolvedValue(undefined),

    // Bulk cleanup — returns 0 (no orphans removed)
    cleanupAllWorktrees: vi.fn().mockResolvedValue(0),

    // Synchronous path getter — consistent with createWorktree
    getWorktreePath: vi.fn().mockImplementation(
      (taskId: string): string => resolveWorktreePath(taskId),
    ),

    // Git version check — always passes
    verifyGitVersion: vi.fn().mockResolvedValue(undefined),

    // Conflict detection — no conflicts by default
    detectConflicts: vi.fn().mockImplementation(
      (taskId: string, targetBranch = 'main'): Promise<ConflictReport> =>
        Promise.resolve({
          hasConflicts: false,
          conflictingFiles: [],
          taskId,
          targetBranch,
        }),
    ),

    // Merge — succeeds with no files by default
    mergeWorktree: vi.fn().mockImplementation(
      (_taskId: string, _targetBranch?: string): Promise<MergeResult> =>
        Promise.resolve({
          success: true,
          mergedFiles: [],
        }),
    ),

    // List — no tracked worktrees by default
    listWorktrees: vi.fn().mockResolvedValue([]),
  }
}
