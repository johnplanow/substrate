/**
 * `substrate plan diff` command
 *
 * Shows differences between two versions of a plan.
 *
 * Usage:
 *   substrate plan diff <plan-id> --from 1 --to 2
 *   substrate plan diff <plan-id> --from 1 --to 2 --output-format json
 *
 * Exit codes:
 *   0   - Success (including no differences found)
 *   1   - Unexpected error
 *   2   - Version not found or usage error
 */

import type { Command } from 'commander'
import { join } from 'path'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { getPlanVersion } from '../../persistence/queries/plan-versions.js'
import { computePlanDiff } from '../../modules/plan-generator/plan-refiner.js'
import type { PlanDiffResult, FieldChange } from '../../modules/plan-generator/plan-refiner.js'
import { createLogger } from '../../utils/logger.js'

export { computePlanDiff } from '../../modules/plan-generator/plan-refiner.js'
export type { PlanDiffResult, FieldChange } from '../../modules/plan-generator/plan-refiner.js'

const logger = createLogger('plan-diff-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const DIFF_EXIT_SUCCESS = 0
export const DIFF_EXIT_ERROR = 1
export const DIFF_EXIT_NOT_FOUND = 2

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PlanDiffActionOptions {
  planId: string
  fromVersion: number
  toVersion: number
  projectRoot: string
  outputFormat: 'human' | 'json'
}

// ---------------------------------------------------------------------------
// runPlanDiffAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the plan diff command.
 */
export async function runPlanDiffAction(options: PlanDiffActionOptions): Promise<number> {
  const { planId, fromVersion, toVersion, projectRoot, outputFormat } = options

  const dbPath = join(projectRoot, '.substrate', 'state.db')
  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
    runMigrations(dbWrapper.db)

    const fromPV = getPlanVersion(dbWrapper.db, planId, fromVersion)
    if (fromPV === undefined) {
      process.stderr.write(`Error: Version v${String(fromVersion)} not found for plan ${planId}\n`)
      return DIFF_EXIT_NOT_FOUND
    }

    const toPV = getPlanVersion(dbWrapper.db, planId, toVersion)
    if (toPV === undefined) {
      process.stderr.write(`Error: Version v${String(toVersion)} not found for plan ${planId}\n`)
      return DIFF_EXIT_NOT_FOUND
    }

    const diff = computePlanDiff(fromPV.task_graph_yaml, toPV.task_graph_yaml)

    const hasDiff =
      diff.added.length > 0 || diff.removed.length > 0 || diff.modified.length > 0

    if (outputFormat === 'json') {
      process.stdout.write(JSON.stringify(diff, null, 2) + '\n')
    } else {
      if (!hasDiff) {
        process.stdout.write(`No differences found between v${String(fromVersion)} and v${String(toVersion)}\n`)
      } else {
        process.stdout.write(`Diff: plan ${planId} v${String(fromVersion)} → v${String(toVersion)}\n`)
        process.stdout.write('─'.repeat(60) + '\n')

        for (const taskId of diff.added) {
          process.stdout.write(`+ ${taskId} (added)\n`)
        }

        for (const taskId of diff.removed) {
          process.stdout.write(`- ${taskId} (removed)\n`)
        }

        for (const { taskId, changes } of diff.modified) {
          for (const change of changes) {
            const fromStr = formatDiffValue(change.from)
            const toStr = formatDiffValue(change.to)
            process.stdout.write(`~ ${taskId}: ${change.field} changed from ${fromStr} to ${toStr}\n`)
          }
        }
      }
    }

    return DIFF_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runPlanDiffAction failed')
    return DIFF_EXIT_ERROR
  } finally {
    dbWrapper.close()
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDiffValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.join(', ')}]`
  }
  if (value === undefined || value === null || value === '') {
    return '(none)'
  }
  return String(value)
}

// ---------------------------------------------------------------------------
// registerPlanDiffCommand
// ---------------------------------------------------------------------------

/**
 * Register the `plan diff` subcommand with the parent plan command.
 */
export function registerPlanDiffCommand(
  planCmd: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  planCmd
    .command('diff <planId>')
    .description('Show differences between two versions of a plan')
    .option('--from <n>', 'Source version number', '1')
    .option('--to <n>', 'Target version number')
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .action(async (planId: string, opts: { from: string; to?: string; outputFormat: string }) => {
      const outputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
      const fromVersion = parseInt(opts.from, 10)
      const toVersionStr = opts.to

      if (isNaN(fromVersion)) {
        process.stderr.write('Error: --from must be a valid version number\n')
        process.exitCode = DIFF_EXIT_NOT_FOUND
        return
      }

      if (toVersionStr === undefined) {
        process.stderr.write('Error: --to is required\n')
        process.exitCode = DIFF_EXIT_NOT_FOUND
        return
      }

      const toVersion = parseInt(toVersionStr, 10)
      if (isNaN(toVersion)) {
        process.stderr.write('Error: --to must be a valid version number\n')
        process.exitCode = DIFF_EXIT_NOT_FOUND
        return
      }

      const exitCode = await runPlanDiffAction({
        planId,
        fromVersion,
        toVersion,
        projectRoot,
        outputFormat,
      })
      process.exitCode = exitCode
    })
}
