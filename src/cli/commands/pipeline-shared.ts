/**
 * Shared utilities for pipeline commands (run, resume, status, health, etc.)
 *
 * Extracted from auto.ts during CLI flattening — all pipeline commands
 * import shared types, constants, and formatters from this module.
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { createRequire } from 'node:module'
import type { PipelineRun, TokenUsageSummary } from '../../persistence/queries/decisions.js'
import { VALID_PHASES } from '../../modules/stop-after/index.js'

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/**
 * Parse a DB timestamp string to a Date, correctly treating it as UTC.
 *
 * SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" without a timezone suffix.
 * JavaScript's Date constructor parses strings without a timezone suffix as
 * *local time*, which causes staleness/duration to be calculated incorrectly
 * on machines not in UTC.
 *
 * Fix: append 'Z' if the string has no timezone marker so it is always
 * parsed as UTC.
 */
export function parseDbTimestampAsUtc(ts: string): Date {
  if (ts.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(ts)) {
    return new Date(ts)
  }
  return new Date(ts.replace(' ', 'T') + 'Z')
}

// ---------------------------------------------------------------------------
// Package root resolution (ESM-compatible)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Find the package root by walking up until we find package.json.
 * Works regardless of build output structure (tsdown bundles into
 * dist/cli/index.js, not dist/cli/commands/auto.js).
 */
export function findPackageRoot(startDir: string): string {
  let dir = startDir
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir
    dir = dirname(dir)
  }
  return startDir
}

// Static export for tests (3 levels is correct from src/cli/commands/)
export const PACKAGE_ROOT = join(__dirname, '..', '..', '..')

/**
 * Resolve the absolute path to the bmad-method package's src/ directory.
 * Uses createRequire so it works in ESM without import.meta.resolve polyfills.
 * Returns null if bmad-method is not installed.
 */
export function resolveBmadMethodSrcPath(fromDir: string = __dirname): string | null {
  try {
    const require = createRequire(join(fromDir, 'synthetic.js'))
    const pkgJsonPath = require.resolve('bmad-method/package.json')
    return join(dirname(pkgJsonPath), 'src')
  } catch {
    return null
  }
}

/**
 * Read the version field from bmad-method's package.json.
 * Returns 'unknown' if not resolvable.
 */
export function resolveBmadMethodVersion(fromDir: string = __dirname): string {
  try {
    const require = createRequire(join(fromDir, 'synthetic.js'))
    const pkgJsonPath = require.resolve('bmad-method/package.json')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(pkgJsonPath) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** BMAD baseline token total for full pipeline comparison (analysis+planning+solutioning+implementation) */
export const BMAD_BASELINE_TOKENS_FULL = 56_800

/** BMAD baseline token total for create+dev+review comparison */
export const BMAD_BASELINE_TOKENS = 23_800

/** Story key pattern: <epic>-<story> e.g. "10-1" */
export const STORY_KEY_PATTERN = /^\d+-\d+$/

/**
 * Top-level keys in .claude/settings.json that substrate owns.
 * On init, these are set/updated unconditionally.
 * User-defined keys outside this set are never touched.
 */
export const SUBSTRATE_OWNED_SETTINGS_KEYS = ['statusLine'] as const

export function getSubstrateDefaultSettings(): Record<string, unknown> {
  return {
    statusLine: {
      type: 'command',
      command: 'bash "$CLAUDE_PROJECT_DIR"/.claude/statusline.sh',
      padding: 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export type OutputFormat = 'human' | 'json'

/**
 * Format output according to the requested format.
 */
export function formatOutput(
  data: unknown,
  format: OutputFormat,
  success = true,
  errorMessage?: string,
): string {
  if (format === 'json') {
    if (!success) {
      return JSON.stringify({ success: false, error: errorMessage ?? 'Unknown error' })
    }
    return JSON.stringify({ success: true, data })
  }
  // Human format: return data as-is if string, otherwise pretty-print
  if (typeof data === 'string') return data
  return JSON.stringify(data, null, 2)
}

/**
 * Build a human-readable token telemetry display from summary rows.
 */
export function formatTokenTelemetry(summary: TokenUsageSummary[], baselineTokens = BMAD_BASELINE_TOKENS): string {
  if (summary.length === 0) {
    return 'No token usage recorded.'
  }

  let totalInput = 0
  let totalOutput = 0
  let totalCost = 0

  const lines: string[] = ['Pipeline Token Usage:']
  for (const row of summary) {
    totalInput += row.total_input_tokens
    totalOutput += row.total_output_tokens
    totalCost += row.total_cost_usd
    const cost = `$${row.total_cost_usd.toFixed(4)}`
    lines.push(
      `  ${row.phase} (${row.agent}): ${row.total_input_tokens.toLocaleString()} input / ${row.total_output_tokens.toLocaleString()} output (${cost})`,
    )
  }
  lines.push('  ' + '─'.repeat(55))

  const costDisplay = `$${totalCost.toFixed(4)}`
  lines.push(
    `  Total:  ${totalInput.toLocaleString()} input / ${totalOutput.toLocaleString()} output (${costDisplay})`,
  )

  const totalTokens = totalInput + totalOutput
  const savingsPct =
    baselineTokens > 0
      ? Math.round(((baselineTokens - totalTokens) / baselineTokens) * 100)
      : 0
  const savingsLabel =
    savingsPct >= 0
      ? `Savings: ${savingsPct}%`
      : `Overhead: +${Math.abs(savingsPct)}%`
  lines.push(
    `  BMAD Baseline: ${baselineTokens.toLocaleString()} tokens → ${savingsLabel}`,
  )

  return lines.join('\n')
}

/**
 * Validate a story key has the expected format: <epic>-<story> (e.g., "10-1").
 */
export function validateStoryKey(key: string): boolean {
  return STORY_KEY_PATTERN.test(key)
}

// ---------------------------------------------------------------------------
// Phase-level status formatting
// ---------------------------------------------------------------------------

export interface PhaseStatusInfo {
  status: 'complete' | 'running' | 'pending'
  started_at?: string
  completed_at?: string
  token_usage?: { input: number; output: number }
}

export interface PipelineStatusOutput {
  run_id: string
  current_phase: string | null
  phases: Record<string, PhaseStatusInfo>
  total_tokens: { input: number; output: number; cost_usd: number }
  decisions_count: number
  stories_count: number
  /** ISO-8601 timestamp of the most recent pipeline activity (Story 16-7 AC4) */
  last_activity: string
  /** Seconds since last pipeline activity (Story 16-7 AC4) */
  staleness_seconds: number
}

/**
 * Build the AC5 JSON status schema for a pipeline run.
 */
export function buildPipelineStatusOutput(
  run: PipelineRun,
  tokenSummary: TokenUsageSummary[],
  decisionsCount: number,
  storiesCount: number,
): PipelineStatusOutput {
  const phases: Record<string, PhaseStatusInfo> = {}

  // Build per-phase token usage map
  const phaseTokenMap: Record<string, { input: number; output: number }> = {}
  for (const row of tokenSummary) {
    if (!phaseTokenMap[row.phase]) {
      phaseTokenMap[row.phase] = { input: 0, output: 0 }
    }
    phaseTokenMap[row.phase].input += row.total_input_tokens
    phaseTokenMap[row.phase].output += row.total_output_tokens
  }

  // Parse phase history from config_json
  let phaseHistory: Array<{ phase: string; startedAt?: string; completedAt?: string }> = []
  try {
    if (run.config_json) {
      const config = JSON.parse(run.config_json) as {
        phaseHistory?: Array<{ phase: string; startedAt?: string; completedAt?: string }>
      }
      phaseHistory = config.phaseHistory ?? []
    }
  } catch {
    // ignore
  }

  const currentPhase = run.current_phase ?? null

  // Build status for each built-in phase
  for (const phaseName of VALID_PHASES) {
    const historyEntry = phaseHistory.find((h) => h.phase === phaseName)
    const tokenUsage = phaseTokenMap[phaseName] ?? { input: 0, output: 0 }

    if (historyEntry?.completedAt) {
      phases[phaseName] = {
        status: 'complete',
        completed_at: historyEntry.completedAt,
        token_usage: tokenUsage,
      }
      if (historyEntry.startedAt) {
        phases[phaseName].started_at = historyEntry.startedAt
      }
    } else if (phaseName === currentPhase || historyEntry?.startedAt) {
      phases[phaseName] = {
        status: 'running',
        started_at: historyEntry?.startedAt,
        token_usage: tokenUsage,
      }
    } else {
      phases[phaseName] = {
        status: 'pending',
      }
    }
  }

  // Compute totals
  let totalInput = 0
  let totalOutput = 0
  let totalCost = 0
  for (const row of tokenSummary) {
    totalInput += row.total_input_tokens
    totalOutput += row.total_output_tokens
    totalCost += row.total_cost_usd
  }

  return {
    run_id: run.id,
    current_phase: currentPhase,
    phases,
    total_tokens: {
      input: totalInput,
      output: totalOutput,
      cost_usd: totalCost,
    },
    decisions_count: decisionsCount,
    stories_count: storiesCount,
    last_activity: run.updated_at,
    staleness_seconds: Math.round((Date.now() - parseDbTimestampAsUtc(run.updated_at).getTime()) / 1000),
  }
}

/**
 * Format a pipeline status summary in human-readable format.
 */
export function formatPipelineStatusHuman(status: PipelineStatusOutput): string {
  const lines: string[] = []
  lines.push(`Pipeline Run: ${status.run_id}`)
  lines.push(`  Current Phase: ${status.current_phase ?? 'N/A'}`)
  lines.push('')
  lines.push('  Phase Status:')

  const statusIcons: Record<string, string> = {
    complete: '[DONE]',
    running: '[RUN] ',
    pending: '[    ]',
  }

  for (const [phaseName, phaseInfo] of Object.entries(status.phases)) {
    const icon = statusIcons[phaseInfo.status] ?? '[?]'
    let line = `    ${icon} ${phaseName}`
    if (phaseInfo.status === 'complete' && phaseInfo.completed_at) {
      line += ` (completed: ${phaseInfo.completed_at})`
    }
    if (phaseInfo.token_usage && (phaseInfo.token_usage.input > 0 || phaseInfo.token_usage.output > 0)) {
      line += ` — tokens: ${phaseInfo.token_usage.input.toLocaleString()} in / ${phaseInfo.token_usage.output.toLocaleString()} out`
    }
    lines.push(line)
  }

  lines.push('')
  lines.push(`  Total Tokens: ${(status.total_tokens.input + status.total_tokens.output).toLocaleString()} (in: ${status.total_tokens.input.toLocaleString()}, out: ${status.total_tokens.output.toLocaleString()})`)
  lines.push(`  Total Cost: $${status.total_tokens.cost_usd.toFixed(4)}`)
  lines.push(`  Decisions: ${status.decisions_count}`)
  lines.push(`  Stories: ${status.stories_count}`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Pipeline summary
// ---------------------------------------------------------------------------

/**
 * Format a complete pipeline run summary.
 */
export function formatPipelineSummary(
  run: PipelineRun,
  tokenSummary: TokenUsageSummary[],
  decisionsCount: number,
  storiesCount: number,
  durationMs: number,
  format: OutputFormat,
): string {
  let totalInput = 0
  let totalOutput = 0
  let totalCost = 0
  for (const row of tokenSummary) {
    totalInput += row.total_input_tokens
    totalOutput += row.total_output_tokens
    totalCost += row.total_cost_usd
  }

  const totalTokens = totalInput + totalOutput
  const savingsPct =
    BMAD_BASELINE_TOKENS_FULL > 0
      ? Math.round(((BMAD_BASELINE_TOKENS_FULL - totalTokens) / BMAD_BASELINE_TOKENS_FULL) * 100)
      : 0

  const durationSec = Math.round(durationMs / 1000)

  if (format === 'json') {
    return JSON.stringify({
      run_id: run.id,
      status: run.status,
      duration_ms: durationMs,
      phases_completed: VALID_PHASES.length,
      decisions_count: decisionsCount,
      stories_count: storiesCount,
      token_usage: {
        input: totalInput,
        output: totalOutput,
        total: totalTokens,
        cost_usd: totalCost,
        bmad_baseline: BMAD_BASELINE_TOKENS_FULL,
        savings_pct: savingsPct,
      },
    })
  }

  const lines: string[] = [
    '┌─────────────────────────────────────────────────────┐',
    '│              Pipeline Run Summary                    │',
    '└─────────────────────────────────────────────────────┘',
    `  Run ID:          ${run.id}`,
    `  Status:          ${run.status}`,
    `  Duration:        ${durationSec}s`,
    `  Phases Complete: ${VALID_PHASES.length}`,
    `  Decisions:       ${decisionsCount}`,
    `  Stories:         ${storiesCount}`,
    '',
    `  Token Usage:     ${totalTokens.toLocaleString()} total`,
    `    Input:         ${totalInput.toLocaleString()}`,
    `    Output:        ${totalOutput.toLocaleString()}`,
    `    Cost:          $${totalCost.toFixed(4)}`,
    '',
    `  BMAD Baseline:   ${BMAD_BASELINE_TOKENS_FULL.toLocaleString()} tokens`,
    `  Token Savings:   ${savingsPct >= 0 ? savingsPct + '%' : 'N/A (overhead)'}`,
  ]

  return lines.join('\n')
}
