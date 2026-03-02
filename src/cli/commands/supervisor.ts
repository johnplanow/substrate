/**
 * `substrate supervisor` command
 *
 * Long-running watchdog that polls pipeline health and automatically
 * kills and restarts stalled pipelines.
 *
 * Extracted from auto.ts during CLI flattening.
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync } from 'fs'
import type { OutputFormat } from './pipeline-shared.js'
import type { PipelineEvent } from '../../modules/implementation-orchestrator/event-types.js'
import type { PipelineHealthOutput } from './health.js'
import { getAutoHealthData } from './health.js'
import type { ResumeOptions } from './resume.js'
import { runResumeAction } from './resume.js'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import {
  incrementRunRestarts,
  getRunMetrics,
  getBaselineRunMetrics,
  getStoryMetricsForRun,
  aggregateTokenUsageForRun,
} from '../../persistence/queries/metrics.js'

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
  incrementRestarts: (runId: string, projectRoot: string) => void
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
  getTokenSnapshot: (runId: string, projectRoot: string) => { input: number; output: number; cost_usd: number }
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
      // Cache the db handle across calls so that a fresh connection is not
      // opened and closed on every supervisor restart (connection-per-call
      // would be wasteful given restarts are infrequent but the pattern should
      // not accumulate file descriptors over many restarts).
      let cachedDbWrapper: DatabaseWrapper | null = null
      return (runId: string, projectRoot: string) => {
        try {
          if (cachedDbWrapper === null) {
            const dbDir = join(projectRoot, '.substrate')
            const dbPath = join(dbDir, 'substrate.db')
            cachedDbWrapper = new DatabaseWrapper(dbPath)
          }
          incrementRunRestarts(cachedDbWrapper.getDb(), runId)
        } catch {
          // Best-effort — never block the supervisor
          try { cachedDbWrapper?.close() } catch { /* ignore close errors */ }
          cachedDbWrapper = null // reset so next call retries the connection
        }
      }
    })(),
    getTokenSnapshot: (runId: string, projectRoot: string) => {
      try {
        const dbPath = join(projectRoot, '.substrate', 'substrate.db')
        if (!existsSync(dbPath)) return { input: 0, output: 0, cost_usd: 0 }
        const dbWrapper = new DatabaseWrapper(dbPath)
        try {
          dbWrapper.open()
          const agg = aggregateTokenUsageForRun(dbWrapper.db, runId)
          return { input: agg.input, output: agg.output, cost_usd: agg.cost }
        } finally {
          try { dbWrapper.close() } catch { /* ignore */ }
        }
      } catch {
        return { input: 0, output: 0, cost_usd: 0 }
      }
    },
    runAnalysis: async (runId: string, projectRoot: string) => {
      // AC1 of Story 17-3: generate post-run analysis report after terminal state
      const dbPath = join(projectRoot, '.substrate', 'substrate.db')
      if (!existsSync(dbPath)) return
      const dbWrapper = new DatabaseWrapper(dbPath)
      try {
        dbWrapper.open()
        runMigrations(dbWrapper.db)
        const db = dbWrapper.db
        const run = getRunMetrics(db, runId)
        if (!run) return
        const stories = getStoryMetricsForRun(db, runId)
        const baseline = getBaselineRunMetrics(db)
        const baselineStories = baseline && baseline.run_id !== runId
          ? getStoryMetricsForRun(db, baseline.run_id)
          : []
        const analysisPath = '../../modules/supervisor/analysis.js'
        const { generateAnalysisReport, writeAnalysisReport } = await import(/* @vite-ignore */ analysisPath)
        const report = generateAnalysisReport(run, stories, baseline, baselineStories)
        writeAnalysisReport(report, projectRoot)
      } catch {
        // Best-effort — never block the supervisor
      } finally {
        try { dbWrapper.close() } catch { /* ignore */ }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// supervisor action
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
  const { getHealth, killPid, resumePipeline, sleep, incrementRestarts, runAnalysis, getTokenSnapshot } = { ...defaultSupervisorDeps(), ...deps }

  let restartCount = 0
  const startTime = Date.now()

  function emitEvent(event: Omit<PipelineEvent, 'ts'> & Record<string, unknown>): void {
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
    const health = await getHealth({ runId, projectRoot })
    const ts = new Date().toISOString()

    // Emit supervisor:poll heartbeat event on each cycle in JSON mode (Story 19-2 AC1-AC4)
    if (outputFormat === 'json') {
      const tokenSnapshot = health.run_id !== null
        ? getTokenSnapshot(health.run_id, projectRoot)
        : { input: 0, output: 0, cost_usd: 0 }
      const proc = health.process ?? { orchestrator_pid: null, child_pids: [], zombies: [] }
      emitEvent({
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
      })
    }

    log(
      `[${ts}] Health: ${health.verdict} | staleness=${health.staleness_seconds}s | ` +
        `stories: active=${health.stories.active} completed=${health.stories.completed} escalated=${health.stories.escalated}`,
    )

    // --- Terminal state: pipeline has completed, failed, or stopped ---
    if (health.verdict === 'NO_PIPELINE_RUNNING') {
      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000)

      const succeeded = Object.entries(health.stories.details)
        .filter(([, s]) => s.phase === 'COMPLETE')
        .map(([k]) => k)
      const failed = Object.entries(health.stories.details)
        .filter(([, s]) => s.phase !== 'COMPLETE' && s.phase !== 'PENDING' && s.phase !== 'ESCALATED')
        .map(([k]) => k)
      const escalated = Object.entries(health.stories.details)
        .filter(([, s]) => s.phase === 'ESCALATED')
        .map(([k]) => k)

      emitEvent({
        type: 'supervisor:summary',
        run_id: health.run_id,
        elapsed_seconds: elapsedSeconds,
        succeeded,
        failed,
        escalated,
        restarts: restartCount,
      })

      log(
        `\nPipeline reached terminal state. Elapsed: ${elapsedSeconds}s | ` +
          `succeeded: ${succeeded.length} | failed: ${failed.length} | restarts: ${restartCount}`,
      )

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
        // Experiment execution is delegated to the Experimenter module (src/modules/supervisor/experimenter.ts).
        // Recommendations come from Story 17-3 analysis engine. When no recommendations file
        // exists (17-3 not yet run), we degrade gracefully and log a message.
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

            // Wire and execute experiments via the Experimenter module (AC3/AC5/AC6/AC7).
            // RunStoryFn adapter: runs a single story via runRunAction, then queries the DB for the new run ID.
            try {
              const { createExperimenter } = await import(/* @vite-ignore */ '../../modules/supervisor/experimenter.js')
              const { getLatestRun: getLatest } = await import(/* @vite-ignore */ '../../persistence/queries/decisions.js')

              const dbPath = join(projectRoot, '.substrate', 'substrate.db')
              const expDbWrapper = new DatabaseWrapper(dbPath)
              try {
                expDbWrapper.open()
                runMigrations(expDbWrapper.db)
                const expDb = expDbWrapper.db

                const { runRunAction: runPipeline } = await import(/* @vite-ignore */ './run.js')
                const runStoryFn = async (opts: { stories: string; projectRoot: string; pack: string }) => {
                  const exitCode = await runPipeline({
                    pack: opts.pack,
                    stories: opts.stories,
                    concurrency: 1,
                    outputFormat: 'json',
                    projectRoot: opts.projectRoot,
                  })
                  // Retrieve the run ID of the just-completed experiment run from the DB
                  const latestRun = getLatest(expDb)
                  const newRunId = latestRun?.run_id ?? `experiment-${Date.now()}`
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
                  expDb,
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
                try { expDbWrapper.close() } catch { /* ignore */ }
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

      return (failed.length > 0 || escalated.length > 0) ? 1 : 0
    }

    // --- Stall detection: kill if staleness exceeds threshold ---
    // Check staleness directly so that configurable --stall-threshold values below the
    // hardcoded 600s in getAutoHealthData (which governs the STALLED verdict) take effect.
    if (health.staleness_seconds >= stallThreshold) {
      const pids = [
        ...(health.process.orchestrator_pid !== null ? [health.process.orchestrator_pid] : []),
        ...health.process.child_pids,
      ]

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
        try {
          killPid(pid, 'SIGTERM')
        } catch {
          // Process may already be dead — ignore
        }
      }

      // 5-second grace period, then SIGKILL
      await sleep(5000)
      for (const pid of pids) {
        try {
          killPid(pid, 'SIGKILL')
        } catch {
          // Process may already be dead — ignore
        }
      }

      // AC4 liveness check: verify processes are dead before restarting
      if (pids.length > 0) {
        let allDead = false
        for (let attempt = 0; attempt < 5; attempt++) {
          await sleep(1000)
          allDead = pids.every((pid) => {
            try {
              process.kill(pid, 0)
              return false // still alive
            } catch {
              return true // ESRCH: process is dead
            }
          })
          if (allDead) break
        }
        if (!allDead) {
          log(`Supervisor: Warning: Some PIDs may still be alive after SIGKILL`)
        }
      }

      // Safety valve: check max restarts before attempting restart
      if (restartCount >= maxRestarts) {
        emitEvent({
          type: 'supervisor:abort',
          run_id: health.run_id,
          reason: 'max_restarts_exceeded',
          attempts: restartCount,
        })
        log(`Supervisor: Max restarts (${maxRestarts}) exceeded. Aborting.`)
        return 2
      }

      // Restart the pipeline
      restartCount++

      // Persist restart count to run_metrics so writeRunMetrics captures it (Issue 2 fix)
      if (health.run_id !== null) {
        incrementRestarts(health.run_id, projectRoot)
      }

      emitEvent({
        type: 'supervisor:restart',
        run_id: health.run_id,
        attempt: restartCount,
      })

      log(`Supervisor: Restarting pipeline (attempt ${restartCount}/${maxRestarts})`)

      // Await resume so the pipeline has started before we poll health again.
      // Without this, the next poll could see NO_PIPELINE_RUNNING and exit prematurely.
      try {
        await resumePipeline({
          runId: health.run_id ?? undefined,
          outputFormat,
          projectRoot,
          concurrency: 3,
          pack,
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        log(`Supervisor: Resume error: ${message}`)
        if (outputFormat === 'json') {
          emitEvent({ type: 'supervisor:error' as any, reason: 'resume_failed', message } as any)
        }
      }
    }

    // Wait for next poll interval
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
        outputFormat: string
        experiment: boolean
        maxExperiments: number
      }) => {
        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
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
