/**
 * Graph executor — drives end-to-end traversal of a factory graph.
 *
 * Dispatches handlers, applies retry logic, writes checkpoints, selects edges,
 * and emits FactoryEvents at each stage of execution.
 *
 * Story 42-14 (base executor).
 * Story 42-16 (allowPartial demotion + ConvergenceController goal gate evaluation).
 *
 * NOTE: The executor uses `events.ts:Outcome` (StageStatus: 'SUCCESS' | 'FAIL' | ...)
 * rather than `types.ts:Outcome` (OutcomeStatus: 'SUCCESS' | 'FAILURE' | ...) because:
 * 1. The acceptance criteria specify status: 'FAIL' (from StageStatus, not OutcomeStatus)
 * 2. All FactoryEvents payloads (graph:node-completed) use events.ts:Outcome
 * NodeHandler returns types.ts:Outcome, which is cast via `as unknown as Outcome` where needed.
 */

import path from 'node:path'
import type { Graph, GraphNode, IGraphContext, Checkpoint, ResumeState, Outcome as GraphOutcome, OutcomeStatus } from './types.js'
import { GraphContext } from './context.js'
import { selectEdge } from './edge-selector.js'
import { CheckpointManager } from './checkpoint.js'
import { RunStateManager, type NodeArtifacts } from './run-state.js'
import type { IHandlerRegistry } from '../handlers/types.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents, Outcome } from '../events.js'
import { createConvergenceController } from '../convergence/index.js'
import type { ScenarioStore, ScenarioManifest } from '../scenarios/index.js'

// ---------------------------------------------------------------------------
// GraphExecutorConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for a single graph execution run.
 */
export interface GraphExecutorConfig {
  /** Unique identifier for this run — included in every emitted event */
  runId: string
  /** Directory where checkpoint.json and node log subdirs are written */
  logsRoot: string
  /** Handler registry used to resolve node type → handler function */
  handlerRegistry: IHandlerRegistry
  /**
   * Typed event bus for emitting graph:* events.
   * Optional — if not provided, event emission is a no-op (safe to omit in tests).
   */
  eventBus?: TypedEventBus<FactoryEvents>
  /**
   * If provided, the executor loads this checkpoint file and resumes
   * from the last completed node rather than starting at the start node.
   */
  checkpointPath?: string
  /**
   * When provided, the executor captures a scenario manifest at run start and
   * verifies integrity before each `tool` node executes (story 44-4).
   * Omit to skip all scenario integrity checks (backward-compatible default).
   */
  scenarioStore?: ScenarioStore
  /**
   * Raw DOT source string of the executed graph.
   * When provided, written to `graph.dot` in the run directory at execution start.
   * Also enables per-node artifact writing via RunStateManager (story 44-7).
   */
  dotSource?: string
}

// ---------------------------------------------------------------------------
// GraphExecutor
// ---------------------------------------------------------------------------

/**
 * Graph executor interface — drives a factory graph from start to exit node.
 */
export interface GraphExecutor {
  run(graph: Graph, config: GraphExecutorConfig): Promise<Outcome>
}

// ---------------------------------------------------------------------------
// normalizeOutcomeStatus
// ---------------------------------------------------------------------------

/**
 * Normalize a types.ts:Outcome (OutcomeStatus) to an events.ts:Outcome (StageStatus).
 *
 * NodeHandler returns `types.ts:Outcome` whose status is `OutcomeStatus`
 * ('SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE' | 'NEEDS_RETRY' | 'ESCALATE').
 * The executor operates on `events.ts:Outcome` whose status is `StageStatus`
 * ('SUCCESS' | 'FAIL' | 'PARTIAL_SUCCESS' | 'RETRY' | 'SKIPPED').
 *
 * Mapping:
 *   OutcomeStatus.FAILURE      → StageStatus.FAIL
 *   OutcomeStatus.NEEDS_RETRY  → StageStatus.FAIL  (retry exhausted at this level)
 *   OutcomeStatus.ESCALATE     → StageStatus.FAIL  (treated as failure for routing)
 *   OutcomeStatus.SUCCESS      → StageStatus.SUCCESS
 *   OutcomeStatus.PARTIAL_SUCCESS → StageStatus.PARTIAL_SUCCESS
 */
function normalizeOutcomeStatus(raw: GraphOutcome): Outcome {
  let status: Outcome['status']
  switch (raw.status) {
    case 'SUCCESS':
      status = 'SUCCESS'
      break
    case 'PARTIAL_SUCCESS':
      status = 'PARTIAL_SUCCESS'
      break
    case 'FAILURE':
    case 'NEEDS_RETRY':
    case 'ESCALATE':
    default:
      status = 'FAIL'
      break
  }
  return {
    ...(raw as unknown as Outcome),
    status,
  }
}

// ---------------------------------------------------------------------------
// computeBackoffDelay
// ---------------------------------------------------------------------------

/**
 * Compute exponential backoff delay with ±50% jitter.
 *
 * @param attempt - Zero-indexed attempt number (0 = first retry, 1 = second, etc.)
 * @returns Delay in milliseconds, floored at 0 and capped at 60,000ms
 */
function computeBackoffDelay(attempt: number): number {
  const rawDelay = Math.min(200 * Math.pow(2, attempt), 60_000)
  // ±50% jitter of rawDelay
  const jitter = rawDelay * 0.5 * (2 * Math.random() - 1)
  return Math.max(0, rawDelay + jitter)
}

// ---------------------------------------------------------------------------
// dispatchWithRetry
// ---------------------------------------------------------------------------

/**
 * Dispatch a node handler with exponential backoff retry on FAIL outcomes.
 *
 * Emits `graph:node-retried` before each retry attempt.
 * Does NOT emit `graph:node-completed` or `graph:node-failed` — those are
 * emitted by the main loop in `createGraphExecutor` AFTER the `allowPartial`
 * demotion check, ensuring correct event semantics for demoted PARTIAL_SUCCESS.
 *
 * @param node         - Node to dispatch (may have fidelity override applied).
 * @param context      - Current graph execution context.
 * @param graph        - The full factory graph.
 * @param config       - Executor configuration (handlerRegistry, eventBus, runId).
 * @param nodeRetries  - Mutable retry counter map; mutated in place.
 * @returns The final Outcome after all retry attempts.
 */
async function dispatchWithRetry(
  node: GraphNode,
  context: IGraphContext,
  graph: Graph,
  config: GraphExecutorConfig,
  nodeRetries: Record<string, number>,
): Promise<Outcome> {
  const maxRetries = node.maxRetries ?? 0
  const maxAttempts = maxRetries + 1
  let attempt = 0

  while (true) {
    let outcome: Outcome
    try {
      const handler = config.handlerRegistry.resolve(node)
      // NodeHandler returns types.ts:Outcome (OutcomeStatus).
      // normalizeOutcomeStatus() maps to events.ts:Outcome (StageStatus) so that
      // 'FAILURE' → 'FAIL', 'NEEDS_RETRY' → 'FAIL', 'ESCALATE' → 'FAIL',
      // while 'SUCCESS' and 'PARTIAL_SUCCESS' pass through unchanged.
      outcome = normalizeOutcomeStatus(await handler(node, context, graph))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      outcome = { status: 'FAIL', failureReason: msg }
    }

    const isFail = outcome.status === 'FAIL'

    if (!isFail || attempt >= maxRetries) {
      // Done: either succeeded or exhausted all retries.
      // NOTE: event emission (graph:node-completed / graph:node-failed) is intentionally
      // deferred to the main loop in createGraphExecutor, where it occurs AFTER the
      // allowPartial demotion check. Emitting here would produce graph:node-completed
      // for PARTIAL_SUCCESS outcomes that are subsequently demoted to FAIL (violating
      // Dev Notes §"allow_partial Demotion — Placement in Executor").
      return outcome
    }

    // Retry path: increment counter, compute delay, emit event, await delay
    nodeRetries[node.id] = (nodeRetries[node.id] ?? 0) + 1
    const delayMs = computeBackoffDelay(attempt)
    config.eventBus?.emit('graph:node-retried', {
      runId: config.runId,
      nodeId: node.id,
      attempt: attempt + 1, // 1-indexed: first retry = 1
      maxAttempts,
      delayMs,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    attempt++
  }
}

// ---------------------------------------------------------------------------
// createGraphExecutor
// ---------------------------------------------------------------------------

/**
 * Create a new graph executor instance.
 *
 * The returned executor's `run()` method drives a factory graph from start node
 * to exit node (or resumes from a checkpoint if `config.checkpointPath` is set),
 * dispatching handlers, applying retry logic, writing checkpoints, and emitting
 * FactoryEvents for full observability.
 */
export function createGraphExecutor(): GraphExecutor {
  return {
    async run(graph: Graph, config: GraphExecutorConfig): Promise<Outcome> {
      const checkpointManager = new CheckpointManager()
      // Checkpoint is always written to this path (filename is fixed by convention)
      const checkpointFilePath = path.join(config.logsRoot, 'checkpoint.json')

      // ConvergenceController for goal gate evaluation (story 42-16)
      const controller = createConvergenceController()

      // Execution state
      let completedNodes: string[] = []
      let nodeRetries: Record<string, number> = {}
      let context: IGraphContext = new GraphContext()
      let step = 0

      // Cycle detection: counts how many times each node is visited
      const visitCount = new Map<string, number>()

      // Resume state (non-null when config.checkpointPath is set)
      let resumeCompletedSet: Set<string> | null = null
      // Fidelity override for the first resumed node ('summary:high' or '')
      let firstResumedFidelity = ''

      // loopRestart flags: suppress cycle check / completed push for intentional loops
      let skipCycleCheck = false
      let skipCompletedPush = false

      // Capture scenario manifest for integrity checks (story 44-4).
      // Only runs when scenarioStore is configured; otherwise skipped (backward-compatible).
      let scenarioManifest: ScenarioManifest | null = null
      if (config.scenarioStore) {
        scenarioManifest = await config.scenarioStore.discover()
      }

      // RunStateManager for per-run artifact persistence (story 44-7).
      // Opt-in: only instantiated when dotSource is provided. Backward-compatible.
      const runStateManager = config.dotSource
        ? new RunStateManager({ runDir: config.logsRoot })
        : null
      if (runStateManager) {
        await runStateManager.initRun(config.dotSource!)
      }

      // -----------------------------------------------------------------------
      // Determine starting node (normal start or resume)
      // -----------------------------------------------------------------------

      let currentNode: GraphNode

      if (config.checkpointPath) {
        const checkpoint: Checkpoint = await checkpointManager.load(config.checkpointPath)
        const resumeState: ResumeState = checkpointManager.resume(graph, checkpoint)

        context = resumeState.context
        completedNodes = [...resumeState.completedNodes]
        nodeRetries = { ...resumeState.nodeRetries }
        firstResumedFidelity = resumeState.firstResumedNodeFidelity
        resumeCompletedSet = resumeState.completedNodes

        if (resumeState.completedNodes.has(checkpoint.currentNode)) {
          // Last checkpoint node was fully completed — resume from the NEXT node
          const lastNode = graph.nodes.get(checkpoint.currentNode)
          if (lastNode) {
            // KNOWN LIMITATION: The Checkpoint type does not store the final outcome
            // status of the last completed node, so we must assume SUCCESS when calling
            // selectEdge() to advance past it during resume. If the checkpointed node's
            // actual last outcome was non-SUCCESS (e.g., FAILURE with a dedicated failure
            // edge), resume will select the SUCCESS edge rather than the FAILURE edge,
            // diverging from the original execution path. Storing `lastOutcomeStatus` in
            // the Checkpoint type would allow a faithful replay.
            const nextEdge = selectEdge(lastNode, { status: 'SUCCESS' }, context, graph)
            if (nextEdge) {
              const nextNode = graph.nodes.get(nextEdge.toNode)
              if (!nextNode) {
                throw new Error(`Edge target node "${nextEdge.toNode}" not found in graph`)
              }
              currentNode = nextNode
            } else {
              // No outgoing edge from last completed node — may already be done
              currentNode = graph.startNode()
            }
          } else {
            currentNode = graph.startNode()
          }
        } else {
          // Last checkpoint node was NOT completed (process was interrupted mid-node)
          // Re-dispatch it from the resumed run
          const resumeNode = graph.nodes.get(checkpoint.currentNode)
          if (resumeNode) {
            currentNode = resumeNode
          } else {
            currentNode = graph.startNode()
          }
        }
      } else {
        currentNode = graph.startNode()
      }

      // -----------------------------------------------------------------------
      // Main traversal loop
      // -----------------------------------------------------------------------

      while (true) {
        // Exit condition: arrived at the exit node → evaluate goal gates (story 42-16)
        const exitNode = graph.exitNode()
        if (currentNode.id === exitNode.id) {
          const gateResult = controller.evaluateGates(graph)
          if (!gateResult.satisfied) {
            // Goal gate unsatisfied — resolve retry target chain (story 42-16 §Dev Notes)
            const failingNodeId = gateResult.failingNodes[0]!
            const failingGateNode = graph.nodes.get(failingNodeId)
            const retryTarget =
              failingGateNode?.retryTarget ||
              failingGateNode?.fallbackRetryTarget ||
              graph.retryTarget ||
              graph.fallbackRetryTarget
            if (retryTarget) {
              const retryNode = graph.nodes.get(retryTarget)
              if (!retryNode) {
                throw new Error(`Retry target node "${retryTarget}" not found in graph`)
              }
              currentNode = retryNode
              continue
            }
            return { status: 'FAIL', failureReason: 'Goal gate failed: no retry target' }
          }
          return { status: 'SUCCESS' }
        }

        // Resume skip: nodes already completed in a prior run are advanced over
        // without dispatching their handler again
        if (resumeCompletedSet?.has(currentNode.id)) {
          // Cast to GraphOutcome (types.ts:Outcome) as required by selectEdge API.
          const skipEdge = selectEdge(currentNode, { status: 'SUCCESS' } as GraphOutcome, context, graph)
          if (!skipEdge) {
            return {
              status: 'FAIL',
              failureReason: `No outgoing edge from node ${currentNode.id}`,
            }
          }
          config.eventBus?.emit('graph:edge-selected', {
            runId: config.runId,
            fromNode: currentNode.id,
            toNode: skipEdge.toNode,
            step,
            ...(skipEdge.label !== '' ? { edgeLabel: skipEdge.label } : {}),
          })
          step++
          const skipNextNode = graph.nodes.get(skipEdge.toNode)
          if (!skipNextNode) {
            throw new Error(`Edge target node "${skipEdge.toNode}" not found in graph`)
          }
          currentNode = skipNextNode
          continue
        }

        // Cycle detection — exempt for nodes reached via loopRestart edges
        if (!skipCycleCheck) {
          const count = (visitCount.get(currentNode.id) ?? 0) + 1
          visitCount.set(currentNode.id, count)
          if (count > graph.nodes.size * 3) {
            throw new Error(
              `Graph cycle detected: node ${currentNode.id} visited ${count} times`,
            )
          }
        }
        skipCycleCheck = false

        // Integrity check: verify scenario files before dispatching any tool node (story 44-4)
        if (currentNode.type === 'tool' && config.scenarioStore && scenarioManifest) {
          const integrityResult = await config.scenarioStore.verifyIntegrity(scenarioManifest)
          if (!integrityResult.valid) {
            config.eventBus?.emit('scenario:integrity-failed', {
              runId: config.runId,
              nodeId: currentNode.id,
              tampered: integrityResult.tampered,
            })
            return {
              status: 'FAIL',
              failureReason: `Scenario integrity violation detected before node "${currentNode.id}": tampered files: ${integrityResult.tampered.join(', ')}`,
            }
          }
          config.eventBus?.emit('scenario:integrity-passed', {
            runId: config.runId,
            nodeId: currentNode.id,
            scenarioCount: scenarioManifest.scenarios.length,
          })
        }

        // ----------------------------------------------------------------
        // Emit graph:node-started before handler invocation
        // ----------------------------------------------------------------
        config.eventBus?.emit('graph:node-started', {
          runId: config.runId,
          nodeId: currentNode.id,
          nodeType: currentNode.type,
        })

        // ----------------------------------------------------------------
        // Fidelity override for the first resumed node
        // ----------------------------------------------------------------
        const nodeToDispatch =
          firstResumedFidelity !== ''
            ? { ...currentNode, fidelity: firstResumedFidelity }
            : currentNode
        firstResumedFidelity = '' // clear after first use

        // Record dispatch start time for artifact timing (story 44-7)
        const startedAt = Date.now()

        // ----------------------------------------------------------------
        // Dispatch handler with retry logic
        // ----------------------------------------------------------------
        let outcome = await dispatchWithRetry(
          nodeToDispatch,
          context,
          graph,
          config,
          nodeRetries,
        )

        // ----------------------------------------------------------------
        // allowPartial demotion (story 42-16, AC2/AC3)
        // After the retry loop exits and the final outcome is determined:
        // if the node does not accept PARTIAL_SUCCESS, demote to FAIL.
        // This check uses nodeToDispatch (which has the correct allowPartial value).
        // ----------------------------------------------------------------
        if (outcome.status === 'PARTIAL_SUCCESS' && !nodeToDispatch.allowPartial) {
          outcome = {
            ...outcome,
            status: 'FAIL',
            failureReason: outcome.failureReason
              ? `${outcome.failureReason} (PARTIAL_SUCCESS not accepted: allowPartial=false)`
              : 'PARTIAL_SUCCESS not accepted: allowPartial=false',
          }
        }

        // ----------------------------------------------------------------
        // Write per-node artifacts (story 44-7)
        // Called after allowPartial demotion so the persisted status reflects the final outcome.
        // ----------------------------------------------------------------
        if (runStateManager) {
          const completedAt = Date.now()
          const nodeArtifacts: NodeArtifacts = {
            nodeId: nodeToDispatch.id,
            nodeType: nodeToDispatch.type,
            status: outcome.status,
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
          }
          if (nodeToDispatch.type === 'codergen') {
            const rawPrompt = nodeToDispatch.prompt || nodeToDispatch.label
            if (rawPrompt) nodeArtifacts.prompt = rawPrompt
            if (typeof outcome.notes === 'string') nodeArtifacts.response = outcome.notes
          }
          await runStateManager.writeNodeArtifacts(nodeArtifacts)
        }

        // ----------------------------------------------------------------
        // Emit node completion/failure event AFTER allowPartial demotion (story 42-16)
        // This placement ensures graph:node-failed is emitted when PARTIAL_SUCCESS is
        // demoted to FAIL, and graph:node-completed is never emitted for a demoted node.
        // ----------------------------------------------------------------
        if (outcome.status === 'FAIL') {
          config.eventBus?.emit('graph:node-failed', {
            runId: config.runId,
            nodeId: nodeToDispatch.id,
            failureReason: outcome.failureReason ?? 'Unknown failure',
          })
        } else {
          config.eventBus?.emit('graph:node-completed', {
            runId: config.runId,
            nodeId: nodeToDispatch.id,
            outcome,
          })
        }

        // ----------------------------------------------------------------
        // Record outcome with ConvergenceController (story 42-16)
        // Map events.ts StageStatus to types.ts OutcomeStatus for the controller.
        // ----------------------------------------------------------------
        {
          const controllerStatus: OutcomeStatus =
            outcome.status === 'SUCCESS' ? 'SUCCESS'
            : outcome.status === 'PARTIAL_SUCCESS' ? 'PARTIAL_SUCCESS'
            : 'FAILURE'
          controller.recordOutcome(nodeToDispatch.id, controllerStatus)
        }

        // ----------------------------------------------------------------
        // Apply context updates from outcome
        // ----------------------------------------------------------------
        if (outcome.contextUpdates) {
          for (const [key, value] of Object.entries(outcome.contextUpdates)) {
            context.set(key, value)
          }
        }

        // ----------------------------------------------------------------
        // Push completed node (skip for loopRestart re-entry nodes)
        // ----------------------------------------------------------------
        if (!skipCompletedPush) {
          completedNodes.push(currentNode.id)
        }
        skipCompletedPush = false

        // ----------------------------------------------------------------
        // Save checkpoint after each node completion
        // ----------------------------------------------------------------
        await checkpointManager.save(config.logsRoot, {
          currentNode: currentNode.id,
          completedNodes,
          nodeRetries,
          context,
        })
        config.eventBus?.emit('graph:checkpoint-saved', {
          runId: config.runId,
          nodeId: currentNode.id,
          checkpointPath: checkpointFilePath,
        })

        // ----------------------------------------------------------------
        // FAIL routing (story 42-16)
        // When outcome is FAIL (including demoted PARTIAL_SUCCESS), route to
        // the node-level retryTarget chain or return FAIL immediately.
        // ----------------------------------------------------------------
        if (outcome.status === 'FAIL') {
          const retryTarget =
            currentNode.retryTarget ||
            currentNode.fallbackRetryTarget ||
            graph.retryTarget ||
            graph.fallbackRetryTarget
          if (retryTarget) {
            const retryNode = graph.nodes.get(retryTarget)
            if (!retryNode) {
              throw new Error(`Retry target node "${retryTarget}" not found in graph`)
            }
            skipCycleCheck = true
            currentNode = retryNode
            continue
          }
          return {
            status: 'FAIL',
            ...(outcome.failureReason !== undefined && { failureReason: outcome.failureReason }),
          }
        }

        // ----------------------------------------------------------------
        // Select next edge
        // ----------------------------------------------------------------
        // Cast outcome to GraphOutcome (types.ts:Outcome) as required by selectEdge API.
        const edge = selectEdge(currentNode, outcome as unknown as GraphOutcome, context, graph)
        if (!edge) {
          return {
            status: 'FAIL',
            failureReason: `No outgoing edge from node ${currentNode.id}`,
          }
        }

        // ----------------------------------------------------------------
        // Emit graph:edge-selected after edge selection
        // ----------------------------------------------------------------
        config.eventBus?.emit('graph:edge-selected', {
          runId: config.runId,
          fromNode: currentNode.id,
          toNode: edge.toNode,
          step,
          ...(edge.label !== '' ? { edgeLabel: edge.label } : {}),
        })
        step++

        // ----------------------------------------------------------------
        // Handle loopRestart: next iteration skips cycle check and
        // completed push (treating target as a fresh re-entry)
        // ----------------------------------------------------------------
        if (edge.loopRestart) {
          skipCycleCheck = true
          skipCompletedPush = true
        }

        // ----------------------------------------------------------------
        // Advance to next node
        // ----------------------------------------------------------------
        const nextNode = graph.nodes.get(edge.toNode)
        if (!nextNode) {
          throw new Error(`Edge target node "${edge.toNode}" not found in graph`)
        }
        currentNode = nextNode
      }
    },
  }
}
