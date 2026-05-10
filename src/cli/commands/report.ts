/**
 * `substrate report` command — Story 71-1.
 *
 * Reads the run manifest and produces a structured completion report showing
 * per-story outcome classifications, cost vs ceiling, verification findings,
 * and escalation diagnostics.
 *
 * Phase D Story 54-5 (2026-04-05) extraction — Structured Completion Report.
 * Path A "recovered" outcomes classified here are produced by Epic 69 Story 69-1.
 * Recovery Engine (Epic 73) will programmatically consume this command's JSON output.
 *
 * AC13 (header citations): motivating incidents and forward consumers.
 *   - Phase D Story 54-5 — original spec for Structured Completion Report
 *   - Epic 69 Story 69-1 (v0.20.60) — produces "recovered" outcomes
 *   - Epic 70 (planned) — produces "verified" outcomes via verdict accuracy
 *   - Epic 73 (planned) — Recovery Engine will programmatically consume JSON
 *
 * Story 71-2 hot-fix (run-discovery canonical chain):
 *   Story 71-1's draft used an invented aggregate-manifest format
 *   (`.substrate/runs/manifest.json`) for "latest run" resolution. That file
 *   does NOT exist in production. Replaced with the canonical chain (matches
 *   status.ts/health.ts/reconcile-from-disk per Story 39-3 / 69-2):
 *     1. Explicit `--run <id>` argument
 *     2. `.substrate/current-run-id` file (via resolveRunManifest)
 *     3. `getLatestRun(adapter)` Dolt fallback
 */

import type { Command } from 'commander'
import { existsSync } from 'fs'
import { join } from 'path'
import { readFile, readdir, unlink } from 'fs/promises'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createLogger } from '../../utils/logger.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { resolveRunManifest } from './manifest-read.js'
import { DoltClient } from '../../modules/state/index.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import { getLatestRun } from '../../persistence/queries/decisions.js'
import { swallowDebug } from '@substrate-ai/core'
import type { HaltNotification } from '../../modules/interactive-prompt/index.js'
import {
  RunManifest,
  runAcTraceabilityCheck,
  type AcTraceabilityRow,
} from '@substrate-ai/sdlc'

const logger = createLogger('report')

// ---------------------------------------------------------------------------
// Raw manifest types (lenient — does not require full Zod schema compliance)
// Probe fixtures use simplified verification_result format; real manifests use
// the full StoredVerificationSummarySchema shape. We handle both here.
// ---------------------------------------------------------------------------

/** Single verification finding as stored in either format. */
interface RawFinding {
  severity: string
  category?: string
  message?: string
  _authoredBy?: string
}

/** Verification result — accepts both real format (checks[]) and probe fixture format. */
interface RawVerificationResult {
  status?: string
  /** Real manifest format: per-check results with findings arrays */
  checks?: Array<{
    checkName?: string
    status?: string
    findings?: RawFinding[]
  }>
  /** Probe fixture format: flat findings array */
  findings?: RawFinding[]
  /** Probe fixture format: explicit flag */
  verification_ran?: boolean
  /** Probe fixture format: pre-aggregated counts */
  error_count?: number
  warn_count?: number
  info_count?: number
}

/** Per-story state as read from raw JSON. */
interface RawStoryState {
  status: string
  phase?: string
  started_at?: string
  completed_at?: string
  review_cycles?: number
  cost_usd?: number
  dispatches?: number
  /** Set on escalated stories — reason classification string. */
  escalation_reason?: string
  verification_result?: RawVerificationResult
  /** Dev story signals including files_modified (Story 60-8 format). */
  dev_story_signals?: {
    files_modified?: string[]
    ac_met?: string[]
    ac_failures?: string[]
    result?: string
    tests?: string
  }
}

/** Full run manifest as read from raw JSON. */
interface RawManifest {
  run_id: string
  created_at?: string
  updated_at?: string
  run_status?: string
  story_scope?: string[]
  per_story_state: Record<string, RawStoryState>
  cost_accumulation?: {
    per_story?: Record<string, number>
    run_total?: number
  }
  cli_flags?: {
    cost_ceiling?: number
    [key: string]: unknown
  }
  recovery_history?: Array<{
    story_key: string
    attempt_number?: number
    [key: string]: unknown
  }>
}

// ---------------------------------------------------------------------------
// Exported JSDoc types for Epic 73 Recovery Engine consumption
// ---------------------------------------------------------------------------

/** Aggregated verification finding counts for a story. */
export interface VerificationFindings {
  error: number
  warn: number
  info: number
  byAuthor: Record<string, number>
}

/** Per-story summary row in the report. */
export interface StorySummary {
  story_key: string
  outcome: 'verified' | 'recovered' | 'escalated' | 'failed'
  wall_clock_ms?: number
  review_cycles: number
  cost_usd?: number
  verification_findings: VerificationFindings
  verification_ran?: boolean
}

/** Escalation diagnostic detail block. */
export interface EscalationDetail {
  story_key: string
  root_cause: string
  recovery_attempts: number
  suggested_operator_action: string
  blast_radius: string
}

/** Summary counts across all stories. */
export interface ReportSummary {
  verified: number
  recovered: number
  escalated: number
  failed: number
  total: number
}

/** Cost metadata for the report. */
export interface ReportCost {
  spent: number
  ceiling?: number
  utilization?: string
  overCeiling: boolean
}

/** Duration metadata for the report. */
export interface ReportDuration {
  started_at: string
  completed_at?: string
  wall_clock_ms?: number
}

/**
 * Per-story AC traceability result included in the report when --verify-ac is set.
 * Story 74-1: on-demand AC-to-test heuristic matching.
 */
export interface StoryAcTraceability {
  matrix: AcTraceabilityRow[]
  confidence: 'approximate'
}

/** Top-level structured JSON output — consumed by Epic 73 Recovery Engine. */
export interface ReportOutput {
  runId: string
  summary: ReportSummary
  stories: StorySummary[]
  escalations: EscalationDetail[]
  cost: ReportCost
  duration: ReportDuration
  /** Operator halt notifications read from .substrate/notifications/ (Story 73-2, AC12). */
  halts?: HaltNotification[]
  /**
   * AC traceability matrix keyed by storyKey.
   * Only present when --verify-ac flag is set (Story 74-1).
   */
  ac_traceability?: Record<string, StoryAcTraceability>
}

// Re-export HaltNotification so callers can use it without importing from interactive-prompt.
export type { HaltNotification }

// ---------------------------------------------------------------------------
// Pure helpers — no CLI dependencies, fully unit-testable
// ---------------------------------------------------------------------------

/**
 * Determine whether verification ran for a story.
 *
 * Handles both real manifest format (checks array) and probe fixture format
 * (explicit verification_ran boolean).
 */
function didVerificationRun(state: RawStoryState): boolean {
  const vr = state.verification_result
  if (!vr) return false
  if (typeof vr.verification_ran === 'boolean') return vr.verification_ran
  // Real format: verification ran if checks array is non-empty
  if (Array.isArray(vr.checks)) return vr.checks.length > 0
  return false
}

/**
 * Extract aggregated finding counts from a story's verification result.
 *
 * Handles both real manifest format (checks[].findings[]) and probe fixture
 * format (error_count / warn_count / info_count + flat findings[]).
 */
function extractVerificationFindings(state: RawStoryState): VerificationFindings {
  const vr = state.verification_result
  if (!vr) return { error: 0, warn: 0, info: 0, byAuthor: {} }

  const byAuthor: Record<string, number> = {}

  // If explicit pre-aggregated counts are present (probe fixture format), use them.
  if (typeof vr.error_count === 'number' || typeof vr.warn_count === 'number') {
    const error = vr.error_count ?? 0
    const warn = vr.warn_count ?? 0
    const info = vr.info_count ?? 0
    // Flat findings array (probe format) — extract byAuthor if present
    const findings: RawFinding[] = vr.findings ?? []
    for (const f of findings) {
      const author = f._authoredBy ?? 'unknown'
      byAuthor[author] = (byAuthor[author] ?? 0) + 1
    }
    return { error, warn, info, byAuthor }
  }

  // Real manifest format: aggregate from checks[].findings[]
  let error = 0
  let warn = 0
  let info = 0
  const allChecks = vr.checks ?? []
  for (const check of allChecks) {
    for (const f of check.findings ?? []) {
      if (f.severity === 'error') error++
      else if (f.severity === 'warn') warn++
      else if (f.severity === 'info') info++
      const author = f._authoredBy ?? 'unknown'
      byAuthor[author] = (byAuthor[author] ?? 0) + 1
    }
  }
  return { error, warn, info, byAuthor }
}

/**
 * Classify a story outcome based on its state in the manifest.
 *
 * Rules (AC3):
 * - `verified`  — status='complete' AND verification ran AND no error findings AND review_cycles=0
 * - `recovered` — status='complete' AND (verification_ran=false OR review_cycles>0)
 * - `escalated` — status='escalated'
 * - `failed`    — status='failed' (or any other non-complete, non-escalated status)
 *
 * This function is pure (no filesystem / Dolt access) and exported for unit testing.
 */
export function classifyStoryOutcome(state: RawStoryState, _manifest?: RawManifest): 'verified' | 'recovered' | 'escalated' | 'failed' {
  if (state.status === 'escalated') return 'escalated'
  if (state.status === 'failed') return 'failed'

  if (state.status === 'complete') {
    const verificationRan = didVerificationRun(state)
    if (!verificationRan) return 'recovered' // Path A reconciled — no verification ran

    // verification ran: check for error-severity findings
    const findings = extractVerificationFindings(state)
    const hasErrors = findings.error > 0
    const reviewCycles = state.review_cycles ?? 0

    if (!hasErrors && reviewCycles === 0) return 'verified'
    return 'recovered' // had errors OR went through review cycles
  }

  // Any other status (pending, dispatched, in-review, etc.) → treat as failed
  return 'failed'
}

/**
 * Build escalation diagnostic enrichment for a story (AC4).
 *
 * Maps escalation_reason to operator-actionable suggestions.
 */
export function enrichEscalation(
  storyKey: string,
  state: RawStoryState,
  runId: string,
  manifest: RawManifest,
): EscalationDetail {
  const root_cause = state.escalation_reason ?? 'unknown'
  const recovery_attempts =
    state.review_cycles ??
    (manifest.recovery_history ?? []).filter((e) => e.story_key === storyKey).length

  const blast_radius = `Story ${storyKey} in run ${runId} — ${recovery_attempts} recovery attempt(s)`

  let suggested_operator_action: string
  switch (root_cause) {
    case 'checkpoint-retry-timeout':
      suggested_operator_action = `Run \`substrate reconcile-from-disk --run ${runId}\` (Epic 69) — implementation may have shipped before timeout; gates will validate.`
      break
    case 'verification-fail-after-cycles':
      suggested_operator_action = `Read findings via \`substrate metrics --run ${runId} --findings\`; consider --max-review-cycles 3 retry.`
      break
    case 'dispatch:spawnsync-timeout':
      suggested_operator_action = `Agent dispatch timed out. Check system load and retry with \`substrate run --events --stories ${storyKey}\`.`
      break
    case 'cost-ceiling-exceeded':
      suggested_operator_action = `Cost ceiling was exceeded. Raise --cost-ceiling or break the story into smaller units before retrying.`
      break
    default:
      suggested_operator_action = `Inspect escalation details with \`substrate metrics --run ${runId}\` and manually review the story work before retrying.`
  }

  return {
    story_key: storyKey,
    root_cause,
    recovery_attempts,
    suggested_operator_action,
    blast_radius,
  }
}

// ---------------------------------------------------------------------------
// Notification file helpers (Story 73-2, AC6, AC12)
// ---------------------------------------------------------------------------

/**
 * Read all halt notification files for a given run from
 * .substrate/notifications/<runId>-*.json and delete them after reading (AC6).
 *
 * Returns an empty array if the notifications directory is absent or
 * no notifications exist for the given run ID.
 *
 * ENOENT is swallowed for each file (external monitors may delete files
 * between listing and reading — AC7 tolerance).
 */
export async function readNotificationsForRun(
  runId: string,
  dbRoot: string,
): Promise<HaltNotification[]> {
  const notifDir = join(dbRoot, '.substrate', 'notifications')
  let entries: string[]
  try {
    entries = await readdir(notifDir)
  } catch {
    // Directory absent — no notifications
    return []
  }

  const matching = entries.filter((f) => f.startsWith(`${runId}-`) && f.endsWith('.json'))
  const notifications: HaltNotification[] = []

  for (const filename of matching) {
    const filePath = join(notifDir, filename)
    try {
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as HaltNotification
      notifications.push(parsed)
    } catch (err) {
      // ENOENT: deleted by external monitor between listing and reading (AC7)
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, filePath }, 'failed to read notification file — skipping')
      }
      continue
    }

    // Delete after reading (AC6)
    try {
      await unlink(filePath)
    } catch (err) {
      // ENOENT: already deleted by external monitor — continue normally (AC7)
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, filePath }, 'failed to delete notification file — continuing')
      }
    }
  }

  return notifications
}

// ---------------------------------------------------------------------------
// Table alignment helper (~20 lines, no external deps — AC14)
// ---------------------------------------------------------------------------

/** Pad a string to a fixed width, truncating with '…' if necessary. */
function padCell(value: string, width: number): string {
  if (value.length > width) return value.slice(0, width - 1) + '…'
  return value.padEnd(width)
}

/** Format a row of columns with fixed widths, separated by ' | '. */
function formatRow(cells: string[], widths: number[]): string {
  return cells.map((c, i) => padCell(c, widths[i] ?? c.length)).join(' | ')
}

// ---------------------------------------------------------------------------
// Duration / cost helpers
// ---------------------------------------------------------------------------

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.floor((ms % 60_000) / 1000)
  return `${mins}m${secs}s`
}

function wallClockMs(state: RawStoryState): number | undefined {
  if (!state.started_at || !state.completed_at) return undefined
  const start = new Date(state.started_at).getTime()
  const end = new Date(state.completed_at).getTime()
  return isNaN(start) || isNaN(end) ? undefined : end - start
}

// ---------------------------------------------------------------------------
// Human-format renderer (AC5, AC9)
// ---------------------------------------------------------------------------

function renderHuman(output: ReportOutput, manifest: RawManifest): string {
  const lines: string[] = []

  const { runId, summary, stories, escalations, cost, duration, halts } = output

  // Banner
  const durationStr = duration.wall_clock_ms != null ? formatDurationMs(duration.wall_clock_ms) : 'unknown'
  const costStr = `$${cost.spent.toFixed(4)}`
  const ceilingStr = cost.ceiling != null
    ? ` / $${cost.ceiling.toFixed(4)} ceiling (${cost.utilization ?? '?'}) ${cost.overCeiling ? '[OVER CEILING]' : ''}`
    : ''
  const verdict =
    summary.escalated > 0 || summary.failed > 0 ? 'NEEDS ATTENTION' : 'ALL PASSED'

  lines.push(`══════════════════════════════════════════════════════════`)
  lines.push(`  Run: ${runId}`)
  lines.push(`  Duration: ${durationStr}`)
  lines.push(`  Cost: ${costStr}${ceilingStr}`)
  lines.push(`  Verdict: ${verdict}`)
  lines.push(`══════════════════════════════════════════════════════════`)
  lines.push('')

  // Summary line
  lines.push(
    `${summary.verified} verified, ${summary.recovered} recovered, ` +
    `${summary.escalated} escalated, ${summary.failed} failed of ${summary.total} total`,
  )
  lines.push('')

  // Per-story table
  const COL_WIDTHS = [50, 10, 10, 8, 10, 14, 10]
  const HEADERS = ['story_key', 'outcome', 'wall-clock', 'cycles', 'cost', 'findings', 'verified']
  lines.push(formatRow(HEADERS, COL_WIDTHS))
  lines.push(COL_WIDTHS.map((w) => '-'.repeat(w)).join('-+-'))

  for (const s of stories) {
    const wallClock = s.wall_clock_ms != null ? formatDurationMs(s.wall_clock_ms) : '-'
    const costCell = s.cost_usd != null ? `$${s.cost_usd.toFixed(4)}` : '-'
    const f = s.verification_findings
    const findingsCell = `E:${f.error} W:${f.warn} I:${f.info}`
    const verifiedTag = s.outcome === 'verified' ? '✓' : ''
    const key = s.story_key.length > 50 ? s.story_key.slice(0, 49) + '…' : s.story_key

    lines.push(formatRow([
      key,
      s.outcome,
      wallClock,
      String(s.review_cycles),
      costCell,
      findingsCell,
      verifiedTag,
    ], COL_WIDTHS))
  }
  lines.push('')

  // Escalation detail blocks (AC5)
  if (escalations.length > 0) {
    lines.push('──── Escalation Details ────')
    for (const esc of escalations) {
      lines.push('')
      lines.push(`  Story:              ${esc.story_key}`)
      lines.push(`  Root cause:         ${esc.root_cause}`)
      lines.push(`  Recovery attempts:  ${esc.recovery_attempts}`)
      lines.push(`  Blast radius:       ${esc.blast_radius}`)
      lines.push(`  Suggested action:   ${esc.suggested_operator_action}`)
    }
    lines.push('')
  }

  // Operator Halts section (Story 73-2, AC12)
  if (halts && halts.length > 0) {
    lines.push('──── Operator Halts ────')
    for (const halt of halts) {
      lines.push('')
      lines.push(`  Timestamp:          ${halt.timestamp}`)
      lines.push(`  Decision type:      ${halt.decisionType}`)
      lines.push(`  Severity:           ${halt.severity}`)
      lines.push(`  Operator choice:    ${halt.operatorChoice ?? '(none — non-interactive)'}`)
    }
    lines.push('')
  }

  // AC Traceability section (Story 74-1, --verify-ac)
  if (output.ac_traceability && Object.keys(output.ac_traceability).length > 0) {
    lines.push('──── AC Traceability (approximate) ────')
    for (const [storyKey, traceability] of Object.entries(output.ac_traceability)) {
      lines.push('')
      lines.push(`  Story: ${storyKey}`)
      if (traceability.matrix.length === 0) {
        lines.push('  (no acceptance criteria found)')
        continue
      }
      // Table header: AC | Matched | Test Name
      const AC_COL = 60
      const MATCH_COL = 9
      const TEST_COL = 50
      lines.push(
        '  ' +
          formatRow(['AC', 'Matched', 'Test Name'], [AC_COL, MATCH_COL, TEST_COL]),
      )
      lines.push('  ' + [AC_COL, MATCH_COL, TEST_COL].map((w) => '-'.repeat(w)).join('-+-'))
      for (const row of traceability.matrix) {
        lines.push(
          '  ' +
            formatRow(
              [row.acText, row.matched ? '✓' : '✗', row.testName ?? '—'],
              [AC_COL, MATCH_COL, TEST_COL],
            ),
        )
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// JSON-format renderer (AC6)
// ---------------------------------------------------------------------------

function renderJson(output: ReportOutput): string {
  return JSON.stringify(output, null, 2)
}

// ---------------------------------------------------------------------------
// Data assembly
// ---------------------------------------------------------------------------

/**
 * Build ReportOutput from a raw manifest.
 *
 * @param runId - Pipeline run ID.
 * @param manifest - Raw manifest data.
 * @param halts - Optional operator halt notifications (Story 73-2, AC12).
 */
function assembleReport(runId: string, manifest: RawManifest, halts?: HaltNotification[]): ReportOutput {
  const perStoryState = manifest.per_story_state ?? {}
  const storyKeys = Object.keys(perStoryState)

  // Duration
  const startedAt = manifest.created_at ?? ''
  const completedAt = manifest.updated_at
  let totalWallMs: number | undefined
  if (startedAt && completedAt) {
    const s = new Date(startedAt).getTime()
    const e = new Date(completedAt).getTime()
    if (!isNaN(s) && !isNaN(e)) totalWallMs = e - s
  }

  const duration: ReportDuration = {
    started_at: startedAt,
    completed_at: completedAt,
    wall_clock_ms: totalWallMs,
  }

  // Cost
  const spent = manifest.cost_accumulation?.run_total ?? 0
  const ceiling = manifest.cost_accumulation != null
    ? (manifest.cli_flags?.cost_ceiling as number | undefined)
    : undefined
  const utilization = ceiling != null && ceiling > 0
    ? `${((spent / ceiling) * 100).toFixed(1)}%`
    : undefined
  const overCeiling = ceiling != null ? spent > ceiling : false
  const cost: ReportCost = { spent, ceiling, utilization, overCeiling }

  // Stories
  const stories: StorySummary[] = []
  const escalations: EscalationDetail[] = []
  const summary: ReportSummary = { verified: 0, recovered: 0, escalated: 0, failed: 0, total: 0 }

  for (const key of storyKeys) {
    const state = perStoryState[key]!
    const outcome = classifyStoryOutcome(state, manifest)
    const findings = extractVerificationFindings(state)
    const verificationRan = didVerificationRun(state)
    const wc = wallClockMs(state)

    const storySummary: StorySummary = {
      story_key: key,
      outcome,
      wall_clock_ms: wc,
      review_cycles: state.review_cycles ?? 0,
      cost_usd: state.cost_usd,
      verification_findings: findings,
      verification_ran: verificationRan,
    }
    stories.push(storySummary)

    summary[outcome]++
    summary.total++

    if (outcome === 'escalated') {
      escalations.push(enrichEscalation(key, state, runId, manifest))
    }
  }

  return { runId, summary, stories, escalations, cost, duration, halts }
}

// ---------------------------------------------------------------------------
// Manifest resolution
// ---------------------------------------------------------------------------

/**
 * Read a single run manifest file directly (without strict Zod schema).
 * Handles both real manifests and probe fixture simplified formats.
 */
async function readRawManifest(runsDir: string, runId: string): Promise<RawManifest | null> {
  // Direct lookup first
  const directPath = join(runsDir, `${runId}.json`)
  try {
    const raw = await readFile(directPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const m = parsed as RawManifest
      if (typeof m.run_id === 'string' && typeof m.per_story_state === 'object') {
        return m
      }
    }
  } catch {
    // File missing or invalid JSON — fall through to scan
  }

  // Scan all JSON files for one with matching run_id (handles probe fixture mismatch)
  try {
    const entries = await readdir(runsDir)
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry === 'manifest.json') continue
      const filePath = join(runsDir, entry)
      try {
        const raw = await readFile(filePath, 'utf-8')
        const parsed = JSON.parse(raw) as unknown
        if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const m = parsed as RawManifest
          if (m.run_id === runId && typeof m.per_story_state === 'object') {
            return m
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // runsDir missing
  }

  return null
}

/**
 * Resolve the latest run ID via canonical chain (Story 71-2 hot-fix).
 *
 * Replaces Story 71-1's invented `.substrate/runs/manifest.json` aggregate
 * format with the canonical chain used by status.ts / health.ts /
 * reconcile-from-disk:
 *   1. `.substrate/current-run-id` is consulted by resolveRunManifest at the
 *      caller's site (not here); this helper handles the post-current-run-id
 *      fallback.
 *   2. `getLatestRun(adapter)` Dolt fallback — the canonical persistence
 *      source. Opens a temporary adapter and closes it before returning.
 *
 * Returns null when neither chain link yields a run ID.
 */
async function resolveLatestRunId(dbRoot: string): Promise<string | null> {
  // Dolt fallback. resolveRunManifest already tried current-run-id at the
  // caller's site; if we're here, that returned null, so jump to Dolt.
  const probeAdapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
  try {
    await initSchema(probeAdapter)
    const latest = await getLatestRun(probeAdapter)
    return latest?.id ?? null
  } catch {
    logger.debug('Dolt fallback failed during run-id resolution')
    return null
  } finally {
    await probeAdapter.close().catch(swallowDebug('report-probe-close'))
  }
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

interface ReportActionOptions {
  run?: string
  outputFormat: 'human' | 'json'
  projectRoot: string
  /** Internal test bypass — skips resolveMainRepoRoot and uses this path directly. */
  _dbRoot?: string
  /**
   * When true, run the AC-to-test traceability check for each completed story
   * and include the results in the report output (Story 74-1, AC3).
   */
  verifyAc?: boolean
}

export async function runReportAction(options: ReportActionOptions): Promise<number> {
  const { run: runArg, outputFormat, projectRoot, _dbRoot, verifyAc } = options

  // Support SUBSTRATE_PROJECT_ROOT env var override (used by runtime probes)
  const effectiveProjectRoot = process.env['SUBSTRATE_PROJECT_ROOT'] ?? projectRoot
  const dbRoot = _dbRoot ?? await resolveMainRepoRoot(effectiveProjectRoot)
  const runsDir = join(dbRoot, '.substrate', 'runs')

  logger.debug({ runArg, effectiveProjectRoot, dbRoot }, 'report action start')

  // ---------------------------------------------------------------------------
  // Step 1: Resolve run ID.
  //
  // Primary path: resolveRunManifest (manifest-read.ts) which reads from
  //   `.substrate/current-run-id` (for latest) or uses the explicit run ID directly.
  // Compatibility shim: probe fixtures and pre-52 runs may write the latest run ID
  //   to `.substrate/runs/manifest.json` instead of `current-run-id` — handled by
  //   resolveLatestRunId below.
  // ---------------------------------------------------------------------------

  let resolvedRunId: string | null = null
  let manifest: RawManifest | null = null

  const isExplicitId = runArg != null && runArg !== 'latest'

  if (isExplicitId) {
    resolvedRunId = runArg!
    // Primary: canonical RunManifest reader (Zod-validated)
    const canonical = await resolveRunManifest(dbRoot, resolvedRunId)
    if (canonical.manifest) {
      try {
        const data = await canonical.manifest.read()
        manifest = data as unknown as RawManifest
      } catch {
        // Canonical schema validation failed — fall through to compatibility shim
        logger.debug({ runId: resolvedRunId }, 'canonical manifest read failed — using raw shim')
      }
    }
    // Compatibility shim: raw JSON scan (handles probe fixtures / pre-Zod manifests)
    if (!manifest) {
      manifest = await readRawManifest(runsDir, resolvedRunId)
    }
  } else {
    // --run latest or no --run
    // Primary: resolveRunManifest reads `.substrate/current-run-id`
    const canonical = await resolveRunManifest(dbRoot, undefined)
    if (canonical.runId && canonical.manifest) {
      resolvedRunId = canonical.runId
      try {
        const data = await canonical.manifest.read()
        manifest = data as unknown as RawManifest
      } catch {
        logger.debug({ runId: canonical.runId }, 'canonical manifest read failed — using raw shim')
        manifest = null
      }
    }

    // Story 71-2 hot-fix: Dolt fallback for run-id discovery (canonical chain).
    if (!resolvedRunId) {
      resolvedRunId = await resolveLatestRunId(dbRoot)
      // After Dolt resolution, materialize the per-run manifest from disk.
      if (resolvedRunId) {
        const reread = await resolveRunManifest(dbRoot, resolvedRunId)
        if (reread.manifest) {
          try {
            const data = await reread.manifest.read()
            manifest = data as unknown as RawManifest
          } catch {
            logger.debug({ runId: resolvedRunId }, 'manifest read failed after Dolt resolution')
          }
        }
        // Compatibility shim: probe-fixtures-only path that writes raw per-run JSON
        // without the canonical RunManifest schema. Only fires when Zod validation fails.
        if (!manifest) {
          manifest = await readRawManifest(runsDir, resolvedRunId)
        }
      }
    }
    if (!resolvedRunId) {
      process.stderr.write('No runs found. Run `substrate run` to start a pipeline.\n')
      return 1
    }
    // Raw shim if canonical didn't yield a manifest
    if (!manifest) {
      manifest = await readRawManifest(runsDir, resolvedRunId)
    }
  }

  if (!manifest) {
    process.stderr.write(
      `No runs found. Run ID "${resolvedRunId}" not found in ${runsDir}.\n` +
      'Run `substrate run` to start a pipeline.\n',
    )
    return 1
  }

  // ---------------------------------------------------------------------------
  // Step 2: Enrich per-story data from Dolt wg_stories (degraded-mode fallback).
  //
  // If Dolt is available, query wg_stories for completed_at values that may be
  // more precise than manifest timestamps. Wrapped in try/catch — report proceeds
  // with manifest-only data if Dolt is unavailable or the query fails.
  // ---------------------------------------------------------------------------

  const statePath = join(dbRoot, '.substrate', 'state')
  if (existsSync(join(statePath, '.dolt'))) {
    // DoltClient holds a mysql2 connection pool. It MUST be close()-d before
    // returning, else the pool keeps the event loop alive past output flush
    // and the report subprocess hangs at the spawnSync timeout edge — surfaced
    // by interactive-prompt.test.ts in v0.20.72 (29-30s borderline → SIGTERM
    // / ETIMEDOUT). try/finally guarantees close() runs on both paths.
    let doltClient: DoltClient | null = null
    try {
      doltClient = new DoltClient({ repoPath: statePath })
      const storyKeys = Object.keys(manifest.per_story_state)
      if (storyKeys.length > 0) {
        const placeholders = storyKeys.map(() => '?').join(', ')
        const rows = await doltClient.query<{ story_key: string; completed_at: string | null }>(
          `SELECT story_key, completed_at FROM wg_stories WHERE story_key IN (${placeholders})`,
          storyKeys,
        )
        for (const row of rows) {
          const state = manifest.per_story_state[row.story_key]
          // Enrich completed_at only when manifest lacks it and Dolt has a value
          if (state && !state.completed_at && row.completed_at) {
            state.completed_at = row.completed_at
          }
        }
        logger.debug({ storyCount: rows.length }, 'Dolt wg_stories enrichment applied')
      }
    } catch (err) {
      // Dolt unavailable, query failed, or connection error — degraded mode
      logger.debug({ err }, 'Dolt enrichment unavailable — using manifest-only data (degraded mode)')
    } finally {
      if (doltClient !== null) {
        await doltClient.close().catch((err: unknown) => {
          logger.debug({ err }, 'DoltClient.close() failed — non-fatal')
        })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3: Read and delete halt notification files (Story 73-2, AC6, AC12).
  //
  // Notifications in .substrate/notifications/<runId>-*.json are written by
  // runInteractivePrompt when the Decision Router halts execution. We read them
  // here so they appear in the report, then delete them (cleanup contract).
  // ---------------------------------------------------------------------------

  const halts = await readNotificationsForRun(resolvedRunId, dbRoot).catch((err: unknown) => {
    logger.debug({ err }, 'notification read failed — continuing without halt data')
    return [] as HaltNotification[]
  })

  // Assemble report
  const output = assembleReport(resolvedRunId, manifest, halts)

  // ---------------------------------------------------------------------------
  // Step 4 (optional): AC-to-test traceability check (Story 74-1, --verify-ac).
  //
  // When --verify-ac is set, run the heuristic AC-to-test traceability check
  // for each completed story that has dev_story_signals.files_modified populated.
  // Story content is read from the standard implementation-artifacts directory.
  // Results are attached to the report output as `ac_traceability`.
  // ---------------------------------------------------------------------------

  if (verifyAc === true) {
    const artifactsDir = join(dbRoot, '_bmad-output', 'implementation-artifacts')
    const acTraceability: Record<string, StoryAcTraceability> = {}

    // AC6: Read run state via RunManifest class (not raw JSON object) per Story 74-1 requirement.
    // Fall back to the already-loaded raw manifest if RunManifest.read() fails (e.g., Zod validation).
    let acPerStoryState: Record<string, RawStoryState> = manifest.per_story_state
    try {
      const rmForAc = RunManifest.open(resolvedRunId!, runsDir)
      const rmData = await rmForAc.read()
      acPerStoryState = rmData.per_story_state as unknown as Record<string, RawStoryState>
    } catch {
      logger.debug({ runId: resolvedRunId }, 'RunManifest.read() for --verify-ac failed — using raw manifest fallback')
    }

    const storyEntries = Object.entries(acPerStoryState)
    for (const [storyKey, state] of storyEntries) {
      const filesModified = state.dev_story_signals?.files_modified ?? []

      // Read story content from implementation-artifacts
      let storyContent = ''
      try {
        const artifactFiles = await readdir(artifactsDir).catch(() => [] as string[])
        const matchingFile = artifactFiles.find(
          (f) => (f.startsWith(`${storyKey}-`) || f === `${storyKey}.md`) && f.endsWith('.md'),
        )
        if (matchingFile) {
          storyContent = await readFile(join(artifactsDir, matchingFile), 'utf-8')
        }
      } catch {
        // story file not found — use empty content
      }

      try {
        const result = await runAcTraceabilityCheck({
          storyKey,
          storyContent,
          filesModified,
        })
        acTraceability[storyKey] = {
          matrix: result.matrix,
          confidence: result.confidence,
        }
      } catch (err) {
        logger.debug({ err, storyKey }, 'ac traceability check failed for story (skipping)')
      }
    }

    output.ac_traceability = acTraceability
  }

  // Render
  if (outputFormat === 'json') {
    process.stdout.write(renderJson(output) + '\n')
  } else {
    process.stdout.write(renderHuman(output, manifest))
  }

  return 0
}

// ---------------------------------------------------------------------------
// Command registration (AC1)
// ---------------------------------------------------------------------------

/**
 * Register the `substrate report` command.
 *
 * Signature mirrors `registerReconcileFromDiskCommand` (Epic 69 Story 69-1)
 * for uniform CLI registration shape. `registry` is present for signature
 * uniformity even though this command does not use it.
 */
export function registerReportCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
  _registry?: AdapterRegistry,
): void {
  program
    .command('report')
    .description('Read run manifest and produce a structured completion report')
    .option('--run <id|latest>', 'Run ID to report on, or "latest" (default: current-run-id file, then Dolt getLatestRun fallback)')
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .option('--basePath <path>', 'Base path override for .substrate directory (used by probes and tests)')
    .option('--verify-ac', 'Run AC-to-test traceability heuristic for each story and append results to report (Story 74-1)')
    .action(async (opts: { run?: string; outputFormat: string; basePath?: string; verifyAc?: boolean }) => {
      const outputFormat: 'human' | 'json' = opts.outputFormat === 'json' ? 'json' : 'human'
      const exitCode = await runReportAction({
        run: opts.run,
        outputFormat,
        projectRoot,
        // basePath overrides resolveMainRepoRoot for probe / test isolation
        _dbRoot: opts.basePath,
        verifyAc: opts.verifyAc,
      })
      process.exitCode = exitCode
    })
}
