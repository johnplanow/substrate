/**
 * `substrate monitor` command group
 *
 * Provides subcommands for monitoring agent performance and metrics:
 *
 * Usage:
 *   substrate monitor report                  Full performance report (AC1)
 *   substrate monitor report --since <date>   Filter by ISO date (AC2)
 *   substrate monitor report --days <n>       Filter last N days (AC3)
 *   substrate monitor report --output-format json  JSON output (AC4)
 *   substrate monitor report --json            JSON shorthand (AC4)
 *   substrate monitor report --include-recommendations  Include routing recs (AC5)
 *   substrate monitor status                   Data summary (AC6)
 *   substrate monitor status --json            JSON output (AC6)
 *   substrate monitor reset                    Clear all data with confirmation (AC7)
 *   substrate monitor reset --force            Skip confirmation (AC7)
 *   substrate monitor recommendations          Routing recommendations (AC8)
 *   substrate monitor recommendations --json   JSON output (AC8)
 *
 * Exit codes:
 *   0 - Success (including empty data)
 *   1 - Error (database not found, query error, invalid options)
 */

import type { Command } from 'commander'
import { Command as CommanderCommand } from 'commander'
import { join } from 'path'
import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { createInterface } from 'readline'
import { MonitorDatabaseImpl } from '../../persistence/monitor-database.js'
import { RecommendationEngine } from '../../modules/monitor/recommendation-engine.js'
import { generateMonitorReport } from '../../modules/monitor/report-generator.js'
import { formatTable, buildJsonOutput } from '../utils/formatting.js'
import type { CLIJsonOutput } from '../utils/formatting.js'
import type { MonitorReport } from '../../modules/monitor/report-generator.js'
import type { Recommendation, RecommendationExport } from '../../modules/monitor/recommendation-types.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('monitor-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const MONITOR_EXIT_SUCCESS = 0
export const MONITOR_EXIT_ERROR = 1

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MonitorReportOptions {
  since?: string
  days?: number
  outputFormat: 'table' | 'json'
  includeRecommendations: boolean
  projectRoot: string
  version?: string
}

export interface MonitorStatusOptions {
  outputFormat: 'table' | 'json'
  projectRoot: string
  version?: string
}

export interface MonitorResetOptions {
  force: boolean
  projectRoot: string
}

export interface MonitorRecommendationsOptions {
  outputFormat: 'table' | 'json'
  projectRoot: string
  version?: string
}

// ---------------------------------------------------------------------------
// DB path resolution
// ---------------------------------------------------------------------------

/**
 * Locate the monitor database file.
 *
 * Checks project-local path first ({projectRoot}/.substrate/monitor.db),
 * then falls back to the global path (~/.substrate/monitor.db).
 *
 * Returns null if neither file exists.
 */
export function resolveMonitorDbPath(projectRoot: string): string | null {
  const projectLocalPath = join(projectRoot, '.substrate', 'monitor.db')
  if (existsSync(projectLocalPath)) {
    return projectLocalPath
  }

  const globalPath = join(homedir(), '.substrate', 'monitor.db')
  if (existsSync(globalPath)) {
    return globalPath
  }

  return null
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format the per-agent summary table.
 */
export function formatAgentSummaryTable(agents: MonitorReport['agents']): string {
  if (agents.length === 0) {
    return 'No agent data available'
  }

  const headers = ['Agent', 'Total Tasks', 'Success Rate', 'Failure Rate', 'Avg Tokens', 'Avg Duration (ms)']
  const keys = ['agent', 'totalTasks', 'successRate', 'failureRate', 'avgTokens', 'avgDuration']

  const rows: Record<string, string>[] = agents.map((a) => ({
    agent: a.agent,
    totalTasks: String(a.total_tasks),
    successRate: `${a.success_rate.toFixed(1)}%`,
    failureRate: `${a.failure_rate.toFixed(1)}%`,
    avgTokens: a.average_tokens.toFixed(0),
    avgDuration: a.average_duration.toFixed(0),
  }))

  return formatTable(headers, rows, keys)
}

/**
 * Format the per-task-type breakdown. Each task type gets its own section.
 */
export function formatTaskTypeTable(taskTypes: MonitorReport['task_types']): string {
  if (taskTypes.length === 0) {
    return 'No task type data available'
  }

  const sections: string[] = []

  for (const tt of taskTypes) {
    sections.push(`Task Type: ${tt.task_type} (${String(tt.total_tasks)} total tasks)`)

    if (tt.agents.length === 0) {
      sections.push('  No agent data for this task type')
    } else {
      const headers = ['Agent', 'Success Rate', 'Avg Tokens', 'Sample Size']
      const keys = ['agent', 'successRate', 'avgTokens', 'sampleSize']

      const rows: Record<string, string>[] = tt.agents.map((a) => ({
        agent: a.agent,
        successRate: `${a.success_rate.toFixed(1)}%`,
        avgTokens: a.average_tokens.toFixed(0),
        sampleSize: String(a.sample_size),
      }))

      sections.push(formatTable(headers, rows, keys))
    }
    sections.push('')
  }

  return sections.join('\n').trimEnd()
}

/**
 * Format the recommendations table.
 */
export function formatRecommendationsTable(recommendations: Recommendation[]): string {
  if (recommendations.length === 0) {
    return 'No routing recommendations available'
  }

  const headers = ['Task Type', 'Current Agent', 'Recommended Agent', 'Confidence', 'Improvement %', 'Reason']
  const keys = ['taskType', 'currentAgent', 'recommendedAgent', 'confidence', 'improvement', 'reason']

  const rows: Record<string, string>[] = recommendations.map((r) => ({
    taskType: r.task_type,
    currentAgent: r.current_agent,
    recommendedAgent: r.recommended_agent,
    confidence: r.confidence,
    improvement: `${r.improvement_percentage.toFixed(1)}%`,
    reason: r.reason,
  }))

  return formatTable(headers, rows, keys)
}

/**
 * Assemble the full human-readable monitor report string.
 */
export function formatMonitorReport(report: MonitorReport): string {
  const lines: string[] = []

  lines.push('=== Monitor Report ===')
  lines.push(`Generated: ${report.generated_at}`)

  if (report.time_range) {
    lines.push(`Time Range: ${report.time_range.since} — ${report.time_range.until}`)
  }

  lines.push('')
  lines.push('--- Summary ---')
  lines.push(`Total Tasks:      ${String(report.summary.total_tasks)}`)
  lines.push(`Total Agents:     ${String(report.summary.total_agents)}`)
  lines.push(`Total Task Types: ${String(report.summary.total_task_types)}`)
  if (report.summary.date_range.earliest) {
    lines.push(`Earliest Data:    ${report.summary.date_range.earliest}`)
  }
  if (report.summary.date_range.latest) {
    lines.push(`Latest Data:      ${report.summary.date_range.latest}`)
  }

  lines.push('')
  lines.push('--- Per-Agent Performance ---')
  lines.push(formatAgentSummaryTable(report.agents))

  lines.push('')
  lines.push('--- Per-Task-Type Breakdown ---')
  lines.push(formatTaskTypeTable(report.task_types))

  if (report.recommendations !== undefined) {
    lines.push('')
    lines.push('--- Routing Recommendations ---')
    if (report.recommendations.count === 0) {
      lines.push('No routing recommendations available')
    } else {
      lines.push(formatRecommendationsTable(report.recommendations.recommendations))
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// runMonitorReportAction
// ---------------------------------------------------------------------------

/**
 * Core action for `substrate monitor report`.
 * Returns exit code.
 */
export async function runMonitorReportAction(options: MonitorReportOptions): Promise<number> {
  const { since, days, outputFormat, includeRecommendations, projectRoot, version = '0.0.0' } = options

  // Validate mutual exclusivity of --since and --days (AC3)
  if (since !== undefined && days !== undefined) {
    process.stderr.write('Error: --since and --days are mutually exclusive. Provide only one.\n')
    return MONITOR_EXIT_ERROR
  }

  // Locate the monitor database
  const dbPath = resolveMonitorDbPath(projectRoot)
  if (dbPath === null) {
    process.stderr.write('Error: No monitor database found. Run some tasks first to collect metrics.\n')
    return MONITOR_EXIT_ERROR
  }

  // Compute sinceDate from options
  let sinceDate: string | undefined
  if (since !== undefined) {
    // Validate the date string before constructing the ISO string (Issue #2)
    const parsedDate = new Date(since)
    if (isNaN(parsedDate.getTime())) {
      process.stderr.write(`Error: Invalid date value for --since: "${since}". Use an ISO 8601 date (e.g. 2026-01-01 or 2026-01-01T00:00:00Z).\n`)
      return MONITOR_EXIT_ERROR
    }
    sinceDate = parsedDate.toISOString()
  } else if (days !== undefined) {
    // Guard against NaN from parseInt (Issue #3)
    if (isNaN(days)) {
      process.stderr.write('Error: Invalid value for --days. Provide a positive integer (e.g. --days 7).\n')
      return MONITOR_EXIT_ERROR
    }
    sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  }

  let monitorDb: MonitorDatabaseImpl | null = null

  try {
    monitorDb = new MonitorDatabaseImpl(dbPath)

    const report = generateMonitorReport(monitorDb, {
      sinceDate,
      includeRecommendations,
    })

    // Check if there's any data in the time range
    if (report.summary.total_tasks === 0 && (since !== undefined || days !== undefined)) {
      const message = 'No data in specified time range'
      if (outputFormat === 'json') {
        const output = buildJsonOutput('substrate monitor report', { message, report }, version)
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
      } else {
        process.stdout.write(message + '\n')
      }
      return MONITOR_EXIT_SUCCESS
    }

    if (outputFormat === 'json') {
      const output: CLIJsonOutput<MonitorReport> = buildJsonOutput(
        'substrate monitor report',
        report,
        version,
      )
      process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    } else {
      process.stdout.write(formatMonitorReport(report) + '\n')
    }

    return MONITOR_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runMonitorReportAction failed')
    return MONITOR_EXIT_ERROR
  } finally {
    if (monitorDb !== null) {
      try {
        monitorDb.close()
      } catch {
        // Ignore close errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// runMonitorStatusAction
// ---------------------------------------------------------------------------

/**
 * Core action for `substrate monitor status`.
 * Returns exit code.
 */
export async function runMonitorStatusAction(options: MonitorStatusOptions): Promise<number> {
  const { outputFormat, projectRoot, version = '0.0.0' } = options

  const dbPath = resolveMonitorDbPath(projectRoot)
  if (dbPath === null) {
    process.stderr.write('Error: No monitor database found. Run some tasks first to collect metrics.\n')
    return MONITOR_EXIT_ERROR
  }

  let monitorDb: MonitorDatabaseImpl | null = null

  try {
    monitorDb = new MonitorDatabaseImpl(dbPath)

    const aggregates = monitorDb.getAggregates()

    // Compute distinct agents and task types
    const distinctAgents = [...new Set(aggregates.map((a) => a.agent))]
    const distinctTaskTypes = [...new Set(aggregates.map((a) => a.taskType))]
    const totalTasks = aggregates.reduce((sum, a) => sum + a.totalTasks, 0)

    // Get date range from last_updated field
    const allDates = aggregates
      .map((a) => a.lastUpdated)
      .filter((d): d is string => typeof d === 'string' && d.length > 0)

    const earliestDate = allDates.length > 0 ? allDates.reduce((a, b) => (a < b ? a : b)) : null
    const latestDate = allDates.length > 0 ? allDates.reduce((a, b) => (a > b ? a : b)) : null

    // Get database file size
    let dbSizeBytes = 0
    try {
      dbSizeBytes = statSync(dbPath).size
    } catch {
      // ignore
    }

    const statusData = {
      total_tasks: totalTasks,
      date_range: { earliest: earliestDate, latest: latestDate },
      agents: distinctAgents.sort(),
      task_types: distinctTaskTypes.sort(),
      database: {
        path: dbPath,
        size_bytes: dbSizeBytes,
      },
    }

    if (outputFormat === 'json') {
      const output = buildJsonOutput('substrate monitor status', statusData, version)
      process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    } else {
      const lines: string[] = []
      lines.push('=== Monitor Status ===')
      lines.push(`Total Tasks Tracked:  ${totalTasks}`)
      lines.push(`Date Range:           ${earliestDate ?? 'N/A'} — ${latestDate ?? 'N/A'}`)
      lines.push(`Agents Tracked:       ${distinctAgents.length > 0 ? distinctAgents.join(', ') : 'None'}`)
      lines.push(`Task Types Tracked:   ${distinctTaskTypes.length > 0 ? distinctTaskTypes.join(', ') : 'None'}`)
      lines.push(`Database Path:        ${dbPath}`)
      lines.push(`Database Size:        ${(dbSizeBytes / 1024).toFixed(1)} KB`)
      process.stdout.write(lines.join('\n') + '\n')
    }

    return MONITOR_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runMonitorStatusAction failed')
    return MONITOR_EXIT_ERROR
  } finally {
    if (monitorDb !== null) {
      try {
        monitorDb.close()
      } catch {
        // Ignore close errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// runMonitorResetAction
// ---------------------------------------------------------------------------

/**
 * Core action for `substrate monitor reset`.
 * Returns exit code.
 */
export async function runMonitorResetAction(options: MonitorResetOptions): Promise<number> {
  const { force, projectRoot } = options

  const dbPath = resolveMonitorDbPath(projectRoot)
  if (dbPath === null) {
    process.stderr.write('Error: No monitor database found.\n')
    return MONITOR_EXIT_ERROR
  }

  // Confirmation prompt unless --force is provided (AC7)
  if (!force) {
    const confirmed = await promptConfirmation(
      "This will delete all monitor metrics. Type 'yes' to confirm: ",
    )

    if (confirmed !== 'yes') {
      process.stdout.write('Reset cancelled\n')
      return MONITOR_EXIT_SUCCESS
    }
  }

  let monitorDb: MonitorDatabaseImpl | null = null

  try {
    monitorDb = new MonitorDatabaseImpl(dbPath)
    monitorDb.resetAllData()

    process.stdout.write('Monitor data reset successfully\n')
    return MONITOR_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runMonitorResetAction failed')
    return MONITOR_EXIT_ERROR
  } finally {
    if (monitorDb !== null) {
      try {
        monitorDb.close()
      } catch {
        // Ignore close errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// runMonitorRecommendationsAction
// ---------------------------------------------------------------------------

/**
 * Core action for `substrate monitor recommendations`.
 * Returns exit code.
 */
export async function runMonitorRecommendationsAction(
  options: MonitorRecommendationsOptions,
): Promise<number> {
  const { outputFormat, projectRoot, version = '0.0.0' } = options

  const dbPath = resolveMonitorDbPath(projectRoot)
  if (dbPath === null) {
    const message = 'No monitor database found. Run some tasks first to collect metrics.'
    if (outputFormat === 'json') {
      const output = buildJsonOutput(
        'substrate monitor recommendations',
        { message, recommendations: [] },
        version,
      )
      process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    } else {
      process.stdout.write(message + '\n')
    }
    return MONITOR_EXIT_SUCCESS
  }

  let monitorDb: MonitorDatabaseImpl | null = null

  try {
    monitorDb = new MonitorDatabaseImpl(dbPath)
    const engine = new RecommendationEngine(monitorDb)
    const exported: RecommendationExport = engine.exportRecommendationsJson()

    if (outputFormat === 'json') {
      const output = buildJsonOutput('substrate monitor recommendations', exported, version)
      process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    } else {
      if (exported.count === 0) {
        process.stdout.write('No recommendations available\n')
      } else {
        const lines: string[] = []
        lines.push('=== Routing Recommendations ===')
        lines.push(`Generated: ${exported.generated_at}`)
        lines.push(`Total: ${exported.count} recommendation(s)`)
        lines.push('')
        lines.push(formatRecommendationsTable(exported.recommendations))
        process.stdout.write(lines.join('\n') + '\n')
      }
    }

    return MONITOR_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runMonitorRecommendationsAction failed')
    return MONITOR_EXIT_ERROR
  } finally {
    if (monitorDb !== null) {
      try {
        monitorDb.close()
      } catch {
        // Ignore close errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Prompt user for confirmation and return the trimmed input.
 * Reads from stdin.
 */
function promptConfirmation(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// ---------------------------------------------------------------------------
// registerMonitorCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate monitor` command group with the CLI program.
 *
 * @param program     - Commander program instance
 * @param version     - Current Substrate package version (for JSON output)
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerMonitorCommand(
  program: Command,
  version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  const monitorCmd = program
    .command('monitor')
    .description('Monitor agent performance and metrics')

  // --- report subcommand ---
  const reportCmd = new CommanderCommand('report')
    .description('Display comprehensive agent performance report')
    .option('--since <date>', 'Only include metrics from this ISO date forward')
    .option('--days <n>', 'Only include metrics from the last N days', (v) => parseInt(v, 10))
    .option(
      '--output-format <format>',
      'Output format: table (default) or json',
      'table',
    )
    .option('--json', 'Output JSON (shorthand for --output-format json)', false)
    .option('--include-recommendations', 'Include routing recommendations in report', false)
    .action(
      async (opts: {
        since?: string
        days?: number
        outputFormat: string
        json: boolean
        includeRecommendations: boolean
      }) => {
        const outputFormat = opts.json ? 'json' : (opts.outputFormat as 'table' | 'json')
        const exitCode = await runMonitorReportAction({
          since: opts.since,
          days: opts.days,
          outputFormat,
          includeRecommendations: opts.includeRecommendations,
          projectRoot,
          version,
        })
        process.exitCode = exitCode
      },
    )

  // --- status subcommand ---
  const statusCmd = new CommanderCommand('status')
    .description('Display summary of collected monitor data')
    .option(
      '--output-format <format>',
      'Output format: table (default) or json',
      'table',
    )
    .option('--json', 'Output JSON (shorthand for --output-format json)', false)
    .action(
      async (opts: {
        outputFormat: string
        json: boolean
      }) => {
        const outputFormat = opts.json ? 'json' : (opts.outputFormat as 'table' | 'json')
        const exitCode = await runMonitorStatusAction({
          outputFormat,
          projectRoot,
          version,
        })
        process.exitCode = exitCode
      },
    )

  // --- reset subcommand ---
  const resetCmd = new CommanderCommand('reset')
    .description('Clear all monitor metrics (with confirmation)')
    .option('--force', 'Skip confirmation prompt', false)
    .action(async (opts: { force: boolean }) => {
      const exitCode = await runMonitorResetAction({
        force: opts.force,
        projectRoot,
      })
      process.exitCode = exitCode
    })

  // --- recommendations subcommand ---
  const recommendationsCmd = new CommanderCommand('recommendations')
    .description('Display routing recommendations based on performance data')
    .option(
      '--output-format <format>',
      'Output format: table (default) or json',
      'table',
    )
    .option('--json', 'Output JSON (shorthand for --output-format json)', false)
    .action(
      async (opts: {
        outputFormat: string
        json: boolean
      }) => {
        const outputFormat = opts.json ? 'json' : (opts.outputFormat as 'table' | 'json')
        const exitCode = await runMonitorRecommendationsAction({
          outputFormat,
          projectRoot,
          version,
        })
        process.exitCode = exitCode
      },
    )

  monitorCmd.addCommand(reportCmd)
  monitorCmd.addCommand(statusCmd)
  monitorCmd.addCommand(resetCmd)
  monitorCmd.addCommand(recommendationsCmd)
}
