/**
 * `substrate merge` command
 *
 * Merges task worktree branches into the target branch after conflict detection.
 *
 * Subcommands:
 *   substrate merge --task <id>   Detect conflicts and merge a single task's branch
 *   substrate merge --all          Detect and merge all completed tasks' branches
 *
 * Exit codes:
 *   0 - Success (all merges successful)
 *   1 - Conflicts detected (one or more tasks have conflicts)
 *   2 - Error (missing worktree, git failure, etc.)
 */

import type { Command } from 'commander'
import { createLogger } from '../../utils/logger.js'
import { createGitWorktreeManager } from '../../modules/git-worktree/git-worktree-manager-impl.js'
import type { ConflictReport, MergeResult } from '../../modules/git-worktree/git-worktree-manager.js'
import { createEventBus } from '../../core/event-bus.js'

const logger = createLogger('merge-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const MERGE_EXIT_SUCCESS = 0
export const MERGE_EXIT_CONFLICT = 1
export const MERGE_EXIT_ERROR = 2

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a conflict report for display.
 */
function formatConflictReport(report: ConflictReport): string {
  const lines: string[] = [
    `Conflicts detected for task "${report.taskId}" (target: ${report.targetBranch}):`,
  ]
  if (report.conflictingFiles.length === 0) {
    lines.push('  (no specific files identified — check git status for details)')
  } else {
    for (const file of report.conflictingFiles) {
      lines.push(`  - ${file}`)
    }
  }
  lines.push('')
  lines.push('Resolve conflicts manually and commit before merging.')
  return lines.join('\n')
}

/**
 * Format a merge success result for display.
 */
function formatMergeSuccess(taskId: string, result: MergeResult, targetBranch: string): string {
  const fileCount = result.mergedFiles.length
  const fileLabel = fileCount === 1 ? 'file' : 'files'
  return `Merged task "${taskId}" into ${targetBranch} (${fileCount} ${fileLabel} changed)`
}


// ---------------------------------------------------------------------------
// merge --task <id>
// ---------------------------------------------------------------------------

/**
 * Execute merge for a single task.
 *
 * @param taskId       - Task identifier
 * @param targetBranch - Branch to merge into
 * @param projectRoot  - Project root directory
 * @returns            - Exit code (0 = success, 1 = conflicts, 2 = error)
 */
export async function mergeTask(
  taskId: string,
  targetBranch: string,
  projectRoot: string,
): Promise<number> {
  const eventBus = createEventBus()
  const manager = createGitWorktreeManager({ eventBus, projectRoot })

  try {
    logger.info({ taskId, targetBranch }, 'Running conflict detection...')
    console.log(`Checking for conflicts: task "${taskId}" -> ${targetBranch}`)

    const conflictReport = await manager.detectConflicts(taskId, targetBranch)

    if (conflictReport.hasConflicts) {
      console.error(formatConflictReport(conflictReport))
      return MERGE_EXIT_CONFLICT
    }

    console.log(`No conflicts detected. Merging task "${taskId}"...`)
    const result = await manager.mergeWorktree(taskId, targetBranch)

    if (!result.success) {
      // Should not happen since we checked conflicts, but handle defensively
      if (result.conflicts) {
        console.error(formatConflictReport(result.conflicts))
      } else {
        console.error(`Merge failed for task "${taskId}".`)
      }
      return MERGE_EXIT_CONFLICT
    }

    console.log(formatMergeSuccess(taskId, result, targetBranch))
    return MERGE_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Error merging task "${taskId}": ${message}`)
    logger.error({ taskId, err }, 'merge --task failed')
    return MERGE_EXIT_ERROR
  }
}

// ---------------------------------------------------------------------------
// merge --all
// ---------------------------------------------------------------------------

/**
 * Execute merge for all completed tasks with worktrees.
 *
 * @param targetBranch - Branch to merge into
 * @param projectRoot  - Project root directory
 * @param taskIds      - List of task IDs to merge (discovered externally)
 * @returns            - Exit code (0 = all success, 1 = some conflicts, 2 = error)
 */
export async function mergeAll(
  targetBranch: string,
  projectRoot: string,
  taskIds: string[],
): Promise<number> {
  if (taskIds.length === 0) {
    console.log('No tasks to merge.')
    return MERGE_EXIT_SUCCESS
  }

  const eventBus = createEventBus()
  const manager = createGitWorktreeManager({ eventBus, projectRoot })

  const successful: string[] = []
  const conflicted: Array<{ taskId: string; report: ConflictReport }> = []
  const errors: Array<{ taskId: string; error: string }> = []

  for (const taskId of taskIds) {
    try {
      console.log(`Processing task "${taskId}"...`)
      const result = await manager.mergeWorktree(taskId, targetBranch)

      if (result.success) {
        successful.push(taskId)
        console.log(`  ${formatMergeSuccess(taskId, result, targetBranch)}`)
      } else if (result.conflicts) {
        conflicted.push({ taskId, report: result.conflicts })
        console.log(`  Conflicts detected for task "${taskId}"`)
      } else {
        errors.push({ taskId, error: 'Merge failed with unknown error' })
        console.log(`  Merge failed for task "${taskId}"`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ taskId, error: message })
      console.log(`  Error for task "${taskId}": ${message}`)
      logger.error({ taskId, err }, 'merge --all: task failed')
    }
  }

  // Display summary
  console.log('')
  console.log(`Merge Summary:`)
  console.log(`  Merged: ${successful.length} task(s)`)
  console.log(`  Conflicts: ${conflicted.length} task(s)`)
  console.log(`  Errors: ${errors.length} task(s)`)

  if (conflicted.length > 0) {
    console.log('')
    console.log('Tasks with conflicts:')
    for (const { taskId, report } of conflicted) {
      console.log(formatConflictReport(report))
    }
  }

  if (errors.length > 0) {
    console.log('')
    console.log('Tasks with errors:')
    for (const { taskId, error } of errors) {
      console.log(`  Task "${taskId}": ${error}`)
    }
  }

  if (errors.length > 0) {
    return MERGE_EXIT_ERROR
  }
  if (conflicted.length > 0) {
    return MERGE_EXIT_CONFLICT
  }
  return MERGE_EXIT_SUCCESS
}

// ---------------------------------------------------------------------------
// registerMergeCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate merge` command with the CLI program.
 *
 * @param program     - Commander program instance
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerMergeCommand(program: Command, projectRoot = process.cwd()): void {
  const merge = program
    .command('merge')
    .description('Detect conflicts and merge task worktree branches into the target branch')
    .option('--task <id>', 'Merge a single task by ID')
    .option('--all', 'Merge all completed tasks')
    .option('--branch <branch>', 'Target branch to merge into', 'main')

  merge.action(async (options: { task?: string; all?: boolean; branch: string }) => {
    const targetBranch = options.branch ?? 'main'

    if (options.task !== undefined) {
      // merge --task <id>
      const exitCode = await mergeTask(options.task, targetBranch, projectRoot)
      process.exitCode = exitCode
    } else if (options.all === true) {
      // merge --all: discover tasks from existing worktrees and merge them all
      const eventBus = createEventBus()
      const manager = createGitWorktreeManager({ eventBus, projectRoot })
      const worktrees = await manager.listWorktrees()
      const taskIds = worktrees.map((wt) => wt.taskId)
      const exitCode = await mergeAll(targetBranch, projectRoot, taskIds)
      process.exitCode = exitCode
    } else {
      merge.help()
    }
  })
}
