/**
 * `substrate plan rollback` command
 *
 * Rollback a plan to a previous version by creating a new version entry
 * that is a copy of the target version's YAML.
 *
 * Usage:
 *   substrate plan rollback <plan-id> --to-version 1
 *
 * Exit codes:
 *   0   - Success
 *   1   - Unexpected error
 *   2   - Plan not found, version not found, or usage error
 */

import type { Command } from 'commander'
import { join } from 'path'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { getPlan, updatePlan } from '../../persistence/queries/plans.js'
import {
  getPlanVersion,
  createPlanVersion,
} from '../../persistence/queries/plan-versions.js'
import { formatPlanVersionForDisplay } from '../formatters/plan-formatter.js'
import { promptApproval } from './plan.js'
import { load as yamlLoad } from 'js-yaml'
import type { TaskGraphFile } from '../../modules/task-graph/schemas.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('plan-rollback-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const ROLLBACK_EXIT_SUCCESS = 0
export const ROLLBACK_EXIT_ERROR = 1
export const ROLLBACK_EXIT_USAGE_ERROR = 2

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PlanRollbackActionOptions {
  planId: string
  toVersion: number
  projectRoot: string
  outputFormat: 'human' | 'json'
  autoApprove?: boolean
}

// ---------------------------------------------------------------------------
// runPlanRollbackAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the plan rollback command.
 */
export async function runPlanRollbackAction(
  options: PlanRollbackActionOptions,
  onEvent?: (event: string, payload: Record<string, unknown>) => void,
): Promise<number> {
  const { planId, toVersion, projectRoot, outputFormat, autoApprove = false } = options

  const dbPath = join(projectRoot, '.substrate', 'state.db')
  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
    runMigrations(dbWrapper.db)

    // Load plan
    const plan = getPlan(dbWrapper.db, planId)
    if (plan === undefined) {
      process.stderr.write(`Error: Plan not found: ${planId}\n`)
      return ROLLBACK_EXIT_USAGE_ERROR
    }

    // Load target version
    const targetVersion = getPlanVersion(dbWrapper.db, planId, toVersion)
    if (targetVersion === undefined) {
      process.stderr.write(`Error: Version v${String(toVersion)} not found for plan ${planId}\n`)
      return ROLLBACK_EXIT_USAGE_ERROR
    }

    const fromVersion = plan.current_version ?? 1

    // Check if already at target version
    if (fromVersion === toVersion) {
      process.stdout.write(`Plan ${planId} is already at v${String(toVersion)}\n`)
      return ROLLBACK_EXIT_SUCCESS
    }

    // Create new version that is a copy of the target version
    const newVersion = fromVersion + 1
    const feedbackUsed = `rollback to v${String(toVersion)}`

    // DB writes before events per transaction isolation rule
    createPlanVersion(dbWrapper.db, {
      plan_id: planId,
      version: newVersion,
      task_graph_yaml: targetVersion.task_graph_yaml,
      feedback_used: feedbackUsed,
      planning_cost_usd: 0.0,
    })

    updatePlan(dbWrapper.db, planId, {
      current_version: newVersion,
      status: 'draft',
    })

    // Emit event
    onEvent?.('plan:rolled-back', {
      planId,
      fromVersion,
      toVersion,
      newVersion,
    })

    logger.info({ planId, fromVersion, toVersion, newVersion }, 'Plan rolled back')

    if (outputFormat === 'json') {
      const envelope = {
        success: true,
        command: 'plan rollback',
        timestamp: new Date().toISOString(),
        data: {
          planId,
          fromVersion,
          toVersion,
          newVersion,
          status: 'draft',
        },
      }
      process.stdout.write(JSON.stringify(envelope) + '\n')
    } else {
      process.stdout.write(
        `Plan ${planId} rolled back from v${String(fromVersion)} to v${String(toVersion)} (new version: v${String(newVersion)})\n`,
      )
      process.stdout.write(`Plan ID: ${planId}  (current version: v${String(newVersion)})\n\n`)

      // Display rolled-back plan for review
      let taskGraph: TaskGraphFile | undefined
      try {
        taskGraph = yamlLoad(targetVersion.task_graph_yaml) as TaskGraphFile
      } catch {
        // ignore parse errors for display
      }

      const displayText = formatPlanVersionForDisplay(targetVersion.task_graph_yaml, taskGraph)
      process.stdout.write(displayText + '\n')

      // Show approve/reject prompt
      let decision: 'approve' | 'reject'
      if (autoApprove) {
        process.stdout.write('Plan auto-approved (--auto-approve flag)\n')
        decision = 'approve'
      } else {
        decision = await promptApproval()
      }

      if (decision === 'approve') {
        process.stdout.write(`Rolled-back plan approved at version v${String(newVersion)}.\n`)
      } else {
        process.stdout.write('Plan rejected — no session created.\n')
      }
    }

    return ROLLBACK_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runPlanRollbackAction failed')
    return ROLLBACK_EXIT_ERROR
  } finally {
    dbWrapper.close()
  }
}

// ---------------------------------------------------------------------------
// registerPlanRollbackCommand
// ---------------------------------------------------------------------------

/**
 * Register the `plan rollback` subcommand with the parent plan command.
 */
export function registerPlanRollbackCommand(
  planCmd: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  planCmd
    .command('rollback <planId>')
    .description('Rollback a plan to a previous version')
    .requiredOption('--to-version <n>', 'Target version number to roll back to')
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .option('--auto-approve', 'Skip interactive review and automatically approve', false)
    .action(
      async (planId: string, opts: { toVersion: string; outputFormat: string; autoApprove: boolean }) => {
        const outputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
        const toVersion = parseInt(opts.toVersion, 10)

        if (isNaN(toVersion)) {
          process.stderr.write('Error: --to-version must be a valid version number\n')
          process.exitCode = ROLLBACK_EXIT_USAGE_ERROR
          return
        }

        const exitCode = await runPlanRollbackAction({
          planId,
          toVersion,
          projectRoot,
          outputFormat,
          autoApprove: opts.autoApprove,
        })
        process.exitCode = exitCode
      },
    )
}
