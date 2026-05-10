/**
 * `substrate cancel` command
 *
 * Cleanly cancels a running or stalled pipeline by killing the orchestrator
 * process tree and updating the pipeline run status to 'cancelled'.
 *
 *   substrate cancel [--force]
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { execSync } from 'child_process'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import { updatePipelineRun, getRunningPipelineRuns } from '../../persistence/queries/decisions.js'
import { RunManifest } from '@substrate-ai/sdlc'
import { swallowDebug } from '@substrate-ai/core'
import { createLogger } from '../../utils/logger.js'
import { inspectProcessTree } from './health.js'
import { type OutputFormat, formatOutput } from './pipeline-shared.js'

const logger = createLogger('cancel-cmd')

export async function runCancelAction(options: {
  outputFormat: OutputFormat
  projectRoot: string
  force?: boolean
}): Promise<number> {
  const { outputFormat, projectRoot, force } = options

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const substrateDirPath = join(dbRoot, '.substrate')
  const pidFilePath = join(substrateDirPath, 'orchestrator.pid')

  // Step 1: Find the orchestrator process
  const processInfo = inspectProcessTree({ projectRoot, substrateDirPath })
  const pid = processInfo.orchestrator_pid
  const zombies = processInfo.zombies ?? []

  if (pid === null && zombies.length === 0) {
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput({ cancelled: false, reason: 'no_running_pipeline' }, 'json', true) + '\n')
    } else {
      process.stdout.write('No running pipeline found.\n')
    }

    // Clean up stale PID file if it exists
    if (existsSync(pidFilePath)) {
      try {
        unlinkSync(pidFilePath)
        if (outputFormat === 'human') {
          process.stdout.write('Cleaned up stale PID file.\n')
        }
      } catch { /* ignore */ }
    }

    return 0
  }

  // Step 2: Kill the process tree
  const killed: number[] = []

  if (pid !== null) {
    try {
      // Kill child processes first, then orchestrator
      for (const childPid of processInfo.child_pids) {
        try {
          process.kill(childPid, 'SIGTERM')
          killed.push(childPid)
        } catch { /* already dead */ }
      }

      // Kill orchestrator
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
      killed.push(pid)

      if (outputFormat === 'human') {
        process.stdout.write(`Killed orchestrator (PID ${pid})`)
        if (processInfo.child_pids.length > 0) {
          process.stdout.write(` and ${processInfo.child_pids.length} child process(es)`)
        }
        process.stdout.write('\n')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn({ pid, err: msg }, 'Failed to kill orchestrator')
      if (outputFormat === 'human') {
        process.stdout.write(`Warning: could not kill PID ${pid}: ${msg}\n`)
      }
    }
  }

  // Kill zombies
  for (const zombiePid of zombies) {
    try {
      process.kill(zombiePid, 'SIGKILL')
      killed.push(zombiePid)
    } catch { /* already dead */ }
  }

  // Step 3: Clean up PID file
  if (existsSync(pidFilePath)) {
    try {
      unlinkSync(pidFilePath)
    } catch { /* ignore */ }
  }

  // Step 4: Mark pipeline run as cancelled in the database
  try {
    const adapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
    try {
      await initSchema(adapter)
      const runningRuns = await getRunningPipelineRuns(adapter)
      for (const run of runningRuns) {
        await updatePipelineRun(adapter, run.id, { status: 'stopped' })
        // Source demotion: mirror to manifest (authoritative)
        RunManifest.open(run.id, join(dbRoot, 'runs')).update({ run_status: 'stopped' }).catch(swallowDebug('manifest-stop'))
        if (outputFormat === 'human') {
          process.stdout.write(`Marked pipeline run ${run.id} as stopped.\n`)
        }
      }
    } finally {
      await adapter.close()
    }
  } catch (err) {
    logger.warn({ err }, 'Could not update pipeline run status (non-fatal)')
  }

  if (outputFormat === 'json') {
    process.stdout.write(formatOutput({
      cancelled: true,
      killed_pids: killed,
      zombies_killed: zombies.length,
    }, 'json', true) + '\n')
  } else if (killed.length === 0 && zombies.length > 0) {
    process.stdout.write(`Killed ${zombies.length} zombie process(es).\n`)
  }

  process.stdout.write('Pipeline cancelled. Run `substrate run` to start fresh.\n')

  return 0
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerCancelCommand(
  program: Command,
  projectRoot = process.cwd(),
): void {
  program
    .command('cancel')
    .description('Cancel the running pipeline — kills orchestrator, cleans up state')
    .option('--force', 'Use SIGKILL instead of SIGTERM')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .action(
      async (opts: {
        force?: boolean
        projectRoot: string
        outputFormat: string
      }) => {
        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
        const exitCode = await runCancelAction({
          outputFormat,
          projectRoot: opts.projectRoot,
          force: opts.force,
        })
        process.exitCode = exitCode
      },
    )
}
