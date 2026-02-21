/**
 * `substrate plan refine` command
 *
 * Refines an existing plan by applying natural language feedback.
 *
 * Usage:
 *   substrate plan refine <plan-id> "feedback text"
 *
 * Exit codes:
 *   0   - Success
 *   1   - Unexpected error
 *   2   - Plan not found, planning error, or usage error
 */

import type { Command } from 'commander'
import { join } from 'path'
import { PlanGenerator } from '../../modules/plan-generator/plan-generator.js'
import { PlanRefiner } from '../../modules/plan-generator/plan-refiner.js'
import { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { formatPlanForDisplay, formatPlanVersionForDisplay } from '../formatters/plan-formatter.js'
import { promptApproval } from './plan.js'
import { load as yamlLoad } from 'js-yaml'
import type { TaskGraphFile } from '../../modules/task-graph/schemas.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('plan-refine-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const REFINE_EXIT_SUCCESS = 0
export const REFINE_EXIT_ERROR = 1
export const REFINE_EXIT_USAGE_ERROR = 2

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PlanRefineActionOptions {
  planId: string
  feedback: string
  projectRoot: string
  outputFormat: 'human' | 'json'
  autoApprove?: boolean
}

// ---------------------------------------------------------------------------
// runPlanRefineAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the plan refine command.
 */
export async function runPlanRefineAction(options: PlanRefineActionOptions): Promise<number> {
  const { planId, feedback, projectRoot, outputFormat, autoApprove = false } = options

  if (!feedback || feedback.trim() === '') {
    process.stderr.write('Error: feedback text is required\n')
    return REFINE_EXIT_USAGE_ERROR
  }

  const dbPath = join(projectRoot, '.substrate', 'state.db')
  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
    runMigrations(dbWrapper.db)

    // Set up adapter registry
    const registry = new AdapterRegistry()
    try {
      await registry.discoverAndRegister()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: ${message}\n`)
      return REFINE_EXIT_ERROR
    }

    const generator = new PlanGenerator({
      adapterRegistry: registry,
      projectRoot,
    })

    const refiner = new PlanRefiner({
      db: dbWrapper.db,
      planGenerator: generator,
      tempDir: join(projectRoot, '.substrate', 'tmp'),
    })

    if (outputFormat === 'human') {
      process.stdout.write(`Refining plan ${planId}...\n`)
      process.stdout.write(`Feedback: "${feedback}"\n`)
    }

    let result: Awaited<ReturnType<PlanRefiner['refine']>>
    try {
      result = await refiner.refine(planId, feedback, (event, payload) => {
        logger.info({ event, payload }, 'Plan refinement event')
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: ${message}\n`)
      return REFINE_EXIT_USAGE_ERROR
    }

    // Display updated plan
    if (outputFormat === 'json') {
      const envelope = {
        success: true,
        command: 'plan refine',
        timestamp: new Date().toISOString(),
        data: {
          planId,
          newVersion: result.newVersion,
          taskCount: result.taskCount,
        },
      }
      process.stdout.write(JSON.stringify(envelope) + '\n')
    } else {
      process.stdout.write(`\nPlan ID: ${planId}  (current version: v${String(result.newVersion)})\n`)
      process.stdout.write(`Task count: ${String(result.taskCount)}\n\n`)

      // Parse the YAML for display
      let taskGraph: TaskGraphFile | undefined
      try {
        taskGraph = yamlLoad(result.updatedYaml) as TaskGraphFile
      } catch {
        // ignore parse errors for display
      }

      const displayText = formatPlanVersionForDisplay(result.updatedYaml, taskGraph)
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
        process.stdout.write(`Plan approved at version v${String(result.newVersion)}.\n`)
      } else {
        process.stdout.write('Plan rejected — no session created.\n')
      }
    }

    return REFINE_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runPlanRefineAction failed')
    return REFINE_EXIT_ERROR
  } finally {
    dbWrapper.close()
  }
}

// ---------------------------------------------------------------------------
// registerPlanRefineCommand
// ---------------------------------------------------------------------------

/**
 * Register the `plan refine` subcommand with the parent plan command.
 */
export function registerPlanRefineCommand(
  planCmd: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  planCmd
    .command('refine <planId> <feedback>')
    .description('Refine an existing plan by applying natural language feedback')
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .option('--auto-approve', 'Skip interactive review and automatically approve', false)
    .action(async (planId: string, feedback: string, opts: { outputFormat: string; autoApprove: boolean }) => {
      const outputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
      const exitCode = await runPlanRefineAction({
        planId,
        feedback,
        projectRoot,
        outputFormat,
        autoApprove: opts.autoApprove,
      })
      process.exitCode = exitCode
    })
}
