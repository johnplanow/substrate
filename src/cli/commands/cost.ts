/**
 * `substrate cost` command
 *
 * Displays cost breakdown for the current or specified session.
 *
 * Usage:
 *   substrate cost                          Default session cost summary
 *   substrate cost --session <id>           Costs for specified session
 *   substrate cost --by-task                Per-task cost breakdown (AC2)
 *   substrate cost --by-agent               Per-agent cost breakdown (AC3)
 *   substrate cost --by-billing             Billing mode breakdown (AC4)
 *   substrate cost --include-planning       Include planning costs in report (AC5)
 *   substrate cost --output-format json     JSON output (AC6)
 *   substrate cost --json                   JSON shorthand
 *
 * Exit codes:
 *   0 - Success (including empty cost data)
 *   1 - Error (database not found, query error, etc.)
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync } from 'fs'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import {
  getSessionCostSummary,
  getAllCostEntriesFiltered,
  getSessionCostSummaryFiltered,
  getPlanningCostTotal,
} from '../../persistence/queries/cost.js'
import { getLatestSessionId } from '../../persistence/queries/sessions.js'
import { formatTable, buildJsonOutput } from '../utils/formatting.js'
import type { CLIJsonOutput } from '../utils/formatting.js'
import type { SessionCostSummary, AgentCostBreakdown, CostEntry } from '../../modules/cost-tracker/types.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('cost-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const COST_EXIT_SUCCESS = 0
export const COST_EXIT_ERROR = 1

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the cost action.
 */
export interface CostActionOptions {
  sessionId?: string
  outputFormat: 'table' | 'json' | 'csv'
  byTask: boolean
  byAgent: boolean
  byBilling: boolean
  includePlanning: boolean
  projectRoot: string
  version?: string
}

/**
 * JSON data payload for `substrate cost --output-format json`.
 */
export interface CostJsonData {
  session_id: string
  summary: SessionCostSummary
  tasks?: CostEntry[]
  agents?: AgentCostBreakdown[]
}

// ---------------------------------------------------------------------------
// Table formatters
// ---------------------------------------------------------------------------

/**
 * Format the default session cost summary as a human-readable display.
 *
 * When `includePlanning` is false (the default), a separate "Planning Costs"
 * line is appended showing the excluded planning cost amount so the user
 * can see how much was spent on planning even though it is excluded from
 * the totals above.
 *
 * @param summary         - The session cost summary (may or may not include planning)
 * @param includePlanning - Whether planning costs are already included in the summary totals
 * @param planningCostUsd - The total planning cost (used when includePlanning=false to show the excluded amount)
 */
export function formatCostSummaryTable(
  summary: SessionCostSummary,
  includePlanning = true,
  planningCostUsd = 0,
): string {
  const lines: string[] = []

  lines.push(`Session: ${summary.session_id}`)
  if (summary.created_at) {
    lines.push(`Date:    ${summary.created_at}`)
  }
  lines.push('')
  lines.push(`Total Cost:    $${summary.total_cost_usd.toFixed(4)}`)
  lines.push(`  Subscription: $${summary.subscription_cost_usd.toFixed(4)} (${summary.subscription_task_count} task${summary.subscription_task_count === 1 ? '' : 's'})`)
  lines.push(`  API Billed:   $${summary.api_cost_usd.toFixed(4)} (${summary.api_task_count} task${summary.api_task_count === 1 ? '' : 's'})`)
  lines.push(`  Savings:      $${summary.savings_usd.toFixed(4)}`)

  // When planning costs are excluded from the totals, show them separately (AC5)
  if (!includePlanning && planningCostUsd > 0) {
    lines.push(`  Planning Costs (excluded): $${planningCostUsd.toFixed(4)}`)
  }

  // Budget status (from story 4.3)
  if (summary.budget_usd !== undefined && summary.budget_usd !== null) {
    lines.push('')
    lines.push(`Budget: $${summary.budget_usd.toFixed(2)} cap`)
    if (summary.remaining_budget_usd !== undefined) {
      lines.push(`  Remaining: $${summary.remaining_budget_usd.toFixed(2)}`)
    }
    if (summary.percentage_used !== undefined) {
      lines.push(`  Used: ${summary.percentage_used.toFixed(1)}%`)
    }
    if (summary.budget_status) {
      lines.push(`  Status: ${summary.budget_status}`)
    }
  }

  if (summary.savings_usd > 0) {
    lines.push('')
    lines.push(summary.savingsSummary)
  }

  return lines.join('\n')
}

/**
 * Format cost entries as a per-task table (AC2).
 */
export function formatByTaskTable(entries: CostEntry[]): string {
  if (entries.length === 0) {
    return 'No task cost entries found'
  }

  const headers = ['Task ID', 'Agent', 'Billing Mode', 'Cost ($)', 'Savings ($)']
  const keys = ['taskId', 'agent', 'billingMode', 'cost', 'savings']

  const rows: Record<string, string>[] = entries.map((e) => ({
    taskId: e.task_id ?? '(no task)',
    agent: e.agent,
    billingMode: e.billing_mode,
    cost: e.cost_usd.toFixed(4),
    savings: e.savings_usd.toFixed(4),
  }))

  return formatTable(headers, rows, keys)
}

/**
 * Format the per-agent breakdown table (AC3).
 */
export function formatByAgentTable(breakdown: AgentCostBreakdown[]): string {
  if (breakdown.length === 0) {
    return 'No agent cost data found'
  }

  const headers = ['Agent', 'Tasks', 'Sub Tasks', 'API Tasks', 'Cost ($)', 'Savings ($)']
  const keys = ['agent', 'taskCount', 'subTasks', 'apiTasks', 'cost', 'savings']

  const rows: Record<string, string>[] = breakdown.map((b) => ({
    agent: b.agent,
    taskCount: String(b.task_count),
    subTasks: String(b.subscription_tasks),
    apiTasks: String(b.api_tasks),
    cost: b.cost_usd.toFixed(4),
    savings: b.savings_usd.toFixed(4),
  }))

  return formatTable(headers, rows, keys)
}

/**
 * Format the billing mode breakdown table (AC4).
 */
export function formatByBillingTable(summary: SessionCostSummary): string {
  const headers = ['Billing Mode', 'Tasks', 'Cost ($)', 'Savings ($)']
  const keys = ['billingMode', 'tasks', 'cost', 'savings']

  const rows: Record<string, string>[] = [
    {
      billingMode: 'subscription',
      tasks: String(summary.subscription_task_count),
      cost: summary.subscription_cost_usd.toFixed(4),
      savings: summary.savings_usd.toFixed(4),
    },
    {
      billingMode: 'api',
      tasks: String(summary.api_task_count),
      cost: summary.api_cost_usd.toFixed(4),
      savings: '0.0000',
    },
  ]

  return formatTable(headers, rows, keys)
}

/**
 * Quote a CSV field value, escaping embedded quotes and wrapping in double-quotes
 * when the value contains commas, double-quotes, or newlines.
 */
function csvField(value: string | number | null): string {
  if (value === null) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/**
 * Format cost data as CSV (AC6).
 *
 * When task entries are provided, outputs per-task rows.
 * Otherwise outputs a session summary row.
 */
export function formatCostCsv(summary: SessionCostSummary, taskEntries?: CostEntry[]): string {
  if (taskEntries && taskEntries.length > 0) {
    const header = 'task_id,agent,billing_mode,cost_usd,savings_usd'
    const rows = taskEntries.map((e) =>
      [
        csvField(e.task_id ?? null),
        csvField(e.agent),
        csvField(e.billing_mode),
        csvField(e.cost_usd.toFixed(4)),
        csvField(e.savings_usd.toFixed(4)),
      ].join(','),
    )
    return [header, ...rows].join('\n')
  }

  const header = 'session_id,total_cost_usd,subscription_cost_usd,api_cost_usd,savings_usd'
  const row = [
    csvField(summary.session_id),
    csvField(summary.total_cost_usd.toFixed(4)),
    csvField(summary.subscription_cost_usd.toFixed(4)),
    csvField(summary.api_cost_usd.toFixed(4)),
    csvField(summary.savings_usd.toFixed(4)),
  ].join(',')
  return [header, row].join('\n')
}

// ---------------------------------------------------------------------------
// runCostAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the cost command.
 *
 * Returns exit code. Separated from Commander integration for testability.
 */
export async function runCostAction(options: CostActionOptions): Promise<number> {
  const {
    sessionId: explicitSessionId,
    outputFormat,
    byTask,
    byAgent,
    byBilling,
    includePlanning,
    projectRoot,
    version = '0.0.0',
  } = options

  const dbPath = join(projectRoot, '.substrate', 'state.db')

  // Check if database exists
  if (!existsSync(dbPath)) {
    process.stderr.write(
      `Error: No Substrate database found at ${dbPath}. Run 'substrate init' first.\n`,
    )
    return COST_EXIT_ERROR
  }

  // Validate output format (FIX 4)
  const validFormats = ['table', 'json', 'csv']
  if (!validFormats.includes(outputFormat)) {
    process.stderr.write(
      `Error: Invalid output format '${outputFormat}'. Valid formats: ${validFormats.join(', ')}\n`,
    )
    return COST_EXIT_ERROR
  }

  let wrapper: DatabaseWrapper | null = null

  try {
    // Open database
    wrapper = new DatabaseWrapper(dbPath)
    wrapper.open()
    const db = wrapper.db

    // Null guard on db (FIX 5)
    if (!db) {
      process.stderr.write('Database connection failed\n')
      return COST_EXIT_ERROR
    }

    // Run migrations to ensure schema is up-to-date
    runMigrations(db)

    // Resolve session ID
    let sessionId: string | null = explicitSessionId ?? null
    if (!sessionId) {
      sessionId = getLatestSessionId(db)
    }

    if (!sessionId) {
      if (outputFormat === 'json') {
        const output = buildJsonOutput('substrate cost', { message: 'No cost data found', sessions: [] }, version)
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
      } else {
        process.stdout.write('No cost data found\n')
      }
      return COST_EXIT_SUCCESS
    }

    // Get cost data — when includePlanning=false, use the filtered variant
    const summary = includePlanning
      ? getSessionCostSummary(db, sessionId)
      : getSessionCostSummaryFiltered(db, sessionId, false)

    // Compute planning cost separately for display when excluded (AC5)
    // Uses a targeted single-query function to avoid a second full summary round-trip.
    const planningCostUsd = includePlanning ? 0 : getPlanningCostTotal(db, sessionId)

    // Check for empty data (AC8)
    if (summary.task_count === 0) {
      if (outputFormat === 'json') {
        const output: CLIJsonOutput<CostJsonData> = buildJsonOutput('substrate cost', {
          session_id: sessionId,
          summary,
        }, version)
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
      } else {
        process.stdout.write('No cost data found\n')
      }
      return COST_EXIT_SUCCESS
    }

    // Helper: get cost entries filtered by includePlanning flag (FIX 3)
    // Uses getAllCostEntriesFiltered from queries which applies SQL-level category filter
    const getFilteredEntries = (): CostEntry[] =>
      getAllCostEntriesFiltered(db, sessionId as string, includePlanning)

    // Handle JSON output (AC6)
    if (outputFormat === 'json') {
      const jsonData: CostJsonData = {
        session_id: sessionId,
        summary,
      }

      if (byTask) {
        jsonData.tasks = getFilteredEntries()
      }

      if (byAgent) {
        jsonData.agents = summary.per_agent_breakdown
      }

      const output: CLIJsonOutput<CostJsonData> = buildJsonOutput('substrate cost', jsonData, version)
      process.stdout.write(JSON.stringify(output, null, 2) + '\n')
      return COST_EXIT_SUCCESS
    }

    // Handle CSV output (AC6)
    if (outputFormat === 'csv') {
      const csvOutput = formatCostCsv(summary, byTask ? getFilteredEntries() : undefined)
      process.stdout.write(csvOutput + '\n')
      return COST_EXIT_SUCCESS
    }

    // Handle human-readable table output
    if (byTask) {
      // AC2: per-task breakdown (FIX 3: respects includePlanning filter)
      const entries = getFilteredEntries()
      process.stdout.write(formatByTaskTable(entries) + '\n')
    } else if (byAgent) {
      // AC3: per-agent breakdown
      process.stdout.write(formatByAgentTable(summary.per_agent_breakdown) + '\n')
    } else if (byBilling) {
      // AC4: billing mode breakdown
      process.stdout.write(formatByBillingTable(summary) + '\n')
    } else {
      // AC1: default summary (FIX 2: pass planning cost info)
      process.stdout.write(formatCostSummaryTable(summary, includePlanning, planningCostUsd) + '\n')
    }

    return COST_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runCostAction failed')
    return COST_EXIT_ERROR
  } finally {
    if (wrapper !== null) {
      try {
        wrapper.close()
      } catch {
        // Ignore close errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// registerCostCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate cost` command with the CLI program.
 *
 * @param program     - Commander program instance
 * @param version     - Current Substrate package version (for JSON output)
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerCostCommand(
  program: Command,
  version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('cost')
    .description('Show cost breakdown for the current session')
    .option('--session <id>', 'Session ID to report on (defaults to latest)')
    .option(
      '--output-format <format>',
      'Output format: table (default), json, or csv',
      'table',
    )
    .option('--json', 'Output JSON (shorthand for --output-format json)', false)
    .option('--by-task', 'Show cost breakdown by task', false)
    .option('--by-agent', 'Show cost breakdown by agent', false)
    .option('--by-billing', 'Show cost breakdown by billing mode', false)
    .option('--include-planning', 'Include planning costs in report', false)
    .action(async (opts: {
      session?: string
      outputFormat: string
      json: boolean
      byTask: boolean
      byAgent: boolean
      byBilling: boolean
      includePlanning: boolean
    }) => {
      // Resolve output format: --json flag overrides --output-format
      const outputFormat = opts.json
        ? 'json'
        : opts.outputFormat as 'table' | 'json' | 'csv'

      const exitCode = await runCostAction({
        ...(opts.session !== undefined && { sessionId: opts.session }),
        outputFormat,
        byTask: opts.byTask,
        byAgent: opts.byAgent,
        byBilling: opts.byBilling,
        includePlanning: opts.includePlanning,
        projectRoot,
        version,
      })

      process.exitCode = exitCode
    })
}
