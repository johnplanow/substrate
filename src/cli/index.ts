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
import { AdapterRegistry } from '../adapters/adapter-registry.js'
import { registerAdaptersCommand } from './commands/adapters.js'
import { registerInitCommand } from './commands/init.js'
import { registerConfigCommand } from './commands/config.js'
import { registerRunCommand } from './commands/run.js'
import { registerResumeCommand } from './commands/resume.js'
import { registerStatusCommand } from './commands/status.js'
import { registerAmendCommand } from './commands/amend.js'
import { registerHealthCommand } from './commands/health.js'
import { registerSupervisorCommand } from './commands/supervisor.js'
import { registerMetricsCommand } from './commands/metrics.js'
import { registerCostCommand } from './commands/cost.js'
import { registerMonitorCommand } from './commands/monitor.js'
import { registerMergeCommand } from './commands/merge.js'
import { registerWorktreesCommand } from './commands/worktrees.js'
import { registerBrainstormCommand } from './commands/brainstorm.js'
import { registerUpgradeCommand } from './commands/upgrade.js'
import { registerExportCommand } from './commands/export.js'
import { registerRetryEscalatedCommand } from './commands/retry-escalated.js'
import { registerContractsCommand } from './commands/contracts.js'
import { registerDiffCommand } from './commands/diff.js'
import { registerHistoryCommand } from './commands/history.js'

// Increase max listeners before any commands or transports register their handlers.
// With CLI commands registered, pino-pretty workers and Commander exit handlers
// can exceed the default limit of 10.
process.setMaxListeners(20)

// Handle EPIPE gracefully when piped to `head`, `grep -m`, `tail`, etc.
// When the downstream reader closes the pipe, exit cleanly instead of stalling
// with unhandled errors that leave the process alive but brain-dead.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
})
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
})

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
    .description('Substrate - Autonomous implementation pipeline for AI coding agents')
    .version(version, '-v, --version', 'Output the current version')

  // Initialize a single AdapterRegistry at CLI startup so adapter health checks
  // run exactly once per invocation and are shared across all commands.
  const registry = new AdapterRegistry()
  await registry.discoverAndRegister()

  // Project setup
  registerAdaptersCommand(program, version, registry)
  registerInitCommand(program, version, registry)
  registerConfigCommand(program, version)

  // Pipeline commands (formerly under `substrate auto`, now top-level)
  registerRunCommand(program, version, process.cwd(), registry)
  registerResumeCommand(program, version, process.cwd(), registry)
  registerStatusCommand(program, version)
  registerAmendCommand(program, version, process.cwd(), registry)
  registerHealthCommand(program, version)
  registerSupervisorCommand(program, version)
  registerMetricsCommand(program, version)

  registerRetryEscalatedCommand(program, version, process.cwd(), registry)

  // Contract declarations and verification
  registerContractsCommand(program)

  // Dolt diff and history commands (Epic 26)
  registerDiffCommand(program)
  registerHistoryCommand(program)

  // Observability
  registerCostCommand(program, version)
  registerMonitorCommand(program, version)

  // Git helpers
  registerMergeCommand(program)
  registerWorktreesCommand(program, version)

  // Interactive tools
  registerBrainstormCommand(program, version)

  // Export / artifact sharing
  registerExportCommand(program, version)

  // Maintenance
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
      const pfx = process.env['npm_command'] === 'exec' ? 'npx ' : ''
      process.stderr.write(
        `\nUpdate available: ${result.currentVersion} → ${result.latestVersion}. Run \`${pfx}substrate upgrade\` to update.\n`
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

// Run only when this is the entry point (not when imported in tests).
// Resolve symlinks so `npx substrate` (symlink in node_modules/.bin) still matches.
import { realpathSync } from 'fs'
const __cli_filename = fileURLToPath(import.meta.url)
const isMainModule = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(__cli_filename)
  } catch {
    return false
  }
})()
if (isMainModule) {
  void main()
}
