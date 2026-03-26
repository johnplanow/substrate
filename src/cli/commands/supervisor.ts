/**
 * `substrate supervisor` command
 *
 * Long-running watchdog that polls pipeline health and automatically
 * kills and restarts stalled pipelines.
 *
 * Extracted from auto.ts during CLI flattening.
 */

import type { Command } from 'commander'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import type { OutputFormat } from './pipeline-shared.js'
import type { PipelineHealthOutput } from './health.js'
import { getAutoHealthData, getAllDescendantPids } from './health.js'
import type { ResumeOptions } from './resume.js'
import { runResumeAction } from './resume.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import type { DatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import {
  incrementRunRestarts,
  getRunMetrics,
  getBaselineRunMetrics,
  getStoryMetricsForRun,
  aggregateTokenUsageForRun,
} from '../../persistence/queries/metrics.js'
import { createDecision } from '../../persistence/queries/decisions.js'
import { OPERATIONAL_FINDING } from '../../persistence/schemas/operational.js'

// ---------------------------------------------------------------------------
// supervisor options & deps
// ---------------------------------------------------------------------------

export interface SupervisorOptions {
  /** How often to poll pipeline health, in seconds. Default: 60 */
  pollInterval: number
  /** Staleness in seconds that triggers a kill. Default: 600 */
  stallThreshold: number
  /** Maximum number of automatic restarts before aborting. Default: 3 */
  maxRestarts: number
  outputFormat: OutputFormat
  projectRoot: string
  runId?: string
  pack: string
  /**
   * When true, after post-run analysis the supervisor enters experiment mode:
   * it creates git branches, applies modifications, runs single-story experiments,
   * and reports verdicts (Story 17-4 AC1).
   * Without this flag, only reports are produced (Tier 2 behaviour).
   */
  experiment?: boolean
  /**
   * Maximum number of experiments to run per analysis cycle (Story 17-4 AC6).
   * Default: 2
   */
  maxExperiments?: number
}

/** Injectable dependencies for testing the supervisor without real processes or timers */
export interface SupervisorDeps {
  getHealth: (opts: { runId?: string; projectRoot: string }) => Promise<PipelineHealthOutput>
  killPid: (pid: number, signal: NodeJS.Signals) => void
  resumePipeline: (opts: ResumeOptions) => Promise<number>
  sleep: (ms: number) => Promise<void>
  /** Called after each successful restart to increment the restarts counter in run_metrics. */
  incrementRestarts: (runId: string, projectRoot: string) => Promise<void> | void
  /**
   * Called after detecting terminal state (AC1 of Story 17-3).
   * Generates the post-run analysis report and writes it to disk.
   * Optional so tests can omit it without side-effects.
   */
  runAnalysis?: (runId: string, projectRoot: string) => Promise<void>
  /**
   * Fetch the cumulative token/cost snapshot for a run from the DB.
   * Called on each poll cycle to populate the supervisor:poll event (Story 19-2 AC3).
   * Returns zeros when the run ID is unknown or DB is unavailable.
   */
  getTokenSnapshot: (runId: string, projectRoot: string) => Promise<{ input: number; output: number; cost_usd: number }> | { input: number; output: number; cost_usd: number }
  /**
   * Collect all descendant PIDs (grandchildren and deeper) of the given root PIDs.
   * Used during stall recovery to kill orphan `claude` and `node` processes that
   * were spawned by direct children of the orchestrator (AC8: orphan cleanup).
   */
  getAllDescendants: (rootPids: number[]) => number[]
  /**
   * Write stall findings to the decision store (AC1 of Story 21-1).
   * Called after stall recovery to persist per-story stall findings.
   * Optional — if omitted no decisions are written (safe for tests that don't need DB).
   */
  writeStallFindings?: (opts: {
    runId: string | null
    storyDetails: Record<string, { phase: string; review_cycles: number }>
    staleness_secs: number
    attempt: number
    outcome: 'recovered' | 'failed' | 'max-restarts-escalated'
    projectRoot: string
  }) => void | Promise<void>
  /**
   * Lazily create and return an AdapterRegistry for use by resumePipeline.
   * The supervisor process doesn't initialize one at startup (only `substrate run` does),
   * so this must be called before any restart attempt.
   */
  getRegistry: () => Promise<AdapterRegistry>
  /**
   * Read the original CLI scope flags (explicitStories, epic) from a pipeline run's config_json.
   * Used during restart to replay the exact scope the user originally requested.
   * Optional — falls back to health snapshot story keys when not provided.
   */
  getRunConfig?: (runId: string, projectRoot: string) => Promise<{ explicitStories?: string[]; epic?: number } | null>
  /**
   * Write a run-level summary finding to the decision store (AC2 of Story 21-1).
   * Called when the pipeline reaches terminal state.
   * Optional — if omitted no decisions are written.
   * The implementation is responsible for querying token totals from the DB if needed.
   */
  writeRunSummary?: (opts: {
    runId: string | null
    succeeded: string[]
    failed: string[]
    escalated: string[]
    total_restarts: number
    elapsed_seconds: number
    projectRoot: string
  }) => void | Promise<void>
}

function defaultSupervisorDeps(): SupervisorDeps {
  return {
    getHealth: getAutoHealthData,
    killPid: (pid, signal) => {
      process.kill(pid, signal)
    },
    resumePipeline: runResumeAction,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    incrementRestarts: (() => {
      // Cache the adapter across calls so that a fresh connection is not
      // opened and closed on every supervisor restart.
      let cachedAdapter: DatabaseAdapter | null = null
      return async (runId: string, projectRoot: string) => {
        try {
          if (cachedAdapter === null) {
            const dbRoot = await resolveMainRepoRoot(projectRoot)
            cachedAdapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
            await initSchema(cachedAdapter)
          }
          await incrementRunRestarts(cachedAdapter, runId)
        } catch {
          // Best-effort — never block the supervisor
          try { await cachedAdapter?.close() } catch { /* ignore close errors */ }
          cachedAdapter = null // reset so next call retries the connection
        }
      }
    })(),
    getTokenSnapshot: async (runId: string, projectRoot: string) => {
      try {
        const dbRoot = await resolveMainRepoRoot(projectRoot)
        const dbPath = join(dbRoot, '.substrate', 'substrate.db')
        const doltDir = join(dbRoot, '.substrate', 'state', '.dolt')
        if (!existsSync(dbPath) && !existsSync(doltDir)) return { input: 0, output: 0, cost_usd: 0 }
        const tsAdapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
        try {
          await initSchema(tsAdapter)
          const agg = await aggregateTokenUsageForRun(tsAdapter, runId)
          return { input: agg.input, output: agg.output, cost_usd: agg.cost }
        } finally {
          try { await tsAdapter.close() } catch { /* ignore */ }
        }
      } catch {
        return { input: 0, output: 0, cost_usd: 0 }
      }
    },
    getAllDescendants: (rootPids: number[]) => getAllDescendantPids(rootPids),
    getRegistry: (() => {
      let cached: AdapterRegistry | null = null
      return async () => {
        if (cached === null) {
          const { AdapterRegistry: AR } = await import(/* @vite-ignore */ '../../adapters/adapter-registry.js')
          cached = new AR()
          await cached.discoverAndRegister()
        }
        return cached
      }
    })(),
    writeStallFindings: async (opts) => {
      try {
        const dbRoot = await resolveMainRepoRoot(opts.projectRoot)
        const dbPath = join(dbRoot, '.substrate', 'substrate.db')
        const doltDir = join(dbRoot, '.substrate', 'state', '.dolt')
        if (!existsSync(dbPath) && !existsSync(doltDir)) return
        const sfAdapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
        try {
          await initSchema(sfAdapter)
          const activeStories = Object.entries(opts.storyDetails).filter(
            ([, s]) => s.phase !== 'PENDING' && s.phase !== 'COMPLETE' && s.phase !== 'ESCALATED',
          )
          const now = Date.now()
          for (const [storyKey, storyState] of activeStories) {
            await createDecision(sfAdapter, {
              pipeline_run_id: opts.runId ?? null,
              phase: 'supervisor',
              category: OPERATIONAL_FINDING,
              key: `stall:${storyKey}:${now}`,
              value: JSON.stringify({
                phase: storyState.phase,
                staleness_secs: opts.staleness_secs,
                attempt: opts.attempt,
                outcome: opts.outcome,
              }),
              rationale: `Supervisor stall recovery: story ${storyKey} was in phase ${storyState.phase} when pipeline stalled after ${opts.staleness_secs}s. Attempt ${opts.attempt}. Outcome: ${opts.outcome}.`,
            })
          }
        } finally {
          try { await sfAdapter.close() } catch { /* ignore */ }
        }
      } catch {
        // Best-effort — never block the supervisor
      }
    },
    writeRunSummary: async (opts) => {
      // Guard: only insert if summary contains at least one story entry
      const totalStories = opts.succeeded.length + opts.failed.length + opts.escalated.length
      if (totalStories === 0) return
      if (opts.runId === null) return
      try {
        const dbRoot = await resolveMainRepoRoot(opts.projectRoot)
        const dbPath = join(dbRoot, '.substrate', 'substrate.db')
        const doltDir = join(dbRoot, '.substrate', 'state', '.dolt')
        if (!existsSync(dbPath) && !existsSync(doltDir)) return
        const rsAdapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
        try {
          await initSchema(rsAdapter)
          // Query token totals directly from DB
          const tokenAgg = await aggregateTokenUsageForRun(rsAdapter, opts.runId)
          await createDecision(rsAdapter, {
            pipeline_run_id: opts.runId,
            phase: 'supervisor',
            category: OPERATIONAL_FINDING,
            key: `run-summary:${opts.runId}`,
            value: JSON.stringify({
              succeeded: opts.succeeded,
              failed: opts.failed,
              escalated: opts.escalated,
              total_restarts: opts.total_restarts,
              elapsed_seconds: opts.elapsed_seconds,
              total_input_tokens: tokenAgg.input,
              total_output_tokens: tokenAgg.output,
            }),
            rationale: `Run summary: ${opts.succeeded.length} succeeded, ${opts.failed.length} failed, ${opts.escalated.length} escalated. ${opts.total_restarts} restarts. Elapsed: ${opts.elapsed_seconds}s.`,
          })
        } finally {
          try { await rsAdapter.close() } catch { /* ignore */ }
        }
      } catch {
        // Best-effort — never block the supervisor
      }
    },
    runAnalysis: async (runId: string, projectRoot: string) => {
      // AC1 of Story 17-3: generate post-run analysis report after terminal state
      const dbPath = join(projectRoot, '.substrate', 'substrate.db')
      const doltDir = join(projectRoot, '.substrate', 'state', '.dolt')
      if (!existsSync(dbPath) && !existsSync(doltDir)) return
      const raAdapter = createDatabaseAdapter({ backend: 'auto', basePath: projectRoot })
      try {
        await initSchema(raAdapter)
        const run = await getRunMetrics(raAdapter, runId)
        if (!run) return
        const stories = await getStoryMetricsForRun(raAdapter, runId)
        const baseline = await getBaselineRunMetrics(raAdapter)
        const baselineStories = baseline && baseline.run_id !== runId
          ? await getStoryMetricsForRun(raAdapter, baseline.run_id)
          : []
        const analysisPath = '../../modules/supervisor/analysis.js'
        const { generateAnalysisReport, writeAnalysisReport } = await import(/* @vite-ignore */ analysisPath)
        const report = generateAnalysisReport(run, stories, baseline, baselineStories)
        writeAnalysisReport(report, projectRoot)
      } catch {
        // Best-effort — never block the supervisor
      } finally {
        try { await raAdapter.close() } catch { /* ignore */ }
      }
    },
    getRunConfig: async (runId: string, projectRoot: string) => {
      try {
        const dbRoot = await resolveMainRepoRoot(projectRoot)
        const rcAdapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
        try {
          await initSchema(rcAdapter)
          const rows = await rcAdapter.query<{ config_json: string | null }>('SELECT config_json FROM pipeline_runs WHERE id = ?', [runId])
          if (rows.length === 0 || rows[0]!.config_json === null) return null
          const config = JSON.parse(rows[0]!.config_json) as { explicitStories?: string[]; epic?: number }
          return { explicitStories: config.explicitStories, epic: config.epic }
        } finally {
          try { await rcAdapter.close() } catch { /* ignore */ }
        }
      } catch {
        return null
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Extracted helpers (shared by single-project and multi-project supervisor)
// ---------------------------------------------------------------------------

/** Build the supervisor:poll event payload. */
export function buildPollEvent(
  health: PipelineHealthOutput,
  projectRoot: string,
  tokenSnapshot: { input: number; output: number; cost_usd: number },
  extraFields?: Record<string, unknown>,
): Record<string, unknown> {
  const proc = health.process ?? { orchestrator_pid: null, child_pids: [], zombies: [] }
  return {
    type: 'supervisor:poll',
    run_id: health.run_id,
    verdict: health.verdict,
    staleness_seconds: health.staleness_seconds,
    stories: {
      active: health.stories.active,
      completed: health.stories.completed,
      escalated: health.stories.escalated,
    },
    story_details: health.stories.details,
    tokens: tokenSnapshot,
    process: {
      orchestrator_pid: proc.orchestrator_pid,
      child_count: proc.child_pids.length,
      zombie_count: proc.zombies.length,
    },
    ...extraFields,
  }
}

/** Extract succeeded / failed / escalated story keys from health details. */
export function buildTerminalSummary(
  storyDetails: Record<string, { phase: string; review_cycles: number }>,
): { succeeded: string[]; failed: string[]; escalated: string[] } {
  const succeeded: string[] = []
  const failed: string[] = []
  const escalated: string[] = []
  for (const [k, s] of Object.entries(storyDetails)) {
    if (s.phase === 'COMPLETE') succeeded.push(k)
    else if (s.phase === 'ESCALATED') escalated.push(k)
    else if (s.phase !== 'PENDING') failed.push(k)
  }
  return { succeeded, failed, escalated }
}

/** Per-project mutable state tracked across poll cycles. */
export interface ProjectCycleState {
  projectRoot: string
  runId?: string
  restartCount: number
}

/**
 * Handle stall recovery for a single project: kill stalled processes, restart pipeline.
 *
 * Returns null if no stall detected (staleness below threshold).
 * Returns updated state + maxRestartsExceeded flag otherwise.
 */
export async function handleStallRecovery(
  health: PipelineHealthOutput,
  state: ProjectCycleState,
  config: { stallThreshold: number; maxRestarts: number; pack: string; outputFormat: OutputFormat },
  deps: Pick<SupervisorDeps, 'killPid' | 'resumePipeline' | 'sleep' | 'incrementRestarts' | 'getAllDescendants' | 'writeStallFindings' | 'getRegistry' | 'getRunConfig'>,
  io: {
    emitEvent: (event: Record<string, unknown>) => void
    log: (msg: string) => void
  },
): Promise<{ state: ProjectCycleState; maxRestartsExceeded: boolean } | null> {
  const { stallThreshold, maxRestarts, pack, outputFormat } = config
  const { killPid, resumePipeline, sleep, incrementRestarts, getAllDescendants, writeStallFindings, getRegistry } = deps
  const { emitEvent, log } = io
  const { projectRoot } = state

  // Phase-aware threshold: code review phases get 2x the threshold since
  // review agents read many files without producing output tokens (Finding 2).
  // Exception: if the orchestrator has 0 child processes but stories are in-progress,
  // the agent is dead and there's nothing to wait for — use base threshold.
  const REVIEW_PHASES = new Set(['IN_REVIEW', 'code-review'])
  const activePhases = Object.values(health.stories.details ?? {}).map((s: any) => s.phase)
  const inReviewPhase = activePhases.some((p: string) => REVIEW_PHASES.has(p))
  const orchestratorIdle = health.process.child_pids.length === 0 && health.stories.active > 0
  const effectiveThreshold = (inReviewPhase && !orchestratorIdle) ? stallThreshold * 2 : stallThreshold

  if (health.staleness_seconds < effectiveThreshold) return null

  // Guard: do not kill a foreign pipeline run (cross-session protection)
  if (state.runId !== undefined && health.run_id !== null && health.run_id !== state.runId) {
    log('Supervisor skipping kill — active pipeline belongs to a different session')
    return null
  }

  const directPids = [
    ...(health.process.orchestrator_pid !== null ? [health.process.orchestrator_pid] : []),
    ...health.process.child_pids,
  ]

  // AC8: Collect all descendant PIDs recursively to kill orphan grandchildren
  const descendantPids = getAllDescendants(directPids)
  const directPidSet = new Set(directPids)
  const pids = [...directPids, ...descendantPids.filter((p) => !directPidSet.has(p))]

  emitEvent({
    type: 'supervisor:kill',
    run_id: health.run_id,
    reason: 'stall',
    staleness_seconds: health.staleness_seconds,
    pids,
  })

  log(
    `Supervisor: Stall confirmed (${health.staleness_seconds}s ≥ ${stallThreshold}s threshold). Killing PIDs: ${pids.join(', ') || 'none'}`,
  )

  // SIGTERM first — graceful shutdown
  for (const pid of pids) {
    try { killPid(pid, 'SIGTERM') } catch { /* Process may already be dead */ }
  }

  // 5-second grace period, then SIGKILL
  await sleep(5000)
  for (const pid of pids) {
    try { killPid(pid, 'SIGKILL') } catch { /* Process may already be dead */ }
  }

  // AC4 liveness check: verify processes are dead before restarting
  if (pids.length > 0) {
    let allDead = false
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(1000)
      allDead = pids.every((pid) => {
        try { process.kill(pid, 0); return false } catch { return true }
      })
      if (allDead) break
    }
    if (!allDead) {
      log(`Supervisor: Warning: Some PIDs may still be alive after SIGKILL`)
    }
  }

  // Safety valve: check max restarts before attempting restart
  if (state.restartCount >= maxRestarts) {
    emitEvent({
      type: 'supervisor:abort',
      run_id: health.run_id,
      reason: 'max_restarts_exceeded',
      attempts: state.restartCount,
    })
    log(`Supervisor: Max restarts (${maxRestarts}) exceeded. Aborting.`)
    if (writeStallFindings) {
      await writeStallFindings({
        runId: health.run_id,
        storyDetails: health.stories.details,
        staleness_secs: health.staleness_seconds,
        attempt: state.restartCount,
        outcome: 'max-restarts-escalated',
        projectRoot,
      })
    }
    return { state, maxRestartsExceeded: true }
  }

  // Restart the pipeline
  const newRestartCount = state.restartCount + 1

  if (health.run_id !== null) {
    await incrementRestarts(health.run_id, projectRoot)
  }

  emitEvent({
    type: 'supervisor:restart',
    run_id: health.run_id,
    attempt: newRestartCount,
  })

  log(`Supervisor: Restarting pipeline (attempt ${newRestartCount}/${maxRestarts})`)

  try {
    // Read the original CLI scope from config_json (preferred), falling back
    // to the health snapshot's active story keys (Finding 1: prevent unscoped discovery).
    let scopedStories: string[] | undefined
    if (deps.getRunConfig !== undefined && health.run_id !== null) {
      try {
        const runConfig = await deps.getRunConfig(health.run_id, projectRoot)
        if (runConfig?.explicitStories !== undefined && runConfig.explicitStories.length > 0) {
          scopedStories = runConfig.explicitStories
        }
      } catch {
        // Best-effort — fall through to health snapshot
      }
    }
    if (scopedStories === undefined) {
      const healthKeys = Object.keys(health.stories.details ?? {})
      if (healthKeys.length > 0) scopedStories = healthKeys
    }

    const registry = await getRegistry()
    await resumePipeline({
      runId: health.run_id ?? undefined,
      outputFormat,
      projectRoot,
      concurrency: 3,
      pack,
      registry,
      ...(scopedStories !== undefined ? { stories: scopedStories } : {}),
    })
    if (writeStallFindings) {
      await writeStallFindings({
        runId: health.run_id,
        storyDetails: health.stories.details,
        staleness_secs: health.staleness_seconds,
        attempt: newRestartCount,
        outcome: 'recovered',
        projectRoot,
      })
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log(`Supervisor: Resume error: ${message}`)
    emitEvent({ type: 'supervisor:error' as any, reason: 'resume_failed', message } as any)
    if (writeStallFindings) {
      await writeStallFindings({
        runId: health.run_id,
        storyDetails: health.stories.details,
        staleness_secs: health.staleness_seconds,
        attempt: newRestartCount,
        outcome: 'failed',
        projectRoot,
      })
    }
  }

  return { state: { ...state, restartCount: newRestartCount }, maxRestartsExceeded: false }
}

// ---------------------------------------------------------------------------
// supervisor action (single project)
// ---------------------------------------------------------------------------

/**
 * Run the pipeline supervisor — a long-running watchdog that polls pipeline health
 * and automatically kills and restarts stalled pipelines.
 *
 * State machine: POLLING → (stall detected) → KILLING → RESTARTING → POLLING
 *
 * Exit codes:
 *   0 — pipeline reached terminal state with no failures
 *   1 — pipeline completed with failures or escalations
 *   2 — max restarts exceeded (safety valve triggered)
 */
export async function runSupervisorAction(
  options: SupervisorOptions,
  deps: Partial<SupervisorDeps> = {},
): Promise<number> {
  const { pollInterval, stallThreshold, maxRestarts, outputFormat, projectRoot, runId, pack, experiment, maxExperiments } = options
  const resolvedDeps = { ...defaultSupervisorDeps(), ...deps }
  const { getHealth, sleep, runAnalysis, getTokenSnapshot, writeRunSummary } = resolvedDeps

  let state: ProjectCycleState = { projectRoot, runId, restartCount: 0 }
  let maxRestartsExhausted = false
  const startTime = Date.now()

  function emitEvent(event: Record<string, unknown>): void {
    if (outputFormat === 'json') {
      const stamped = { ...event, ts: new Date().toISOString() }
      process.stdout.write(JSON.stringify(stamped) + '\n')
    }
  }

  function log(message: string): void {
    if (outputFormat === 'human') {
      process.stdout.write(message + '\n')
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const health = await getHealth({ runId: state.runId ?? runId, projectRoot })
    const ts = new Date().toISOString()

    // Auto-bind to the active run on first poll if no --run-id was provided.
    // This ensures the cross-session guard in handleStallRecovery works even
    // when the supervisor is started without an explicit run ID. Without this,
    // state.runId stays undefined and the guard is bypassed, allowing the
    // supervisor to kill PIDs from a different active run.
    if (state.runId === undefined && health.run_id !== null) {
      state = { ...state, runId: health.run_id }
      log(`Supervisor: auto-bound to active run ${health.run_id}`)
    }

    // Emit supervisor:poll heartbeat event on each cycle in JSON mode
    if (outputFormat === 'json') {
      const tokenSnapshot = health.run_id !== null
        ? await getTokenSnapshot(health.run_id, projectRoot)
        : { input: 0, output: 0, cost_usd: 0 }
      emitEvent(buildPollEvent(health, projectRoot, tokenSnapshot))
    }

    log(
      `[${ts}] Health: ${health.verdict} | staleness=${health.staleness_seconds}s | ` +
        `stories: active=${health.stories.active} completed=${health.stories.completed} escalated=${health.stories.escalated}`,
    )

    // --- Terminal state: pipeline has completed, failed, or stopped ---
    if (health.verdict === 'NO_PIPELINE_RUNNING') {
      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000)
      const summary = buildTerminalSummary(health.stories.details)

      emitEvent({
        type: 'supervisor:summary',
        run_id: health.run_id,
        elapsed_seconds: elapsedSeconds,
        ...summary,
        restarts: state.restartCount,
      })

      log(
        `\nPipeline reached terminal state. Elapsed: ${elapsedSeconds}s | ` +
          `succeeded: ${summary.succeeded.length} | failed: ${summary.failed.length} | restarts: ${state.restartCount}`,
      )

      // --- AC2 of Story 21-1: persist run-level summary to decision store ---
      if (writeRunSummary !== undefined) {
        await writeRunSummary({
          runId: health.run_id,
          succeeded: summary.succeeded,
          failed: summary.failed,
          escalated: summary.escalated,
          total_restarts: state.restartCount,
          elapsed_seconds: elapsedSeconds,
          projectRoot,
        })
      }

      // --- AC1 of Story 17-3: run post-run analysis when a run-id is known ---
      if (health.run_id !== null && runAnalysis !== undefined) {
        log(`[supervisor] Running post-run analysis for ${health.run_id}...`)
        try {
          await runAnalysis(health.run_id, projectRoot)
          log(`[supervisor] Analysis report written to _bmad-output/supervisor-reports/${health.run_id}-analysis.md`)
          emitEvent({ type: 'supervisor:analysis:complete', run_id: health.run_id })
        } catch (analysisErr) {
          const analysisErrMsg = analysisErr instanceof Error ? analysisErr.message : String(analysisErr)
          log(`[supervisor] Analysis failed (best-effort) — continuing.`)
          emitEvent({ type: 'supervisor:analysis:error', run_id: health.run_id, error: analysisErrMsg })
        }
      }

      // --- Experiment mode (Story 17-4 AC1): enter after post-run analysis ---
      if (experiment && health.run_id !== null) {
        log(`\n[supervisor] Experiment mode enabled. Checking for optimization recommendations...`)
        emitEvent({ type: 'supervisor:experiment:start', run_id: health.run_id })
        const analysisReportPath = join(
          projectRoot,
          '_bmad-output',
          'supervisor-reports',
          `${health.run_id}-analysis.json`,
        )
        try {
          const { readFile: fsReadFile } = await import('fs/promises')
          const raw = await fsReadFile(analysisReportPath, 'utf-8')
          const analysisData = JSON.parse(raw) as {
            recommendations?: Array<{
              type: string
              story_key: string
              phase: string
              description: string
              short_desc: string
            }>
          }
          const recommendations = analysisData.recommendations ?? []
          if (recommendations.length === 0) {
            log(`[supervisor] No recommendations found in analysis report — skipping experiments.`)
            emitEvent({ type: 'supervisor:experiment:skip', run_id: health.run_id, reason: 'no_recommendations' })
          } else {
            log(`[supervisor] Found ${recommendations.length} recommendation(s) to experiment with.`)
            emitEvent({ type: 'supervisor:experiment:recommendations', run_id: health.run_id, count: recommendations.length })

            try {
              const { createExperimenter } = await import(/* @vite-ignore */ '../../modules/supervisor/experimenter.js')
              const { getLatestRun: getLatest } = await import(/* @vite-ignore */ '../../persistence/queries/decisions.js')

              const expAdapter = createDatabaseAdapter({ backend: 'auto', basePath: projectRoot })
              try {
                await initSchema(expAdapter)

                const { runRunAction: runPipeline } = await import(/* @vite-ignore */ './run.js')
                const runStoryFn = async (opts: { stories: string; projectRoot: string; pack: string }) => {
                  const exitCode = await runPipeline({
                    pack: opts.pack,
                    stories: opts.stories,
                    concurrency: 1,
                    outputFormat: 'json',
                    projectRoot: opts.projectRoot,
                  })
                  const latestRun = await getLatest(expAdapter)
                  const newRunId = latestRun?.id ?? `experiment-${Date.now()}`
                  return { runId: newRunId, exitCode }
                }

                const experimenter = createExperimenter(
                  {
                    projectRoot,
                    pack,
                    maxExperiments: maxExperiments ?? 2,
                    tokenBudgetMultiplier: 2,
                  },
                  { runStory: runStoryFn, log: (msg: string) => log(msg) },
                )

                const results = await experimenter.runExperiments(
                  expAdapter,
                  recommendations as any[],
                  health.run_id!,
                )

                const improved = results.filter((r: any) => r.verdict === 'IMPROVED').length
                const mixed = results.filter((r: any) => r.verdict === 'MIXED').length
                const regressed = results.filter((r: any) => r.verdict === 'REGRESSED').length
                log(`[supervisor] Experiment cycle complete: ${improved} improved, ${mixed} mixed, ${regressed} regressed`)
                emitEvent({
                  type: 'supervisor:experiment:complete',
                  run_id: health.run_id,
                  improved,
                  mixed,
                  regressed,
                })
              } finally {
                try { await expAdapter.close() } catch { /* ignore */ }
              }
            } catch (expErr) {
              const msg = expErr instanceof Error ? expErr.message : String(expErr)
              log(`[supervisor] Experiment execution failed (best-effort): ${msg}`)
              emitEvent({ type: 'supervisor:experiment:error', run_id: health.run_id, error: msg })
            }
          }
        } catch {
          log(`[supervisor] Analysis report not found at ${analysisReportPath} — skipping experiments.`)
          log(`[supervisor] Run 'substrate metrics --analysis <run-id>' first to generate recommendations.`)
          emitEvent({ type: 'supervisor:experiment:skip', run_id: health.run_id, reason: 'no_analysis_report' })
        }
      }

      return (summary.failed.length > 0 || summary.escalated.length > 0) ? 1 : 0
    }

    // --- Max restarts exhaustion check ---
    // If max restarts were exhausted on a previous cycle and the pipeline
    // didn't reach terminal state (checked above), exit with code 2.
    // This must run BEFORE stall recovery to avoid re-entering handleStallRecovery.
    if (maxRestartsExhausted) {
      return 2
    }

    // --- Stall detection and recovery ---
    const stallResult = await handleStallRecovery(
      health,
      state,
      { stallThreshold, maxRestarts, pack, outputFormat },
      {
        killPid: resolvedDeps.killPid,
        resumePipeline: resolvedDeps.resumePipeline,
        sleep: resolvedDeps.sleep,
        incrementRestarts: resolvedDeps.incrementRestarts,
        getAllDescendants: resolvedDeps.getAllDescendants,
        writeStallFindings: resolvedDeps.writeStallFindings,
        getRegistry: resolvedDeps.getRegistry,
        getRunConfig: resolvedDeps.getRunConfig,
      },
      { emitEvent, log },
    )
    if (stallResult !== null) {
      if (stallResult.maxRestartsExceeded) {
        // Don't return immediately — do one more poll cycle so the terminal
        // state check (above) can detect if the pipeline actually completed
        // before the stall was detected. This avoids returning exit code 2
        // when the pipeline finished successfully.
        maxRestartsExhausted = true
      } else {
        state = stallResult.state
      }
    }

    // Wait for next poll interval
    await sleep(pollInterval * 1000)
  }
}

// ---------------------------------------------------------------------------
// Multi-project supervisor
// ---------------------------------------------------------------------------

export interface MultiProjectSupervisorOptions {
  projects: string[]
  pollInterval: number
  stallThreshold: number
  maxRestarts: number
  outputFormat: OutputFormat
  pack: string
}

/**
 * Run the supervisor across multiple projects simultaneously.
 * Polls each project sequentially within each cycle, tagging events with `project`.
 *
 * Exit codes:
 *   0 — all projects completed without failures
 *   1 — at least one project completed with failures or escalations
 *   2 — at least one project hit max restarts
 */
export async function runMultiProjectSupervisor(
  options: MultiProjectSupervisorOptions,
  deps: Partial<SupervisorDeps> = {},
): Promise<number> {
  const { projects, pollInterval, stallThreshold, maxRestarts, outputFormat, pack } = options
  const resolvedDeps = { ...defaultSupervisorDeps(), ...deps }
  const { getHealth, sleep, getTokenSnapshot } = resolvedDeps

  if (projects.length === 0) {
    process.stderr.write('Error: --projects requires at least one project path\n')
    return 1
  }

  const states = new Map<string, ProjectCycleState>(
    projects.map((p) => [p, { projectRoot: p, restartCount: 0 }]),
  )
  const doneProjects = new Set<string>()
  const projectExitCodes = new Map<string, number>()
  const maxRestartsExhaustedProjects = new Set<string>()
  const startTime = Date.now()

  function emitEvent(event: Record<string, unknown>): void {
    if (outputFormat === 'json') {
      const stamped = { ...event, ts: new Date().toISOString() }
      process.stdout.write(JSON.stringify(stamped) + '\n')
    }
  }

  function log(message: string): void {
    if (outputFormat === 'human') {
      process.stdout.write(message + '\n')
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const projectRoot of projects) {
      if (doneProjects.has(projectRoot)) continue

      let health: PipelineHealthOutput
      try {
        health = await getHealth({ projectRoot })
      } catch {
        // Project may have disappeared (DB deleted, dir removed) — mark terminal
        log(`[supervisor] ${projectRoot}: health check failed — marking as done`)
        emitEvent({ type: 'supervisor:error', project: projectRoot, reason: 'health_check_failed' } as any)
        doneProjects.add(projectRoot)
        projectExitCodes.set(projectRoot, 1)
        continue
      }

      const state = states.get(projectRoot)!

      // Emit poll event with project tag
      if (outputFormat === 'json') {
        const tokenSnapshot = health.run_id !== null
          ? await getTokenSnapshot(health.run_id, projectRoot)
          : { input: 0, output: 0, cost_usd: 0 }
        emitEvent(buildPollEvent(health, projectRoot, tokenSnapshot, { project: projectRoot }))
      }

      log(
        `[${projectRoot}] Health: ${health.verdict} | staleness=${health.staleness_seconds}s | ` +
          `active=${health.stories.active} completed=${health.stories.completed} escalated=${health.stories.escalated}`,
      )

      // Terminal state
      if (health.verdict === 'NO_PIPELINE_RUNNING') {
        const elapsedSeconds = Math.round((Date.now() - startTime) / 1000)
        const summary = buildTerminalSummary(health.stories.details)

        emitEvent({
          type: 'supervisor:summary',
          project: projectRoot,
          run_id: health.run_id,
          elapsed_seconds: elapsedSeconds,
          ...summary,
          restarts: state.restartCount,
        })

        log(
          `[${projectRoot}] Terminal. succeeded=${summary.succeeded.length} failed=${summary.failed.length} restarts=${state.restartCount}`,
        )

        doneProjects.add(projectRoot)
        projectExitCodes.set(
          projectRoot,
          (summary.failed.length > 0 || summary.escalated.length > 0) ? 1 : 0,
        )
        continue
      }

      // If max restarts were exhausted on a previous cycle and the pipeline
      // still hasn't reached terminal state, mark as done with exit code 2.
      if (maxRestartsExhaustedProjects.has(projectRoot)) {
        doneProjects.add(projectRoot)
        projectExitCodes.set(projectRoot, 2)
        continue
      }

      // Stall recovery
      const stallResult = await handleStallRecovery(
        health,
        state,
        { stallThreshold, maxRestarts, pack, outputFormat },
        resolvedDeps,
        {
          emitEvent: (evt) => emitEvent({ ...evt, project: projectRoot }),
          log: (msg) => log(`[${projectRoot}] ${msg}`),
        },
      )
      if (stallResult !== null) {
        if (stallResult.maxRestartsExceeded) {
          // Don't mark as done immediately — give one more poll cycle for
          // the terminal state check to detect if the pipeline completed.
          maxRestartsExhaustedProjects.add(projectRoot)
        } else {
          states.set(projectRoot, stallResult.state)
        }
      }
    }

    // Check if all projects are done
    if (doneProjects.size >= projects.length) {
      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000)
      emitEvent({
        type: 'supervisor:done',
        elapsed_seconds: elapsedSeconds,
        project_results: Object.fromEntries(projectExitCodes),
      })
      log(`\nAll projects reached terminal state. Elapsed: ${elapsedSeconds}s`)

      const exitCodes = [...projectExitCodes.values()]
      if (exitCodes.includes(2)) return 2
      if (exitCodes.includes(1)) return 1
      return 0
    }

    await sleep(pollInterval * 1000)
  }
}

// ---------------------------------------------------------------------------
// CLI registration
// ---------------------------------------------------------------------------

export function registerSupervisorCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('supervisor')
    .description('Monitor a pipeline run and automatically recover from stalls')
    .option('--poll-interval <seconds>', 'Health poll interval in seconds', (v) => parseInt(v, 10), 60)
    .option(
      '--stall-threshold <seconds>',
      'Staleness in seconds before killing a stalled pipeline',
      (v) => parseInt(v, 10),
      600,
    )
    .option('--max-restarts <n>', 'Maximum automatic restarts before aborting', (v) => parseInt(v, 10), 3)
    .option('--run-id <id>', 'Pipeline run ID to monitor (defaults to latest)')
    .option('--pack <name>', 'Methodology pack name', 'bmad')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option('--projects <paths>', 'Comma-separated project root directories to monitor (multi-project mode)')
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .option(
      '--experiment',
      'After post-run analysis, enter experiment mode: create branches, apply modifications, run single-story experiments, and report verdicts (Story 17-4)',
      false,
    )
    .option(
      '--max-experiments <n>',
      'Maximum number of experiments to run per analysis cycle (default: 2, Story 17-4 AC6)',
      (v: string) => parseInt(v, 10),
      2,
    )
    .action(
      async (opts: {
        pollInterval: number
        stallThreshold: number
        maxRestarts: number
        runId?: string
        pack: string
        projectRoot: string
        projects?: string
        outputFormat: string
        experiment: boolean
        maxExperiments: number
      }) => {
        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
        if (opts.stallThreshold < 120) {
          console.warn(
            `Warning: --stall-threshold ${opts.stallThreshold}s is below 120s. ` +
            `Agent steps typically take 45-90s. This may cause false stall detections and wasted restarts.`,
          )
        }

        // Multi-project mode: --projects takes precedence
        if (opts.projects) {
          if (opts.runId) {
            console.error('Error: --run-id cannot be used with --projects (ambiguous)')
            process.exitCode = 1
            return
          }
          if (opts.experiment) {
            console.warn('Warning: --experiment is not supported in multi-project mode — ignored.')
          }
          const projects = opts.projects.split(',').map((p) => resolve(p.trim()))
          const exitCode = await runMultiProjectSupervisor({
            projects,
            pollInterval: opts.pollInterval,
            stallThreshold: opts.stallThreshold,
            maxRestarts: opts.maxRestarts,
            outputFormat,
            pack: opts.pack,
          })
          process.exitCode = exitCode
          return
        }

        // Single-project mode (backwards compatible)
        const exitCode = await runSupervisorAction({
          pollInterval: opts.pollInterval,
          stallThreshold: opts.stallThreshold,
          maxRestarts: opts.maxRestarts,
          runId: opts.runId,
          pack: opts.pack,
          outputFormat,
          projectRoot: opts.projectRoot,
          experiment: opts.experiment,
          maxExperiments: opts.maxExperiments,
        })
        process.exitCode = exitCode
      },
    )
}
