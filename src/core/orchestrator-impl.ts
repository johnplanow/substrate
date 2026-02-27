/**
 * OrchestratorImpl — concrete implementation of the Orchestrator interface.
 *
 * The createOrchestrator() factory:
 *  1. Creates the database service
 *  2. Instantiates the TypedEventBus
 *  3. Creates all module instances via constructor injection
 *  4. Wires module event subscriptions via ServiceRegistry
 *  5. Sets up SIGTERM/SIGINT graceful shutdown handlers
 *  6. Emits orchestrator:ready when initialization completes
 *
 * Architecture constraints (Section 19):
 *  - No direct module-to-module imports; all wiring here
 *  - Modules communicate only via event bus or injected interfaces
 *  - Zero circular dependencies
 */

import { join } from 'node:path'
import { createLogger } from '../utils/logger.js'
import { createEventBus } from './event-bus.js'
import { ServiceRegistry } from './di.js'
import type { TypedEventBus } from './event-bus.js'
import type { Orchestrator, OrchestratorConfig } from './orchestrator.js'
import { createDatabaseService } from '../modules/database/database-service.js'
import { createTaskGraphEngine } from '../modules/task-graph/task-graph-engine.js'
import { createRoutingEngine } from '../modules/routing/routing-engine.js'
import { createWorkerPoolManager } from '../modules/worker-pool/worker-pool-manager-impl.js'
import { AdapterRegistry } from '../adapters/adapter-registry.js'
import { createBudgetTracker } from '../modules/budget/budget-tracker.js'
import { createGitManager } from '../modules/git/git-manager.js'
import { createGitWorktreeManager } from '../modules/git-worktree/git-worktree-manager-impl.js'
import { createMonitorAgent } from '../modules/monitor/monitor-agent-impl.js'
import { createMonitorDatabase } from '../persistence/monitor-database.js'
import { createConfigWatcher, computeChangedKeys } from '../modules/config/config-watcher.js'
import type { ConfigWatcher } from '../modules/config/config-watcher.js'
import type { SubstrateConfig } from '../modules/config/config-schema.js'

const logger = createLogger('orchestrator')

// ---------------------------------------------------------------------------
// OrchestratorImpl
// ---------------------------------------------------------------------------

/** Internal symbol used to expose lifecycle hooks to the factory only */
const INTERNAL = Symbol('OrchestratorImpl.internal')

class OrchestratorImpl implements Orchestrator {
  readonly eventBus: TypedEventBus
  private readonly _registry: ServiceRegistry
  private _ready = false
  private _shutdown = false
  private _shutdownHandlersRegistered = false
  private _configWatcher: ConfigWatcher | null = null

  constructor(eventBus: TypedEventBus, registry: ServiceRegistry) {
    this.eventBus = eventBus
    this._registry = registry
  }

  get isReady(): boolean {
    return this._ready
  }

  async shutdown(): Promise<void> {
    if (this._shutdown) return
    this._shutdown = true

    logger.info('Orchestrator shutdown initiated')
    this.eventBus.emit('orchestrator:shutdown', { reason: 'shutdown() called' })

    // Stop config watcher before shutting down services
    if (this._configWatcher !== null) {
      this._configWatcher.stop()
      this._configWatcher = null
    }

    try {
      await this._registry.shutdownAll()
    } catch (err) {
      logger.error({ err }, 'Error during orchestrator shutdown')
    }

    logger.info('Orchestrator shutdown complete')
  }

  private _markReady(): void {
    this._ready = true
  }

  private _sigtermHandler: (() => void) | null = null
  private _sigintHandler: (() => void) | null = null

  private _registerShutdownHandlers(): void {
    if (this._shutdownHandlersRegistered) return
    this._shutdownHandlersRegistered = true

    const makeHandler = (signal: string) => () => {
      logger.info({ signal }, 'Received signal — initiating graceful shutdown')
      this.shutdown().then(() => {
        process.exit(0)
      }).catch((err) => {
        logger.error({ err }, 'Error during signal-triggered shutdown')
        process.exit(1)
      })
    }

    this._sigtermHandler = makeHandler('SIGTERM')
    this._sigintHandler = makeHandler('SIGINT')

    process.once('SIGTERM', this._sigtermHandler)
    process.once('SIGINT', this._sigintHandler)
  }

  private _removeShutdownHandlers(): void {
    if (this._sigtermHandler !== null) {
      process.removeListener('SIGTERM', this._sigtermHandler)
      this._sigtermHandler = null
    }
    if (this._sigintHandler !== null) {
      process.removeListener('SIGINT', this._sigintHandler)
      this._sigintHandler = null
    }
  }

  /**
   * Internal accessor used exclusively by the createOrchestrator factory.
   * Do not call outside of this module.
   * @internal
   */
  [INTERNAL](): {
    markReady: () => void
    registerShutdownHandlers: () => void
    removeShutdownHandlers: () => void
    setConfigWatcher: (watcher: ConfigWatcher) => void
  } {
    return {
      markReady: () => this._markReady(),
      registerShutdownHandlers: () => this._registerShutdownHandlers(),
      removeShutdownHandlers: () => this._removeShutdownHandlers(),
      setConfigWatcher: (watcher: ConfigWatcher) => {
        this._configWatcher = watcher
      },
    }
  }
}

// ---------------------------------------------------------------------------
// createOrchestrator factory
// ---------------------------------------------------------------------------

/**
 * Initialize the orchestrator with all modules wired via dependency injection.
 *
 * Steps performed:
 *  1. Create the TypedEventBus
 *  2. Create the SQLite database service
 *  3. Instantiate all modules (TaskGraphEngine, RoutingEngine, WorkerManager,
 *     BudgetTracker, GitManager) with constructor injection
 *  4. Register all modules in the ServiceRegistry
 *  5. Call initialize() on all services in registration order
 *  6. Register SIGTERM/SIGINT graceful shutdown handlers
 *  7. Emit orchestrator:ready
 *
 * @param config - Orchestrator configuration
 * @returns Initialized Orchestrator instance
 */
export async function createOrchestrator(config: OrchestratorConfig): Promise<Orchestrator> {
  logger.info({ databasePath: config.databasePath }, 'Initializing orchestrator')

  // Step 1: Create the event bus
  const eventBus = createEventBus()

  // Step 2: Create the database service
  const databaseService = createDatabaseService(config.databasePath)

  // Step 3: Create all module instances with dependency injection
  const taskGraphEngine = createTaskGraphEngine({ eventBus, databaseService })
  const adapterRegistry = new AdapterRegistry()
  const routingEngine = createRoutingEngine({ eventBus, adapterRegistry })
  const budgetTracker = createBudgetTracker({ eventBus })
  const gitManager = createGitManager({
    eventBus,
    repoRoot: config.projectRoot,
  })

  // AC1, AC4: Create GitWorktreeManager before WorkerPoolManager so it initializes first
  const gitWorktreeManager = createGitWorktreeManager({
    eventBus,
    projectRoot: config.projectRoot,
    db: databaseService,
  })

  // Create WorkerPoolManager with all required dependencies
  const workerPoolManager = createWorkerPoolManager({
    eventBus,
    adapterRegistry,
    engine: taskGraphEngine,
    db: databaseService,
    gitWorktreeManager,
  })

  // Step 3b: Create the monitor agent (separate database connection)
  const monitorDbPath = config.monitor?.databasePath ?? ':memory:'
  const monitorDatabase = createMonitorDatabase(monitorDbPath)
  const monitorAgent = createMonitorAgent({
    eventBus,
    monitorDb: monitorDatabase,
    config: {
      retentionDays: config.monitor?.retentionDays ?? 90,
      customTaxonomy: config.monitor?.customTaxonomy,
      use_recommendations: config.monitor?.use_recommendations ?? false,
      recommendation_threshold_percentage: config.monitor?.recommendation_threshold_percentage,
      min_sample_size: config.monitor?.min_sample_size,
      recommendation_history_days: config.monitor?.recommendation_history_days,
    },
  })

  // Step 4: Register all services in the ServiceRegistry
  // IMPORTANT: GitWorktreeManager must be registered before WorkerPoolManager
  // so it initializes (and validates git) before workers can be spawned.
  // MonitorAgent is registered last to ensure it shuts down first (reverse order).
  const registry = new ServiceRegistry()
  registry.register('database', databaseService)
  registry.register('taskGraph', taskGraphEngine)
  registry.register('routingEngine', routingEngine)
  registry.register('gitWorktreeManager', gitWorktreeManager)
  registry.register('workerPoolManager', workerPoolManager)
  registry.register('budgetTracker', budgetTracker)
  registry.register('gitManager', gitManager)
  registry.register('monitorAgent', monitorAgent)

  // Step 5: Create orchestrator instance, then initialize all services.
  // If initialization fails, remove signal handlers and shut down any
  // partially-initialized services before re-throwing.
  const orchestrator = new OrchestratorImpl(eventBus, registry)
  const internal = orchestrator[INTERNAL]()

  try {
    await registry.initializeAll()
  } catch (err) {
    logger.error({ err }, 'Service initialization failed — cleaning up')
    // Remove only the handlers registered by this orchestrator instance
    internal.removeShutdownHandlers()
    try {
      await registry.shutdownAll()
    } catch (shutdownErr) {
      logger.error({ err: shutdownErr }, 'Error during cleanup after failed initialization')
    }
    throw err
  }

  // Step 6: Register graceful shutdown handlers for SIGTERM/SIGINT
  internal.registerShutdownHandlers()

  // Step 7: Set up config hot-reload watcher (AC1, AC8, AC9)
  const enableConfigHotReload = config.enableConfigHotReload ?? true
  if (enableConfigHotReload) {
    const configFilePath = config.configPath ?? join(config.projectRoot, 'substrate.config.yaml')
    let currentConfig: SubstrateConfig | null = null

    const configWatcher = createConfigWatcher({
      configPath: configFilePath,
      onReload: (newConfig: SubstrateConfig) => {
        const previousConfig = currentConfig
        if (previousConfig === null) {
          // First load — just store the config
          currentConfig = newConfig
          return
        }
        const changedKeys = computeChangedKeys(previousConfig, newConfig)
        currentConfig = newConfig

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
    internal.setConfigWatcher(configWatcher)
  }

  // Step 8: Mark ready and emit orchestrator:ready
  internal.markReady()
  eventBus.emit('orchestrator:ready', {})

  logger.info('Orchestrator ready')
  return orchestrator
}
