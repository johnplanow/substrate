#!/usr/bin/env node
/**
 * Substrate CLI - Main entry point
 * Provides the `substrate` command-line interface
 */

import { Command } from 'commander'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { readFile } from 'fs/promises'
import { createLogger } from '../utils/logger.js'
import { registerAdaptersCommand } from './commands/adapters.js'
import { registerInitCommand } from './commands/init.js'
import { registerConfigCommand } from './commands/config.js'
import { registerMergeCommand } from './commands/merge.js'
import { registerWorktreesCommand } from './commands/worktrees.js'
import { registerCostCommand } from './commands/cost.js'
import { registerStartCommand } from './commands/start.js'
import { registerStatusCommand } from './commands/status.js'
import { registerPauseCommand } from './commands/pause.js'
import { registerResumeCommand } from './commands/resume.js'
import { registerCancelCommand } from './commands/cancel.js'
import { registerRetryCommand } from './commands/retry.js'
import { registerGraphCommand } from './commands/graph.js'
import { registerLogCommand } from './commands/log.js'
import { registerPlanCommand } from './commands/plan.js'
import { registerAutoCommand } from './commands/auto.js'
import { registerBrainstormCommand } from './commands/brainstorm.js'
import { registerMonitorCommand } from './commands/monitor.js'
import { registerUpgradeCommand } from './commands/upgrade.js'

// Increase max listeners before any commands or transports register their handlers.
// With 16+ CLI commands registered, pino-pretty workers and Commander exit handlers
// can exceed the default limit of 10.
process.setMaxListeners(30)

const logger = createLogger('cli')

/** Resolve the package.json path relative to this file */
async function getPackageVersion(): Promise<string> {
  try {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    // Try multiple levels up since this may be run from dist/ or src/
    const paths = [
      resolve(__dirname, '../../package.json'),
      resolve(__dirname, '../package.json'),
      resolve(__dirname, '../../../package.json'),
    ]

    for (const pkgPath of paths) {
      try {
        const content = await readFile(pkgPath, 'utf-8')
        const pkg = JSON.parse(content) as { version?: string; name?: string }
        if (pkg.name === 'substrate' || pkg.version) {
          return pkg.version ?? '0.0.0'
        }
      } catch {
        // Try next path
      }
    }
    return '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Create and configure the CLI program */
export async function createProgram(): Promise<Command> {
  const version = await getPackageVersion()

  const program = new Command()

  program
    .name('substrate')
    .description('Substrate - Multi-agent orchestration for AI coding agents')
    .version(version, '-v, --version', 'Output the current version')

  // Register adapters command group (story 1.3)
  registerAdaptersCommand(program, version)

  // Register init command (story 1.4)
  registerInitCommand(program, version)

  // Register config command group (story 1.4)
  registerConfigCommand(program, version)

  // Register merge command (story 3.2)
  registerMergeCommand(program)

  // Register worktrees command (story 3.3)
  registerWorktreesCommand(program, version)

  // Register cost command (story 4.4)
  registerCostCommand(program, version)

  // Register start command (story 5.1)
  registerStartCommand(program, version)

  // Register status command (story 5.2)
  registerStatusCommand(program, version)

  // Register pause command (story 5.3)
  registerPauseCommand(program, version)

  // Register resume command (story 5.3)
  registerResumeCommand(program, version)

  // Register cancel command (story 5.3)
  registerCancelCommand(program, version)

  // Register retry command (story 5.4)
  registerRetryCommand(program, version)

  // Register graph command (story 5.5)
  registerGraphCommand(program, version)

  // Register log command (story 6.3)
  registerLogCommand(program, version)

  // Register plan command (story 7.1)
  registerPlanCommand(program, version)

  // Register auto command (story 10.5)
  registerAutoCommand(program, version)

  // Register brainstorm command (story 12.4)
  registerBrainstormCommand(program, version)

  // Register monitor command (story 8.7)
  registerMonitorCommand(program, version)

  // Register upgrade command (story 8.3)
  registerUpgradeCommand(program)

  return program
}

/** Fire-and-forget startup version check (story 8.3, AC3/AC5) */
function checkForUpdatesInBackground(currentVersion: string): void {
  if (process.env.SUBSTRATE_NO_UPDATE_CHECK === '1') return
  // Dynamic import to avoid loading version-manager for every CLI invocation
  import('./commands/upgrade.js').then(async () => {
    const { createVersionManager } = await import('../modules/version-manager/version-manager-impl.js')
    const vm = createVersionManager()
    const result = await vm.checkForUpdates()
    if (result.updateAvailable) {
      process.stderr.write(
        `\nUpdate available: ${result.currentVersion} → ${result.latestVersion}. Run \`substrate upgrade\` to update.\n`
      )
    }
  }).catch(() => {
    // Silently ignore — never block CLI for update checks
  })
}

/** Main entry point */
async function main(): Promise<void> {
  try {
    const program = await createProgram()
    const version = await getPackageVersion()
    // Skip update notification when running the upgrade command itself
    const activeCommand = process.argv[2]
    if (activeCommand !== 'upgrade') {
      // Non-blocking update check (AC3: never delays command output)
      checkForUpdatesInBackground(version)
    }
    await program.parseAsync(process.argv)
  } catch (error) {
    logger.error({ error }, 'CLI error')
    process.exit(1)
  }
}

// Run if this is the main module
// Errors are handled internally by main() which calls process.exit(1)
void main()
