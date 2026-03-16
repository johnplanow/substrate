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
 *   Uses DatabaseAdapter from src/persistence/adapter.ts for all DB access.
 */

import type { Command } from 'commander'
import { join } from 'path'
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'fs'
import { readFile } from 'fs/promises'
import { createEventEmitter } from '../../modules/implementation-orchestrator/event-emitter.js'
import { createProgressRenderer } from '../../modules/implementation-orchestrator/progress-renderer.js'
import type { PipelinePhase } from '../../modules/implementation-orchestrator/event-types.js'
import { runHelpAgent } from './help-agent.js'
import { createTuiApp, isTuiCapable, printNonTtyWarning } from '../../tui/index.js'

import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createEventBus } from '../../core/event-bus.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { createContextCompiler, RepoMapInjector } from '../../modules/context-compiler/index.js'
import { createDispatcher } from '../../modules/agent-dispatch/index.js'
import { RoutingResolver, RoutingTokenAccumulator, RoutingTelemetry, RoutingTuner, RoutingRecommender, loadModelRoutingConfig } from '../../modules/routing/index.js'
import type { ModelRoutingConfig } from '../../modules/routing/index.js'
import {
  DoltSymbolRepository,
  DoltRepoMapMetaRepository,
  RepoMapQueryEngine,
  RepoMapModule,
  RepoMapTelemetry,
} from '../../modules/repo-map/index.js'
import { DoltClient, FileStateStore } from '../../modules/state/index.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { createImplementationOrchestrator, discoverPendingStoryKeys, resolveStoryKeys } from '../../modules/implementation-orchestrator/index.js'
import { detectStartPhase } from '../../modules/phase-orchestrator/phase-detection.js'
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
import { createConfigSystem } from '../../modules/config/config-system-impl.js'
import type { TokenCeilings } from '../../modules/config/config-schema.js'
import { IngestionServer } from '../../modules/telemetry/ingestion-server.js'
import { AdapterTelemetryPersistence } from '../../modules/telemetry/adapter-persistence.js'
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
  /** When true, skip the pre-flight build check (Story 25-2) */
  skipPreflight?: boolean
  /** Scope story discovery to a single epic number (e.g., 27) */
  epic?: number
  /** When true, preview routing and repo-map injection without dispatching (Story 28-9) */
  dryRun?: boolean
  /** Maximum number of review cycles per story (default: 2) */
  maxReviewCycles?: number
  /** Optional pre-initialized registry; if omitted, a new registry is created and discovered */
  registry?: AdapterRegistry
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
    skipPreflight,
    epic: epicNumber,
    dryRun,
    maxReviewCycles = 2,
    registry: injectedRegistry,
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

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const packPath = join(dbRoot, 'packs', packName)
  const dbDir = join(dbRoot, '.substrate')
  const dbPath = join(dbDir, 'substrate.db')

  // Write orchestrator PID file for cross-project process detection (Story 23-6).
  // `substrate health` reads this file to locate the orchestrator process even when
  // `--project-root` is not in the process command line (i.e. when substrate is
  // invoked from the target project's CWD). The file is removed on process exit.
  mkdirSync(dbDir, { recursive: true })
  const pidFilePath = join(dbDir, 'orchestrator.pid')
  try {
    writeFileSync(pidFilePath, String(process.pid), 'utf-8')
    const cleanupPidFile = () => {
      try { unlinkSync(pidFilePath) } catch { /* ignore */ }
    }
    // Clean up on normal exit (covers most graceful shutdowns).
    process.on('exit', cleanupPidFile)
    // Also clean up on SIGTERM and SIGINT so stale PID files don't persist
    // after signal-based termination. SIGKILL cannot be caught — the alive-check
    // in inspectProcessTree handles that residual case by verifying the PID is
    // still present in ps output before treating it as a live orchestrator.
    process.once('SIGTERM', () => { cleanupPidFile(); process.exit(0) })
    process.once('SIGINT', () => { cleanupPidFile(); process.exit(130) })
  } catch {
    // Non-fatal: process detection falls back to command-line matching
  }

  // Load token_ceilings and telemetry config from project config.
  // Non-fatal: if config loading fails, orchestrator uses hardcoded defaults.
  let tokenCeilings: TokenCeilings | undefined
  let telemetryEnabled = false
  let telemetryPort = 4318
  try {
    const configSystem = createConfigSystem({ projectConfigDir: dbDir })
    await configSystem.load()
    const cfg = configSystem.getConfig()
    tokenCeilings = cfg.token_ceilings
    if (cfg.telemetry?.enabled === true) {
      telemetryEnabled = true
      telemetryPort = cfg.telemetry.port ?? 4318
    }
  } catch {
    logger.debug('Config loading skipped — using default token ceilings and telemetry settings')
  }

  // Parse --stories early so both --from and legacy paths can use them
  let parsedStoryKeys: string[] = []
  if (storiesArg !== undefined && storiesArg !== '') {
    parsedStoryKeys = storiesArg
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0)

    for (const key of parsedStoryKeys) {
      if (!validateStoryKey(key)) {
        const errorMsg = `Story key '${key}' is not a valid format. Expected: <epic>-<story> (e.g., 10-1, 1-1a, NEW-26)`
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
        } else {
          process.stderr.write(`Error: ${errorMsg}\n`)
        }
        return 1
      }
    }
  }

  // Determine which phase to start from.
  // If --from is explicit, use it. Otherwise, auto-detect from DB state.
  let effectiveStartPhase: PhaseName | undefined = startPhase

  if (effectiveStartPhase === undefined) {
    // Auto-detect: open DB temporarily to inspect pipeline state
    mkdirSync(dbDir, { recursive: true })
    try {
      const detectAdapter = createDatabaseAdapter({ backend: 'auto', basePath: projectRoot })
      try {
        await initSchema(detectAdapter)
        const detection = await detectStartPhase(detectAdapter, projectRoot, epicNumber)

        if (detection.phase !== 'implementation') {
          // Pipeline needs earlier phases — route through full pipeline
          effectiveStartPhase = detection.phase as PhaseName

          if (outputFormat === 'human') {
            process.stdout.write(`[AUTO-DETECT] ${detection.reason}\n`)
          }

          // If concept is needed and not provided, give an actionable error
          if (detection.needsConcept && concept === undefined) {
            const errorMsg = `Pipeline needs to start from ${detection.phase} phase, which requires a concept.\nProvide --concept "your idea" or --concept-file path/to/brief.md`
            if (outputFormat === 'json') {
              process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
            } else {
              process.stderr.write(`Error: ${errorMsg}\n`)
            }
            await detectAdapter.close()
            return 1
          }
        } else if (outputFormat === 'human') {
          process.stdout.write(`[AUTO-DETECT] ${detection.reason}\n`)
        }
      } finally {
        await detectAdapter.close()
      }
    } catch {
      // DB not initialized — fall through to legacy path
      // (which will also fail with "run substrate init" message)
    }
  }

  // Route through full pipeline if an earlier phase is needed
  if (effectiveStartPhase !== undefined) {
    return runFullPipeline({
      packName,
      packPath,
      dbDir,
      dbPath,
      startPhase: effectiveStartPhase,
      stopAfter,
      concept,
      concurrency,
      outputFormat,
      projectRoot,
      tokenCeilings,
      ...(parsedStoryKeys.length > 0 ? { stories: parsedStoryKeys } : {}),
      ...(eventsFlag === true ? { events: true } : {}),
      ...(skipUx === true ? { skipUx: true } : {}),
      ...(researchFlag === true ? { research: true } : {}),
      ...(skipResearchFlag === true ? { skipResearch: true } : {}),
      ...(skipPreflight === true ? { skipPreflight: true } : {}),
      ...(epicNumber !== undefined ? { epic: epicNumber } : {}),
      ...(injectedRegistry !== undefined ? { registry: injectedRegistry } : {}),
      ...(telemetryEnabled ? { telemetryEnabled: true, telemetryPort } : {}),
      maxReviewCycles,
    })
  }

  // Implementation path: stories exist, run them directly
  let storyKeys: string[] = [...parsedStoryKeys]

  // Ensure database directory
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  // Open database
  const adapter = createDatabaseAdapter({ backend: 'auto', basePath: projectRoot })

  try {
    try {
      await initSchema(adapter)
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

    // Story 28-6: Create TelemetryPersistence early so it's available for routing and
    // repo-map telemetry injection. The IngestionServer stays near the orchestrator.
    const telemetryPersistence = telemetryEnabled
      ? new AdapterTelemetryPersistence(adapter)
      : undefined

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
      const activeReqs = await adapter.query<{ description: string }>(
        `SELECT description FROM requirements WHERE status = 'active' AND type = 'story'`,
      )

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
          const completedRuns = await adapter.query<{ token_usage_json: string }>(
            `SELECT token_usage_json FROM pipeline_runs WHERE status = 'completed' AND token_usage_json IS NOT NULL`,
          )

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
        storyKeys = discoverPendingStoryKeys(projectRoot, epicNumber)
        if (storyKeys.length > 0) {
          const scopeLabel = epicNumber !== undefined ? `epic ${epicNumber}` : 'epics.md'
          process.stdout.write(
            `Discovered ${storyKeys.length} pending stories from ${scopeLabel}: ${storyKeys.join(', ')}\n`,
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
    const staleRuns = (await getRunningPipelineRuns(adapter)) ?? []
    if (staleRuns.length > 0) {
      const processInfo = inspectProcessTree({ projectRoot })
      let swept = 0
      for (const stale of staleRuns) {
        // If no orchestrator is running, all "running" rows are stale.
        // If an orchestrator IS running, it belongs to someone else's active run —
        // we still mark all existing rows as failed since we're about to start a new one.
        // (The new run gets its own fresh row below.)
        if (processInfo.orchestrator_pid === null) {
          await updatePipelineRun(adapter, stale.id, { status: 'failed' })
          swept++
        }
      }
      if (swept > 0) {
        process.stderr.write(`Swept ${swept} stale pipeline run(s) (dead orchestrator)\n`)
      }
    }

    // Create pipeline run record
    const pipelineRun = await createPipelineRun(adapter, {
      methodology: pack.manifest.name,
      start_phase: 'implementation',
      config_json: JSON.stringify({ storyKeys, concurrency, ...(parsedStoryKeys.length > 0 ? { explicitStories: parsedStoryKeys } : {}) }),
    })

    // Create dependencies
    const eventBus = createEventBus()
    const contextCompiler = createContextCompiler({ db: adapter })
    if (!injectedRegistry) {
      throw new Error('AdapterRegistry is required — must be initialized at CLI startup')
    }

    const routingConfigPath = join(projectRoot, 'substrate.routing.yml')
    const routingResolver = RoutingResolver.createWithFallback(routingConfigPath, logger)

    // --- Story 28-6: Routing telemetry wiring ---
    // Load routing config to construct RoutingTokenAccumulator (needs baseline_model).
    // If the config file is absent, the accumulator is skipped — no phase breakdown data.
    let routingTokenAccumulator: RoutingTokenAccumulator | undefined
    let routingConfig: ModelRoutingConfig | undefined
    try {
      routingConfig = loadModelRoutingConfig(routingConfigPath)
    } catch {
      // Config not found or invalid — accumulator not constructed (graceful degradation)
      logger.debug('Routing config not loadable — RoutingTokenAccumulator skipped')
    }
    let routingTuner: RoutingTuner | undefined
    if (routingConfig !== undefined) {
      const kvStateStore = new FileStateStore({ basePath: join(dbRoot, '.substrate') })
      routingTokenAccumulator = new RoutingTokenAccumulator(routingConfig, kvStateStore, logger)

      // AC1: Subscribe to routing:model-selected events
      eventBus.on('routing:model-selected', (payload) => {
        routingTokenAccumulator!.onRoutingSelected({
          dispatchId: payload.dispatchId,
          phase: payload.phase,
          model: payload.model,
        })
      })

      // AC2: Subscribe to agent:completed events for token attribution
      eventBus.on('agent:completed', (payload) => {
        routingTokenAccumulator!.onAgentCompleted({
          dispatchId: payload.dispatchId,
          inputTokens: payload.inputTokens ?? 0,
          outputTokens: payload.outputTokens ?? 0,
        })
      })

      // Story 28-8: Construct RoutingTuner only when auto_tune is enabled
      if (routingConfig.auto_tune === true) {
        routingTuner = new RoutingTuner(
          kvStateStore,
          new RoutingRecommender(logger),
          eventBus,
          routingConfigPath,
          logger,
        )
      }
    }

    // --- Story 28-9: Dolt detection + repo-map wiring ---
    // Detect Dolt by checking whether the canonical state path has a .dolt subdirectory.
    // When Dolt is available, construct the repo-map chain for structural context injection
    // and staleness detection. When Dolt is not available, incur zero performance cost.
    const statePath = join(dbRoot, '.substrate', 'state')
    const isDoltAvailable = existsSync(join(statePath, '.dolt'))
    let repoMapInjector: RepoMapInjector | undefined
    let repoMapModule: RepoMapModule | undefined
    const MAX_REPO_MAP_TOKENS = 2000
    if (isDoltAvailable) {
      try {
        const doltClient = new DoltClient({ repoPath: statePath })
        const symbolRepo = new DoltSymbolRepository(doltClient, logger)
        const metaRepo = new DoltRepoMapMetaRepository(doltClient)
        // AC6: Inject RepoMapTelemetry when telemetry is enabled
        const repoMapTelemetry = telemetryPersistence !== undefined
          ? new RepoMapTelemetry(telemetryPersistence, logger)
          : undefined
        const queryEngine = new RepoMapQueryEngine(symbolRepo, logger, repoMapTelemetry)
        repoMapInjector = new RepoMapInjector(queryEngine, logger)
        repoMapModule = new RepoMapModule(metaRepo, logger)
        logger.debug('repo-map injector constructed (Dolt backend detected)')
      } catch (err) {
        logger.warn({ err }, 'Failed to construct repo-map injector — continuing without it')
      }
    }

    // --- Story 28-9: --dry-run preview ---
    // When --dry-run is active, resolve routing decisions and estimated symbol counts
    // for each story × phase combination, then exit without spawning any sub-agents.
    if (dryRun === true) {
      const phases = ['explore', 'generate', 'review']
      const storiesPreview: Array<{ storyKey: string; phases: Array<{ phase: string; model: string; estimatedSymbolCount: number }> }> = []
      const artifactsDir = join(projectRoot, '_bmad-output', 'implementation-artifacts')
      for (const storyKey of storyKeys) {
        let storyContent = ''
        if (existsSync(artifactsDir)) {
          try {
            const { readdir } = await import('fs/promises')
            const allFiles = await readdir(artifactsDir)
            const match = allFiles.find((f) => f.startsWith(`${storyKey}-`) && f.endsWith('.md'))
            if (match !== undefined) {
              storyContent = await readFile(join(artifactsDir, match), 'utf-8')
            }
          } catch {
            // story file not found — use empty content
          }
        }
        const phasesResult = []
        for (const phase of phases) {
          const model = routingResolver.resolveModel(phase)?.model ?? 'default'
          let estimatedSymbolCount = 0
          if (repoMapInjector !== undefined) {
            try {
              const injection = await repoMapInjector.buildContext(storyContent, MAX_REPO_MAP_TOKENS)
              estimatedSymbolCount = injection.symbolCount
            } catch {
              // ignore injection errors
            }
          }
          phasesResult.push({ phase, model, estimatedSymbolCount })
        }
        storiesPreview.push({ storyKey, phases: phasesResult })
      }
      if (outputFormat === 'json') {
        process.stdout.write(JSON.stringify({ stories: storiesPreview }) + '\n')
      } else {
        const COL = { story: 8, phase: 10, model: 30, symbols: 12 }
        const header =
          'Story'.padEnd(COL.story) +
          'Phase'.padEnd(COL.phase) +
          'Model'.padEnd(COL.model) +
          'Est. Symbols'
        const sep = '─'.repeat(COL.story + COL.phase + COL.model + COL.symbols)
        process.stdout.write(header + '\n')
        process.stdout.write(sep + '\n')
        for (const s of storiesPreview) {
          for (const p of s.phases) {
            process.stdout.write(
              s.storyKey.padEnd(COL.story) +
                p.phase.padEnd(COL.phase) +
                p.model.padEnd(COL.model) +
                String(p.estimatedSymbolCount) +
                '\n',
            )
          }
        }
      }
      return 0
    }

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: injectedRegistry,
      config: {
        routingResolver,
      },
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
          addTokenUsage(adapter, pipelineRun.id, {
            phase: payload.phase,
            agent: 'claude-code',
            input_tokens: input,
            output_tokens: output,
            cost_usd: costUsd,
            metadata: JSON.stringify({ storyKey: payload.storyKey }),
          }).catch((err) => {
            logger.warn({ err }, 'Failed to record token usage for phase')
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

      // Emit routing:model-selected as NDJSON event for observability
      eventBus.on('routing:model-selected', (payload) => {
        ndjsonEmitter!.emit({
          type: 'routing:model-selected',
          ts: new Date().toISOString(),
          dispatch_id: payload.dispatchId,
          task_type: payload.taskType,
          phase: payload.phase,
          model: payload.model,
          source: payload.source,
        })
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

      // Stall detection events (Story 16-7 AC2, Story 23-7 AC5)
      eventBus.on('orchestrator:stall', (payload) => {
        ndjsonEmitter!.emit({
          type: 'story:stall',
          ts: new Date().toISOString(),
          run_id: payload.runId,
          story_key: payload.storyKey,
          phase: payload.phase,
          elapsed_ms: payload.elapsedMs,
          child_pids: payload.childPids,
          child_active: payload.childActive,
        })
      })

      // Zero-diff detection gate (Story 24-1)
      eventBus.on('orchestrator:zero-diff-escalation', (payload) => {
        ndjsonEmitter!.emit({
          type: 'story:zero-diff-escalation',
          ts: new Date().toISOString(),
          storyKey: payload.storyKey,
          reason: payload.reason,
        })
      })

      // Build verification gate (Story 24-2)
      // These events are emitted as 'story:*' directly by the orchestrator (no
      // 'orchestrator:' prefix), so they need explicit handlers here — there is
      // no catch-all routing.
      eventBus.on('story:build-verification-passed', (payload) => {
        ndjsonEmitter!.emit({
          type: 'story:build-verification-passed',
          ts: new Date().toISOString(),
          storyKey: payload.storyKey,
        })
      })

      eventBus.on('story:build-verification-failed', (payload) => {
        ndjsonEmitter!.emit({
          type: 'story:build-verification-failed',
          ts: new Date().toISOString(),
          storyKey: payload.storyKey,
          exitCode: payload.exitCode,
          output: payload.output,
        })
      })

      // Interface change detection warning (Story 24-3)
      // Non-blocking: emitted after build verification, before code-review.
      eventBus.on('story:interface-change-warning', (payload) => {
        ndjsonEmitter!.emit({
          type: 'story:interface-change-warning',
          ts: new Date().toISOString(),
          storyKey: payload.storyKey,
          modifiedInterfaces: payload.modifiedInterfaces,
          potentiallyAffectedTests: payload.potentiallyAffectedTests,
        })
      })

      // Story metrics snapshot on terminal state (Story 24-4)
      eventBus.on('story:metrics', (payload) => {
        ndjsonEmitter!.emit({
          type: 'story:metrics',
          ts: new Date().toISOString(),
          storyKey: payload.storyKey,
          wallClockMs: payload.wallClockMs,
          phaseBreakdown: payload.phaseBreakdown,
          tokens: payload.tokens,
          reviewCycles: payload.reviewCycles,
          dispatches: payload.dispatches,
        })
      })

      // Pre-flight build failure (Story 25-2): pipeline-level abort before any story dispatch
      eventBus.on('pipeline:pre-flight-failure', (payload) => {
        ndjsonEmitter!.emit({
          type: 'pipeline:pre-flight-failure',
          ts: new Date().toISOString(),
          exitCode: payload.exitCode,
          output: payload.output + '\nTip: Use --skip-preflight to bypass, or check your build command in .substrate/project-profile.yaml',
        })
      })

      // Post-sprint contract verification mismatch (Story 25-6): non-blocking warning
      eventBus.on('pipeline:contract-mismatch', (payload) => {
        ndjsonEmitter!.emit({
          type: 'pipeline:contract-mismatch',
          ts: new Date().toISOString(),
          exporter: payload.exporter,
          importer: payload.importer,
          contractName: payload.contractName,
          mismatchDescription: payload.mismatchDescription,
        })
      })

      // Contract verification summary: consolidated pass/fail result
      eventBus.on('pipeline:contract-verification-summary', (payload) => {
        ndjsonEmitter!.emit({
          type: 'pipeline:contract-verification-summary',
          ts: new Date().toISOString(),
          verified: payload.verified,
          stalePruned: payload.stalePruned,
          mismatches: payload.mismatches,
          verdict: payload.verdict,
        })
      })

      // Project profile staleness warning: non-blocking post-run check
      eventBus.on('pipeline:profile-stale', (payload) => {
        ndjsonEmitter!.emit({
          type: 'pipeline:profile-stale',
          ts: new Date().toISOString(),
          message: payload.message,
          indicators: payload.indicators,
        })
      })
    }

    // Create OTLP ingestion server if telemetry is enabled (Story 27-9).
    // TelemetryPersistence was created earlier (Story 28-6) for routing/repo-map telemetry.
    // The orchestrator handles start/stop lifecycle internally.
    const ingestionServer = telemetryEnabled
      ? new IngestionServer({ port: telemetryPort })
      : undefined

    // --- Story 28-6 AC5: Wire RoutingTelemetry — emit OTEL spans for each routing decision ---
    if (telemetryPersistence !== undefined) {
      const routingTelemetry = new RoutingTelemetry(telemetryPersistence, logger)
      eventBus.on('routing:model-selected', (payload) => {
        routingTelemetry.recordModelResolved({
          dispatchId: payload.dispatchId,
          taskType: payload.taskType,
          phase: payload.phase,
          model: payload.model,
          source: payload.source,
          latencyMs: 0, // Observed via event — resolve latency is sub-ms
        })
      })
    }

    // --- Story 28-9: staleness check (AC5) ---
    // Non-blocking: compare stored commit SHA against HEAD and emit event if stale.
    // Runs after story resolution, before first dispatch.
    if (repoMapModule !== undefined) {
      try {
        const stale = await repoMapModule.checkStaleness()
        if (stale !== null) {
          eventBus.emit('pipeline:repo-map-stale', stale)
          logger.warn(stale, 'Repo-map is stale — run `substrate repo-map --update` to refresh')
        }
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'Staleness check failed — skipping',
        )
      }
    }

    // Create orchestrator
    const orchestrator = createImplementationOrchestrator({
      db: adapter,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config: {
        maxConcurrency: concurrency,
        maxReviewCycles,
        pipelineRunId: pipelineRun.id,
        // Only enable heartbeat/watchdog timer when --events mode is active (AC1/Issue 5)
        enableHeartbeat: eventsFlag === true,
        // Skip pre-flight build check when --skip-preflight is set (Story 25-2)
        skipPreflight: skipPreflight === true,
      },
      projectRoot,
      tokenCeilings,
      ...(ingestionServer !== undefined ? { ingestionServer } : {}),
      ...(telemetryPersistence !== undefined ? { telemetryPersistence } : {}),
      ...(repoMapInjector !== undefined ? { repoMapInjector, maxRepoMapTokens: MAX_REPO_MAP_TOKENS } : {}),
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

    // AC3 (Story 28-6): Flush phase token breakdown to StateStore at run completion
    if (routingTokenAccumulator !== undefined) {
      try {
        await routingTokenAccumulator.flush(pipelineRun.id)
        logger.debug({ runId: pipelineRun.id }, 'Phase token breakdown flushed')
      } catch (flushErr) {
        logger.warn({ err: flushErr }, 'Failed to flush phase token breakdown (best-effort)')
      }
    }

    // Story 28-8: Auto-tune routing config after pipeline run completes (best-effort)
    if (routingTuner !== undefined && routingConfig !== undefined) {
      try {
        await routingTuner.maybeAutoTune(pipelineRun.id, routingConfig)
      } catch (tuneErr) {
        logger.warn({ err: tuneErr }, 'RoutingTuner.maybeAutoTune failed (best-effort)')
      }
    }

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
      const runStartMs = parseDbTimestampAsUtc(pipelineRun.created_at ?? '').getTime()
      const tokenAgg = await aggregateTokenUsageForRun(adapter, pipelineRun.id)
      const storyMetrics = await getStoryMetricsForRun(adapter, pipelineRun.id)
      const totalReviewCycles = storyMetrics.reduce((sum, m) => sum + (m.review_cycles ?? 0), 0)
      const totalDispatches = storyMetrics.reduce((sum, m) => sum + (m.dispatches ?? 0), 0)
      // restarts is preserved automatically by writeRunMetrics (ON CONFLICT DO UPDATE keeps
      // the DB-side value), so there is no TOCTOU race from a concurrent incrementRunRestarts().
      await writeRunMetrics(adapter, {
        run_id: pipelineRun.id,
        methodology: pack.manifest.name,
        status: failedKeys.length > 0
          ? 'failed'
          : escalatedKeys.length > 0
            ? 'completed_with_escalations'
            : 'completed',
        started_at: pipelineRun.created_at ?? '',
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
    const tokenSummary = await getTokenUsageSummary(adapter, pipelineRun.id)

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
      await adapter.close()
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
  /** Optional pre-initialized registry; if omitted, a new registry is created and discovered */
  registry?: AdapterRegistry
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
  /** When true, skip the pre-flight build check (Story 25-2) */
  skipPreflight?: boolean
  /** Maximum number of review cycles per story (default: 2) */
  maxReviewCycles?: number
  /** Optional per-workflow token ceiling overrides from config (Story 25-1) */
  tokenCeilings?: TokenCeilings
  /** Explicit story keys from --stories flag (passed through to implementation phase) */
  stories?: string[]
  /** Scope story discovery to a single epic number */
  epic?: number
  /** Whether OTLP telemetry ingestion is enabled */
  telemetryEnabled?: boolean
  /** Port for the local OTLP HTTP ingestion server */
  telemetryPort?: number
}

async function runFullPipeline(options: FullPipelineOptions): Promise<number> {
  const { packName, packPath, dbDir, dbPath, startPhase, stopAfter, concept, concurrency, outputFormat, projectRoot, events: eventsFlag, skipUx, research: researchFlag, skipResearch: skipResearchFlag, skipPreflight, maxReviewCycles = 2, registry: injectedRegistry, tokenCeilings, stories: explicitStories, telemetryEnabled: fullTelemetryEnabled, telemetryPort: fullTelemetryPort } =
    options

  // Ensure database directory
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  const adapter = createDatabaseAdapter({ backend: 'auto', basePath: projectRoot })

  try {
    try {
      await initSchema(adapter)
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
    const contextCompiler = createContextCompiler({ db: adapter })
    if (!injectedRegistry) {
      throw new Error('AdapterRegistry is required — must be initialized at CLI startup')
    }

    const routingConfigPath = join(projectRoot, 'substrate.routing.yml')
    const routingResolver = RoutingResolver.createWithFallback(routingConfigPath, logger)

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: injectedRegistry,
      config: {
        routingResolver,
      },
    })

    const phaseDeps = { db: adapter, pack, contextCompiler, dispatcher }

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
    const phaseOrchestrator = createPhaseOrchestrator({ db: adapter, pack })

    // Start the run
    const startedAt = Date.now()
    const runId = await phaseOrchestrator.startRun(concept ?? '', startPhase)

    // Persist original CLI scope flags so supervisor can replay them on restart
    if (explicitStories !== undefined && explicitStories.length > 0 || options.epic !== undefined) {
      const existingRun = (await adapter.query<{ config_json: string | null }>('SELECT config_json FROM pipeline_runs WHERE id = ?', [runId]))[0]
      const existing = JSON.parse(existingRun?.config_json ?? '{}')
      const updated = {
        ...existing,
        ...(explicitStories !== undefined && explicitStories.length > 0 ? { explicitStories } : {}),
        ...(options.epic !== undefined ? { epic: options.epic } : {}),
      }
      await adapter.query('UPDATE pipeline_runs SET config_json = ? WHERE id = ?', [JSON.stringify(updated), runId])
    }

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
          await addTokenUsage(adapter, runId, {
            phase: 'analysis',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }

        if (result.result === 'failed') {
          await updatePipelineRun(adapter, runId, { status: 'failed' })
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
          await addTokenUsage(adapter, runId, {
            phase: 'planning',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }

        if (result.result === 'failed') {
          await updatePipelineRun(adapter, runId, { status: 'failed' })
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
          await addTokenUsage(adapter, runId, {
            phase: 'research',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }

        if (result.result === 'failed') {
          await updatePipelineRun(adapter, runId, { status: 'failed' })
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
          await addTokenUsage(adapter, runId, {
            phase: 'ux-design',
            agent: 'claude-code',
            input_tokens: result.tokenUsage.input,
            output_tokens: result.tokenUsage.output,
            cost_usd: costUsd,
          })
        }

        if (result.result === 'failed') {
          await updatePipelineRun(adapter, runId, { status: 'failed' })
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
          await addTokenUsage(adapter, runId, {
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
          await phaseOrchestrator.markPhaseFailed(runId, 'solutioning', errorMsg)
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
        // Create OTLP ingestion server and telemetry persistence if enabled
        const fpIngestionServer = fullTelemetryEnabled
          ? new IngestionServer({ port: fullTelemetryPort ?? 4318 })
          : undefined
        const fpTelemetryPersistence = fullTelemetryEnabled
          ? new AdapterTelemetryPersistence(adapter)
          : undefined

        // Run implementation orchestrator
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
            // Skip pre-flight build check when --skip-preflight is set (Story 25-2)
            skipPreflight: skipPreflight === true,
          },
          projectRoot,
          tokenCeilings,
          ...(fpIngestionServer !== undefined ? { ingestionServer: fpIngestionServer } : {}),
          ...(fpTelemetryPersistence !== undefined ? { telemetryPersistence: fpTelemetryPersistence } : {}),
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
              addTokenUsage(adapter, runId, {
                phase: payload.phase,
                agent: 'claude-code',
                input_tokens: input,
                output_tokens: output,
                cost_usd: costUsd,
              }).catch((err) => {
                logger.warn({ err }, 'Failed to record token usage for phase')
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

        // Resolve story keys via unified fallback chain:
        // explicit --stories → decisions table → epic shards → epics.md
        const storyKeys = await resolveStoryKeys(adapter, projectRoot, {
          explicit: explicitStories,
          epicNumber: options.epic,
        })

        if (storyKeys.length === 0 && outputFormat === 'human') {
          process.stdout.write(
            '[IMPLEMENTATION] No stories found. Run solutioning first or pass --stories.\n',
          )
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
          const stopCountRows = await adapter.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`, [runId])
          const decisionsCount = stopCountRows[0]?.cnt ?? 0

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
    const tokenSummary = await getTokenUsageSummary(adapter, runId)
    const durationMs = Date.now() - startedAt

    // Count decisions and stories
    const decRows = await adapter.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`, [runId])
    const decisionsCount = decRows[0]?.cnt ?? 0

    const storyRows = await adapter.query<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM requirements WHERE pipeline_run_id = ? AND source = 'solutioning-phase'`,
      [runId],
    )
    const storiesCount = storyRows[0]?.cnt ?? 0

    // Get pipeline run for summary
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
      await adapter.close()
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
  registry?: AdapterRegistry,
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
    .option('--epic <n>', 'Scope story discovery to a single epic number (e.g., 27)', (v) => parseInt(v, 10))
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
    .option('--skip-preflight', 'Skip the pre-flight build check (escape hatch for known-broken projects)')
    .option('--max-review-cycles <n>', 'Maximum review cycles per story (default: 2)', (v: string) => parseInt(v, 10), 2)
    .option('--dry-run', 'Preview routing and repo-map injection without dispatching (Story 28-9)')
    .action(
      async (opts: {
        pack: string
        from?: string
        stopAfter?: string
        concept?: string
        conceptFile?: string
        stories?: string
        epic?: number
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
        skipPreflight?: boolean
        maxReviewCycles: number
        dryRun?: boolean
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
          epic: opts.epic,
          concurrency: opts.concurrency,
          outputFormat,
          projectRoot: opts.projectRoot,
          events: opts.events,
          verbose: opts.verbose,
          tui: opts.tui,
          skipUx: opts.skipUx,
          research: opts.research,
          skipResearch: opts.skipResearch,
          skipPreflight: opts.skipPreflight,
          maxReviewCycles: opts.maxReviewCycles,
          dryRun: opts.dryRun,
          registry,
        })
        process.exitCode = exitCode
      },
    )
}
