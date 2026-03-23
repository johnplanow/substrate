/**
 * SDLC Event Bridge — translates factory graph executor lifecycle events into
 * SDLC orchestrator events for backward compatibility with existing consumers.
 *
 * Story 43-9: SDLC-as-Graph NDJSON Event Compatibility.
 *
 * ADR-003: This file MUST NOT import any runtime value from `@substrate-ai/factory`.
 * All coupling to the factory event bus shape is via local duck-typed interfaces.
 */

// ---------------------------------------------------------------------------
// Duck-typed interfaces (ADR-003: no factory import at runtime)
// ---------------------------------------------------------------------------

/**
 * Structurally compatible with Node.js EventEmitter or TypedEventBus<FactoryEvents>.
 * Only `on` and `off` are required — the bridge never emits on the graph bus.
 */
export interface GraphEventEmitter {
  on(event: string, handler: (data: unknown) => void): this
  off(event: string, handler: (data: unknown) => void): this
}

/**
 * Structurally compatible with TypedEventBus<SdlcEvents>.emit.
 * The bridge emits translated events onto this bus.
 */
export interface SdlcEventBus {
  emit(event: string, payload: unknown): void
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for `createSdlcEventBridge`. */
export interface SdlcEventBridgeOptions {
  /** Story key for all emitted SDLC events. */
  storyKey: string
  /** Optional pipeline run ID forwarded to phase start/complete payloads. */
  pipelineRunId?: string
  /** SDLC event bus that receives translated orchestrator events. */
  sdlcBus: SdlcEventBus
  /** Factory graph event emitter (source of raw graph lifecycle events). */
  graphEvents: GraphEventEmitter
}

// ---------------------------------------------------------------------------
// SDLC node phase map
// ---------------------------------------------------------------------------

/**
 * Maps factory graph node IDs to SDLC phase names.
 * Node IDs not present here are silently ignored by the bridge (AC5).
 *
 * | Graph Node ID  | SDLC Phase Name |
 * |----------------|-----------------|
 * | analysis       | 'analysis'      |
 * | planning       | 'planning'      |
 * | solutioning    | 'solutioning'   |
 * | create_story   | 'create'        |
 * | dev_story      | 'dev'           |
 * | code_review    | 'review'        |
 * | start          | (ignored)       |
 * | exit           | (ignored)       |
 */
const SDLC_NODE_PHASE_MAP: Record<string, string> = {
  analysis: 'analysis',
  planning: 'planning',
  solutioning: 'solutioning',
  create_story: 'create',
  dev_story: 'dev',
  code_review: 'review',
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Creates an event bridge that translates factory graph executor lifecycle events
 * into SDLC orchestrator events for backward compatibility with existing consumers
 * (supervisor, CLI polling, telemetry).
 *
 * Supported translations:
 * - `graph:node-started`          → `orchestrator:story-phase-start`    (AC1)
 * - `graph:node-completed`        → `orchestrator:story-phase-complete`  (AC2)
 * - `graph:node-retried`          → (counter only — tracks review cycles)
 * - `graph:completed` (SUCCESS)   → `orchestrator:story-complete`        (AC3)
 * - `graph:goal-gate-unsatisfied` → `orchestrator:story-escalated`       (AC4)
 * - Non-SDLC node IDs             → silently ignored                     (AC5)
 *
 * @returns An object with a `teardown()` function that removes all registered
 *          graph event listeners (AC7). Must be called after story execution
 *          completes (use try/finally).
 */
export function createSdlcEventBridge(opts: SdlcEventBridgeOptions): { teardown(): void } {
  const { storyKey, pipelineRunId, sdlcBus, graphEvents } = opts

  // Tracks dev_story retry count — used for reviewCycles in complete/escalated events (AC3, AC4)
  let devStoryRetries = 0

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  const onNodeStarted = (data: unknown): void => {
    const { nodeId } = data as { nodeId: string }
    const phase = SDLC_NODE_PHASE_MAP[nodeId]
    if (!phase) return // silently ignore non-SDLC nodes (AC5)
    sdlcBus.emit('orchestrator:story-phase-start', { storyKey, phase, pipelineRunId })
  }

  const onNodeCompleted = (data: unknown): void => {
    const { nodeId, outcome } = data as { nodeId: string; outcome: unknown }
    const phase = SDLC_NODE_PHASE_MAP[nodeId]
    if (!phase) return // silently ignore non-SDLC nodes (AC5)
    sdlcBus.emit('orchestrator:story-phase-complete', {
      storyKey,
      phase,
      result: outcome,
      pipelineRunId,
    })
  }

  const onNodeRetried = (data: unknown): void => {
    const { nodeId } = data as { nodeId: string }
    if (nodeId === 'dev_story') {
      devStoryRetries++
    }
  }

  const onGraphCompleted = (data: unknown): void => {
    const { finalOutcome } = data as { finalOutcome: { status: string } }
    if (finalOutcome.status === 'SUCCESS') {
      sdlcBus.emit('orchestrator:story-complete', {
        storyKey,
        reviewCycles: devStoryRetries,
      })
    }
  }

  const onGoalGateUnsatisfied = (data: unknown): void => {
    const { nodeId } = data as { nodeId: string }
    if (nodeId === 'dev_story') {
      sdlcBus.emit('orchestrator:story-escalated', {
        storyKey,
        lastVerdict: 'NEEDS_MAJOR_REWORK',
        reviewCycles: devStoryRetries,
        issues: [],
      })
    }
  }

  // -------------------------------------------------------------------------
  // Register all listeners
  // -------------------------------------------------------------------------

  graphEvents.on('graph:node-started', onNodeStarted)
  graphEvents.on('graph:node-completed', onNodeCompleted)
  graphEvents.on('graph:node-retried', onNodeRetried)
  graphEvents.on('graph:completed', onGraphCompleted)
  graphEvents.on('graph:goal-gate-unsatisfied', onGoalGateUnsatisfied)

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  return {
    /**
     * Removes all graph event listeners registered by this bridge (AC7).
     * Call this after story execution completes (use try/finally).
     */
    teardown(): void {
      graphEvents.off('graph:node-started', onNodeStarted)
      graphEvents.off('graph:node-completed', onNodeCompleted)
      graphEvents.off('graph:node-retried', onNodeRetried)
      graphEvents.off('graph:completed', onGraphCompleted)
      graphEvents.off('graph:goal-gate-unsatisfied', onGoalGateUnsatisfied)
    },
  }
}
