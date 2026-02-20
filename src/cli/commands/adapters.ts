/**
 * `substrate adapters` command group
 *
 * Provides two subcommands:
 *   - `substrate adapters list`  — discover all known adapters and show availability
 *   - `substrate adapters check` — run health checks and report CLI agent status
 */

import type { Command } from 'commander'
import { AdapterRegistry } from '../../adapters/adapter-registry.js'
import {
  buildAdapterListRows,
  buildAdapterHealthRows,
  formatAdapterListTable,
  formatAdapterHealthTable,
  buildJsonOutput,
  healthResultToJson,
} from '../utils/formatting.js'

/** Exit codes used by adapters commands */
export const EXIT_CODE_SUCCESS = 0
export const EXIT_CODE_ERROR = 1
export const EXIT_CODE_NO_ADAPTERS = 2

/** Supported output formats */
type OutputFormat = 'table' | 'json'

/** Installation hint for each adapter */
const INSTALL_HINTS: Record<string, string> = {
  'claude-code': 'Install Claude Code: https://claude.ai/code',
  codex: 'Install Codex CLI: npm install -g @openai/codex',
  gemini: 'Install Gemini CLI: https://ai.google.dev/gemini-api/cli',
}

/**
 * Determine whether an adapter result represents a "not installed" state.
 *
 * An adapter is considered not installed when its health check failed AND it
 * has no detectable CLI path.  This is the single canonical check used by
 * both `list` and `check` subcommands so that the two never disagree about
 * whether a given adapter entry counts as "absent from the system".
 */
function isNotInstalled(healthResult: {
  healthy: boolean
  cliPath?: string
}): boolean {
  return !healthResult.healthy && !healthResult.cliPath
}

/**
 * Register the `adapters` command group onto a Commander program.
 *
 * @param program   The root Commander program
 * @param version   The current Substrate package version (for JSON output)
 * @param registry  Optional AdapterRegistry to use (defaults to new instance)
 */
export function registerAdaptersCommand(
  program: Command,
  version: string,
  registry?: AdapterRegistry
): void {
  const adaptersCmd = program
    .command('adapters')
    .description('Manage and inspect CLI agent adapters')

  // -------------------------------------------------------------------------
  // `substrate adapters list`
  // -------------------------------------------------------------------------
  adaptersCmd
    .command('list')
    .description('List all known adapters with availability status')
    .option(
      '--output-format <format>',
      'Output format: table (default) or json',
      'table'
    )
    .option('--verbose', 'Show additional detail in output', false)
    .action(async (opts: { outputFormat: string; verbose: boolean }) => {
      const outputFormat = opts.outputFormat as OutputFormat
      // TODO: AdapterRegistry should be initialized at CLI startup and injected
      // (dependency injection) rather than constructed fresh per command invocation.
      const reg = registry ?? new AdapterRegistry()

      // Run discovery to get health results for all adapters
      const report = await reg.discoverAndRegister()

      if (outputFormat === 'json') {
        const jsonData = report.results.map((r) =>
          healthResultToJson(r.adapterId, r.displayName, r.healthResult)
        )
        const output = buildJsonOutput('substrate adapters list', jsonData, version)
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
        // NOTE: `list --output-format json` intentionally exits 0 even when
        // adapters are unhealthy/unavailable.  The `list` command reports what
        // adapters *exist* (available or not), so the presence of unavailable
        // adapters is not an error condition for this command — it is expected
        // output.  Only an empty results array (no adapters defined at all)
        // triggers a non-zero exit.  The `check` subcommand uses stricter exit
        // codes because its purpose is to verify operational health.
        if (report.results.length === 0) {
          process.exit(EXIT_CODE_NO_ADAPTERS)
        } else {
          process.exit(EXIT_CODE_SUCCESS)
        }
      }

      // Human-readable table output
      const rows = buildAdapterListRows(report.results)

      if (rows.length === 0) {
        process.stdout.write(
          'No adapters found. Please install Claude Code, Codex CLI, or Gemini CLI.\n'
        )
        for (const hint of Object.values(INSTALL_HINTS)) {
          process.stdout.write(`  - ${hint}\n`)
        }
        process.exit(EXIT_CODE_NO_ADAPTERS)
      }

      // `list` always shows the table, even when all adapters are unavailable.
      // It is the job of `check` to report operational health failures.
      process.stdout.write(formatAdapterListTable(rows) + '\n')

      if (opts.verbose) {
        for (const result of report.results) {
          const health = result.healthResult
          if (!health.healthy && health.error) {
            process.stdout.write(`\n[${result.adapterId}] Error: ${health.error}\n`)
          }
        }
      }

      // `list` exits 0 as long as adapters are defined, regardless of their
      // availability status.  Use `substrate adapters check` for health-based exit codes.
      process.exit(EXIT_CODE_SUCCESS)
    })

  // -------------------------------------------------------------------------
  // `substrate adapters check`
  // -------------------------------------------------------------------------
  adaptersCmd
    .command('check')
    .description('Run health checks on all adapters and verify headless mode')
    .option(
      '--output-format <format>',
      'Output format: table (default) or json',
      'table'
    )
    .option('--verbose', 'Show additional detail including error messages', false)
    .action(async (opts: { outputFormat: string; verbose: boolean }) => {
      const outputFormat = opts.outputFormat as OutputFormat
      // TODO: AdapterRegistry should be initialized at CLI startup and injected
      // (dependency injection) rather than constructed fresh per command invocation.
      const reg = registry ?? new AdapterRegistry()

      // Run discovery (performs health checks on all built-in adapters)
      const report = await reg.discoverAndRegister()

      // Use the single unified isNotInstalled() check so that both subcommands
      // always agree on whether an adapter is considered absent from the system.
      const noneInstalled =
        report.results.length > 0 &&
        report.results.every((r) => isNotInstalled(r.healthResult))

      if (outputFormat === 'json') {
        const jsonData = report.results.map((r) =>
          healthResultToJson(r.adapterId, r.displayName, r.healthResult)
        )
        const output = buildJsonOutput('substrate adapters check', jsonData, version)
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')

        // Exit code based on health results
        if (noneInstalled) {
          process.exit(EXIT_CODE_NO_ADAPTERS)
        } else if (report.failedCount > 0) {
          process.exit(EXIT_CODE_ERROR)
        } else {
          process.exit(EXIT_CODE_SUCCESS)
        }
      }

      // Human-readable table output
      if (noneInstalled) {
        process.stdout.write(
          'No adapters found. Please install Claude Code, Codex CLI, or Gemini CLI.\n'
        )
        for (const hint of Object.values(INSTALL_HINTS)) {
          process.stdout.write(`  - ${hint}\n`)
        }
        process.exit(EXIT_CODE_NO_ADAPTERS)
      }

      const rows = buildAdapterHealthRows(report.results)
      process.stdout.write(formatAdapterHealthTable(rows) + '\n')

      if (opts.verbose) {
        for (const result of report.results) {
          const health = result.healthResult
          if (!health.healthy && health.error) {
            process.stdout.write(`\n[${result.displayName}] Error: ${health.error}\n`)
          }
        }
      }

      // Exit code: 0 if all healthy, 1 if any unhealthy but some found
      if (report.failedCount === 0) {
        process.exit(EXIT_CODE_SUCCESS)
      } else {
        process.exit(EXIT_CODE_ERROR)
      }
    })
}
