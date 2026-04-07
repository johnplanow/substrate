/**
 * Mesh Reporter — pushes structured RunReports to an agent-mesh telemetry server
 * after pipeline completion.
 *
 * Uses the A2A JSON-RPC protocol to invoke the `receive-run-report` skill on the
 * configured mesh server. Failures are logged but never block the pipeline.
 *
 * Configuration:
 *   telemetry.meshUrl   — URL of the agent-mesh server (e.g., http://localhost:4100)
 *   telemetry.projectId — project identifier (defaults to directory name)
 */

import { basename } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../../utils/logger.js'
import type { DatabaseAdapter } from '@substrate-ai/core'
import {
  getRunMetrics,
  getStoryMetricsForRun,
} from '../../persistence/queries/metrics.js'
import { RunManifest } from '@substrate-ai/sdlc'

const logger = createLogger('mesh-reporter')

/** Lazy-loaded substrate version (avoids module-load-time side effects that break test mocking). */
let _cachedVersion: string | undefined
function getSubstrateVersion(): string {
  if (_cachedVersion !== undefined) return _cachedVersion
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8')) as { version: string }
    _cachedVersion = pkg.version
  } catch {
    _cachedVersion = 'unknown'
  }
  return _cachedVersion
}

// ---------------------------------------------------------------------------
// RunReport types (mirrors agent-mesh RunReport schema)
// ---------------------------------------------------------------------------

interface VerificationCheck {
  checkName: string
  status: 'pass' | 'warn' | 'fail'
  details?: string
  durationMs?: number
}

interface ContractMismatch {
  exporter: string
  importer: string | null
  contractName: string
  mismatchDescription: string
}

interface StoryReport {
  storyKey: string
  result: string
  wallClockSeconds: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  reviewCycles: number
  dispatches: number
  phaseDurations?: Record<string, number>
  escalationReason?: string
  verificationStatus?: 'pass' | 'warn' | 'fail'
  verificationChecks?: VerificationCheck[]
  qualityScore?: number
}

interface RunReport {
  runId: string
  projectId: string
  substrateVersion: string
  timestamp: string
  status: 'completed' | 'partial' | 'failed'
  wallClockSeconds: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  storiesAttempted: number
  storiesSucceeded: number
  storiesFailed: number
  storiesEscalated: number
  totalReviewCycles: number
  totalDispatches: number
  restarts: number
  stories: StoryReport[]
  contractVerification?: {
    verified: number
    mismatches: number
    verdict: 'pass' | 'fail' | 'skipped'
    details?: ContractMismatch[]
  }
  warnings?: string[]
  efficiencyScore?: number
  agentBackend: string
  engineType: string
  concurrency: number
}

// ---------------------------------------------------------------------------
// Enrichment: verification results from RunManifest
// ---------------------------------------------------------------------------

async function loadVerificationResults(
  runId: string,
  runsDir: string,
): Promise<Record<string, { status: string; checks: VerificationCheck[] }>> {
  const results: Record<string, { status: string; checks: VerificationCheck[] }> = {}
  try {
    const manifest = RunManifest.open(runId, runsDir)
    const data = await manifest.read()
    if (data?.per_story_state) {
      for (const [storyKey, state] of Object.entries(data.per_story_state)) {
        const vr = (state as Record<string, unknown>)['verification_result'] as {
          status?: string
          checks?: Array<{ checkName: string; status: string; details?: string; duration_ms?: number }>
        } | undefined
        if (vr) {
          results[storyKey] = {
            status: vr.status ?? 'pass',
            checks: (vr.checks ?? []).map(c => ({
              checkName: c.checkName,
              status: c.status as 'pass' | 'warn' | 'fail',
              ...(c.details !== undefined && { details: c.details }),
              ...(c.duration_ms !== undefined && { durationMs: c.duration_ms }),
            })),
          }
        }
      }
    }
  } catch {
    logger.debug({ runId }, 'Could not read RunManifest for verification results — skipping')
  }
  return results
}

// ---------------------------------------------------------------------------
// Enrichment: efficiency scores from database
// ---------------------------------------------------------------------------

async function loadEfficiencyScores(
  adapter: DatabaseAdapter,
  storyKeys: string[],
): Promise<Record<string, number>> {
  const scores: Record<string, number> = {}
  if (storyKeys.length === 0) return scores

  try {
    // Get the latest composite score per story
    for (const key of storyKeys) {
      const rows = await adapter.query<{ composite_score: number }>(
        'SELECT composite_score FROM efficiency_scores WHERE story_key = ? ORDER BY timestamp DESC LIMIT 1',
        [key],
      )
      if (rows.length > 0 && rows[0] !== undefined) {
        scores[key] = rows[0].composite_score
      }
    }
  } catch {
    logger.debug('Could not query efficiency_scores table — skipping')
  }
  return scores
}

// ---------------------------------------------------------------------------
// Enrichment: contract verification from decisions table
// ---------------------------------------------------------------------------

async function loadContractVerification(
  adapter: DatabaseAdapter,
  runId: string,
): Promise<RunReport['contractVerification'] | undefined> {
  try {
    // Query interface-contract decisions for this run
    const rows = await adapter.query<{ key: string; value: string }>(
      `SELECT key, value FROM decisions WHERE pipeline_run_id = ? AND category = 'interface-contract'`,
      [runId],
    )

    if (rows.length === 0) return undefined

    const mismatches: ContractMismatch[] = []
    let verified = 0

    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as {
          verdict?: string
          exporter?: string
          importer?: string | null
          contractName?: string
          mismatchDescription?: string
        }
        if (parsed.verdict === 'fail' && parsed.contractName && parsed.mismatchDescription) {
          mismatches.push({
            exporter: parsed.exporter ?? row.key,
            importer: parsed.importer ?? null,
            contractName: parsed.contractName,
            mismatchDescription: parsed.mismatchDescription,
          })
        } else {
          verified++
        }
      } catch {
        // Malformed decision — skip
      }
    }

    return {
      verified,
      mismatches: mismatches.length,
      verdict: mismatches.length > 0 ? 'fail' : 'pass',
      ...(mismatches.length > 0 && { details: mismatches }),
    }
  } catch {
    logger.debug('Could not query contract verification decisions — skipping')
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Build RunReport from database metrics + enrichment sources
// ---------------------------------------------------------------------------

export async function buildRunReport(
  adapter: DatabaseAdapter,
  runId: string,
  opts: {
    projectId?: string
    projectRoot?: string
    substrateVersion?: string
    agentBackend?: string
    engineType?: string
    concurrency?: number
  },
): Promise<RunReport | null> {
  const runMetrics = await getRunMetrics(adapter, runId)
  if (!runMetrics) {
    logger.warn({ runId }, 'No run_metrics found — cannot build RunReport')
    return null
  }

  const storyMetrics = await getStoryMetricsForRun(adapter, runId)
  const storyKeys = storyMetrics.map(s => s.story_key)

  // Load enrichment data (all best-effort — failures don't block the report)
  const dbDir = opts.projectRoot ? join(opts.projectRoot, '.substrate') : '.substrate'
  const runsDir = join(dbDir, 'runs')
  const verificationResults = await loadVerificationResults(runId, runsDir)
  const efficiencyScores = await loadEfficiencyScores(adapter, storyKeys)
  const contractVerification = await loadContractVerification(adapter, runId)

  // Load interface change warnings from decisions
  const warnings: string[] = []
  try {
    const warnRows = await adapter.query<{ key: string; value: string }>(
      `SELECT key, value FROM decisions WHERE pipeline_run_id = ? AND category = 'INTERFACE_WARNING'`,
      [runId],
    )
    for (const row of warnRows) {
      try {
        const parsed = JSON.parse(row.value) as { modifiedInterfaces?: string[]; potentiallyAffectedTests?: string[] }
        const storyKey = row.key.split(':')[0] ?? 'unknown'
        const ifaces = parsed.modifiedInterfaces?.join(', ') ?? ''
        warnings.push(`${storyKey}: modified interfaces [${ifaces}]`)
      } catch {
        // Malformed — skip
      }
    }
  } catch {
    logger.debug('Could not query INTERFACE_WARNING decisions — skipping')
  }

  // Load test expansion findings from decisions
  const testExpansions: Record<string, { priority: string; gapCount: number }> = {}
  try {
    const expRows = await adapter.query<{ key: string; value: string }>(
      `SELECT key, value FROM decisions WHERE pipeline_run_id = ? AND category = 'TEST_EXPANSION_FINDING'`,
      [runId],
    )
    for (const row of expRows) {
      try {
        const parsed = JSON.parse(row.value) as { expansion_priority?: string; coverage_gaps?: unknown[] }
        const storyKey = row.key.split(':')[0] ?? 'unknown'
        testExpansions[storyKey] = {
          priority: parsed.expansion_priority ?? 'unknown',
          gapCount: parsed.coverage_gaps?.length ?? 0,
        }
      } catch {
        // Malformed — skip
      }
    }
  } catch {
    logger.debug('Could not query TEST_EXPANSION_FINDING decisions — skipping')
  }

  // Add test expansion warnings for stories with coverage gaps
  for (const [storyKey, exp] of Object.entries(testExpansions)) {
    if (exp.gapCount > 0) {
      warnings.push(`${storyKey}: test expansion found ${exp.gapCount} coverage gap(s), priority=${exp.priority}`)
    }
  }

  const stories: StoryReport[] = storyMetrics.map((s) => {
    let phaseDurations: Record<string, number> | undefined
    if (s.phase_durations_json) {
      try {
        phaseDurations = JSON.parse(s.phase_durations_json) as Record<string, number>
      } catch {
        // ignore malformed JSON
      }
    }

    const vr = verificationResults[s.story_key]
    const qualityScore = efficiencyScores[s.story_key]

    return {
      storyKey: s.story_key,
      result: s.result,
      wallClockSeconds: s.wall_clock_seconds,
      inputTokens: s.input_tokens,
      outputTokens: s.output_tokens,
      costUsd: s.cost_usd,
      reviewCycles: s.review_cycles,
      dispatches: s.dispatches,
      ...(phaseDurations !== undefined && { phaseDurations }),
      ...(vr !== undefined && {
        verificationStatus: vr.status as 'pass' | 'warn' | 'fail',
        verificationChecks: vr.checks,
      }),
      ...(qualityScore !== undefined && { qualityScore }),
    }
  })

  // Compute aggregate efficiency score (average across stories that have scores)
  const storyScores = stories.map(s => s.qualityScore).filter((s): s is number => s !== undefined)
  const avgEfficiencyScore = storyScores.length > 0
    ? Math.round(storyScores.reduce((a, b) => a + b, 0) / storyScores.length)
    : undefined

  // Derive status
  const rawStatus = runMetrics.status.toLowerCase()
  const status: 'completed' | 'partial' | 'failed' =
    rawStatus === 'completed' ? 'completed'
    : rawStatus === 'failed' ? 'failed'
    : 'partial'

  const projectId =
    opts.projectId ??
    (opts.projectRoot ? basename(opts.projectRoot) : 'unknown')

  return {
    runId,
    projectId,
    substrateVersion: opts.substrateVersion ?? getSubstrateVersion(),
    timestamp: new Date().toISOString(),
    status,
    wallClockSeconds: runMetrics.wall_clock_seconds,
    totalInputTokens: runMetrics.total_input_tokens,
    totalOutputTokens: runMetrics.total_output_tokens,
    totalCostUsd: runMetrics.total_cost_usd,
    storiesAttempted: runMetrics.stories_attempted,
    storiesSucceeded: runMetrics.stories_succeeded,
    storiesFailed: runMetrics.stories_failed,
    storiesEscalated: runMetrics.stories_escalated,
    totalReviewCycles: runMetrics.total_review_cycles,
    totalDispatches: runMetrics.total_dispatches,
    restarts: runMetrics.restarts,
    stories,
    ...(contractVerification !== undefined && { contractVerification }),
    ...(warnings.length > 0 && { warnings }),
    ...(avgEfficiencyScore !== undefined && { efficiencyScore: avgEfficiencyScore }),
    agentBackend: opts.agentBackend ?? 'claude-code',
    engineType: opts.engineType ?? 'linear',
    concurrency: opts.concurrency ?? runMetrics.concurrency_setting,
  }
}

// ---------------------------------------------------------------------------
// Push RunReport to agent-mesh server
// ---------------------------------------------------------------------------

/**
 * Push a RunReport to the configured agent-mesh telemetry server.
 *
 * Uses the A2A JSON-RPC protocol: POST to /rpc with method `message/send`
 * targeting the `receive-run-report` skill.
 *
 * Returns true if accepted, false on any failure (logged, never thrown).
 */
export async function pushRunReport(
  meshUrl: string,
  report: RunReport,
): Promise<boolean> {
  const rpcUrl = meshUrl.replace(/\/$/, '') + '/rpc'

  const rpcRequest = {
    jsonrpc: '2.0',
    id: `report-${report.runId}`,
    method: 'message/send',
    params: {
      message: {
        parts: [{ kind: 'data', data: { skillId: 'receive-run-report', ...report } }],
        metadata: {
          skillId: 'receive-run-report',
          contextId: `run-${report.runId}`,
        },
      },
    },
  }

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcRequest),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      logger.warn(
        { status: response.status, meshUrl },
        'Mesh server returned non-OK status — report not delivered',
      )
      return false
    }

    const rpcResponse = (await response.json()) as {
      result?: { status?: { state?: string } }
      error?: { code: number; message: string }
    }

    if (rpcResponse.error) {
      logger.warn(
        { code: rpcResponse.error.code, message: rpcResponse.error.message },
        'Mesh server returned RPC error',
      )
      return false
    }

    logger.info(
      { runId: report.runId, projectId: report.projectId, meshUrl },
      'RunReport pushed to mesh telemetry server',
    )
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(
      { meshUrl, err: message },
      'Failed to push RunReport to mesh — telemetry server may be offline',
    )
    return false
  }
}

// ---------------------------------------------------------------------------
// Outbox — local queue for failed pushes
// ---------------------------------------------------------------------------

const OUTBOX_DIR = '.substrate/outbox'

/**
 * Resolve the outbox directory path, creating it if necessary.
 */
function resolveOutboxDir(projectRoot?: string): string {
  const dir = join(projectRoot ?? process.cwd(), OUTBOX_DIR)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/**
 * Queue a RunReport to the local outbox for later delivery.
 */
export function enqueueReport(report: RunReport, meshUrl: string, projectRoot?: string): void {
  try {
    const dir = resolveOutboxDir(projectRoot)
    const filename = `report-${report.runId}-${Date.now()}.json`
    const envelope = { meshUrl, report }
    writeFileSync(join(dir, filename), JSON.stringify(envelope, null, 2))
    logger.info({ runId: report.runId, filename }, 'RunReport queued to outbox for later delivery')
  } catch (err) {
    logger.warn({ err }, 'Failed to write RunReport to outbox (data lost)')
  }
}

/**
 * Drain the outbox — attempt to deliver all queued reports.
 * Successfully delivered reports are removed from the outbox.
 * Returns the number of reports successfully delivered.
 */
export async function drainOutbox(meshUrl: string, projectRoot?: string): Promise<number> {
  const dir = resolveOutboxDir(projectRoot)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return 0
  }

  if (files.length === 0) return 0

  logger.info({ count: files.length }, 'Draining outbox — attempting to deliver queued reports')
  let delivered = 0

  for (const file of files) {
    const filepath = join(dir, file)
    try {
      const envelope = JSON.parse(readFileSync(filepath, 'utf-8')) as { meshUrl: string; report: RunReport }
      const ok = await pushRunReport(envelope.meshUrl, envelope.report)
      if (ok) {
        unlinkSync(filepath)
        delivered++
      } else {
        // Server responded but rejected — stop draining (server may be having issues)
        break
      }
    } catch {
      // Network failure — stop draining (server offline)
      break
    }
  }

  if (delivered > 0) {
    logger.info({ delivered, remaining: files.length - delivered }, 'Outbox drain complete')
  }
  return delivered
}

// ---------------------------------------------------------------------------
// High-level: build + push in one call (with outbox integration)
// ---------------------------------------------------------------------------

/**
 * Build a RunReport from the database and push it to the mesh server.
 * On push failure, queues to the local outbox for later delivery.
 * On success, drains any previously queued reports.
 * Best-effort — failures are logged, never thrown.
 */
export async function reportToMesh(
  adapter: DatabaseAdapter,
  runId: string,
  meshUrl: string,
  opts: {
    projectId?: string
    projectRoot?: string
    substrateVersion?: string
    agentBackend?: string
    engineType?: string
    concurrency?: number
  },
): Promise<boolean> {
  try {
    const report = await buildRunReport(adapter, runId, opts)
    if (!report) return false

    const ok = await pushRunReport(meshUrl, report)
    if (ok) {
      // Success — drain any previously queued reports
      await drainOutbox(meshUrl, opts.projectRoot).catch(() => {})
      return true
    } else {
      // Push failed — queue for later
      enqueueReport(report, meshUrl, opts.projectRoot)
      return false
    }
  } catch (err) {
    logger.warn({ err, runId }, 'reportToMesh failed (non-fatal)')
    return false
  }
}
