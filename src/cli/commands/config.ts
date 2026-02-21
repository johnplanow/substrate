/**
 * `substrate config` command group
 *
 * Subcommands:
 *   - `substrate config show`                  — display merged config (credentials masked)
 *   - `substrate config set <key> <value>`      — update a project config value
 *   - `substrate config export`                 — export merged config to stdout or file
 *   - `substrate config import <file>`          — import config from file with diff preview
 */

import type { Command } from 'commander'
import yaml from 'js-yaml'
import { writeFile, readFile } from 'fs/promises'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createConfigSystem } from '../../modules/config/config-system-impl.js'
import { ConfigError } from '../../core/errors.js'
import { PartialSubstrateConfigSchema } from '../../modules/config/config-schema.js'
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
// Flatten config helper (dot-notation leaf paths)
// ---------------------------------------------------------------------------

function flattenConfig(obj: unknown, prefix: string = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (obj === null || obj === undefined || typeof obj !== 'object' || Array.isArray(obj)) {
    if (prefix !== '') {
      result[prefix] = obj
    }
    return result
  }
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (
      val !== null &&
      val !== undefined &&
      typeof val === 'object' &&
      !Array.isArray(val)
    ) {
      Object.assign(result, flattenConfig(val, fullKey))
    } else {
      result[fullKey] = val
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// `config export` action
// ---------------------------------------------------------------------------

export interface ConfigExportOptions {
  output?: string
  outputFormat?: 'yaml' | 'json'
  projectConfigDir?: string
  globalConfigDir?: string
}

export async function runConfigExport(opts: ConfigExportOptions = {}): Promise<number> {
  const system = createConfigSystem({
    ...(opts.projectConfigDir !== undefined && { projectConfigDir: opts.projectConfigDir }),
    ...(opts.globalConfigDir !== undefined && { globalConfigDir: opts.globalConfigDir }),
  })

  try {
    await system.load()
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Error: ${err.message}\n`)
      return CONFIG_EXIT_INVALID
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'Failed to load configuration')
    process.stderr.write(`Error loading configuration: ${message}\n`)
    return CONFIG_EXIT_ERROR
  }

  const masked = system.getMasked()
  const format = opts.outputFormat ?? 'yaml'
  const timestamp = new Date().toISOString()

  let serialized: string
  if (format === 'json') {
    serialized = JSON.stringify(masked, null, 2) + '\n'
  } else {
    serialized = `# Substrate Configuration Export — ${timestamp}\n` + yaml.dump(masked)
  }

  if (opts.output) {
    try {
      await writeFile(opts.output, serialized, 'utf-8')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: Failed to write file: ${message}\n`)
      return CONFIG_EXIT_ERROR
    }
    process.stdout.write(`Configuration exported to ${opts.output}\n`)
  } else {
    process.stdout.write(serialized)
  }

  return CONFIG_EXIT_SUCCESS
}

// ---------------------------------------------------------------------------
// `config import` action
// ---------------------------------------------------------------------------

export interface ConfigImportOptions {
  yes?: boolean
  projectConfigDir?: string
  globalConfigDir?: string
  /** When true, bypass the readline prompt (for testing) */
  autoConfirm?: boolean
}

export async function runConfigImport(
  filePath: string,
  opts: ConfigImportOptions = {}
): Promise<number> {
  // Check file existence
  if (!existsSync(filePath)) {
    process.stderr.write(`Error: Config file not found: ${filePath}\n`)
    return CONFIG_EXIT_INVALID
  }

  // Read and parse file
  let rawContent: string
  try {
    rawContent = await readFile(filePath, 'utf-8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: Failed to read config file: ${message}\n`)
    return CONFIG_EXIT_INVALID
  }

  const ext = filePath.toLowerCase()
  let parsed: unknown
  try {
    if (ext.endsWith('.json')) {
      parsed = JSON.parse(rawContent)
    } else {
      // .yaml and .yml
      parsed = yaml.load(rawContent)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: Failed to parse config file: ${message}\n`)
    return CONFIG_EXIT_INVALID
  }

  // Validate against PartialSubstrateConfigSchema
  const validation = PartialSubstrateConfigSchema.safeParse(parsed)
  if (!validation.success) {
    process.stderr.write('Error: Configuration validation failed:\n')
    for (const issue of validation.error.issues) {
      process.stderr.write(`  • ${issue.path.join('.')}: ${issue.message}\n`)
    }
    return CONFIG_EXIT_INVALID
  }

  // Load current config
  const system = createConfigSystem({
    ...(opts.projectConfigDir !== undefined && { projectConfigDir: opts.projectConfigDir }),
    ...(opts.globalConfigDir !== undefined && { globalConfigDir: opts.globalConfigDir }),
  })

  try {
    await system.load()
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Error: ${err.message}\n`)
      return CONFIG_EXIT_INVALID
    }
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error loading configuration: ${message}\n`)
    return CONFIG_EXIT_ERROR
  }

  const currentConfig = system.getConfig()

  // Flatten both configs
  const currentFlat = flattenConfig(currentConfig)
  const importedFlat = flattenConfig(validation.data)

  // Compute diff: keys in imported that are different from current
  const changedKeys: Array<{ key: string; from: unknown; to: unknown }> = []
  for (const [key, importedVal] of Object.entries(importedFlat)) {
    const currentVal = currentFlat[key]
    if (currentVal !== importedVal) {
      changedKeys.push({ key, from: currentVal, to: importedVal })
    }
  }

  // No changes
  if (changedKeys.length === 0) {
    process.stdout.write('No changes detected. Configuration is already up to date.\n')
    return CONFIG_EXIT_SUCCESS
  }

  // Display diff
  for (const { key, from, to } of changedKeys) {
    process.stdout.write(
      `  ${key}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}\n`
    )
  }

  // Prompt for confirmation unless --yes or autoConfirm
  if (!opts.yes && !opts.autoConfirm) {
    const confirmed = await new Promise<boolean>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      rl.question('Apply these changes? [y/N]: ', (answer) => {
        rl.close()
        resolve(answer === 'y' || answer === 'Y')
      })
    })

    if (!confirmed) {
      process.stdout.write('Import cancelled.\n')
      return CONFIG_EXIT_SUCCESS
    }
  }

  // Apply changes
  try {
    for (const { key, to } of changedKeys) {
      await system.set(key, to)
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Error: ${err.message}\n`)
      return CONFIG_EXIT_ERROR
    }
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error applying configuration: ${message}\n`)
    return CONFIG_EXIT_ERROR
  }

  process.stdout.write(
    `Configuration imported successfully. ${changedKeys.length} setting(s) updated.\n`
  )
  return CONFIG_EXIT_SUCCESS
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

  // -----------------------------------------------------------------------
  // config export
  // -----------------------------------------------------------------------
  configCmd
    .command('export')
    .description('Export the current merged configuration to stdout or a file (credentials masked)')
    .option('--output <file>', 'Write output to a file instead of stdout')
    .option('--output-format <format>', 'Output format: yaml (default) or json', 'yaml')
    .option('--project-config-dir <dir>', 'Path to project .substrate/ directory')
    .option('--global-config-dir <dir>', 'Path to global .substrate/ directory')
    .action(
      async (opts: {
        output?: string
        outputFormat?: string
        projectConfigDir?: string
        globalConfigDir?: string
      }) => {
        const exitCode = await runConfigExport({
          ...(opts.output !== undefined && { output: opts.output }),
          outputFormat: (opts.outputFormat ?? 'yaml') as 'yaml' | 'json',
          ...(opts.projectConfigDir !== undefined && { projectConfigDir: opts.projectConfigDir }),
          ...(opts.globalConfigDir !== undefined && { globalConfigDir: opts.globalConfigDir }),
        })
        process.exit(exitCode)
      }
    )

  // -----------------------------------------------------------------------
  // config import
  // -----------------------------------------------------------------------
  configCmd
    .command('import <file>')
    .description('Import configuration from a file, validate it, show diff, and apply')
    .option('-y, --yes', 'Apply changes without confirmation prompt')
    .option('--project-config-dir <dir>', 'Path to project .substrate/ directory')
    .option('--global-config-dir <dir>', 'Path to global .substrate/ directory')
    .action(
      async (
        file: string,
        opts: {
          yes?: boolean
          projectConfigDir?: string
          globalConfigDir?: string
        }
      ) => {
        const exitCode = await runConfigImport(file, {
          ...(opts.yes !== undefined && { yes: opts.yes }),
          ...(opts.projectConfigDir !== undefined && { projectConfigDir: opts.projectConfigDir }),
          ...(opts.globalConfigDir !== undefined && { globalConfigDir: opts.globalConfigDir }),
        })
        process.exit(exitCode)
      }
    )
}
