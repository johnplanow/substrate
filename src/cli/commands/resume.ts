/**
 * `substrate resume` command
 *
 * Resumes a previously interrupted pipeline run from its last checkpoint.
 *
 *   substrate resume [--run-id <id>] [--pack bmad] [--stop-after <phase>]
 *                    [--concurrency 3] [--project-root .] [--output-format json]
 *
 * Architecture (ADR-001: Modular Monolith):
 *   CLI is a thin wiring layer — all business logic lives in modules.
 *
 * Database:
 *   Uses createDatabaseAdapter() from src/persistence/adapter.ts for all DB access.
 */

import type { Command } from 'commander'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createEventEmitter } from '../../modules/implementation-orchestrator/event-emitter.js'
import type { PipelinePhase } from '../../modules/implementation-orchestrator/event-types.js'
import { IngestionServer } from '../../modules/telemetry/ingestion-server.js'
import { AdapterTelemetryPersistence } from '../../modules/telemetry/adapter-persistence.js'
import { createConfigSystem } from '../../modules/config/config-system-impl.js'
import { createEventBus } from '../../core/event-bus.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { createContextCompiler } from '../../modules/context-compiler/index.js'
import { createDispatcher } from '../../modules/agent-dispatch/index.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { createImplementationOrchestrator, resolveStoryKeys } from '../../modules/implementation-orchestrator/index.js'
import { createPhaseOrchestrator } from '../../modules/phase-orchestrator/index.js'
import { runAnalysisPhase } from '../../modules/phase-orchestrator/phases/analysis.js'
import { runPlanningPhase } from '../../modules/phase-orchestrator/phases/planning.js'
import { runSolutioningPhase } from '../../modules/phase-orchestrator/phases/solutioning.js'
import {
  getLatestRun,
  addTokenUsage,
  getTokenUsageSummary,
  updatePipelineRun,
} from '../../persistence/queries/decisions.js'
import type { PipelineRun } from '../../persistence/queries/decisions.js'
import { createLogger } from '../../utils/logger.js'
import {
  VALID_PHASES,
  createStopAfterGate,
  formatPhaseCompletionSummary,
} from '../../modules/stop-after/index.js'
import type { PhaseName } from '../../modules/stop-after/index.js'
import {
  type OutputFormat,
  formatOutput,
  BMAD_BASELINE_TOKENS_FULL,
  buildPipelineStatusOutput,
  formatPipelineSummary,
} from './pipeline-shared.js'

const logger = createLogger('resume-cmd')

/**
 * Map internal orchestrator phase names to pipeline event protocol phase names.
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

// ---------------------------------------------------------------------------
// resume action
// ---------------------------------------------------------------------------

export interface ResumeOptions {
  runId?: string
  stopAfter?: PhaseName
  outputFormat: OutputFormat
  projectRoot: string
  concurrency: number
  pack: string
  events?: boolean
  registry?: AdapterRegistry
  /** Explicit story keys to scope the resumed run to (prevents unscoped discovery). */
  stories?: string[]
  /** Maximum number of review cycles per story (default: 2) */
  maxReviewCycles?: number
  /** Agent backend for dispatches: 'claude-code' (default), 'codex', or 'gemini' */
  agent?: string
}

export async function runResumeAction(options: ResumeOptions): Promise<number> {
  const { runId: specifiedRunId, stopAfter, outputFormat, projectRoot, concurrency, pack: packName, events: eventsFlag, registry, maxReviewCycles = 2, agent: agentId } = options

  // Validate --stop-after phase (before any DB writes) (AC7)
  if (stopAfter !== undefined && !VALID_PHASES.includes(stopAfter)) {
    const errorMsg = `Invalid phase: "${stopAfter}". Valid phases: ${VALID_PHASES.join(', ')}`
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const packPath = join(dbRoot, 'packs', packName)
  const dbPath = join(dbRoot, '.substrate', 'substrate.db')

  const doltDir = join(dbRoot, '.substrate', 'state', '.dolt')
  if (!existsSync(dbPath) && !existsSync(doltDir)) {
    const errorMsg = `Decision store not initialized. Run 'substrate init' first.`
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  const adapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })

  try {
    await initSchema(adapter)

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

    // Load pipeline run
    let run: PipelineRun | undefined
    if (specifiedRunId !== undefined && specifiedRunId !== '') {
      const rows = await adapter.query<PipelineRun>('SELECT * FROM pipeline_runs WHERE id = ?', [specifiedRunId])
      run = rows[0]
    } else {
      run = await getLatestRun(adapter)
    }

    if (run === undefined) {
      const errorMsg =
        specifiedRunId !== undefined
          ? `Pipeline run '${specifiedRunId}' not found.`
          : 'No pipeline runs found. Run `substrate run --from analysis` first.'
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    const runId = run.id

    if (outputFormat === 'human') {
      process.stdout.write(`Resuming pipeline run: ${runId}\n`)
    }

    // Create PhaseOrchestrator and determine resume point
    const phaseOrchestrator = createPhaseOrchestrator({ db: adapter, pack })
    const runStatus = await phaseOrchestrator.resumeRun(runId)

    const resumePhase = runStatus.currentPhase as PhaseName | null

    if (resumePhase === null || runStatus.status === 'completed') {
      if (outputFormat === 'human') {
        process.stdout.write('Pipeline run is already completed.\n')
      } else {
        process.stdout.write(formatOutput({ runId, status: 'completed' }, 'json', true) + '\n')
      }
      return 0
    }

    if (outputFormat === 'human') {
      process.stdout.write(`Resuming from phase: ${resumePhase}\n`)
    }

    // Get concept and explicit story scope from config_json.
    // When `substrate run --stories X,Y` persists explicitStories in config_json,
    // resume reads them back so it doesn't re-discover all stories from epic files.
    let concept = ''
    let scopedStories: string[] | undefined
    try {
      const config = JSON.parse(run.config_json ?? '{}') as { concept?: string; explicitStories?: string[] }
      concept = config.concept ?? ''
      if (Array.isArray(config.explicitStories) && config.explicitStories.length > 0) {
        scopedStories = config.explicitStories
      }
    } catch {
      // ignore
    }

    // Determine db directory from db path
    const dbDir = dbPath.replace('/substrate.db', '')

    // Execute remaining phases — prefer CLI --stories, then persisted scope, then full discovery
    return runFullPipelineFromPhase({
      packName,
      packPath,
      dbDir,
      dbPath,
      startPhase: resumePhase,
      stopAfter,
      concept,
      concurrency,
      outputFormat,
      events: eventsFlag,
      existingRunId: runId,
      projectRoot,
      registry,
      stories: options.stories ?? scopedStories,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'auto resume failed')
    return 1
  } finally {
    try {
      await adapter.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Full pipeline execution from a specific phase with an existing run ID
// ---------------------------------------------------------------------------

export interface FullPipelineFromPhaseOptions {
  packName: string
  packPath: string
  dbDir: string
  dbPath: string
  startPhase: PhaseName
  stopAfter?: PhaseName
  concept: string
  concurrency: number
  outputFormat: OutputFormat
  events?: boolean
  existingRunId?: string
  projectRoot: string
  registry?: AdapterRegistry
  /** Explicit story keys to scope this run to (prevents unscoped ready_stories discovery). */
  stories?: string[]
  /** Maximum number of review cycles per story (default: 2) */
  maxReviewCycles?: number
}

export async function runFullPipelineFromPhase(options: FullPipelineFromPhaseOptions): Promise<number> {
  const {
    packName,
    packPath,
    dbDir,
    dbPath,
    startPhase,
    stopAfter,
    concept,
    concurrency,
    outputFormat,
    events: eventsFlag,
    existingRunId,
    projectRoot,
    registry: injectedRegistry,
    stories: explicitStories,
    maxReviewCycles = 2,
  } = options

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  const adapter = createDatabaseAdapter({ backend: 'auto', basePath: projectRoot })

  try {
    await initSchema(adapter)

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

    const eventBus = createEventBus()
    const contextCompiler = createContextCompiler({ db: adapter })
    if (!injectedRegistry) {
      throw new Error('AdapterRegistry is required — must be initialized at CLI startup')
    }
    const dispatcher = createDispatcher({ eventBus, adapterRegistry: injectedRegistry })
    const phaseDeps = { db: adapter, pack, contextCompiler, dispatcher }

    const phaseOrchestrator = createPhaseOrchestrator({ db: adapter, pack })

    const startedAt = Date.now()
    let runId: string

    if (existingRunId !== undefined) {
      runId = existingRunId
    } else {
      runId = await phaseOrchestrator.startRun(concept, startPhase)
    }

    // Wire NDJSON event emitter when --events flag is active
    let ndjsonEmitter: ReturnType<typeof createEventEmitter> | undefined
    if (eventsFlag === true) {
      ndjsonEmitter = createEventEmitter(process.stdout)
    }

    const phaseOrder: PhaseName[] = ['analysis', 'planning', 'solutioning', 'implementation']
    const startIdx = phaseOrder.indexOf(startPhase)

    for (let i = startIdx; i < phaseOrder.length; i++) {
      const currentPhase = phaseOrder[i]

      if (outputFormat === 'human') {
        process.stdout.write(`\n[${currentPhase.toUpperCase()}] Starting...\n`)
      }

      if (currentPhase === 'analysis') {
        const result = await runAnalysisPhase(phaseDeps, { runId, concept })
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd = (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          await addTokenUsage(adapter, runId, {
            phase: 'analysis',
            agent: agentId ?? 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }
        if (result.result === 'failed') {
          await updatePipelineRun(adapter, runId, { status: 'failed' })
          const errorMsg = `Analysis phase failed: ${result.error ?? 'unknown error'}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }
        if (outputFormat === 'human') {
          process.stdout.write(`[ANALYSIS] Complete\n`)
        }
      } else if (currentPhase === 'planning') {
        const result = await runPlanningPhase(phaseDeps, { runId })
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd = (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          await addTokenUsage(adapter, runId, {
            phase: 'planning',
            agent: agentId ?? 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }
        if (result.result === 'failed') {
          await updatePipelineRun(adapter, runId, { status: 'failed' })
          const errorMsg = `Planning phase failed: ${result.error ?? 'unknown error'}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }
        if (outputFormat === 'human') {
          process.stdout.write(`[PLANNING] Complete\n`)
        }
      } else if (currentPhase === 'solutioning') {
        const result = await runSolutioningPhase(phaseDeps, { runId })
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd = (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          await addTokenUsage(adapter, runId, {
            phase: 'solutioning',
            agent: agentId ?? 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }
        if (result.result === 'failed') {
          await updatePipelineRun(adapter, runId, { status: 'failed' })
          const errorMsg = `Solutioning phase failed: ${result.error ?? 'unknown error'}`
          if (outputFormat === 'human') {
            process.stderr.write(`Error: ${errorMsg}\n`)
          } else {
            process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
          }
          return 1
        }
        if (outputFormat === 'human') {
          process.stdout.write(`[SOLUTIONING] Complete\n`)
        }
      } else if (currentPhase === 'implementation') {
        // Create OTLP ingestion server and telemetry persistence if telemetry is enabled
        let telemetryEnabled = false
        let telemetryPort = 4318
        try {
          const configSystem = createConfigSystem({ projectConfigDir: dbDir })
          await configSystem.load()
          const cfg = configSystem.getConfig()
          if (cfg.telemetry?.enabled === true) {
            telemetryEnabled = true
            telemetryPort = cfg.telemetry.port ?? 4318
          }
        } catch {
          // Non-fatal: proceed without telemetry
        }

        const ingestionServer = telemetryEnabled
          ? new IngestionServer({ port: telemetryPort })
          : undefined
        const telemetryPersistence = telemetryEnabled
          ? new AdapterTelemetryPersistence(adapter)
          : undefined

        const orchestrator = createImplementationOrchestrator({
          db: adapter,
          pack,
          contextCompiler,
          dispatcher,
          eventBus,
          config: {
            maxConcurrency: concurrency,
            maxReviewCycles,
            pipelineRunId: runId,
            enableHeartbeat: eventsFlag === true,
          },
          projectRoot,
          agentId,
          ...(ingestionServer !== undefined ? { ingestionServer } : {}),
          ...(telemetryPersistence !== undefined ? { telemetryPersistence } : {}),
        })

        // Wire NDJSON event listeners for --events mode
        if (ndjsonEmitter !== undefined) {
          // Resolve story keys early so we can include them in pipeline:start
          const resolvedKeys = await resolveStoryKeys(adapter, projectRoot, {
            explicit: explicitStories,
            pipelineRunId: runId,
          })

          ndjsonEmitter.emit({
            type: 'pipeline:start',
            ts: new Date().toISOString(),
            run_id: runId,
            stories: resolvedKeys,
            concurrency,
          })

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

          eventBus.on('orchestrator:story-phase-complete', (payload) => {
            const phase = mapInternalPhaseToEventPhase(payload.phase)
            if (phase !== null) {
              const result = payload.result as { story_file?: string; verdict?: string }
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

          eventBus.on('orchestrator:story-complete', (payload) => {
            ndjsonEmitter!.emit({
              type: 'story:done',
              ts: new Date().toISOString(),
              key: payload.storyKey,
              result: 'success',
              review_cycles: payload.reviewCycles,
            })
          })

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
        }

        eventBus.on('orchestrator:story-phase-complete', (payload) => {
          try {
            const result = payload.result as { tokenUsage?: { input: number; output: number } }
            if (result?.tokenUsage !== undefined) {
              const { input, output } = result.tokenUsage
              const costUsd = (input * 3 + output * 15) / 1_000_000
              addTokenUsage(adapter, runId, {
                phase: payload.phase,
                agent: agentId ?? 'claude-code',
                input_tokens: input,
                output_tokens: output,
                cost_usd: costUsd,
              }).catch((err) => {
                logger.warn({ err }, 'Failed to record token usage')
              })
            }
          } catch (err) {
            logger.warn({ err }, 'Failed to record token usage')
          }
        })

        // Resolve story keys via unified fallback chain (scoped to this run)
        const storyKeys = await resolveStoryKeys(adapter, projectRoot, {
          explicit: explicitStories,
          pipelineRunId: runId,
        })

        if (storyKeys.length === 0 && outputFormat === 'human') {
          process.stdout.write(
            '[IMPLEMENTATION] No stories found for this run. Check solutioning phase output.\n',
          )
        }

        await orchestrator.run(storyKeys)

        // Emit pipeline:complete event
        if (ndjsonEmitter !== undefined) {
          ndjsonEmitter.emit({
            type: 'pipeline:complete',
            ts: new Date().toISOString(),
            succeeded: storyKeys, // Best-effort; full breakdown requires orchestrator result
            failed: [],
            escalated: [],
          })
        }

        if (outputFormat === 'human') {
          process.stdout.write('[IMPLEMENTATION] Complete\n')
        }
      }

      // Evaluate stop-after gate after each phase completes (AC8: between phases, not mid-phase)
      if (stopAfter !== undefined && currentPhase === stopAfter) {
        const gate = createStopAfterGate(stopAfter)
        if (gate.shouldHalt()) {
          // Count decisions for summary
          const countRows = await adapter.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`, [runId])
          const decisionsCount = countRows[0]?.cnt ?? 0

          // Update run status to 'stopped' atomically before emitting summary (AC4)
          await updatePipelineRun(adapter, runId, { status: 'stopped' })

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

      // Advance phase (except after implementation)
      if (i < phaseOrder.length - 1) {
        const advanceResult = await phaseOrchestrator.advancePhase(runId)
        if (!advanceResult.advanced) {
          const gateErrors =
            advanceResult.gateFailures?.map((f) => f.error).join('; ') ?? 'unknown gate failure'
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

    // Final summary
    const tokenSummary = await getTokenUsageSummary(adapter, runId)
    const durationMs = Date.now() - startedAt

    const decRows = await adapter.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`, [runId])
    const decisionsCount = decRows[0]?.cnt ?? 0

    const storyRows = await adapter.query<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM requirements WHERE pipeline_run_id = ? AND source = 'solutioning-phase'`,
      [runId],
    )
    const storiesCount = storyRows[0]?.cnt ?? 0

    const finalRunRows = await adapter.query<PipelineRun>('SELECT * FROM pipeline_runs WHERE id = ?', [runId])
    const finalRun = finalRunRows[0]

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
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'pipeline from phase failed')
    return 1
  } finally {
    try {
      await adapter.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerResumeCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
  registry?: AdapterRegistry,
): void {
  program
    .command('resume')
    .description('Resume a previously interrupted pipeline run')
    .option('--run-id <id>', 'Pipeline run ID to resume (defaults to latest)')
    .option('--pack <name>', 'Methodology pack name', 'bmad')
    .option('--stop-after <phase>', 'Stop pipeline after this phase completes (overrides saved state)')
    .option('--concurrency <n>', 'Maximum parallel conflict groups', (v: string) => parseInt(v, 10), 3)
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .option('--events', 'Emit structured NDJSON events on stdout for programmatic consumption')
    .option('--max-review-cycles <n>', 'Maximum review cycles per story (default: 2)', (v: string) => parseInt(v, 10), 2)
    .option('--agent <id>', 'Agent backend: claude-code (default), codex, or gemini')
    .action(
      async (opts: {
        runId?: string
        stopAfter?: string
        pack: string
        concurrency: number
        projectRoot: string
        outputFormat: string
        events?: boolean
        maxReviewCycles: number
        agent?: string
      }) => {
        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
        const exitCode = await runResumeAction({
          runId: opts.runId,
          stopAfter: opts.stopAfter as PhaseName | undefined,
          outputFormat,
          projectRoot: opts.projectRoot,
          concurrency: opts.concurrency,
          pack: opts.pack,
          events: opts.events,
          maxReviewCycles: opts.maxReviewCycles,
          agent: opts.agent,
          registry,
        })
        process.exitCode = exitCode
      },
    )
}
