/**
 * `substrate amend` command
 *
 * Runs an amendment pipeline against a completed run, re-running phases
 * with a new concept and detecting decision supersessions.
 *
 *   substrate amend --concept <text> [--concept-file <path>] [--run-id <id>]
 *                   [--stop-after <phase>] [--from <phase>] [--pack <name>]
 *
 * Architecture (ADR-001: Modular Monolith):
 *   CLI is a thin wiring layer — all business logic lives in modules.
 *
 * Database (ADR-003: SQLite WAL):
 *   Uses DatabaseWrapper from src/persistence/database.ts for all DB access.
 */

import type { Command } from 'commander'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { join } from 'path'
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createEventBus } from '../../core/event-bus.js'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { createContextCompiler } from '../../modules/context-compiler/index.js'
import { createDispatcher } from '../../modules/agent-dispatch/index.js'
import { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { runAnalysisPhase } from '../../modules/phase-orchestrator/phases/analysis.js'
import { runPlanningPhase } from '../../modules/phase-orchestrator/phases/planning.js'
import { runSolutioningPhase } from '../../modules/phase-orchestrator/phases/solutioning.js'
import {
  createDecision,
  getDecisionsByPhaseForRun,
  addTokenUsage,
  updatePipelineRun,
} from '../../persistence/queries/decisions.js'
import {
  createAmendmentRun,
  getLatestCompletedRun,
  getActiveDecisions,
  supersedeDecision,
} from '../../persistence/queries/amendments.js'
import { createAmendmentContextHandler } from '../../modules/amendment-handlers/index.js'
import type { AmendmentContextHandler } from '../../modules/amendment-handlers/index.js'
import {
  generateDeltaDocument,
  formatDeltaDocument,
} from '../../modules/delta-document/index.js'
import { createLogger } from '../../utils/logger.js'
import {
  VALID_PHASES,
  createStopAfterGate,
  validateStopAfterFromConflict,
  formatPhaseCompletionSummary,
} from '../../modules/stop-after/index.js'
import type { PhaseName } from '../../modules/stop-after/index.js'
import type { OutputFormat } from './pipeline-shared.js'

const logger = createLogger('amend-cmd')

// ---------------------------------------------------------------------------
// Amendment supersession detection
// ---------------------------------------------------------------------------

/**
 * Detect and apply supersessions after a phase completes in an amendment run.
 *
 * Compares new decisions from the amendment run for the given phase against
 * parent run decisions by (phase, category, key) tuple. For each match,
 * calls supersedeDecision() and handler.logSupersession().
 *
 * Errors in individual supersession calls are logged as warnings but do not
 * fail the phase (AC7: atomic with phase completion, non-blocking on error).
 */
export function runPostPhaseSupersessionDetection(
  db: BetterSqlite3Database,
  amendmentRunId: string,
  currentPhase: string,
  handler: AmendmentContextHandler,
): void {
  const newDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId, phase: currentPhase })
  const parentDecisions = handler.getParentDecisions()

  for (const newDec of newDecisions) {
    const parentMatch = parentDecisions.find(
      (p) => p.phase === newDec.phase && p.category === newDec.category && p.key === newDec.key
    )
    if (parentMatch) {
      try {
        supersedeDecision(db, parentMatch.id, newDec.id)
        handler.logSupersession({
          originalDecisionId: parentMatch.id,
          supersedingDecisionId: newDec.id,
          phase: currentPhase,
          key: newDec.key,
          reason: `Amendment replaced ${parentMatch.category}/${parentMatch.key}`,
          loggedAt: new Date().toISOString(),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn({ err, originalId: parentMatch.id, supersedingId: newDec.id }, `Supersession failed: ${msg}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// amend action
// ---------------------------------------------------------------------------

export interface AmendOptions {
  concept?: string
  conceptFile?: string
  runId?: string
  stopAfter?: PhaseName
  from?: PhaseName
  projectRoot: string
  pack: string
  registry?: AdapterRegistry
}

export async function runAmendAction(options: AmendOptions): Promise<number> {
  const { concept: conceptArg, conceptFile, runId: specifiedRunId, stopAfter, from: startPhase, projectRoot, pack: packName, registry: injectedRegistry } = options

  // AC2: --concept or --concept-file is required (before any DB reads/writes)
  let concept: string
  if (conceptFile !== undefined && conceptFile !== '') {
    try {
      concept = await readFile(conceptFile, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: Failed to read concept file '${conceptFile}': ${msg}\n`)
      return 1
    }
  } else if (conceptArg !== undefined && conceptArg !== '') {
    concept = conceptArg
  } else {
    process.stderr.write('Either --concept or --concept-file is required for amendment runs\n')
    return 1
  }

  // AC3: Validate --stop-after / --from conflict (before any DB writes)
  if (stopAfter !== undefined && startPhase !== undefined) {
    const conflictResult = validateStopAfterFromConflict(stopAfter, startPhase)
    if (!conflictResult.valid) {
      process.stderr.write(`Error: ${conflictResult.error ?? 'Invalid --stop-after / --from combination'}\n`)
      return 1
    }
  }

  // Validate --from phase
  if (startPhase !== undefined && !VALID_PHASES.includes(startPhase)) {
    process.stderr.write(`Error: Invalid phase '${startPhase}'. Valid phases: ${VALID_PHASES.join(', ')}\n`)
    return 1
  }

  // Validate --stop-after phase
  if (stopAfter !== undefined && !VALID_PHASES.includes(stopAfter)) {
    process.stderr.write(`Error: Invalid phase: "${stopAfter}". Valid phases: ${VALID_PHASES.join(', ')}\n`)
    return 1
  }

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbDir = join(dbRoot, '.substrate')
  const dbPath = join(dbDir, 'substrate.db')
  const packPath = join(projectRoot, 'packs', packName)

  if (!existsSync(dbPath)) {
    process.stderr.write(`Error: Decision store not initialized. Run 'substrate init' first.\n`)
    return 1
  }

  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
    runMigrations(dbWrapper.db)
    const db = dbWrapper.db

    // AC4: Resolve parentRunId: use --run-id or getLatestCompletedRun()
    let parentRunId: string
    if (specifiedRunId !== undefined && specifiedRunId !== '') {
      parentRunId = specifiedRunId
    } else {
      const latestCompleted = getLatestCompletedRun(db)
      if (latestCompleted === undefined) {
        process.stderr.write("No completed pipeline run found. Run 'substrate run' first.\n")
        return 1
      }
      parentRunId = latestCompleted.id
    }

    // AC5: createAmendmentRun() creates DB record
    const amendmentRunId = randomUUID()
    let methodology = packName
    try {
      const packLoader = createPackLoader()
      const pack = await packLoader.load(packPath)
      methodology = pack.manifest.name
    } catch {
      // Use packName as fallback
    }

    try {
      createAmendmentRun(db, {
        id: amendmentRunId,
        parentRunId,
        methodology,
        configJson: JSON.stringify({ concept, startPhase, stopAfter }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: ${msg}\n`)
      return 1
    }

    // AC6: createAmendmentContextHandler() before the phase loop
    const handler = createAmendmentContextHandler(db, parentRunId, { framingConcept: concept })

    // Load methodology pack and assemble PhaseDeps (matching runFullPipeline pattern)
    const packLoader = createPackLoader()
    let pack
    try {
      pack = await packLoader.load(packPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: Methodology pack '${packName}' not found. Run 'substrate init' first.\n${msg}\n`)
      return 1
    }

    const eventBus = createEventBus()
    const contextCompiler = createContextCompiler({ db })
    const adapterRegistry = injectedRegistry ?? new AdapterRegistry()
    if (injectedRegistry === undefined) {
      await adapterRegistry.discoverAndRegister()
    }
    const dispatcher = createDispatcher({ eventBus, adapterRegistry })
    const phaseDeps = { db, pack, contextCompiler, dispatcher }

    // Determine phases to run
    const phaseOrder: PhaseName[] = ['analysis', 'planning', 'solutioning', 'implementation']
    const startIdx = startPhase !== undefined ? phaseOrder.indexOf(startPhase) : 0

    // Copy parent decisions for skipped phases so downstream phases can query them
    if (startIdx > 0) {
      const phasesToCopy = phaseOrder.slice(0, startIdx)
      for (const phase of phasesToCopy) {
        const parentDecisions = getDecisionsByPhaseForRun(db, parentRunId, phase)
        for (const d of parentDecisions) {
          createDecision(db, {
            pipeline_run_id: amendmentRunId,
            phase: d.phase,
            category: d.category,
            key: d.key,
            value: d.value,
            rationale: d.rationale ?? undefined,
          })
        }
        if (parentDecisions.length > 0) {
          process.stdout.write(`[AMENDMENT] Copied ${parentDecisions.length} ${phase} decisions from parent run\n`)
        }
      }
    }

    const startedAt = Date.now()

    // AC9: Phase loop with context injection and actual phase execution
    let stopped = false
    for (let i = startIdx; i < phaseOrder.length; i++) {
      const currentPhase = phaseOrder[i]

      // AC6 + AC9: Load context for this phase and inject it
      const amendmentContext = handler.loadContextForPhase(currentPhase)
      logger.info({ phase: currentPhase, amendmentContextLen: amendmentContext.length }, 'Amendment context loaded for phase')

      process.stdout.write(`\n[AMENDMENT:${currentPhase.toUpperCase()}] Starting (with amendment context)...\n`)

      // Execute actual phase runners with amendment context (AC4)
      if (currentPhase === 'analysis') {
        const result = await runAnalysisPhase(phaseDeps, { runId: amendmentRunId, concept, amendmentContext })
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd = (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, amendmentRunId, {
            phase: 'analysis',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }
        if (result.result === 'failed') {
          updatePipelineRun(db, amendmentRunId, { status: 'failed' })
          process.stderr.write(`Error: Analysis phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}\n`)
          return 1
        }
        // AC1 (Story 12-12): Post-phase supersession detection
        runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)
        process.stdout.write(`[AMENDMENT:ANALYSIS] Complete\n`)
      } else if (currentPhase === 'planning') {
        const result = await runPlanningPhase(phaseDeps, { runId: amendmentRunId, amendmentContext })
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd = (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, amendmentRunId, {
            phase: 'planning',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }
        if (result.result === 'failed') {
          updatePipelineRun(db, amendmentRunId, { status: 'failed' })
          process.stderr.write(`Error: Planning phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}\n`)
          return 1
        }
        // AC1 (Story 12-12): Post-phase supersession detection
        runPostPhaseSupersessionDetection(db, amendmentRunId, 'planning', handler)
        process.stdout.write(`[AMENDMENT:PLANNING] Complete\n`)
      } else if (currentPhase === 'solutioning') {
        const result = await runSolutioningPhase(phaseDeps, { runId: amendmentRunId, amendmentContext })
        if (result.tokenUsage.input > 0 || result.tokenUsage.output > 0) {
          const costUsd = (result.tokenUsage.input * 3 + result.tokenUsage.output * 15) / 1_000_000
          addTokenUsage(db, amendmentRunId, {
            phase: 'solutioning',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }
        if (result.result === 'failed') {
          updatePipelineRun(db, amendmentRunId, { status: 'failed' })
          process.stderr.write(`Error: Solutioning phase failed: ${result.error ?? 'unknown error'}${result.details ? ` — ${result.details}` : ''}\n`)
          return 1
        }
        // AC1 (Story 12-12): Post-phase supersession detection
        runPostPhaseSupersessionDetection(db, amendmentRunId, 'solutioning', handler)
        process.stdout.write(`[AMENDMENT:SOLUTIONING] Complete\n`)
      } else if (currentPhase === 'implementation') {
        // Implementation phase: context injection only (implementation is story-based, not re-run on amend)
        process.stdout.write(`[AMENDMENT:IMPLEMENTATION] Context injected (${amendmentContext.length} chars)\n`)
      }

      // AC7: Stop-after gate reused from Story 12-2
      if (stopAfter !== undefined && currentPhase === stopAfter) {
        const gate = createStopAfterGate(stopAfter)
        if (gate.shouldHalt()) {
          const decisionsCount =
            (db
              .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`)
              .get(amendmentRunId) as { cnt: number } | undefined)?.cnt ?? 0

          updatePipelineRun(db, amendmentRunId, { status: 'stopped' })

          const phaseStartedAt = new Date(startedAt).toISOString()
          const phaseCompletedAt = new Date().toISOString()
          const summary = formatPhaseCompletionSummary({
            phaseName: stopAfter,
            startedAt: phaseStartedAt,
            completedAt: phaseCompletedAt,
            decisionsCount,
            artifactPaths: [],
            runId: amendmentRunId,
          })
          process.stdout.write(summary + '\n')
          stopped = true
          break
        }
      }
    }

    // AC8: generateDeltaDocument() on completion
    if (!stopped) {
      updatePipelineRun(db, amendmentRunId, { status: 'completed' })
    }

    // Query amendment decisions and superseded decisions from DB
    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId })
    const parentDecisions = handler.getParentDecisions()
    const supersessionLog = handler.getSupersessionLog()

    // Build superseded decisions list from supersession log
    const supersededDecisionIds = new Set(supersessionLog.map((s) => s.originalDecisionId))
    const supersededDecisions = parentDecisions.filter((d) => supersededDecisionIds.has(d.id))

    try {
      const deltaDoc = await generateDeltaDocument({
        amendmentRunId,
        parentRunId,
        parentDecisions,
        amendmentDecisions,
        supersededDecisions,
        framingConcept: concept,
      })

      const deltaDocPath = join(projectRoot, `amendment-delta-${amendmentRunId}.md`)
      await writeFile(deltaDocPath, formatDeltaDocument(deltaDoc), 'utf-8')
      process.stdout.write(`Delta document written to: ${deltaDocPath}\n`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Warning: Delta document generation failed: ${msg}\n`)
      // AC8: degrade gracefully — exit 0
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${msg}\n`)
    logger.error({ err }, 'amend failed')
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

export function registerAmendCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
  registry?: AdapterRegistry,
): void {
  program
    .command('amend')
    .description('Run an amendment pipeline against a completed run and an existing run')
    .option('--concept <text>', 'Amendment concept description (inline)')
    .option('--concept-file <path>', 'Path to concept file')
    .option('--run-id <id>', 'Parent run ID (defaults to latest completed run)')
    .option('--stop-after <phase>', 'Stop pipeline after this phase completes')
    .option('--from <phase>', 'Start pipeline from this phase')
    .option('--pack <name>', 'Methodology pack name', 'bmad')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(
      async (opts: {
        concept?: string
        conceptFile?: string
        runId?: string
        stopAfter?: string
        from?: string
        pack: string
        projectRoot: string
        outputFormat: string
      }) => {
        const exitCode = await runAmendAction({
          concept: opts.concept,
          conceptFile: opts.conceptFile,
          runId: opts.runId,
          stopAfter: opts.stopAfter as PhaseName | undefined,
          from: opts.from as PhaseName | undefined,
          projectRoot: opts.projectRoot,
          pack: opts.pack,
          registry,
        })
        process.exitCode = exitCode
      },
    )
}
