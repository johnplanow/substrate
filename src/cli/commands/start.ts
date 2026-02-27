/**
 * `substrate start` command
 *
 * Starts orchestration from a pre-authored YAML/JSON task graph (FR31).
 *
 * Usage:
 *   substrate start --graph tasks.yaml                    Load and execute a task graph
 *   substrate start --graph tasks.yaml --dry-run          Validate without executing (AC4)
 *   substrate start --graph tasks.yaml --max-concurrency 2  Override concurrency (AC3)
 *   substrate start --graph tasks.yaml --output-format json  NDJSON streaming output (AC5)
 *
 * Exit codes (Architecture Section 13):
 *   0   - All tasks completed successfully
 *   1   - System error (unexpected exception)
 *   2   - Usage error (invalid args, missing file, parse/validation error)
 *   3   - Budget exceeded
 *   4   - All tasks failed
 *   130 - User interrupted (SIGINT/Ctrl+C)
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync } from 'fs'
import { mkdirSync } from 'fs'
import { createEventBus } from '../../core/event-bus.js'
import { createDatabaseService } from '../../modules/database/database-service.js'
import { createTaskGraphEngine } from '../../modules/task-graph/task-graph-engine.js'
import { createRoutingEngine } from '../../modules/routing/routing-engine.js'
import type { RoutingEngineImpl } from '../../modules/routing/routing-engine-impl.js'
import { createWorkerPoolManager } from '../../modules/worker-pool/worker-pool-manager-impl.js'
import { createGitWorktreeManager } from '../../modules/git-worktree/git-worktree-manager-impl.js'
import { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { createMonitorAgent } from '../../modules/monitor/monitor-agent-impl.js'
import { createMonitorDatabase } from '../../persistence/monitor-database.js'
import { createConfigSystem } from '../../modules/config/config-system-impl.js'
import { createConfigWatcher, computeChangedKeys } from '../../modules/config/config-watcher.js'
import { ParseError, parseGraphFile } from '../../modules/task-graph/task-parser.js'
import { ValidationError, validateGraph } from '../../modules/task-graph/task-validator.js'
import { emitEvent } from '../formatters/streaming.js'
import { createLogger } from '../../utils/logger.js'
import type { SubstrateConfig } from '../../modules/config/config-schema.js'
import { ConfigError } from '../../core/errors.js'
import { CrashRecoveryManager } from '../../recovery/crash-recovery.js'
import { setupGracefulShutdown } from '../../recovery/shutdown-handler.js'

const logger = createLogger('start-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const START_EXIT_SUCCESS = 0
export const START_EXIT_ERROR = 1
export const START_EXIT_USAGE_ERROR = 2
export const START_EXIT_BUDGET_EXCEEDED = 3
export const START_EXIT_ALL_FAILED = 4
export const START_EXIT_INTERRUPTED = 130

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the start action.
 */
export interface StartActionOptions {
  graphFile?: string
  dryRun: boolean
  maxConcurrency?: number
  outputFormat: 'human' | 'json'
  projectRoot: string
  version?: string
  /** When true, config hot-reload watcher is disabled */
  noWatchConfig?: boolean
  /**
   * When true, the command is operating in "resume" mode (i.e. called from `substrate resume`).
   * This changes the behavior when no interrupted session is found:
   *   - resume mode:  prints "No interrupted session found" to stdout and returns 0
   *   - start mode:   prints an error to stderr and returns START_EXIT_USAGE_ERROR (2)
   */
  resumeMode?: boolean
}

// ---------------------------------------------------------------------------
// runStartAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the start command.
 *
 * Returns exit code. Separated from Commander integration for testability.
 */
export async function runStartAction(options: StartActionOptions): Promise<number> {
  const {
    graphFile,
    dryRun,
    maxConcurrency: cliMaxConcurrency,
    outputFormat,
    projectRoot,
    noWatchConfig = false,
    resumeMode = false,
  } = options

  // Resolve graph file path if provided
  let resolvedGraphFile: string | null = null
  if (graphFile !== undefined && graphFile !== null && graphFile !== '') {
    resolvedGraphFile = graphFile.startsWith('/') ? graphFile : join(projectRoot, graphFile)
  }

  // AC6: Validate graph file exists (only when provided)
  if (resolvedGraphFile !== null && !existsSync(resolvedGraphFile)) {
    process.stderr.write(`Error: Graph file not found: ${resolvedGraphFile}\n`)
    return START_EXIT_USAGE_ERROR
  }

  // AC4: Dry-run mode — parse and validate without creating any DB session
  if (dryRun) {
    if (resolvedGraphFile === null) {
      process.stderr.write('Error: --graph <file> is required for dry-run mode\n')
      return START_EXIT_USAGE_ERROR
    }
    try {
      const raw = parseGraphFile(resolvedGraphFile)
      const result = validateGraph(raw)
      if (!result.valid) {
        process.stderr.write(
          `Error: Graph validation failed: ${resolvedGraphFile}\n${result.errors.join('\n')}\n`,
        )
        return START_EXIT_USAGE_ERROR
      }
      const taskEntries = Object.entries(result.graph!.tasks)
      const readyCount = taskEntries.filter(([, t]) => !t.depends_on || t.depends_on.length === 0).length
      process.stdout.write(`Dry run: ${taskEntries.length} tasks, ${readyCount} ready\n`)
      process.stdout.write(`Tasks:\n`)
      for (const [id, task] of taskEntries) {
        process.stdout.write(`  - ${id}: ${task.name}\n`)
      }
      return START_EXIT_SUCCESS
    } catch (err) {
      if (err instanceof ParseError) {
        process.stderr.write(
          `Error: Failed to parse graph file: ${resolvedGraphFile}\n${err.message}\n`,
        )
        return START_EXIT_USAGE_ERROR
      }
      if (err instanceof ValidationError) {
        process.stderr.write(
          `Error: Graph validation failed: ${resolvedGraphFile}\n${err.errors.join('\n')}\n`,
        )
        return START_EXIT_USAGE_ERROR
      }
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: ${message}\n`)
      return START_EXIT_ERROR
    }
  }

  // Determine database path
  const dbPath = join(projectRoot, '.substrate', 'state.db')

  // Ensure .substrate directory exists
  const substrateDir = join(projectRoot, '.substrate')
  if (!existsSync(substrateDir)) {
    mkdirSync(substrateDir, { recursive: true })
  }

  // Create event bus
  const eventBus = createEventBus()

  // Create and open database service
  const databaseService = createDatabaseService(dbPath)

  // Create config system to get defaults
  const configSystem = createConfigSystem({ projectRoot })
  try {
    await configSystem.load()
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Error: ${err.message}\n`)
      return START_EXIT_USAGE_ERROR
    }
    throw err
  }
  const config = configSystem.getConfig()

  // Resolve max concurrency: CLI flag > config value > default (4)
  const resolvedMaxConcurrency = cliMaxConcurrency ?? config.global?.max_concurrent_workers ?? config.global?.max_concurrent_tasks ?? 4

  // Resolve base branch from config
  const baseBranch = config.global?.base_branch ?? 'main'

  // Create modules
  const taskGraphEngine = createTaskGraphEngine({ eventBus, databaseService })
  const adapterRegistry = new AdapterRegistry()
  const gitWorktreeManager = createGitWorktreeManager({
    eventBus,
    projectRoot,
    db: databaseService,
  })
  const routingEngine = createRoutingEngine({ eventBus, adapterRegistry })

  // Create monitor agent for performance tracking and advisory recommendations
  const monitorDbPath = join(projectRoot, '.substrate', 'monitor.db')
  const monitorDatabase = createMonitorDatabase(monitorDbPath)
  const monitorAgent = createMonitorAgent({ eventBus, monitorDb: monitorDatabase })

  // Wire monitor agent into routing engine for advisory recommendations
  ;(routingEngine as RoutingEngineImpl).setMonitorAgent(monitorAgent, true)

  const workerPoolManager = createWorkerPoolManager({
    eventBus,
    adapterRegistry,
    engine: taskGraphEngine,
    db: databaseService,
    gitWorktreeManager,
  })

  try {
    // Initialize all services in order
    await databaseService.initialize()
    await taskGraphEngine.initialize()
    // AdapterRegistry uses discoverAndRegister() for health-checked adapter discovery
    await adapterRegistry.discoverAndRegister()
    await gitWorktreeManager.initialize()
    await routingEngine.initialize()
    await monitorAgent.initialize()
    await workerPoolManager.initialize()

    // AC8: No watcher in dry-run mode (already returned above)
    // AC9: --no-watch-config disables the watcher
    let configWatcher: ReturnType<typeof createConfigWatcher> | null = null
    const configFilePath = join(projectRoot, 'substrate.config.yaml')
    if (noWatchConfig) {
      logger.info('Config hot-reload disabled (--no-watch-config).')
      process.stdout.write('Config hot-reload disabled (--no-watch-config).\n')
    } else {
      let currentHotConfig: SubstrateConfig | null = config as SubstrateConfig | null
      configWatcher = createConfigWatcher({
        configPath: configFilePath,
        onReload: (newConfig: SubstrateConfig) => {
          const previousConfig = currentHotConfig
          if (previousConfig === null) {
            currentHotConfig = newConfig
            return
          }
          const changedKeys = computeChangedKeys(previousConfig, newConfig)
          currentHotConfig = newConfig
          const n = changedKeys.length
          logger.info({ changedKeys, configPath: configFilePath }, `Config reloaded: ${n} setting(s) changed`)
          eventBus.emit('config:reloaded', {
            path: configFilePath,
            previousConfig,
            newConfig,
            changedKeys,
          })
        },
        onError: (err: Error) => {
          logger.error({ err, configPath: configFilePath }, `Config reload failed: ${err.message}. Continuing with previous config.`)
        },
      })
      configWatcher.start()
    }

    // Check for interrupted session before loading graph (AC5, AC6)
    const interruptedSession = CrashRecoveryManager.findInterruptedSession(databaseService.db)

    // Load graph or resume interrupted session
    let sessionId: string
    let cleanupShutdown: (() => void) | null = null

    if (resolvedGraphFile === null) {
      // No --graph flag: resume interrupted session if one exists (AC5)
      if (interruptedSession !== undefined) {
        process.stdout.write(`Resuming interrupted session ${interruptedSession.id}\n`)
        logger.info({ sessionId: interruptedSession.id }, 'session:resumed')
        const recovery = new CrashRecoveryManager({ db: databaseService.db, gitWorktreeManager })
        recovery.recover(interruptedSession.id)
        sessionId = interruptedSession.id
      } else {
        if (resumeMode) {
          process.stdout.write('No interrupted session found\n')
          return START_EXIT_SUCCESS
        }
        process.stderr.write('Error: No graph file provided and no interrupted session found.\n')
        return START_EXIT_USAGE_ERROR
      }
    } else {
      // --graph flag provided
      if (interruptedSession !== undefined) {
        // Archive the interrupted session and start fresh (AC6)
        CrashRecoveryManager.archiveSession(databaseService.db, interruptedSession.id)
        process.stdout.write(`Prior session ${interruptedSession.id} archived (abandoned). Starting new session.\n`)
      }
      // Load graph: catches ParseError and ValidationError
      try {
        sessionId = await taskGraphEngine.loadGraph(resolvedGraphFile)
      } catch (err) {
        if (err instanceof ParseError) {
          process.stderr.write(
            `Error: Failed to parse graph file: ${resolvedGraphFile}\n${err.message}\n`,
          )
          return START_EXIT_USAGE_ERROR
        }
        if (err instanceof ValidationError) {
          process.stderr.write(
            `Error: Graph validation failed: ${resolvedGraphFile}\n${err.errors.join('\n')}\n`,
          )
          return START_EXIT_USAGE_ERROR
        }
        throw err
      }
    }

    // Set up graceful shutdown handler (AC3) — replaces inline SIGINT/SIGTERM handlers
    cleanupShutdown = setupGracefulShutdown({
      db: databaseService.db,
      workerPoolManager,
      taskGraphEngine,
      sessionId,
    })

    // Set up event listeners based on output format
    let graphLoadedPayload: { sessionId: string; taskCount: number; readyCount: number } | null =
      null

    // Capture graph:loaded payload for human output header
    eventBus.on('graph:loaded', (payload) => {
      graphLoadedPayload = payload
    })

    if (outputFormat === 'json') {
      // AC5: NDJSON streaming output
      eventBus.on('graph:loaded', (payload) => {
        emitEvent('graph:loaded', {
          sessionId: payload.sessionId,
          taskCount: payload.taskCount,
          readyCount: payload.readyCount,
        })
      })
      eventBus.on('task:started', (payload) => {
        emitEvent('task:started', {
          taskId: payload.taskId,
          workerId: payload.workerId,
          agent: payload.agent,
        })
      })
      eventBus.on('task:complete', (payload) => {
        emitEvent('task:complete', {
          taskId: payload.taskId,
          costUsd: payload.result.costUsd,
        })
      })
      eventBus.on('task:failed', (payload) => {
        emitEvent('task:failed', {
          taskId: payload.taskId,
          error: payload.error.message,
        })
      })
      eventBus.on('task:cancelled', (payload) => {
        emitEvent('task:cancelled', {
          taskId: payload.taskId,
          reason: payload.reason,
        })
      })
      eventBus.on('graph:complete', (payload) => {
        emitEvent('graph:complete', {
          totalTasks: payload.totalTasks,
          completedTasks: payload.completedTasks,
          failedTasks: payload.failedTasks,
          totalCostUsd: payload.totalCostUsd,
        })
      })
      eventBus.on('config:reloaded', (payload) => {
        emitEvent('config:reloaded', payload)
      })
    } else {
      // AC7: Human-readable output
      eventBus.on('task:started', (payload) => {
        process.stdout.write(`→ [running] ${payload.taskId} (agent: ${payload.agent})\n`)
      })
      eventBus.on('task:complete', (payload) => {
        const cost = payload.result.costUsd !== undefined ? `$${payload.result.costUsd.toFixed(2)}` : 'N/A'
        process.stdout.write(`✓ [complete] ${payload.taskId} (cost: ${cost})\n`)
      })
      eventBus.on('task:failed', (payload) => {
        process.stdout.write(`✗ [failed] ${payload.taskId}: ${payload.error.message}\n`)
      })
    }

    // Set up done promise: resolves when graph:complete, graph:cancelled, or budget exceeded
    const done = new Promise<{ exitCode: number }>((resolve) => {
      eventBus.on('graph:complete', ({ totalTasks, completedTasks, failedTasks, totalCostUsd }) => {
        if (outputFormat === 'human') {
          // Print final summary
          process.stdout.write(
            `\nGraph complete: ${completedTasks}/${totalTasks} completed, ${failedTasks} failed, cost: $${totalCostUsd.toFixed(4)}\n`,
          )
        }
        // AC7: exit 0 if all completed, exit 4 if all failed
        if (failedTasks === totalTasks && totalTasks > 0) {
          resolve({ exitCode: START_EXIT_ALL_FAILED })
        } else {
          resolve({ exitCode: START_EXIT_SUCCESS })
        }
      })

      eventBus.on('graph:cancelled', () => {
        resolve({ exitCode: START_EXIT_INTERRUPTED })
      })

      // AC7: budget:exceeded → exit 3
      eventBus.on('session:budget:exceeded', () => {
        resolve({ exitCode: START_EXIT_BUDGET_EXCEEDED })
      })
    })

    // Print session start header for human output (AC7)
    if (outputFormat === 'human') {
      if (graphLoadedPayload !== null) {
        const loaded = graphLoadedPayload as { sessionId: string; taskCount: number; readyCount: number }
        process.stdout.write(
          `Starting orchestration session ${loaded.sessionId}: ${loaded.taskCount} tasks, ${loaded.readyCount} ready\n`,
        )
      } else {
        process.stdout.write(`Starting orchestration session ${sessionId}\n`)
      }
    }

    // AC1, AC2: Start execution
    taskGraphEngine.startExecution(sessionId, resolvedMaxConcurrency)

    // Wait for completion
    const result = await done

    // Clean up graceful shutdown handler
    if (cleanupShutdown !== null) {
      cleanupShutdown()
    }

    return result.exitCode
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runStartAction failed')
    return START_EXIT_ERROR
  } finally {
    try {
      configWatcher?.stop()
    } catch { /* ignore */ }
    try {
      await workerPoolManager.shutdown()
    } catch { /* ignore */ }
    try {
      await routingEngine.shutdown()
    } catch { /* ignore */ }
    try {
      await gitWorktreeManager.shutdown()
    } catch { /* ignore */ }
    try {
      await taskGraphEngine.shutdown()
    } catch { /* ignore */ }
    try {
      await databaseService.shutdown()
    } catch { /* ignore */ }
    try {
      await monitorAgent.shutdown()
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// registerStartCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate start` command with the CLI program.
 *
 * @param program     - Commander program instance
 * @param version     - Current Substrate package version
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerStartCommand(
  program: Command,
  version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('start')
    .description('Start orchestration from a task graph file')
    .option('--graph <file>', 'Path to YAML/JSON task graph file (optional if resuming an interrupted session)')
    .option('--dry-run', 'Validate and display graph without executing', false)
    .option('--max-concurrency <n>', 'Maximum number of concurrent tasks', parseInt)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json (NDJSON streaming)',
      'human',
    )
    .option('--no-watch-config', 'Disable config file watching during orchestration')
    .action(async (opts: {
      graph?: string
      dryRun: boolean
      maxConcurrency?: number
      outputFormat: string
      watchConfig: boolean
    }) => {
      const outputFormat = opts.outputFormat === 'json' ? 'json' : 'human'

      const exitCode = await runStartAction({
        graphFile: opts.graph,
        dryRun: opts.dryRun,
        maxConcurrency: opts.maxConcurrency,
        outputFormat,
        projectRoot,
        version,
        noWatchConfig: !opts.watchConfig,
      })

      process.exitCode = exitCode
    })
}
