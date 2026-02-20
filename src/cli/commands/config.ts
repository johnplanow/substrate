/**
 * `substrate config` command group
 *
 * Subcommands:
 *   - `substrate config show`         — display merged config (credentials masked)
 *   - `substrate config set <key> <value>` — update a project config value
 */

import type { Command } from 'commander'
import yaml from 'js-yaml'
import { createConfigSystem } from '../../modules/config/config-system-impl.js'
import { ConfigError } from '../../core/errors.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('config-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const CONFIG_EXIT_SUCCESS = 0
export const CONFIG_EXIT_ERROR = 1
export const CONFIG_EXIT_INVALID = 2

// ---------------------------------------------------------------------------
// Coerce string value to appropriate JS type
// ---------------------------------------------------------------------------

function coerceValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10)
  if (/^-?\d*\.\d+$/.test(trimmed)) return parseFloat(trimmed)
  return trimmed
}

// ---------------------------------------------------------------------------
// `config show` action
// ---------------------------------------------------------------------------

export interface ConfigShowOptions {
  projectConfigDir?: string
  globalConfigDir?: string
  format?: 'yaml' | 'json'
}

export async function runConfigShow(opts: ConfigShowOptions = {}): Promise<number> {
  const system = createConfigSystem({
    ...(opts.projectConfigDir !== undefined && { projectConfigDir: opts.projectConfigDir }),
    ...(opts.globalConfigDir !== undefined && { globalConfigDir: opts.globalConfigDir }),
  })

  try {
    await system.load()
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`  Configuration error: ${err.message}\n`)
      return CONFIG_EXIT_INVALID
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'Failed to load configuration')
    process.stderr.write(`  Error loading configuration: ${message}\n`)
    return CONFIG_EXIT_ERROR
  }

  const masked = system.getMasked()
  const format = opts.format ?? 'yaml'

  if (format === 'json') {
    process.stdout.write(JSON.stringify(masked, null, 2) + '\n')
  } else {
    process.stdout.write('# Substrate Configuration (credentials masked)\n\n')
    process.stdout.write(yaml.dump(masked))
  }

  return CONFIG_EXIT_SUCCESS
}

// ---------------------------------------------------------------------------
// `config set` action
// ---------------------------------------------------------------------------

export interface ConfigSetOptions {
  projectConfigDir?: string
  globalConfigDir?: string
}

export async function runConfigSet(
  key: string,
  rawValue: string,
  opts: ConfigSetOptions = {}
): Promise<number> {
  if (!key || key.trim() === '') {
    process.stderr.write('  Error: key must not be empty\n')
    return CONFIG_EXIT_INVALID
  }

  const value = coerceValue(rawValue)

  const system = createConfigSystem({
    ...(opts.projectConfigDir !== undefined && { projectConfigDir: opts.projectConfigDir }),
    ...(opts.globalConfigDir !== undefined && { globalConfigDir: opts.globalConfigDir }),
  })

  try {
    await system.load()
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`  Configuration error: ${err.message}\n`)
      return CONFIG_EXIT_INVALID
    }
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`  Error loading configuration: ${message}\n`)
    return CONFIG_EXIT_ERROR
  }

  try {
    await system.set(key, value)
    process.stdout.write(`  Set ${key} = ${JSON.stringify(value)}\n`)
    return CONFIG_EXIT_SUCCESS
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`  Error: ${err.message}\n`)
      return CONFIG_EXIT_INVALID
    }
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`  Error updating configuration: ${message}\n`)
    return CONFIG_EXIT_ERROR
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register the `config` command group on a Commander program.
 */
export function registerConfigCommand(
  program: Command,
  _version: string
): void {
  const configCmd = program
    .command('config')
    .description('View and modify Substrate configuration')

  // -----------------------------------------------------------------------
  // config show
  // -----------------------------------------------------------------------
  configCmd
    .command('show')
    .description('Display the merged configuration with credentials masked')
    .option('--format <format>', 'Output format: yaml (default) or json', 'yaml')
    .option('--project-config-dir <dir>', 'Path to project .substrate/ directory')
    .option('--global-config-dir <dir>', 'Path to global .substrate/ directory')
    .action(
      async (opts: {
        format: string
        projectConfigDir?: string
        globalConfigDir?: string
      }) => {
        const exitCode = await runConfigShow({
          format: opts.format as 'yaml' | 'json',
          ...(opts.projectConfigDir !== undefined && { projectConfigDir: opts.projectConfigDir }),
          ...(opts.globalConfigDir !== undefined && { globalConfigDir: opts.globalConfigDir }),
        })
        process.exit(exitCode)
      }
    )

  // -----------------------------------------------------------------------
  // config set
  // -----------------------------------------------------------------------
  configCmd
    .command('set <key> <value>')
    .description(
      'Set a configuration value using dot-notation (e.g. global.log_level debug)'
    )
    .option('--project-config-dir <dir>', 'Path to project .substrate/ directory')
    .option('--global-config-dir <dir>', 'Path to global .substrate/ directory')
    .action(
      async (
        key: string,
        value: string,
        opts: {
          projectConfigDir?: string
          globalConfigDir?: string
        }
      ) => {
        const exitCode = await runConfigSet(key, value, {
          ...(opts.projectConfigDir !== undefined && { projectConfigDir: opts.projectConfigDir }),
          ...(opts.globalConfigDir !== undefined && { globalConfigDir: opts.globalConfigDir }),
        })
        process.exit(exitCode)
      }
    )
}
