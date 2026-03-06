/**
 * `substrate run` command
 *
 * Runs the autonomous pipeline. Extracted from the `auto run` sub-command
 * during CLI flattening so that `substrate run` works as a top-level command.
 *
 *   substrate run [--pack bmad] [--from <phase>] [--concept <text>] [--concept-file <path>]
 *                 [--stories 10-1,10-2] [--concurrency 2] [--output-format json] [--skip-ux]
 *
 * Architecture (ADR-001: Modular Monolith):
 *   CLI is a thin wiring layer — all business logic lives in modules.
 *
 * Database (ADR-003: SQLite WAL):
 *   Uses DatabaseWrapper from src/persistence/database.ts for all DB access.
 */

import type { Command } from 'commander'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { createEventEmitter } from '../../modules/implementation-orchestrator/event-emitter.js'
import { createProgressRenderer } from '../../modules/implementation-orchestrator/progress-renderer.js'
import type { PipelinePhase } from '../../modules/implementation-orchestrator/event-types.js'
import { runHelpAgent } from './help-agent.js'
import { createTuiApp, isTuiCapable, printNonTtyWarning } from '../../tui/index.js'

import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createEventBus } from '../../core/event-bus.js'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { createContextCompiler } from '../../modules/context-compiler/index.js'
import { createDispatcher } from '../../modules/agent-dispatch/index.js'
import { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { createImplementationOrchestrator, discoverPendingStoryKeys } from '../../modules/implementation-orchestrator/index.js'
import { createPhaseOrchestrator } from '../../modules/phase-orchestrator/index.js'
import { runAnalysisPhase } from '../../modules/phase-orchestrator/phases/analysis.js'
import { runPlanningPhase } from '../../modules/phase-orchestrator/phases/planning.js'
import { runSolutioningPhase } from '../../modules/phase-orchestrator/phases/solutioning.js'
import { runUxDesignPhase } from '../../modules/phase-orchestrator/phases/ux-design.js'
import { runResearchPhase } from '../../modules/phase-orchestrator/phases/research.js'
import {
  createPipelineRun,
  addTokenUsage,
  getTokenUsageSummary,
  updatePipelineRun,
  getRunningPipelineRuns,
} from '../../persistence/queries/decisions.js'
import type { PipelineRun } from '../../persistence/queries/decisions.js'
import { inspectProcessTree } from './health.js'
import {
  writeRunMetrics,
  getStoryMetricsForRun,
  aggregateTokenUsageForRun,
} from '../../persistence/queries/metrics.js'
import { createLogger } from '../../utils/logger.js'
import {
  VALID_PHASES,
  createStopAfterGate,
  validateStopAfterFromConflict,
  formatPhaseCompletionSummary,
} from '../../modules/stop-after/index.js'
import type { PhaseName } from '../../modules/stop-after/index.js'

// Shared pipeline utilities
import {
  type OutputFormat,
  formatOutput,
  formatTokenTelemetry,
  validateStoryKey,
  STORY_KEY_PATTERN,
  BMAD_BASELINE_TOKENS,
  BMAD_BASELINE_TOKENS_FULL,
  buildPipelineStatusOutput,
  formatPipelineSummary,
  parseDbTimestampAsUtc,
} from './pipeline-shared.js'

const logger = createLogger('run-cmd')

// ---------------------------------------------------------------------------
// auto run action
// ---------------------------------------------------------------------------

/**
 * Map internal orchestrator phase names to pipeline event protocol phase names.
 * Returns null for internal phases that don't correspond to an event phase
 * (e.g., IN_MINOR_FIX / IN_MAJOR_FIX map to 'fix').
 */
function mapInternalPhaseToEventPhase(internalPhase: string): PipelinePhase | null {
  switch (internalPhase) {
    case 'IN_STORY_CREATION':
      return 'create-story'
    case 'IN_DEV':
      return 'dev-story'
    case 'IN_REVIEW':
      return 'code-review'
    case 'IN_MINOR_FIX':
    case 'IN_MAJOR_FIX':
      return 'fix'
    default:
      return null
  }
}

export interface RunOptions {
  pack: string
  from?: PhaseName
  stopAfter?: PhaseName
  concept?: string
  conceptFile?: string
  stories?: string
  concurrency: number
  outputFormat: OutputFormat
  projectRoot: string
  /** When true, emit structured NDJSON events on stdout (AC1) */
  events?: boolean
  /** When true, preserve full pino stderr output for debugging (AC5) */
  verbose?: boolean
  /** When true, activate the full-screen TUI dashboard (Story 15-5) */
  tui?: boolean
  /** When true, skip the UX design phase even if enabled in the pack manifest (AC7) */
  skipUx?: boolean
  /** When true, enable the research phase even if not set in the pack manifest */
  research?: boolean
  /** When true, skip the research phase even if enabled in the pack manifest */
  skipResearch?: boolean
}

export async function runRunAction(options: RunOptions): Promise<number> {
  const {
    pack: packName,
    from: startPhase,
    stopAfter,
    concept: conceptArg,
    conceptFile,
    stories: storiesArg,
    concurrency,
    outputFormat,
    projectRoot,
    events: eventsFlag,
    verbose: verboseFlag,
    tui: tuiFlag,
    skipUx,
    research: researchFlag,
    skipResearch: skipResearchFlag,
  } = options

  // Validate --from phase
  if (startPhase !== undefined && !VALID_PHASES.includes(startPhase)) {
    const errorMsg = `Invalid phase '${startPhase}'. Valid phases: ${VALID_PHASES.join(', ')}`
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  // Validate --stop-after phase (before any DB writes)
  if (stopAfter !== undefined && !VALID_PHASES.includes(stopAfter)) {
    const errorMsg = `Invalid phase: "${stopAfter}". Valid phases: ${VALID_PHASES.join(', ')}`
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  // Validate --stop-after / --from conflict (before any DB writes)
  if (stopAfter !== undefined && startPhase !== undefined) {
    const conflictResult = validateStopAfterFromConflict(stopAfter, startPhase)
    if (!conflictResult.valid) {
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, conflictResult.error) + '\n')
      } else {
        process.stderr.write(`Error: ${conflictResult.error ?? 'Invalid --stop-after / --from combination'}\n`)
      }
      return 1
    }
  }

  // Resolve concept text when starting from analysis
  let concept: string | undefined
  if (startPhase === 'research' || startPhase === 'analysis' || startPhase === undefined) {
    if (conceptFile !== undefined && conceptFile !== '') {
      try {
        concept = await readFile(conceptFile, 'utf-8')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const errorMsg = `Failed to read concept file '${conceptFile}': ${msg}`
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
        } else {
          process.stderr.write(`Error: ${errorMsg}\n`)
        }
        return 1
      }
    } else if (conceptArg !== undefined && conceptArg !== '') {
      concept = conceptArg
    } else if (startPhase === 'research' || startPhase === 'analysis') {
      // Analysis requires concept
      const errorMsg = '--concept or --concept-file required when starting from research or analysis phase'
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }
  }

  const packPath = join(projectRoot, 'packs', packName)
  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbDir = join(dbRoot, '.substrate')
  const dbPath = join(dbDir, 'substrate.db')

  // If --from is provided, we're running the full phase pipeline
  if (startPhase !== undefined) {
    return runFullPipeline({
      packName,
      packPath,
      dbDir,
      dbPath,
      startPhase,
      stopAfter,
      concept,
      concurrency,
      outputFormat,
      projectRoot,
      ...(eventsFlag === true ? { events: true } : {}),
      ...(skipUx === true ? { skipUx: true } : {}),
      ...(researchFlag === true ? { research: true } : {}),
      ...(skipResearchFlag === true ? { skipResearch: true } : {}),
    })
  }

  // Legacy behavior: run implementation-only (existing auto run without --from)
  // Parse story keys
  let storyKeys: string[] = []
  if (storiesArg !== undefined && storiesArg !== '') {
    storyKeys = storiesArg
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0)

    // Validate story key format
    for (const key of storyKeys) {
      if (!validateStoryKey(key)) {
        const errorMsg = `Story key '${key}' is not a valid format. Expected: <epic>-<story> (e.g., 10-1)`
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
        } else {
          process.stderr.write(`Error: ${errorMsg}\n`)
        }
        return 1
      }
    }
  }

  // Ensure database directory
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  // Open database
  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    try {
      dbWrapper.open()
      runMigrations(dbWrapper.db)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Decision store not initialized. Run 'substrate init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    const db = dbWrapper.db

    // Load methodology pack
    const packLoader = createPackLoader()
    let pack
    try {
      pack = await packLoader.load(packPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Methodology pack '${packName}' not found. Run 'substrate init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    // Discover story keys from DB if not provided
    if (storyKeys.length === 0) {
      // Query requirements table for active stories
      const activeReqs = db
        .prepare(`SELECT description FROM requirements WHERE status = 'active' AND type = 'story'`)
        .all() as Array<{ description: string }>

      for (const req of activeReqs) {
        const match = STORY_KEY_PATTERN.exec(req.description.trim())
        if (match !== null) {
          storyKeys.push(match[0])
        }
      }

      // AC8: filter out stories already completed in previous pipeline runs
      if (storyKeys.length > 0) {
        const completedStoryKeys = new Set<string>()
        try {
          const completedRuns = db
            .prepare(
              `SELECT token_usage_json FROM pipeline_runs WHERE status = 'completed' AND token_usage_json IS NOT NULL`,
            )
            .all() as Array<{ token_usage_json: string }>

          for (const row of completedRuns) {
            try {
              const state = JSON.parse(row.token_usage_json) as {
                stories?: Record<string, { phase: string }>
              }
              if (state.stories !== undefined) {
                for (const [key, s] of Object.entries(state.stories)) {
                  if (s.phase === 'COMPLETE') {
                    completedStoryKeys.add(key)
                  }
                }
              }
            } catch {
              // ignore parse errors
            }
          }
        } catch {
          // ignore query errors — proceed with all discovered stories
        }

        storyKeys = storyKeys.filter((k) => !completedStoryKeys.has(k))
      }

      // Fallback: discover from epics.md if requirements table is empty
      if (storyKeys.length === 0) {
        storyKeys = discoverPendingStoryKeys(projectRoot)
        if (storyKeys.length > 0) {
          process.stdout.write(
            `Discovered ${storyKeys.length} pending stories from epics.md: ${storyKeys.join(', ')}\n`,
          )
        }
      }

      if (storyKeys.length === 0) {
        if (outputFormat === 'human') {
          process.stdout.write('No pending stories found in decision store.\n')
        } else {
          process.stdout.write(
            formatOutput({ storyKeys: [], message: 'No pending stories found.' }, 'json', true) +
              '\n',
          )
        }
        return 0
      }
    }

    // Sweep stale "running" pipeline rows whose orchestrator process is dead.
    // Without this, zombie rows from crashed runs accumulate and confuse agents
    // that inspect pipeline_runs to determine if a run is in progress.
    const staleRuns = getRunningPipelineRuns(db) ?? []
    if (staleRuns.length > 0) {
      const processInfo = inspectProcessTree({ projectRoot })
      let swept = 0
      for (const stale of staleRuns) {
        // If no orchestrator is running, all "running" rows are stale.
        // If an orchestrator IS running, it belongs to someone else's active run —
        // we still mark all existing rows as failed since we're about to start a new one.
        // (The new run gets its own fresh row below.)
        if (processInfo.orchestrator_pid === null) {
          updatePipelineRun(db, stale.id, { status: 'failed' })
          swept++
        }
      }
      if (swept > 0) {
        process.stderr.write(`Swept ${swept} stale pipeline run(s) (dead orchestrator)\n`)
      }
    }

    // Create pipeline run record
    const pipelineRun = createPipelineRun(db, {
      methodology: pack.manifest.name,
      start_phase: 'implementation',
      config_json: JSON.stringify({ storyKeys, concurrency }),
    })

    // Create dependencies
    const eventBus = createEventBus()
    const contextCompiler = createContextCompiler({ db })
    const adapterRegistry = new AdapterRegistry()
    await adapterRegistry.discoverAndRegister()

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry,
    })

    // AC5: Subscribe to phase-complete events to record token usage
    eventBus.on('orchestrator:story-phase-complete', (payload) => {
      try {
        const result = payload.result as {
          tokenUsage?: { input: number; output: number }
        }
        if (result?.tokenUsage !== undefined) {
          const { input, output } = result.tokenUsage
          // Estimate cost: $3/1M input + $15/1M output (Claude pricing)
          const costUsd = (input * 3 + output * 15) / 1_000_000
          addTokenUsage(db, pipelineRun.id, {
            phase: payload.phase,
            agent: 'claude-code',
            input_tokens: input,
            output_tokens: output,
            cost_usd: costUsd,
            metadata: JSON.stringify({ storyKey: payload.storyKey }),
          })
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to record token usage for phase')
      }

      if (outputFormat === 'human') {
        process.stdout.write(
          `  [${payload.phase}] ${payload.storyKey} — phase complete\n`,
        )
      }
    })

    // Subscribe to progress events
    if (outputFormat === 'human') {
      eventBus.on('orchestrator:story-complete', (payload) => {
        process.stdout.write(
          `  [COMPLETE] ${payload.storyKey} (${payload.reviewCycles} review cycle(s))\n`,
        )
      })
      eventBus.on('orchestrator:story-escalated', (payload) => {
        process.stdout.write(
          `  [ESCALATED] ${payload.storyKey}: ${payload.lastVerdict}\n`,
        )
      })
    }

    // AC6 (Story 15-5): Non-TTY rejection for --tui flag
    if (tuiFlag === true && !isTuiCapable()) {
      printNonTtyWarning()
      // Fall through to default output (tuiApp remains undefined)
    }

    // AC5 (Story 15-2): Suppress pino stderr by default unless --verbose is set.
    // This prevents raw JSON log lines from appearing in default terminal output.
    if (verboseFlag !== true && eventsFlag !== true) {
      // Override LOG_LEVEL to 'silent' so pino writes nothing to stderr.
      // We only do this when NOT in --events mode (events mode is programmatic).
      process.env.LOG_LEVEL = 'silent'
    }

    // AC1-AC6 (Story 15-5): Wire TUI dashboard when --tui flag is active and stdout is a TTY.
    let tuiApp: ReturnType<typeof createTuiApp> | undefined
    if (tuiFlag === true && isTuiCapable() && eventsFlag !== true && outputFormat === 'human') {
      tuiApp = createTuiApp(process.stdout, process.stdin)

      // Emit pipeline:start to TUI
      tuiApp.handleEvent({
        type: 'pipeline:start',
        ts: new Date().toISOString(),
        run_id: pipelineRun.id,
        stories: storyKeys,
        concurrency,
      })

      // Wire story phase events to the TUI
      eventBus.on('orchestrator:story-phase-complete', (payload) => {
        const phase = mapInternalPhaseToEventPhase(payload.phase)
        if (phase !== null && tuiApp !== undefined) {
          const result = payload.result as { story_file?: string; verdict?: string }
          tuiApp.handleEvent({
            type: 'story:phase',
            ts: new Date().toISOString(),
            key: payload.storyKey,
            phase,
            status: 'complete',
            ...(phase === 'code-review' && result?.verdict !== undefined
              ? { verdict: result.verdict }
              : {}),
            ...(phase === 'create-story' && result?.story_file !== undefined
              ? { file: result.story_file }
              : {}),
          })
        }
      })

      // Wire story:done events
      eventBus.on('orchestrator:story-complete', (payload) => {
        tuiApp?.handleEvent({
          type: 'story:done',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          result: 'success',
          review_cycles: payload.reviewCycles,
        })
      })

      // Wire story:escalation events
      eventBus.on('orchestrator:story-escalated', (payload) => {
        const rawIssues = Array.isArray(payload.issues) ? payload.issues : []
        const issues = rawIssues.map((issue) => {
          const iss = issue as { severity?: string; file?: string; description?: string; desc?: string }
          return {
            severity: (iss.severity ?? 'unknown') as 'blocker' | 'major' | 'minor' | 'unknown',
            file: iss.file ?? '',
            desc: iss.desc ?? iss.description ?? '',
          }
        })
        tuiApp?.handleEvent({
          type: 'story:escalation',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          reason: payload.lastVerdict ?? 'escalated',
          cycles: payload.reviewCycles ?? 0,
          issues,
        })
      })
    }

    // AC1-AC4 (Story 15-2): Wire progress renderer when default human output is active
    // (i.e., not --events and not --output-format json and not --tui).
    let progressRenderer: ReturnType<typeof createProgressRenderer> | undefined
    if (eventsFlag !== true && outputFormat === 'human' && tuiApp === undefined) {
      progressRenderer = createProgressRenderer(process.stdout)

      // Emit pipeline:start to renderer
      progressRenderer.render({
        type: 'pipeline:start',
        ts: new Date().toISOString(),
        run_id: pipelineRun.id,
        stories: storyKeys,
        concurrency,
      })

      // Wire story phase start events to the renderer (in_progress status)
      eventBus.on('orchestrator:story-phase-start', (payload) => {
        const phase = mapInternalPhaseToEventPhase(payload.phase)
        if (phase !== null && progressRenderer !== undefined) {
          progressRenderer.render({
            type: 'story:phase',
            ts: new Date().toISOString(),
            key: payload.storyKey,
            phase,
            status: 'in_progress',
          })
        }
      })

      // Wire story phase events to the renderer
      eventBus.on('orchestrator:story-phase-complete', (payload) => {
        const phase = mapInternalPhaseToEventPhase(payload.phase)
        if (phase !== null && progressRenderer !== undefined) {
          const result = payload.result as { story_file?: string; verdict?: string }
          progressRenderer.render({
            type: 'story:phase',
            ts: new Date().toISOString(),
            key: payload.storyKey,
            phase,
            status: 'complete',
            ...(phase === 'code-review' && result?.verdict !== undefined
              ? { verdict: result.verdict }
              : {}),
            ...(phase === 'create-story' && result?.story_file !== undefined
              ? { file: result.story_file }
              : {}),
          })
        }
      })

      // Wire story:done events
      eventBus.on('orchestrator:story-complete', (payload) => {
        progressRenderer?.render({
          type: 'story:done',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          result: 'success',
          review_cycles: payload.reviewCycles,
        })
      })

      // Wire story:escalation events
      eventBus.on('orchestrator:story-escalated', (payload) => {
        const rawIssues = Array.isArray(payload.issues) ? payload.issues : []
        const issues = rawIssues.map((issue) => {
          const iss = issue as { severity?: string; file?: string; description?: string; desc?: string }
          return {
            severity: (iss.severity ?? 'unknown') as 'blocker' | 'major' | 'minor' | 'unknown',
            file: iss.file ?? '',
            desc: iss.desc ?? iss.description ?? '',
          }
        })
        progressRenderer?.render({
          type: 'story:escalation',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          reason: payload.lastVerdict ?? 'escalated',
          cycles: payload.reviewCycles ?? 0,
          issues,
        })
      })

      // Wire story:warn events for non-fatal warnings
      eventBus.on('orchestrator:story-warn', (payload) => {
        progressRenderer?.render({
          type: 'story:warn',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          msg: payload.msg,
        })
      })
    }

    // AC1: Wire NDJSON event emitter when --events flag is active
    let ndjsonEmitter: ReturnType<typeof createEventEmitter> | undefined
    if (eventsFlag === true) {
      ndjsonEmitter = createEventEmitter(process.stdout)

      // AC2: pipeline:start — first event
      ndjsonEmitter.emit({
        type: 'pipeline:start',
        ts: new Date().toISOString(),
        run_id: pipelineRun.id,
        stories: storyKeys,
        concurrency,
      })

      // AC3: story:phase events for each pipeline phase (in_progress on start)
      eventBus.on('orchestrator:story-phase-start', (payload) => {
        const phase = mapInternalPhaseToEventPhase(payload.phase)
        if (phase !== null) {
          ndjsonEmitter!.emit({
            type: 'story:phase',
            ts: new Date().toISOString(),
            key: payload.storyKey,
            phase,
            status: 'in_progress',
          })
        }
      })

      // AC3: story:phase events for each pipeline phase (complete on finish)
      eventBus.on('orchestrator:story-phase-complete', (payload) => {
        // Map internal phase names to event protocol phase names
        const phase = mapInternalPhaseToEventPhase(payload.phase)
        if (phase !== null) {
          const result = payload.result as {
            story_file?: string
            verdict?: string
          }
          ndjsonEmitter!.emit({
            type: 'story:phase',
            ts: new Date().toISOString(),
            key: payload.storyKey,
            phase,
            status: 'complete',
            ...(phase === 'code-review' && result?.verdict !== undefined
              ? { verdict: result.verdict }
              : {}),
            ...(phase === 'create-story' && result?.story_file !== undefined
              ? { file: result.story_file }
              : {}),
          })
        }
      })

      // AC4: story:done events on story completion
      eventBus.on('orchestrator:story-complete', (payload) => {
        ndjsonEmitter!.emit({
          type: 'story:done',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          result: 'success',
          review_cycles: payload.reviewCycles,
        })
      })

      // AC5: story:escalation events on escalation (+ Story 22-3: include diagnosis)
      eventBus.on('orchestrator:story-escalated', (payload) => {
        const rawIssues = Array.isArray(payload.issues) ? payload.issues : []
        const issues = rawIssues.map((issue) => {
          const iss = issue as { severity?: string; file?: string; description?: string; desc?: string }
          return {
            severity: (iss.severity ?? 'unknown') as 'blocker' | 'major' | 'minor' | 'unknown',
            file: iss.file ?? '',
            desc: iss.desc ?? iss.description ?? '',
          }
        })
        ndjsonEmitter!.emit({
          type: 'story:escalation',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          reason: payload.lastVerdict ?? 'escalated',
          cycles: payload.reviewCycles ?? 0,
          issues,
          ...(payload.diagnosis !== undefined ? { diagnosis: payload.diagnosis } : {}),
        })
      })

      // AC6: story:warn events for non-fatal warnings
      eventBus.on('orchestrator:story-warn', (payload) => {
        ndjsonEmitter!.emit({
          type: 'story:warn',
          ts: new Date().toISOString(),
          key: payload.storyKey,
          msg: payload.msg,
        })
      })

      // Heartbeat events (Story 16-7 AC1)
      eventBus.on('orchestrator:heartbeat', (payload) => {
        ndjsonEmitter!.emit({
          type: 'pipeline:heartbeat',
          ts: new Date().toISOString(),
          run_id: payload.runId,
          active_dispatches: payload.activeDispatches,
          completed_dispatches: payload.completedDispatches,
          queued_dispatches: payload.queuedDispatches,
        })
      })

      // Stall detection events (Story 16-7 AC2)
      eventBus.on('orchestrator:stall', (payload) => {
        ndjsonEmitter!.emit({
          type: 'story:stall',
          ts: new Date().toISOString(),
          run_id: payload.runId,
          story_key: payload.storyKey,
          phase: payload.phase,
          elapsed_ms: payload.elapsedMs,
          child_pid: payload.childPid,
        })
      })
    }

    // Create orchestrator
    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config: {
        maxConcurrency: concurrency,
        maxReviewCycles: 2,
        pipelineRunId: pipelineRun.id,
        // Only enable heartbeat/watchdog timer when --events mode is active (AC1/Issue 5)
        enableHeartbeat: eventsFlag === true,
      },
      projectRoot,
    })

    // Display startup header (only in legacy human mode without progress renderer or NDJSON emitter)
    if (outputFormat === 'human' && progressRenderer === undefined && ndjsonEmitter === undefined) {
      process.stdout.write(
        `Starting pipeline: ${storyKeys.length} story/stories, concurrency=${concurrency}\n`,
      )
      process.stdout.write(`Pipeline run ID: ${pipelineRun.id}\n`)
      process.stdout.write(`Stories: ${storyKeys.join(', ')}\n`)
    }

    // Run the orchestrator
    const status = await orchestrator.run(storyKeys)

    // Compute succeeded/failed/escalated for both progress renderer and ndjson emitter
    const succeededKeys: string[] = []
    const failedKeys: string[] = []
    const escalatedKeys: string[] = []
    for (const [key, s] of Object.entries(status.stories)) {
      if (s.phase === 'COMPLETE') succeededKeys.push(key)
      else if (s.phase === 'ESCALATED') {
        if (s.error !== undefined) failedKeys.push(key)
        else escalatedKeys.push(key)
      } else {
        failedKeys.push(key)
      }
    }

    // AC1 (Story 17-2): Write run-level metrics to DB on pipeline terminal state
    try {
      const runEndMs = Date.now()
      const runStartMs = parseDbTimestampAsUtc(pipelineRun.created_at).getTime()
      const tokenAgg = aggregateTokenUsageForRun(db, pipelineRun.id)
      const storyMetrics = getStoryMetricsForRun(db, pipelineRun.id)
      const totalReviewCycles = storyMetrics.reduce((sum, m) => sum + (m.review_cycles ?? 0), 0)
      const totalDispatches = storyMetrics.reduce((sum, m) => sum + (m.dispatches ?? 0), 0)
      // restarts is preserved automatically by writeRunMetrics (ON CONFLICT DO UPDATE keeps
      // the DB-side value), so there is no TOCTOU race from a concurrent incrementRunRestarts().
      writeRunMetrics(db, {
        run_id: pipelineRun.id,
        methodology: pack.manifest.name,
        status: (failedKeys.length > 0 || escalatedKeys.length > 0) ? 'failed' : 'completed',
        started_at: pipelineRun.created_at,
        completed_at: new Date().toISOString(),
        wall_clock_seconds: Math.round((runEndMs - runStartMs) / 1000),
        total_input_tokens: tokenAgg.input,
        total_output_tokens: tokenAgg.output,
        total_cost_usd: tokenAgg.cost,
        stories_attempted: storyKeys.length,
        stories_succeeded: succeededKeys.length,
        stories_failed: failedKeys.length,
        stories_escalated: escalatedKeys.length,
        total_review_cycles: totalReviewCycles,
        total_dispatches: totalDispatches,
        concurrency_setting: concurrency,
        max_concurrent_actual: status.maxConcurrentActual ?? Math.min(concurrency, storyKeys.length),
        // restarts: not passed — writeRunMetrics preserves the DB-side value on upsert
      })
    } catch (metricsErr) {
      logger.warn({ err: metricsErr }, 'Failed to write run metrics (best-effort)')
    }

    // pipeline:complete — emit to progress renderer (AC2 of Story 15-2)
    if (progressRenderer !== undefined) {
      progressRenderer.render({
        type: 'pipeline:complete',
        ts: new Date().toISOString(),
        succeeded: succeededKeys,
        failed: failedKeys,
        escalated: escalatedKeys,
      })
    }

    // pipeline:complete — emit to TUI app (Story 15-5)
    if (tuiApp !== undefined) {
      tuiApp.handleEvent({
        type: 'pipeline:complete',
        ts: new Date().toISOString(),
        succeeded: succeededKeys,
        failed: failedKeys,
        escalated: escalatedKeys,
      })
    }

    // AC2: pipeline:complete — last event (emitted after all stories settle)
    if (ndjsonEmitter !== undefined) {
      ndjsonEmitter.emit({
        type: 'pipeline:complete',
        ts: new Date().toISOString(),
        succeeded: succeededKeys,
        failed: failedKeys,
        escalated: escalatedKeys,
      })
    }

    // Record final token usage for the run
    const tokenSummary = getTokenUsageSummary(db, pipelineRun.id)

    // Keep the process alive so the user can interact with the TUI (Story 15-5)
    // Wait for TUI to exit BEFORE writing any plain-text summary to stdout, so
    // that the alternate-screen buffer is restored before the summary appears.
    if (tuiApp !== undefined) {
      await tuiApp.waitForExit()
    }

    // Output results (after TUI has exited and restored the normal screen)
    if (outputFormat === 'json') {
      process.stdout.write(
        formatOutput(
          {
            pipelineRunId: pipelineRun.id,
            status,
            tokenSummary,
          },
          'json',
          true,
        ) + '\n',
      )
    } else if (tuiApp === undefined && ndjsonEmitter === undefined) {
      // Only write plain-text summary when TUI and NDJSON emitter are not active;
      // TUI displays pipeline status via its event-driven panels, and NDJSON
      // emitter already emits pipeline:complete with structured data.
      process.stdout.write('\n')
      // Count story outcomes
      let completed = 0
      let escalated = 0
      for (const s of Object.values(status.stories)) {
        if (s.phase === 'COMPLETE') completed++
        else if (s.phase === 'ESCALATED') escalated++
      }
      process.stdout.write(
        `Pipeline complete: ${completed}/${storyKeys.length} stories completed, ${escalated} escalated\n`,
      )
      process.stdout.write('\n')
      process.stdout.write(formatTokenTelemetry(tokenSummary) + '\n')
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'run failed')
    return 1
  } finally {
    try {
      dbWrapper.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Full multi-phase pipeline execution
// ---------------------------------------------------------------------------

export interface FullPipelineOptions {
  packName: string
  packPath: string
  dbDir: string
  dbPath: string
  startPhase: PhaseName
  stopAfter?: PhaseName
  concept?: string
  concurrency: number
  outputFormat: OutputFormat
  projectRoot: string
  /** When true, emit structured NDJSON events on stdout for phase transitions and failures */
  events?: boolean
  /** When true, skip UX design phase even if enabled in pack manifest (AC7) */
  skipUx?: boolean
  /** When true, enable research phase even if not set in pack manifest */
  research?: boolean
  /** When true, skip research phase even if enabled in pack manifest */
  skipResearch?: boolean
}

async function runFullPipeline(options: FullPipelineOptions): Promise<number> {
  const { packName, packPath, dbDir, dbPath, startPhase, stopAfter, concept, concurrency, outputFormat, projectRoot, events: eventsFlag, skipUx, research: researchFlag, skipResearch: skipResearchFlag } =
    options

  // Ensure database directory
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    try {
      dbWrapper.open()
      runMigrations(dbWrapper.db)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Decision store not initialized. Run 'substrate init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    const db = dbWrapper.db

    // Load methodology pack
    const packLoader = createPackLoader()
    let pack
    try {
      pack = await packLoader.load(packPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Methodology pack '${packName}' not found. Run 'substrate init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    // Create shared dependencies
    const eventBus = createEventBus()
    const contextCompiler = createContextCompiler({ db })
    const adapterRegistry = new AdapterRegistry()
    await adapterRegistry.discoverAndRegister()

    const dispatcher = createDispatcher({ eventBus, adapterRegistry })

    const phaseDeps = { db, pack, contextCompiler, dispatcher }

    // Create PhaseOrchestrator — when --skip-ux is set, override uxDesign to false;
    // when --research/--skip-research are set, override research accordingly.
    // Resolve effective research setting: CLI --research wins over manifest false;
    // CLI --skip-research wins over manifest true; otherwise use manifest value (default false).
    let effectiveResearch = pack.manifest.research === true
    if (researchFlag === true) effectiveResearch = true
    if (skipResearchFlag === true) effectiveResearch = false

    let effectiveUxDesign = pack.manifest.uxDesign === true
    if (skipUx === true) effectiveUxDesign = false

    // Mutate manifest in place to preserve the Pack class prototype (getPhases, etc.)
    pack.manifest.research = effectiveResearch
    pack.manifest.uxDesign = effectiveUxDesign
    const phaseOrchestrator = createPhaseOrchestrator({ db, pack })

    // Start the run
    const startedAt = Date.now()
    const runId = await phaseOrchestrator.startRun(concept ?? '', startPhase)

    if (outputFormat === 'human') {
      process.stdout.write(`Starting full pipeline from phase: ${startPhase}\n`)
      process.stdout.write(`Pipeline run ID: ${runId}\n`)
    }

    // Execute phases in order starting from startPhase
    // Include 'research' before analysis when research is enabled
    // Include 'ux-design' between planning and solutioning when the pack has it enabled
    const phaseOrder: Array<PhaseName | 'ux-design'> = []
    if (effectiveResearch) phaseOrder.push('research')
    phaseOrder.push('analysis', 'planning')
    if (effectiveUxDesign) phaseOrder.push('ux-design')
    phaseOrder.push('solutioning', 'implementation')
    const startIdx = phaseOrder.indexOf(startPhase)

    for (let i = startIdx; i < phaseOrder.length; i++) {
      const currentPhase = phaseOrder[i]

      if (outputFormat === 'human') {
        process.stdout.write(`\n[${currentPhase.toUpperCase()}] Starting...\n`)
      }

      // Execute the phase
      if (currentPhase === 'analysis') {
        const result = await runAnalysisPhase(phaseDeps, { runId, concept: concept ?? '' })

        // Record token usage
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd =
            (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, runId, {
            phase: 'analysis',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }

        if (result.result === 'failed') {
          updatePipelineRun(db, runId, { status: 'failed' })
          const errorMsg = `Analysis phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }

        if (outputFormat === 'human') {
          process.stdout.write(
            `[ANALYSIS] Complete — product brief created (artifact: ${result.artifact_id ?? 'n/a'})\n`,
          )
          process.stdout.write(
            `  Tokens: ${result.tokenUsage.input.toLocaleString()} input / ${result.tokenUsage.output.toLocaleString()} output\n`,
          )
        }
      } else if (currentPhase === 'planning') {
        const result = await runPlanningPhase(phaseDeps, { runId })

        // Record token usage
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd =
            (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, runId, {
            phase: 'planning',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }

        if (result.result === 'failed') {
          updatePipelineRun(db, runId, { status: 'failed' })
          const errorMsg = `Planning phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }

        if (outputFormat === 'human') {
          process.stdout.write(
            `[PLANNING] Complete — ${result.requirements_count ?? 0} requirements, ${result.user_stories_count ?? 0} user stories\n`,
          )
          process.stdout.write(
            `  Tokens: ${result.tokenUsage.input.toLocaleString()} input / ${result.tokenUsage.output.toLocaleString()} output\n`,
          )
        }
      } else if (currentPhase === 'research') {
        const result = await runResearchPhase(phaseDeps, { runId, concept: concept ?? '' })

        // Record token usage
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd =
            (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, runId, {
            phase: 'research',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }

        if (result.result === 'failed') {
          updatePipelineRun(db, runId, { status: 'failed' })
          const errorMsg = `Research phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }

        if (outputFormat === 'human') {
          process.stdout.write(
            `[RESEARCH] Complete — research findings artifact registered (artifact: ${result.artifact_id ?? 'n/a'})\n`,
          )
          process.stdout.write(
            `  Tokens: ${result.tokenUsage.input.toLocaleString()} input / ${result.tokenUsage.output.toLocaleString()} output\n`,
          )
        }
      } else if (currentPhase === 'ux-design') {
        const result = await runUxDesignPhase(phaseDeps, { runId })

        // Record token usage
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd =
            (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, runId, {
            phase: 'ux-design',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }

        if (result.result === 'failed') {
          updatePipelineRun(db, runId, { status: 'failed' })
          const errorMsg = `UX design phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }

        if (outputFormat === 'human') {
          process.stdout.write(
            `[UX-DESIGN] Complete — UX design artifact registered (artifact: ${result.artifact_id ?? 'n/a'})\n`,
          )
          process.stdout.write(
            `  Tokens: ${result.tokenUsage.input.toLocaleString()} input / ${result.tokenUsage.output.toLocaleString()} output\n`,
          )
        }
      } else if (currentPhase === 'solutioning') {
        const result = await runSolutioningPhase(phaseDeps, { runId })

        // Record token usage
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd =
            (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, runId, {
            phase: 'solutioning',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }

        if (result.result === 'failed') {
          const errorMsg = `Solutioning phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}`
          // Use markPhaseFailed to record failure in phase history AND update status to 'failed'
          phaseOrchestrator.markPhaseFailed(runId, 'solutioning', errorMsg)
          // Surface failure via NDJSON event stream when --events is active
          if (eventsFlag === true) {
            const ndjsonEmitter = createEventEmitter(process.stdout)
            ndjsonEmitter.emit({
              type: 'story:warn',
              ts: new Date().toISOString(),
              key: 'solutioning',
              msg: errorMsg,
            })
          }
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }

        if (outputFormat === 'human') {
          process.stdout.write(
            `[SOLUTIONING] Complete — ${result.architecture_decisions ?? 0} architecture decisions, ${result.epics ?? 0} epics, ${result.stories ?? 0} stories\n`,
          )
          process.stdout.write(
            `  Tokens: ${result.tokenUsage.input.toLocaleString()} input / ${result.tokenUsage.output.toLocaleString()} output\n`,
          )
        }
      } else if (currentPhase === 'implementation') {
        // Run implementation orchestrator
        const orchestrator = createImplementationOrchestrator({
          db,
          pack,
          contextCompiler,
          dispatcher,
          eventBus,
          config: {
            maxConcurrency: concurrency,
            maxReviewCycles: 2,
            pipelineRunId: runId,
          },
          projectRoot,
        })

        // Subscribe to events for progress reporting
        eventBus.on('orchestrator:story-phase-complete', (payload) => {
          try {
            const result = payload.result as {
              tokenUsage?: { input: number; output: number }
            }
            if (result?.tokenUsage !== undefined) {
              const { input, output } = result.tokenUsage
              const costUsd = (input * 3 + output * 15) / 1_000_000
              addTokenUsage(db, runId, {
                phase: payload.phase,
                agent: 'claude-code',
                input_tokens: input,
                output_tokens: output,
                cost_usd: costUsd,
              })
            }
          } catch (err) {
            logger.warn({ err }, 'Failed to record token usage for phase')
          }

          if (outputFormat === 'human') {
            process.stdout.write(`  [${payload.phase}] ${payload.storyKey} — phase complete\n`)
          }
        })

        if (outputFormat === 'human') {
          eventBus.on('orchestrator:story-complete', (payload) => {
            process.stdout.write(
              `  [COMPLETE] ${payload.storyKey} (${payload.reviewCycles} review cycle(s))\n`,
            )
          })
          eventBus.on('orchestrator:story-escalated', (payload) => {
            process.stdout.write(`  [ESCALATED] ${payload.storyKey}: ${payload.lastVerdict}\n`)
          })
        }

        // Discover story keys from DB
        const storyDecisions = db
          .prepare(
            `SELECT description FROM requirements WHERE status = 'active' AND source = 'solutioning-phase'`,
          )
          .all() as Array<{ description: string }>

        const storyKeys: string[] = []
        for (const req of storyDecisions) {
          // Keys embedded in solutioning decisions
          const keyMatch = /^(\d+-\d+):/.exec(req.description)
          if (keyMatch) {
            storyKeys.push(keyMatch[1])
          }
        }

        if (outputFormat === 'human') {
          process.stdout.write(
            `[IMPLEMENTATION] Starting ${storyKeys.length} stories with concurrency=${concurrency}\n`,
          )
        }

        await orchestrator.run(storyKeys)

        if (outputFormat === 'human') {
          process.stdout.write('[IMPLEMENTATION] Complete\n')
        }
      }

      // Evaluate stop-after gate after each phase completes (AC8: between phases, not mid-phase)
      if (stopAfter !== undefined && currentPhase === stopAfter) {
        const gate = createStopAfterGate(stopAfter)
        if (gate.shouldHalt()) {
          // Count decisions for summary
          const decisionsCount =
            (db
              .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`)
              .get(runId) as { cnt: number } | undefined)?.cnt ?? 0

          // Update run status to 'stopped' atomically before emitting summary (AC4)
          updatePipelineRun(db, runId, { status: 'stopped' })

          // Emit phase completion summary (AC5)
          const phaseStartedAt = new Date(startedAt).toISOString()
          const phaseCompletedAt = new Date().toISOString()
          const summary = formatPhaseCompletionSummary({
            phaseName: stopAfter,
            startedAt: phaseStartedAt,
            completedAt: phaseCompletedAt,
            decisionsCount,
            // artifact paths not available at integration level; summary uses phase metadata only
            artifactPaths: [],
            runId,
          })
          process.stdout.write(summary + '\n')
          return 0
        }
      }

      // Advance to next phase (if not the last phase)
      if (i < phaseOrder.length - 1) {
        const advanceResult = await phaseOrchestrator.advancePhase(runId)
        if (!advanceResult.advanced) {
          const gateErrors = advanceResult.gateFailures?.map((f) => f.error).join('; ') ?? 'unknown gate failure'
          const errorMsg = `Phase gate check failed after ${currentPhase}: ${gateErrors}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }
      }
    }

    // Get final token summary
    const tokenSummary = getTokenUsageSummary(db, runId)
    const durationMs = Date.now() - startedAt

    // Count decisions and stories
    const decisionsCount = (db
      .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`)
      .get(runId) as { cnt: number } | undefined)?.cnt ?? 0

    const storiesCount = (db
      .prepare(
        `SELECT COUNT(*) as cnt FROM requirements WHERE pipeline_run_id = ? AND source = 'solutioning-phase'`,
      )
      .get(runId) as { cnt: number } | undefined)?.cnt ?? 0

    // Get pipeline run for summary
    const finalRun = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(runId) as
      | PipelineRun
      | undefined

    if (outputFormat === 'json') {
      const statusOutput = buildPipelineStatusOutput(
        finalRun ?? ({ id: runId } as PipelineRun),
        tokenSummary,
        decisionsCount,
        storiesCount,
      )
      process.stdout.write(formatOutput(statusOutput, 'json', true) + '\n')
    } else {
      process.stdout.write('\n')
      process.stdout.write(
        formatPipelineSummary(
          finalRun ?? ({ id: runId } as PipelineRun),
          tokenSummary,
          decisionsCount,
          storiesCount,
          durationMs,
          'human',
        ) + '\n',
      )
      process.stdout.write('\n')
      process.stdout.write(formatTokenTelemetry(tokenSummary, BMAD_BASELINE_TOKENS_FULL) + '\n')
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'full pipeline run failed')
    return 1
  } finally {
    try {
      dbWrapper.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerRunCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('run')
    .description('Run the autonomous pipeline (use --from to start from a specific phase)')
    .option('--pack <name>', 'Methodology pack name', 'bmad')
    .option(
      '--from <phase>',
      'Start from this phase: analysis, planning, solutioning, implementation',
    )
    .option('--stop-after <phase>', 'Stop pipeline after this phase completes')
    .option('--concept <text>', 'Inline concept text (required when --from analysis)')
    .option('--concept-file <path>', 'Path to a file containing the concept text')
    .option('--stories <keys>', 'Comma-separated story keys (e.g., 10-1,10-2)')
    .option('--concurrency <n>', 'Maximum parallel conflict groups', (v) => parseInt(v, 10), 3)
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .option('--events', 'Emit structured NDJSON events on stdout for programmatic consumption')
    .option('--verbose', 'Show detailed pino log output')
    .option('--help-agent', 'Print a machine-optimized prompt fragment for AI agents and exit')
    .option('--tui', 'Show TUI dashboard')
    .option('--skip-ux', 'Skip the UX design phase even if enabled in the pack manifest')
    .option('--research', 'Enable the research phase even if not set in the pack manifest')
    .option('--skip-research', 'Skip the research phase even if enabled in the pack manifest')
    .action(
      async (opts: {
        pack: string
        from?: string
        stopAfter?: string
        concept?: string
        conceptFile?: string
        stories?: string
        concurrency: number
        projectRoot: string
        outputFormat: string
        events?: boolean
        verbose?: boolean
        helpAgent?: boolean
        tui?: boolean
        skipUx?: boolean
        research?: boolean
        skipResearch?: boolean
      }) => {
        // --help-agent: print agent instructions and exit without running the pipeline
        if (opts.helpAgent) {
          process.exitCode = await runHelpAgent()
          return
        }

        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'

        // Validate --from phase
        let fromPhase: PhaseName | undefined
        if (opts.from !== undefined) {
          if (!VALID_PHASES.includes(opts.from as PhaseName)) {
            const errorMsg = `Invalid phase '${opts.from}'. Valid phases: ${VALID_PHASES.join(', ')}`
            if (outputFormat === 'json') {
              process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
            } else {
              process.stderr.write(`Error: ${errorMsg}\n`)
            }
            process.exitCode = 1
            return
          }
          fromPhase = opts.from as PhaseName
        }

        const exitCode = await runRunAction({
          pack: opts.pack,
          from: fromPhase,
          stopAfter: opts.stopAfter as PhaseName | undefined,
          concept: opts.concept,
          conceptFile: opts.conceptFile,
          stories: opts.stories,
          concurrency: opts.concurrency,
          outputFormat,
          projectRoot: opts.projectRoot,
          events: opts.events,
          verbose: opts.verbose,
          tui: opts.tui,
          skipUx: opts.skipUx,
          research: opts.research,
          skipResearch: opts.skipResearch,
        })
        process.exitCode = exitCode
      },
    )
}
