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

  // Placeholder for future commands - they will be added as stories progress
  program
    .command('status')
    .description('Show the current status of Substrate')
    .action(() => {
      logger.info(`Substrate v${version} - Ready`)
      logger.info('No active session. Use `substrate run <task-graph>` to start.')
    })

  // Register adapters command group (story 1.3)
  registerAdaptersCommand(program, version)

  // Register init command (story 1.4)
  registerInitCommand(program, version)

  // Register config command group (story 1.4)
  registerConfigCommand(program, version)

  return program
}

/** Main entry point */
async function main(): Promise<void> {
  try {
    const program = await createProgram()
    await program.parseAsync(process.argv)
  } catch (error) {
    logger.error({ error }, 'CLI error')
    process.exit(1)
  }
}

// Run if this is the main module
// Errors are handled internally by main() which calls process.exit(1)
void main()
