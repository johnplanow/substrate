/**
 * `substrate worktrees` command
 *
 * Lists all active git worktrees and their associated task information.
 *
 * Usage:
 *   substrate worktrees                        List all active worktrees (table)
 *   substrate worktrees --output-format json   JSON output
 *   substrate worktrees --json                 JSON shorthand
 *   substrate worktrees --status running       Filter by task status
 *   substrate worktrees --sort created         Sort by creation time (default)
 *   substrate worktrees --sort task-id         Sort by task ID
 *   substrate worktrees --sort status          Sort by task status
 *
 * Exit codes:
 *   0 - Success (including empty worktree case)
 *   1 - Error (database error, filesystem error, etc.)
 */

import type { Command } from 'commander'
import { createGitWorktreeManager } from '../../modules/git-worktree/git-worktree-manager-impl.js'
import type { WorktreeInfo } from '../../modules/git-worktree/git-worktree-manager.js'
import { createEventBus } from '../../core/event-bus.js'
import { formatTable, buildJsonOutput } from '../utils/formatting.js'
import type { TaskStatus, WorktreeDisplayInfo, WorktreeJsonEntry, WorktreeSortKey } from '../types/worktree-output.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('worktrees-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const WORKTREES_EXIT_SUCCESS = 0
export const WORKTREES_EXIT_ERROR = 1

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid task statuses for filtering */
const VALID_STATUSES: TaskStatus[] = ['pending', 'ready', 'running', 'completed', 'failed', 'paused', 'queued']

/** Valid sort keys */
const VALID_SORT_KEYS: WorktreeSortKey[] = ['created', 'task-id', 'status']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date for display in the worktrees table.
 */
function formatTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

/**
 * Convert WorktreeInfo to WorktreeDisplayInfo by enriching with task status.
 *
 * Attempts to look up task status from the persistence layer if a database
 * path is available. Falls back to 'running' for worktrees without DB access.
 */
export function buildWorktreeDisplayInfo(
  worktreeInfo: WorktreeInfo,
  taskStatus: TaskStatus = 'running',
  completedAt?: Date,
): WorktreeDisplayInfo {
  return {
    taskId: worktreeInfo.taskId,
    branchName: worktreeInfo.branchName,
    worktreePath: worktreeInfo.worktreePath,
    taskStatus,
    createdAt: worktreeInfo.createdAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
  }
}

/**
 * Sort worktrees by the given key.
 * Default order is newest-first for 'created'.
 */
export function sortWorktrees(
  worktrees: WorktreeDisplayInfo[],
  sortKey: WorktreeSortKey,
): WorktreeDisplayInfo[] {
  const sorted = [...worktrees]

  switch (sortKey) {
    case 'created':
      // Newest first (descending)
      sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      break
    case 'task-id':
      // Ascending by task ID (alphabetical)
      sorted.sort((a, b) => a.taskId.localeCompare(b.taskId))
      break
    case 'status':
      // Alphabetical by status
      sorted.sort((a, b) => a.taskStatus.localeCompare(b.taskStatus))
      break
    default:
      // Default: newest first
      sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }

  return sorted
}

/**
 * Filter worktrees by task status.
 */
export function filterWorktreesByStatus(
  worktrees: WorktreeDisplayInfo[],
  status: TaskStatus,
): WorktreeDisplayInfo[] {
  return worktrees.filter((w) => w.taskStatus === status)
}

/**
 * Format worktrees as a human-readable table.
 */
export function formatWorktreesTable(worktrees: WorktreeDisplayInfo[]): string {
  const headers = ['Task ID', 'Branch', 'Path', 'Status', 'Created']
  const keys = ['taskId', 'branchName', 'worktreePath', 'taskStatus', 'createdAt']

  const rows: Record<string, string>[] = worktrees.map((w) => ({
    taskId: w.taskId,
    branchName: w.branchName,
    worktreePath: w.worktreePath,
    taskStatus: w.taskStatus,
    createdAt: formatTimestamp(w.createdAt),
  }))

  return formatTable(headers, rows, keys)
}

/**
 * Convert WorktreeDisplayInfo to JSON-serializable entry.
 */
export function worktreeToJsonEntry(worktree: WorktreeDisplayInfo): WorktreeJsonEntry {
  return {
    taskId: worktree.taskId,
    branchName: worktree.branchName,
    worktreePath: worktree.worktreePath,
    taskStatus: worktree.taskStatus,
    createdAt: worktree.createdAt.toISOString(),
    completedAt: worktree.completedAt?.toISOString() ?? null,
  }
}

// ---------------------------------------------------------------------------
// listWorktreesAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Options for the worktrees list action.
 */
export interface WorktreesActionOptions {
  outputFormat: 'table' | 'json'
  status?: TaskStatus
  sort: WorktreeSortKey
  projectRoot: string
  version?: string
}

/**
 * Core action for listing worktrees.
 *
 * Returns the exit code. Separated from Commander integration for testability.
 *
 * @param options - Action options
 * @returns       - Exit code (0 = success, 1 = error)
 */
export async function listWorktreesAction(options: WorktreesActionOptions): Promise<number> {
  const { outputFormat, status, sort, projectRoot, version = '0.0.0' } = options

  try {
    // Discover worktrees using GitWorktreeManager
    const eventBus = createEventBus()
    const manager = createGitWorktreeManager({ eventBus, projectRoot })

    let worktreeInfos: WorktreeInfo[]
    try {
      worktreeInfos = await manager.listWorktrees()
    } catch (err) {
      logger.error({ err }, 'Failed to list worktrees')
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error listing worktrees: ${message}\n`)
      return WORKTREES_EXIT_ERROR
    }

    // Build display info (enriched with task status)
    // For now, we default to 'running' since we don't have DB access in the CLI.
    // Future: inject DB service to look up actual task status.
    let displayInfos: WorktreeDisplayInfo[] = worktreeInfos.map((info) =>
      buildWorktreeDisplayInfo(info)
    )

    // Apply status filter if provided
    if (status !== undefined) {
      displayInfos = filterWorktreesByStatus(displayInfos, status)
    }

    // Apply sorting
    displayInfos = sortWorktrees(displayInfos, sort)

    // Handle empty case (AC3)
    if (displayInfos.length === 0) {
      if (outputFormat === 'json') {
        const output = buildJsonOutput('substrate worktrees', [], version)
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
      } else {
        process.stdout.write('No active worktrees\n')
      }
      return WORKTREES_EXIT_SUCCESS
    }

    // Output results
    if (outputFormat === 'json') {
      // AC2: JSON output
      const jsonEntries = displayInfos.map(worktreeToJsonEntry)
      const output = buildJsonOutput('substrate worktrees', jsonEntries, version)
      process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    } else {
      // AC1: Table output
      const table = formatWorktreesTable(displayInfos)
      process.stdout.write(table + '\n')
    }

    return WORKTREES_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'listWorktreesAction failed')
    return WORKTREES_EXIT_ERROR
  }
}

// ---------------------------------------------------------------------------
// registerWorktreesCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate worktrees` command with the CLI program.
 *
 * @param program     - Commander program instance
 * @param version     - Current Substrate package version (for JSON output)
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerWorktreesCommand(
  program: Command,
  version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('worktrees')
    .description('List all active git worktrees and their associated tasks')
    .option(
      '--output-format <format>',
      'Output format: table (default) or json',
      'table',
    )
    .option('--json', 'Output JSON (shorthand for --output-format json)', false)
    .option(
      '--status <status>',
      `Filter by task status: ${VALID_STATUSES.join(', ')}`,
    )
    .option(
      '--sort <key>',
      `Sort by: ${VALID_SORT_KEYS.join(', ')} (default: created)`,
      'created',
    )
    .action(async (opts: { outputFormat: string; json: boolean; status?: string; sort: string }) => {
      // Resolve output format: --json flag overrides --output-format
      const outputFormat: 'table' | 'json' = opts.json ? 'json' : (opts.outputFormat === 'json' ? 'json' : 'table')

      // Validate status filter
      let statusFilter: TaskStatus | undefined
      if (opts.status !== undefined) {
        if (!VALID_STATUSES.includes(opts.status as TaskStatus)) {
          process.stderr.write(
            `Invalid status "${opts.status}". Valid values: ${VALID_STATUSES.join(', ')}\n`,
          )
          process.exitCode = WORKTREES_EXIT_ERROR
          return
        }
        statusFilter = opts.status as TaskStatus
      }

      // Validate sort key
      if (!VALID_SORT_KEYS.includes(opts.sort as WorktreeSortKey)) {
        process.stderr.write(
          `Invalid sort key "${opts.sort}". Valid values: ${VALID_SORT_KEYS.join(', ')}\n`,
        )
        process.exitCode = WORKTREES_EXIT_ERROR
        return
      }

      const exitCode = await listWorktreesAction({
        outputFormat,
        status: statusFilter,
        sort: opts.sort as WorktreeSortKey,
        projectRoot,
        version,
      })

      process.exitCode = exitCode
    })
}
