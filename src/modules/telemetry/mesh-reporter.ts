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
import type { DatabaseAdapter } from '@substrate-ai/core'
import {
  getRunMetrics,
  getStoryMetricsForRun,
} from '../../persistence/queries/metrics.js'

const logger = createLogger('mesh-reporter')

// ---------------------------------------------------------------------------
// RunReport types (mirrors agent-mesh RunReport schema)
// ---------------------------------------------------------------------------

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
  agentBackend: string
  engineType: string
  concurrency: number
}

// ---------------------------------------------------------------------------
// Build RunReport from database metrics
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

  const stories: StoryReport[] = storyMetrics.map((s) => {
    let phaseDurations: Record<string, number> | undefined
    if (s.phase_durations_json) {
      try {
        phaseDurations = JSON.parse(s.phase_durations_json) as Record<string, number>
      } catch {
        // ignore malformed JSON
      }
    }

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
    }
  })

  // Derive status from the run_metrics status field
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
