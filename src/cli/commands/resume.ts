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
 * Database (ADR-003: SQLite WAL):
 *   Uses DatabaseWrapper from src/persistence/database.ts for all DB access.
 */

import type { Command } from 'commander'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createEventBus } from '../../core/event-bus.js'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { createContextCompiler } from '../../modules/context-compiler/index.js'
import { createDispatcher } from '../../modules/agent-dispatch/index.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { createImplementationOrchestrator } from '../../modules/implementation-orchestrator/index.js'
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
  registry?: AdapterRegistry
}

export async function runResumeAction(options: ResumeOptions): Promise<number> {
  const { runId: specifiedRunId, stopAfter, outputFormat, projectRoot, concurrency, pack: packName, registry } = options

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

  const packPath = join(projectRoot, 'packs', packName)
  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbPath = join(dbRoot, '.substrate', 'substrate.db')

  if (!existsSync(dbPath)) {
    const errorMsg = `Decision store not initialized. Run 'substrate init' first.`
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
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

    // Load pipeline run
    let run: PipelineRun | undefined
    if (specifiedRunId !== undefined && specifiedRunId !== '') {
      run = db
        .prepare('SELECT * FROM pipeline_runs WHERE id = ?')
        .get(specifiedRunId) as PipelineRun | undefined
    } else {
      run = getLatestRun(db)
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
    const phaseOrchestrator = createPhaseOrchestrator({ db, pack })
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

    // Get concept from config_json
    let concept = ''
    try {
      const config = JSON.parse(run.config_json ?? '{}') as { concept?: string }
      concept = config.concept ?? ''
    } catch {
      // ignore
    }

    // Determine db directory from db path
    const dbDir = dbPath.replace('/substrate.db', '')

    // Execute remaining phases
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
      existingRunId: runId,
      projectRoot,
      registry,
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
      dbWrapper.close()
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
  existingRunId?: string
  projectRoot: string
  registry?: AdapterRegistry
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
    existingRunId,
    projectRoot,
    registry: injectedRegistry,
  } = options

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
    runMigrations(dbWrapper.db)
    const db = dbWrapper.db

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
    const contextCompiler = createContextCompiler({ db })
    if (!injectedRegistry) {
      throw new Error('AdapterRegistry is required — must be initialized at CLI startup')
    }
    const dispatcher = createDispatcher({ eventBus, adapterRegistry: injectedRegistry })
    const phaseDeps = { db, pack, contextCompiler, dispatcher }

    const phaseOrchestrator = createPhaseOrchestrator({ db, pack })

    const startedAt = Date.now()
    let runId: string

    if (existingRunId !== undefined) {
      runId = existingRunId
    } else {
      runId = await phaseOrchestrator.startRun(concept, startPhase)
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
          addTokenUsage(db, runId, {
            phase: 'solutioning',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }
        if (result.result === 'failed') {
          updatePipelineRun(db, runId, { status: 'failed' })
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

        eventBus.on('orchestrator:story-phase-complete', (payload) => {
          try {
            const result = payload.result as { tokenUsage?: { input: number; output: number } }
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
            logger.warn({ err }, 'Failed to record token usage')
          }
        })

        const storyDecisions = db
          .prepare(
            `SELECT description FROM requirements WHERE pipeline_run_id = ? AND source = 'solutioning-phase'`,
          )
          .all(runId) as Array<{ description: string }>

        const storyKeys: string[] = []
        for (const req of storyDecisions) {
          const keyMatch = /^(\d+-\d+):/.exec(req.description)
          if (keyMatch) {
            storyKeys.push(keyMatch[1])
          }
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
    const tokenSummary = getTokenUsageSummary(db, runId)
    const durationMs = Date.now() - startedAt

    const decisionsCount =
      (
        db
          .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`)
          .get(runId) as { cnt: number } | undefined
      )?.cnt ?? 0

    const storiesCount =
      (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM requirements WHERE pipeline_run_id = ? AND source = 'solutioning-phase'`,
          )
          .get(runId) as { cnt: number } | undefined
      )?.cnt ?? 0

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
      dbWrapper.close()
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
    .action(
      async (opts: {
        runId?: string
        stopAfter?: string
        pack: string
        concurrency: number
        projectRoot: string
        outputFormat: string
      }) => {
        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
        const exitCode = await runResumeAction({
          runId: opts.runId,
          stopAfter: opts.stopAfter as PhaseName | undefined,
          outputFormat,
          projectRoot: opts.projectRoot,
          concurrency: opts.concurrency,
          pack: opts.pack,
          registry,
        })
        process.exitCode = exitCode
      },
    )
}
