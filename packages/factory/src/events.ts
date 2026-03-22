/**
 * FactoryEvents — typed event map for factory graph execution events.
 *
 * Extends CoreEvents (via intersection) with all factory-specific event types:
 * graph:started/completed/failed, graph:node-*, graph:edge-*, graph:checkpoint-*,
 * graph:goal-gate-*, scenario:*, convergence:*
 *
 * Payload shapes are sourced from architecture-software-factory.md Section 8.2 and 3.1.
 *
 * Every factory-specific event payload includes `runId: string` as its first field.
 */

import type { CoreEvents } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// Helper payload types
// ---------------------------------------------------------------------------

/**
 * Status of a node handler execution.
 * Sourced from architecture Section 3.1.
 */
export type StageStatus = 'SUCCESS' | 'FAIL' | 'PARTIAL_SUCCESS' | 'RETRY' | 'SKIPPED'

/**
 * Result of a node handler execution.
 * Sourced from architecture Section 3.1.
 */
export interface Outcome {
  status: StageStatus
  preferredLabel?: string
  suggestedNextIds?: string[]
  contextUpdates?: Record<string, unknown>
  notes?: string
  failureReason?: string
}

/**
 * Result of a single scenario execution.
 * Sourced from architecture Section 5.1.
 */
export interface ScenarioResult {
  name: string
  status: 'pass' | 'fail'
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

/**
 * Aggregated result of a scenario validation run.
 * Sourced from architecture Section 5.1.
 */
export interface ScenarioRunResult {
  scenarios: ScenarioResult[]
  summary: { total: number; passed: number; failed: number }
  durationMs: number
}

// ---------------------------------------------------------------------------
// FactoryEvents
// ---------------------------------------------------------------------------

/**
 * Complete typed map of all factory graph execution events.
 * Intersection with CoreEvents so TypedEventBus<FactoryEvents> includes all core event keys.
 *
 * NOTE: Factory graph:* events (graph:started, graph:completed, etc.) are DIFFERENT
 * from CoreEvents graph:* events (graph:loaded, graph:complete, graph:cancelled).
 * CoreEvents graph:* = task-graph dispatcher lifecycle.
 * FactoryEvents graph:* = factory graph execution engine lifecycle.
 * These are distinct namespaces and do NOT conflict.
 */
export type FactoryEvents = CoreEvents & {
  // -------------------------------------------------------------------------
  // Graph lifecycle events
  // -------------------------------------------------------------------------

  /** Factory graph execution has started */
  'graph:started': { runId: string; graphFile: string; goal: string; nodeCount: number }

  /** Factory graph execution has completed with a final outcome */
  'graph:completed': { runId: string; finalOutcome: Outcome; totalCostUsd: number; durationMs: number }

  /** Factory graph execution has failed */
  'graph:failed': { runId: string; failureReason: string; lastNodeId: string }

  // -------------------------------------------------------------------------
  // Node execution events
  // -------------------------------------------------------------------------

  /** A graph node has started execution */
  'graph:node-started': { runId: string; nodeId: string; nodeType: string }

  /** A graph node has completed execution with an outcome */
  'graph:node-completed': { runId: string; nodeId: string; outcome: Outcome }

  /** A graph node is being retried after a failure */
  'graph:node-retried': { runId: string; nodeId: string; attempt: number; maxAttempts: number; delayMs: number }

  /** A graph node has failed */
  'graph:node-failed': { runId: string; nodeId: string; failureReason: string }

  // -------------------------------------------------------------------------
  // Edge and checkpoint events
  // -------------------------------------------------------------------------

  /** An edge was selected during graph traversal */
  'graph:edge-selected': { runId: string; fromNode: string; toNode: string; step: number; edgeLabel?: string }

  /** A graph execution checkpoint has been saved to disk */
  'graph:checkpoint-saved': { runId: string; nodeId: string; checkpointPath: string }

  // -------------------------------------------------------------------------
  // Goal gate events
  // -------------------------------------------------------------------------

  /** A goal gate was checked for satisfaction */
  'graph:goal-gate-checked': { runId: string; nodeId: string; satisfied: boolean; score?: number }

  /** A goal gate was not satisfied — execution may retry or fail */
  'graph:goal-gate-unsatisfied': { runId: string; nodeId: string; retryTarget: string | null }

  // -------------------------------------------------------------------------
  // Scenario validation events
  // -------------------------------------------------------------------------

  /** Scenario validation run has started */
  'scenario:started': { runId: string; scenarioCount: number; iteration: number }

  /** Scenario validation run has completed */
  'scenario:completed': { runId: string; results: ScenarioRunResult; iteration: number }

  // -------------------------------------------------------------------------
  // Convergence events
  // -------------------------------------------------------------------------

  /** A convergence iteration has completed */
  'convergence:iteration': { runId: string; iteration: number; score: number; threshold: number; passed: boolean }

  /** A convergence plateau has been detected — score is not improving */
  'convergence:plateau-detected': { runId: string; nodeId: string; scores: number[]; window: number }

  /** Convergence budget has been exhausted at the given level */
  'convergence:budget-exhausted': { runId: string; level: 'node' | 'pipeline' | 'session'; reason: string }
}
