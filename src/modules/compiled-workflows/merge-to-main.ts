/**
 * runMergeToMain — merge-to-main phase handler.
 *
 * Merges a completed story's isolated worktree branch back into the base branch
 * (typically main) after verification SHIP_IT. This closes the branch lifecycle
 * that was opened by the worktree creation phase in Story 75-1.
 *
 * Merge strategy (AC2):
 *  1. Attempt fast-forward merge (`git merge --ff-only <branch>`) — zero-risk path.
 *  2. On FF failure, attempt 3-way merge (`git merge <branch>`) — handles base moved.
 *  3. On conflict, emit `pipeline:merge-conflict-detected`, abort merge, return failure.
 *
 * On success: worktree is cleaned up and the merged branch is deleted (AC4).
 * On conflict: worktree and branch are preserved for operator inspection (AC5).
 *
 * Sequential serialization is enforced by the orchestrator's merge mutex
 * (see orchestrator-impl.ts enqueueMerge) — this function itself is stateless
 * and has no concurrency guard internally (AC7).
 *
 * References:
 *  - Story 75-1: worktree creation phase (creates the branch this handler merges)
 *  - Story 75-2: this file — merge-to-main phase architecture
 *
 * Architecture constraints:
 *  - All imports use .js extension (ESM — project-wide rule)
 *  - GitWorktreeManager imported via @substrate-ai/core (never directly from impl)
 *  - No package additions (AC10)
 */

import { execFileSync } from 'node:child_process'
import type { GitWorktreeManager } from '@substrate-ai/core'
import type { TypedEventBus } from '../../core/event-bus.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('compiled-workflows:merge-to-main')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parameters for the merge-to-main phase handler.
 */
export interface MergeToMainParams {
  /** Story key (e.g., "75-2") */
  storyKey: string
  /** Branch name to merge (e.g., "substrate/story-75-2") */
  branchName: string
  /** Base branch to merge into (captured at orchestrator start, typically "main") */
  startBranch: string
  /** Worktree manager for cleanup on success */
  worktreeManager: GitWorktreeManager
  /** Event bus for emitting pipeline:merge-conflict-detected */
  eventBus: TypedEventBus
  /** Project root (main working tree directory) */
  projectRoot: string
  /**
   * H3.3 (AC2): merge strategy. 'ff-only' (default) refuses to merge when the
   * base branch has moved since the story branched — deterministic, never
   * synthesizes a merge commit. 'three-way' restores the pre-H3.3 fallback
   * (ff, then `git merge --no-edit`), needed for concurrent multi-story runs
   * where later stories cannot fast-forward past earlier merges.
   * Config: `finalization.merge_strategy`.
   */
  mergeStrategy?: 'ff-only' | 'three-way'
}

/**
 * Result from the merge-to-main phase handler.
 */
export interface MergeToMainResult {
  /** Whether the merge succeeded */
  success: boolean
  /** Reason for failure (present only when success is false) */
  reason?: 'merge-conflict-detected' | 'parent-tree-dirtied-by-run' | 'ff-only-merge-not-possible'
  /** Files with unresolved conflicts (present only on merge-conflict-detected) */
  conflictingFiles?: string[]
  /**
   * H3.3 (AC1): files that are BOTH dirty in the parent working tree AND part
   * of the story's diff (present only on parent-tree-dirtied-by-run). Merging
   * over these would entangle unreviewed parent edits with the verified story
   * content — field finding #15's truthful escalation.
   */
  dirtiedFiles?: string[]
}

// ---------------------------------------------------------------------------
// runMergeToMain
// ---------------------------------------------------------------------------

/**
 * Execute the merge-to-main phase: merge the story branch into the base branch.
 *
 * Attempts fast-forward first, falls back to 3-way merge. On conflict:
 * emits `pipeline:merge-conflict-detected` event, aborts the merge, preserves
 * the worktree and branch for operator inspection, and returns a failure result.
 *
 * Merge commands run against `projectRoot` (the main working tree).
 * The main working tree must already be on `startBranch` (checked out at
 * orchestrator startup — no branch switching is performed here).
 *
 * @param params - Merge phase parameters (storyKey, branchName, startBranch,
 *                 worktreeManager, eventBus, projectRoot)
 * @returns MergeToMainResult — success=true on merged; success=false with
 *          reason='merge-conflict-detected' and conflictingFiles on conflict.
 */
export async function runMergeToMain(params: MergeToMainParams): Promise<MergeToMainResult> {
  const { storyKey, branchName, startBranch, worktreeManager, eventBus, projectRoot } = params
  const mergeStrategy = params.mergeStrategy ?? 'ff-only'

  logger.info({ storyKey, branchName, startBranch, mergeStrategy }, 'Starting merge-to-main phase')

  // ---------------------------------------------------------------------------
  // Step 0 (H3.3 AC1): parent-clean precondition. If the parent working tree
  // has uncommitted changes to files the story ALSO touched, a merge would
  // entangle unreviewed parent edits with the verified story content (or git
  // would refuse mid-merge, leaving a messier state). Unrelated parent dirt
  // is fine — only the intersection blocks.
  // ---------------------------------------------------------------------------

  const dirtiedFiles = listParentDirtyIntersection(branchName, startBranch, projectRoot)
  if (dirtiedFiles.length > 0) {
    logger.warn(
      { storyKey, branchName, dirtiedFiles },
      'parent working tree has uncommitted changes to files in the story diff — refusing to merge',
    )
    return { success: false, reason: 'parent-tree-dirtied-by-run', dirtiedFiles }
  }

  // ---------------------------------------------------------------------------
  // Step 1: Attempt fast-forward merge
  // ---------------------------------------------------------------------------

  const ffSuccess = tryFfMerge(branchName, projectRoot)

  if (ffSuccess) {
    logger.info({ storyKey, branchName }, 'Fast-forward merge succeeded')
    await cleanupAfterSuccessfulMerge(storyKey, branchName, worktreeManager, projectRoot)
    return { success: true }
  }

  // H3.3 (AC2): under ff-only (the default), a diverged base is a STOP, not a
  // fallback — an autonomous pipeline must never synthesize a merge commit
  // unless the operator opted in.
  if (mergeStrategy === 'ff-only') {
    logger.warn(
      { storyKey, branchName, startBranch },
      `fast-forward not possible (base moved since the story branched) and merge_strategy is ff-only — refusing 3-way merge. ` +
        `Set finalization.merge_strategy: three-way to allow it (required for concurrent multi-story runs), or integrate the branch manually.`,
    )
    return { success: false, reason: 'ff-only-merge-not-possible' }
  }

  logger.info({ storyKey, branchName }, 'Fast-forward merge failed — attempting 3-way merge')

  // ---------------------------------------------------------------------------
  // Step 2: Attempt 3-way merge
  // ---------------------------------------------------------------------------

  const threeWayResult = tryThreeWayMerge(branchName, projectRoot)

  if (threeWayResult.success) {
    logger.info({ storyKey, branchName }, '3-way merge succeeded')
    await cleanupAfterSuccessfulMerge(storyKey, branchName, worktreeManager, projectRoot)
    return { success: true }
  }

  // ---------------------------------------------------------------------------
  // Step 3: Merge conflict — emit event, preserve worktree/branch
  // ---------------------------------------------------------------------------

  const { conflictingFiles } = threeWayResult

  logger.warn(
    { storyKey, branchName, conflictingFiles },
    'Merge conflict detected — preserving worktree for operator inspection',
  )

  eventBus.emit('pipeline:merge-conflict-detected', {
    storyKey,
    branchName,
    conflictingFiles,
  })

  return {
    success: false,
    reason: 'merge-conflict-detected',
    conflictingFiles,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * H3.3 (AC1): files that are both dirty in the parent working tree and part of
 * the story branch's diff against the start branch. Best-effort: if either
 * git query fails, returns [] (the merge itself will surface genuine issues).
 */
function listParentDirtyIntersection(
  branchName: string,
  startBranch: string,
  projectRoot: string,
): string[] {
  try {
    const statusOut = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as string
    const dirty = new Set(
      statusOut
        .split('\n')
        .filter((line) => line.trim().length > 0)
        // porcelain format: XY <path> (rename lines: XY <old> -> <new>)
        .map((line) => {
          const body = line.slice(3).trim()
          const arrow = body.indexOf(' -> ')
          return arrow === -1 ? body : body.slice(arrow + 4)
        }),
    )
    if (dirty.size === 0) return []
    const diffOut = execFileSync(
      'git',
      ['diff', '--name-only', `${startBranch}...${branchName}`],
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ) as string
    return diffOut
      .split('\n')
      .filter((f) => f.trim().length > 0)
      .filter((f) => dirty.has(f))
  } catch (err) {
    logger.warn({ err }, 'parent-clean precondition check failed (best-effort) — proceeding to merge')
    return []
  }
}

/**
 * Attempt a fast-forward merge of `branchName` into the current branch.
 *
 * @param branchName  - Branch to merge
 * @param projectRoot - Working directory (main worktree, already on startBranch)
 * @returns           - true if FF succeeded, false if it failed (branch diverged)
 */
function tryFfMerge(branchName: string, projectRoot: string): boolean {
  try {
    execFileSync('git', ['merge', '--ff-only', branchName], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Attempt a 3-way merge of `branchName` into the current branch.
 *
 * On conflict: parses conflicting files from `git diff --name-only --diff-filter=U`
 * and aborts the merge before returning.
 *
 * @param branchName  - Branch to merge
 * @param projectRoot - Working directory (main worktree, already on startBranch)
 * @returns           - { success: true } on clean merge;
 *                      { success: false, conflictingFiles: string[] } on conflict
 */
function tryThreeWayMerge(
  branchName: string,
  projectRoot: string,
): { success: boolean; conflictingFiles: string[] } {
  try {
    execFileSync('git', ['merge', '--no-edit', branchName], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { success: true, conflictingFiles: [] }
  } catch {
    // Merge produced conflicts — collect the conflicting file list
    let conflictingFiles: string[] = []
    try {
      const diffOutput = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      conflictingFiles = (diffOutput as string)
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
    } catch (diffErr) {
      logger.warn({ err: diffErr }, 'Failed to list conflicting files (best-effort)')
    }

    // Abort the merge to restore a clean working tree
    try {
      execFileSync('git', ['merge', '--abort'], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (abortErr) {
      logger.warn({ err: abortErr }, 'Failed to abort merge (best-effort)')
    }

    return { success: false, conflictingFiles }
  }
}

/**
 * Clean up the worktree and delete the merged branch after a successful merge.
 *
 * Cleanup is best-effort — a failure here does not revert the already-completed
 * git merge. Both operations are attempted independently.
 *
 * @param storyKey       - Story key (used as worktree task ID)
 * @param branchName     - Branch that was merged (to delete)
 * @param worktreeManager - Manager for removing the worktree directory
 * @param projectRoot    - Working directory for git branch deletion
 */
async function cleanupAfterSuccessfulMerge(
  storyKey: string,
  branchName: string,
  worktreeManager: GitWorktreeManager,
  _projectRoot: string,
): Promise<void> {
  // Remove the worktree directory AND its branch. `cleanupWorktree` is the
  // single source of truth for both — it calls `gitUtils.removeBranch` as
  // part of its lifecycle. Pre-v0.20.88, this function ALSO ran an explicit
  // `git branch -d` afterwards, but that call always failed (branch already
  // deleted by cleanupWorktree) and produced the noisy warning:
  //   "Failed to delete merged branch (best-effort) — error: branch
  //    'substrate/story-X-Y' not found"
  // The double-delete fired in production for every successful merge —
  // confusing operators grep-ing logs for real merge issues. Removed
  // 2026-05-11 (v0.20.88, per BMAD panel review of obs_2026-05-10_028
  // follow-up). _projectRoot retained in the signature for backward
  // compatibility with callers + the documented contract.
  try {
    await worktreeManager.cleanupWorktree(storyKey)
    logger.info({ storyKey, branchName }, 'Worktree + branch removed after successful merge')
  } catch (worktreeErr) {
    logger.warn({ storyKey, err: worktreeErr }, 'Failed to remove worktree (best-effort)')
  }
}

// ---------------------------------------------------------------------------
// createMergeQueue
// ---------------------------------------------------------------------------

/**
 * Create a serialized merge queue to prevent concurrent git merge operations.
 *
 * Returns an `enqueueMerge` function that wraps `runMergeToMain`. All calls
 * through the returned function are serialized: each invocation waits for the
 * previous to fully complete before starting. This prevents data-corruption
 * from concurrent `git merge` operations against the same base branch (AC7).
 *
 * Used by `orchestrator-impl.ts` to create a per-run merge queue. Exported
 * separately so the serialization logic can be unit-tested independently of
 * the orchestrator (see AC8d in Story 75-2).
 *
 * @returns A queue-serialized wrapper around `runMergeToMain`.
 */
export function createMergeQueue(): (params: MergeToMainParams) => Promise<MergeToMainResult> {
  let queue: Promise<void> = Promise.resolve()
  return (params: MergeToMainParams): Promise<MergeToMainResult> =>
    new Promise<MergeToMainResult>((resolve, reject) => {
      queue = queue
        .then(() => runMergeToMain(params))
        .then(resolve, reject)
        .then(
          () => undefined,
          () => undefined,
        )
    })
}
