/**
 * Orchestrator interface — the public contract for the central orchestration engine.
 *
 * All callers should depend on this interface, not the concrete implementation.
 * Create an instance via `createOrchestrator()` from orchestrator-impl.ts.
 */

import type { TypedEventBus } from './event-bus.js'

// ---------------------------------------------------------------------------
// OrchestratorConfig
// ---------------------------------------------------------------------------

/**
 * Configuration required to initialize the orchestrator.
 */
export interface OrchestratorConfig {
  /** Path to the SQLite database file (e.g., ".substrate/state.db") */
  databasePath: string

  /** Working directory for the orchestrated project */
  projectRoot: string

  /**
   * Maximum number of concurrent worker tasks.
   * @default 4
   */
  maxConcurrency?: number

  /**
   * Budget cap in USD (0 = unlimited).
   * @default 0
   */
  budgetCapUsd?: number

  /**
   * Budget cap in tokens (0 = unlimited).
   * @default 0
   */
  budgetCapTokens?: number

  /** Optional logger level override */
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

  /**
   * Monitor agent configuration.
   * If omitted, monitor agent is initialized with defaults.
   */
  monitor?: {
    /**
     * Path to the monitor SQLite database file.
     * @default ':memory:' (in-memory, non-persistent) when not specified
     */
    databasePath?: string
    /**
     * Number of days to retain task metrics.
     * @default 90
     */
    retentionDays?: number
    /**
     * Custom task type taxonomy for classification overrides.
     */
    customTaxonomy?: Record<string, string[]>
  }
}

// ---------------------------------------------------------------------------
// Orchestrator interface
// ---------------------------------------------------------------------------

/**
 * Central orchestration engine — coordinates all modules via the event bus
 * and dependency injection.
 *
 * Lifecycle:
 *  1. Create via `createOrchestrator(config)`
 *  2. Factory emits `orchestrator:ready` when initialization completes
 *  3. Consumers interact with modules via the event bus or injected interfaces
 *  4. On SIGTERM/SIGINT, graceful shutdown is triggered automatically
 *  5. Call `shutdown()` explicitly for programmatic shutdown
 */
export interface Orchestrator {
  /**
   * The typed event bus for this orchestrator instance.
   * Modules and consumers use this to subscribe to and emit events.
   */
  readonly eventBus: TypedEventBus

  /**
   * Whether the orchestrator has been fully initialized.
   */
  readonly isReady: boolean

  /**
   * Perform a graceful shutdown of all modules.
   * Calls shutdown() on all services in reverse initialization order.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  shutdown(): Promise<void>
}
