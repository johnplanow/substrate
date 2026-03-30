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
  /**
   * Parsed JSON output when the scenario writes valid JSON to stdout.
   * Omitted (not set to null) when stdout is plain text or empty.
   * Added in story 44-2.
   */
  parsedOutput?: unknown
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
 *
 * Twin lifecycle events (story 47-2): twin:started, twin:stopped
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

  /** Scenario integrity check passed — files unmodified since manifest capture */
  'scenario:integrity-passed': { runId: string; nodeId: string; scenarioCount: number }

  /** Scenario integrity check failed — one or more files were tampered with */
  'scenario:integrity-failed': { runId: string; nodeId: string; tampered: string[] }

  /** Dual-signal score computed — code review verdict compared against scenario score — story 46-5 */
  'scenario:score-computed': { runId: string; score: number; threshold: number; passes: boolean; agreement: 'AGREE' | 'DISAGREE'; codeReviewPassed: boolean; scenarioPassed: boolean; authoritativeDecision: string }

  /** Code review verdict logged as advisory when scenario is the authoritative decision-maker — story 46-6 */
  'scenario:advisory-computed': { runId: string; verdict: string; codeReviewPassed: boolean; score: number; threshold: number; agreement: 'AGREE' | 'DISAGREE' }

  // -------------------------------------------------------------------------
  // Convergence events
  // -------------------------------------------------------------------------

  /** A convergence iteration has completed */
  'convergence:iteration': { runId: string; iteration: number; score: number; threshold: number; passed: boolean }

  /** A convergence plateau has been detected — score is not improving */
  'convergence:plateau-detected': { runId: string; nodeId: string; scores: number[]; window: number }

  /** Convergence budget has been exhausted at the given level */
  'convergence:budget-exhausted': { runId: string; level: 'node' | 'pipeline' | 'session'; reason: string }

  // -------------------------------------------------------------------------
  // Twin lifecycle events (story 47-2)
  // -------------------------------------------------------------------------

  /** Twin container started successfully and health check passed (story 47-2) */
  'twin:started': {
    runId?: string
    twinName: string
    ports: Array<{ host: number; container: number }>
    healthStatus: 'healthy' | 'unknown'
  }

  /** Twin container stopped and cleaned up (story 47-2) */
  'twin:stopped': {
    twinName: string
  }

  // story 47-6
  /** Twin health check failed mid-run but has not yet exhausted retries (story 47-6) */
  'twin:health-warning': {
    runId?: string
    twinName: string
    error: string
    consecutiveFailures: number
  }

  // story 47-6
  /** Twin confirmed unhealthy — consecutive failure limit exhausted (story 47-6) */
  'twin:health-failed': {
    runId?: string
    twinName: string
    error: string
  }

  // -------------------------------------------------------------------------
  // Config hot-reload events (story 46-2 AC4)
  // -------------------------------------------------------------------------

  /** Factory config value changed during execution via hot-reload */
  'factory:config-reloaded': {
    key: string
    oldValue: unknown
    newValue: unknown
  }

  // -------------------------------------------------------------------------
  // Context summarization events (story 49-5)
  // -------------------------------------------------------------------------

  /** Executor applied fidelity-based context summarization before node dispatch */
  'graph:context-summarized': {
    runId: string
    nodeId: string
    /** SummaryLevel applied: 'high' | 'medium' | 'low' */
    level: string
    /** Estimated token count of the original factory.nodeContext content */
    originalTokenCount: number
    /** Estimated token count of the compressed factory.compressedNodeContext content */
    summaryTokenCount: number
  }

  // -------------------------------------------------------------------------
  // Parallel fan-out/fan-in lifecycle events (story 50-9)
  // -------------------------------------------------------------------------

  /** Parallel node started fan-out execution with N branches (story 50-9) */
  'graph:parallel-started': {
    runId: string
    nodeId: string
    branchCount: number
    maxParallel: number
    policy: string
  }

  /** A single branch started executing inside a parallel node (story 50-9) */
  'graph:parallel-branch-started': {
    runId: string
    nodeId: string
    branchIndex: number
  }

  /** A single branch completed execution inside a parallel node (story 50-9) */
  'graph:parallel-branch-completed': {
    runId: string
    nodeId: string
    branchIndex: number
    status: StageStatus
    durationMs: number
  }

  /** Parallel node completed all branches and applied the join policy (story 50-9) */
  'graph:parallel-completed': {
    runId: string
    nodeId: string
    completedCount: number
    cancelledCount: number
    policy: string
  }

  // -------------------------------------------------------------------------
  // Subgraph lifecycle events (story 50-9)
  // -------------------------------------------------------------------------

  /** Subgraph handler started executing a nested .dot graph file (story 50-9) */
  'graph:subgraph-started': {
    runId: string
    nodeId: string
    graphFile: string
    depth: number
  }

  /** Subgraph handler finished executing a nested .dot graph file (story 50-9) */
  'graph:subgraph-completed': {
    runId: string
    nodeId: string
    graphFile: string
    depth: number
    status: StageStatus
    durationMs: number
  }

  // -------------------------------------------------------------------------
  // LLM edge evaluation event (story 50-9)
  // -------------------------------------------------------------------------

  /** An LLM-evaluated edge condition was resolved (story 50-9) */
  'graph:llm-edge-evaluated': {
    runId: string
    nodeId: string
    question: string
    result: boolean
  }

  // -------------------------------------------------------------------------
  // Agent session events (story 48-12)
  // -------------------------------------------------------------------------

  /** Agent tool call started or completed during a direct backend run */
  'agent:tool-call': {
    runId: string
    nodeId: string
    toolName: string
    direction: 'call' | 'result'
    inputSummary?: string
  }

  /** Loop detected in agent session during a direct backend run */
  'agent:loop-detected': {
    runId: string
    nodeId: string
    windowSize: number
    pattern: string[]
  }

  /** Steering message injected into agent session during a direct backend run */
  'agent:steering-injected': {
    runId: string
    nodeId: string
    message: string
  }
}
