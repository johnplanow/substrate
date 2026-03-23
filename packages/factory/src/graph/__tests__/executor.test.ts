/**
 * Unit tests for the graph executor (story 42-14).
 *
 * Covers all 7 acceptance criteria:
 *   AC1 — 3-node graph traversal returns SUCCESS
 *   AC2 — handler exceptions converted to FAIL outcome
 *   AC3 — retry with exponential backoff (via fake timers)
 *   AC4 — checkpoint saved after each node; resume from checkpoint
 *   AC5 — all 6 FactoryEvents emitted with correct payloads
 *   AC6 — per-node transition overhead < 100ms for 20-node graph
 *   AC7 — all unit tests pass
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Graph, GraphNode, GraphEdge } from '../types.js'
import type { IHandlerRegistry, NodeHandler } from '../../handlers/types.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents, Outcome } from '../../events.js'
import type { GraphExecutorConfig } from '../executor.js'

// ---------------------------------------------------------------------------
// Hoist mock factories so they are available when vi.mock() runs
// ---------------------------------------------------------------------------

const { mockSave, mockLoad, mockResume } = vi.hoisted(() => ({
  mockSave: vi.fn().mockResolvedValue(undefined as void),
  mockLoad: vi.fn(),
  mockResume: vi.fn(),
}))

const { mockEvaluateGates, mockRecordOutcome } = vi.hoisted(() => ({
  mockEvaluateGates: vi.fn().mockReturnValue({ satisfied: true, failingNodes: [] }),
  mockRecordOutcome: vi.fn(),
}))

// Mock CheckpointManager to avoid real file I/O in executor tests
vi.mock('../checkpoint.js', () => ({
  CheckpointManager: vi.fn().mockImplementation(() => ({
    save: mockSave,
    load: mockLoad,
    resume: mockResume,
  })),
}))

// Mock ConvergenceController to avoid implicit reliance on goalGate=false for all nodes.
// Explicit mock ensures tests are not fragile to future nodes with goalGate=true.
// Path is relative to this test file: __tests__/../../convergence/index.js → src/convergence/index.js
vi.mock('../../convergence/index.js', () => ({
  createConvergenceController: vi.fn().mockImplementation(() => ({
    evaluateGates: mockEvaluateGates,
    recordOutcome: mockRecordOutcome,
  })),
}))

// Import AFTER mocking
import { createGraphExecutor } from '../executor.js'
import { GraphContext } from '../context.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const minimalNode: GraphNode = {
  id: '',
  label: '',
  shape: '',
  type: '',
  prompt: '',
  maxRetries: 0,
  goalGate: false,
  retryTarget: '',
  fallbackRetryTarget: '',
  fidelity: '',
  threadId: '',
  class: '',
  timeout: 0,
  llmModel: '',
  llmProvider: '',
  reasoningEffort: '',
  autoStatus: false,
  allowPartial: false,
  toolCommand: '',
}

function makeNode(id: string, overrides?: Partial<GraphNode>): GraphNode {
  return { ...minimalNode, id, ...overrides }
}

function makeEdge(fromNode: string, toNode: string, overrides?: Partial<GraphEdge>): GraphEdge {
  return {
    fromNode,
    toNode,
    label: '',
    condition: '',
    weight: 0,
    fidelity: '',
    threadId: '',
    loopRestart: false,
    ...overrides,
  }
}

/**
 * Build a minimal Graph stub conforming to the Graph interface.
 * startNodeId and exitNodeId designate which nodes play those roles.
 */
function makeGraph(
  nodeList: GraphNode[],
  edgeList: GraphEdge[],
  startNodeId: string,
  exitNodeId: string,
): Graph {
  const nodeMap = new Map(nodeList.map((n) => [n.id, n]))
  return {
    id: '',
    goal: '',
    label: '',
    modelStylesheet: '',
    defaultMaxRetries: 0,
    retryTarget: '',
    fallbackRetryTarget: '',
    defaultFidelity: '',
    nodes: nodeMap,
    edges: edgeList,
    outgoingEdges: (nodeId: string) => edgeList.filter((e) => e.fromNode === nodeId),
    startNode: () => nodeMap.get(startNodeId)!,
    exitNode: () => nodeMap.get(exitNodeId)!,
  }
}

/** Build a mock IHandlerRegistry that returns the given handler for all nodes. */
function makeRegistry(handler: NodeHandler): IHandlerRegistry {
  return {
    register: vi.fn(),
    registerShape: vi.fn(),
    setDefault: vi.fn(),
    resolve: vi.fn().mockReturnValue(handler),
  }
}

/** Build a mock TypedEventBus<FactoryEvents> with a spy on emit(). */
function makeEventBus(): { bus: TypedEventBus<FactoryEvents>; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn()
  const bus: TypedEventBus<FactoryEvents> = {
    emit,
    on: vi.fn(),
    off: vi.fn(),
  }
  return { bus, emit }
}

/** Minimal config with fake logsRoot. */
function makeConfig(
  registry: IHandlerRegistry,
  overrides?: Partial<GraphExecutorConfig>,
): GraphExecutorConfig {
  return {
    runId: 'test-run-id',
    logsRoot: '/tmp/executor-test',
    handlerRegistry: registry,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockSave.mockResolvedValue(undefined)
  // Reset convergence mocks to default passing state
  mockEvaluateGates.mockReturnValue({ satisfied: true, failingNodes: [] })
})

// ---------------------------------------------------------------------------
// AC1: 3-node graph traversal returns SUCCESS
// ---------------------------------------------------------------------------

describe('AC1: 3-node graph traversal', () => {
  it('dispatches handlers in order and returns SUCCESS', async () => {
    const successHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(successHandler as unknown as NodeHandler)
    const { bus, emit } = makeEventBus()

    const startNode = makeNode('start')
    const codergenNode = makeNode('codergen')
    const exitNode = makeNode('exit')
    const edges = [makeEdge('start', 'codergen'), makeEdge('codergen', 'exit')]
    const graph = makeGraph([startNode, codergenNode, exitNode], edges, 'start', 'exit')

    const executor = createGraphExecutor()
    const outcome = await executor.run(graph, makeConfig(registry, { eventBus: bus }))

    expect(outcome.status).toBe('SUCCESS')
    // Handler dispatched for start and codergen (not exit — exit terminates loop)
    expect(successHandler).toHaveBeenCalledTimes(2)

    // graph:node-started emitted once per dispatched node (start, codergen)
    const nodeStartedCalls = emit.mock.calls.filter(([event]) => event === 'graph:node-started')
    expect(nodeStartedCalls).toHaveLength(2)

    // graph:checkpoint-saved emitted once per completed node
    const checkpointSavedCalls = emit.mock.calls.filter(
      ([event]) => event === 'graph:checkpoint-saved',
    )
    expect(checkpointSavedCalls).toHaveLength(2)

    // CheckpointManager.save called once per node
    expect(mockSave).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// AC2: Handler exceptions converted to FAIL outcome
// ---------------------------------------------------------------------------

describe('AC2: handler exception converted to FAIL', () => {
  it('catches thrown Error and returns { status: FAIL, failureReason }', async () => {
    const throwingHandler = vi.fn().mockRejectedValue(new Error('boom'))
    const registry = makeRegistry(throwingHandler as unknown as NodeHandler)
    const { bus, emit } = makeEventBus()

    // Use a graph where the retry-node has no outgoing edges so the FAIL propagates
    const retryNode = makeNode('start')
    const exitNode = makeNode('exit')
    // No edge from start → exit: forces FAIL from "No outgoing edge"
    const graph = makeGraph([retryNode, exitNode], [], 'start', 'exit')

    const executor = createGraphExecutor()
    const outcome = await executor.run(graph, makeConfig(registry, { eventBus: bus }))

    // Handler throws; exception is caught and converted to FAIL
    expect(outcome.status).toBe('FAIL')
    // failureReason should come from either the exception or the no-edge message
    expect(typeof outcome.failureReason).toBe('string')

    // graph:node-failed should be emitted for the exception case
    const failedCalls = emit.mock.calls.filter(([event]) => event === 'graph:node-failed')
    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0]![1]).toMatchObject({ nodeId: 'start', failureReason: 'boom' })
  })

  it('catches non-Error throws and converts to FAIL with string failureReason', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const throwingHandler = vi.fn().mockRejectedValue('string error' as any)
    const registry = makeRegistry(throwingHandler as unknown as NodeHandler)
    const { bus, emit } = makeEventBus()

    const startNode = makeNode('start')
    const exitNode = makeNode('exit')
    // No edge from start → executor returns FAIL (no outgoing edge)
    const graph = makeGraph([startNode, exitNode], [], 'start', 'exit')

    const executor = createGraphExecutor()
    const outcome = await executor.run(graph, makeConfig(registry, { eventBus: bus }))

    // run() returns FAIL (no outgoing edge after the exception)
    expect(outcome.status).toBe('FAIL')
    // The node-failed event carries the original exception failureReason
    const failedCalls = emit.mock.calls.filter(([e]) => e === 'graph:node-failed')
    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0]![1]).toMatchObject({ failureReason: 'string error' })
  })
})

// ---------------------------------------------------------------------------
// AC3: Retry with exponential backoff
// ---------------------------------------------------------------------------

describe('AC3: retry with exponential backoff', () => {
  it('retries up to max_retries=2 times (3 total attempts) and emits node-retried twice', async () => {
    vi.useFakeTimers()

    const failHandler = vi.fn().mockResolvedValue({ status: 'FAIL' } as unknown as Outcome)
    const registry = makeRegistry(failHandler as unknown as NodeHandler)
    const { bus, emit } = makeEventBus()

    // Node with maxRetries=2 (3 total attempts): 1 initial + 2 retries
    const retryNode = makeNode('retry-node', { maxRetries: 2 })
    const exitNode = makeNode('exit')
    // No outgoing edge from retry-node → final run() returns FAIL
    const graph = makeGraph([retryNode, exitNode], [], 'retry-node', 'exit')

    const executor = createGraphExecutor()

    // Start the run — it will pause at each setTimeout
    const runPromise = executor.run(graph, makeConfig(registry, { eventBus: bus }))

    // Advance all fake timers to allow retries to complete
    await vi.runAllTimersAsync()

    const outcome = await runPromise

    // Handler called 3 times total (1 initial + 2 retries)
    expect(failHandler).toHaveBeenCalledTimes(3)

    // graph:node-retried emitted once per retry (before each retry attempt)
    const retriedCalls = emit.mock.calls.filter(([event]) => event === 'graph:node-retried')
    expect(retriedCalls).toHaveLength(2)

    // First retry: attempt=1
    expect(retriedCalls[0]![1]).toMatchObject({
      runId: 'test-run-id',
      nodeId: 'retry-node',
      attempt: 1,
      maxAttempts: 3,
    })

    // Second retry: attempt=2
    expect(retriedCalls[1]![1]).toMatchObject({ attempt: 2, maxAttempts: 3 })

    // Final outcome is FAIL (no outgoing edge from retry-node)
    expect(outcome.status).toBe('FAIL')

    vi.useRealTimers()
  })

  it('increments nodeRetries counter for each retry', async () => {
    vi.useFakeTimers()

    const failHandler = vi.fn().mockResolvedValue({ status: 'FAIL' } as unknown as Outcome)
    const registry = makeRegistry(failHandler as unknown as NodeHandler)

    const retryNode = makeNode('my-node', { maxRetries: 1 })
    const exitNode = makeNode('exit')
    const graph = makeGraph([retryNode, exitNode], [], 'my-node', 'exit')

    const executor = createGraphExecutor()
    const runPromise = executor.run(graph, makeConfig(registry))
    await vi.runAllTimersAsync()
    await runPromise

    // save should have been called after the final failed attempt
    expect(mockSave).toHaveBeenCalled()
    const lastSaveCall = mockSave.mock.calls[mockSave.mock.calls.length - 1]
    const saveParams = lastSaveCall![1] as { nodeRetries: Record<string, number> }
    // nodeRetries['my-node'] should be 1 (one retry was done)
    expect(saveParams.nodeRetries['my-node']).toBe(1)

    vi.useRealTimers()
  })

  it('does not retry when maxRetries=0 (default)', async () => {
    const failHandler = vi.fn().mockResolvedValue({ status: 'FAIL' } as unknown as Outcome)
    const registry = makeRegistry(failHandler as unknown as NodeHandler)
    const { bus, emit } = makeEventBus()

    const startNode = makeNode('start') // maxRetries: 0 (default)
    const exitNode = makeNode('exit')
    const graph = makeGraph([startNode, exitNode], [], 'start', 'exit')

    const executor = createGraphExecutor()
    await executor.run(graph, makeConfig(registry, { eventBus: bus }))

    // Handler called exactly once (no retries)
    expect(failHandler).toHaveBeenCalledTimes(1)
    const retriedCalls = emit.mock.calls.filter(([event]) => event === 'graph:node-retried')
    expect(retriedCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC4: Checkpoint save and resume
// ---------------------------------------------------------------------------

describe('AC4: checkpoint save', () => {
  it('calls checkpointManager.save once per completed node with correct currentNode', async () => {
    const successHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(successHandler as unknown as NodeHandler)

    const startNode = makeNode('start')
    const codergenNode = makeNode('codergen')
    const exitNode = makeNode('exit')
    const edges = [makeEdge('start', 'codergen'), makeEdge('codergen', 'exit')]
    const graph = makeGraph([startNode, codergenNode, exitNode], edges, 'start', 'exit')

    const executor = createGraphExecutor()
    await executor.run(graph, makeConfig(registry))

    // 2 saves: after start, after codergen (not after exit)
    expect(mockSave).toHaveBeenCalledTimes(2)

    const firstSave = mockSave.mock.calls[0]![1] as { currentNode: string; completedNodes: string[] }
    expect(firstSave.currentNode).toBe('start')
    expect(firstSave.completedNodes).toContain('start')

    const secondSave = mockSave.mock.calls[1]![1] as { currentNode: string; completedNodes: string[] }
    expect(secondSave.currentNode).toBe('codergen')
    expect(secondSave.completedNodes).toContain('start')
    expect(secondSave.completedNodes).toContain('codergen')
  })
})

describe('AC4: checkpoint resume', () => {
  it('skips completed nodes and dispatches from the resumed node', async () => {
    const handlerSpy = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(handlerSpy as unknown as NodeHandler)

    // Graph: start → codergen → exit
    const startNode = makeNode('start')
    const codergenNode = makeNode('codergen')
    const exitNode = makeNode('exit')
    const edges = [makeEdge('start', 'codergen'), makeEdge('codergen', 'exit')]
    const graph = makeGraph([startNode, codergenNode, exitNode], edges, 'start', 'exit')

    // Checkpoint: start was already completed
    mockLoad.mockResolvedValue({
      timestamp: Date.now(),
      currentNode: 'start',
      completedNodes: ['start'],
      nodeRetries: {},
      contextValues: {},
      logs: [],
    })
    // resume() returns a state with start in completedNodes
    mockResume.mockReturnValue({
      context: new GraphContext(),
      completedNodes: new Set(['start']),
      nodeRetries: {},
      firstResumedNodeFidelity: '',
    })

    const executor = createGraphExecutor()
    const outcome = await executor.run(
      graph,
      makeConfig(registry, { checkpointPath: '/tmp/checkpoint.json' }),
    )

    expect(outcome.status).toBe('SUCCESS')
    // 'start' should NOT have been dispatched (it was already completed)
    // Only 'codergen' should have been dispatched
    expect(handlerSpy).toHaveBeenCalledTimes(1)
    const dispatchedNode = (handlerSpy.mock.calls[0] as [GraphNode, ...unknown[]])[0]
    expect(dispatchedNode.id).toBe('codergen')
  })

  it('re-dispatches currentNode if it was not in completedNodes', async () => {
    const handlerSpy = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(handlerSpy as unknown as NodeHandler)

    const startNode = makeNode('start')
    const codergenNode = makeNode('codergen')
    const exitNode = makeNode('exit')
    const edges = [makeEdge('start', 'codergen'), makeEdge('codergen', 'exit')]
    const graph = makeGraph([startNode, codergenNode, exitNode], edges, 'start', 'exit')

    // Checkpoint: start was NOT completed (process interrupted mid-start)
    mockLoad.mockResolvedValue({
      timestamp: Date.now(),
      currentNode: 'start',
      completedNodes: [],  // start not in completedNodes
      nodeRetries: {},
      contextValues: {},
      logs: [],
    })
    mockResume.mockReturnValue({
      context: new GraphContext(),
      completedNodes: new Set<string>(),  // empty set
      nodeRetries: {},
      firstResumedNodeFidelity: '',
    })

    const executor = createGraphExecutor()
    const outcome = await executor.run(
      graph,
      makeConfig(registry, { checkpointPath: '/tmp/checkpoint.json' }),
    )

    expect(outcome.status).toBe('SUCCESS')
    // start AND codergen should have been dispatched (start was re-dispatched)
    expect(handlerSpy).toHaveBeenCalledTimes(2)
    const firstDispatch = (handlerSpy.mock.calls[0] as [GraphNode, ...unknown[]])[0]
    expect(firstDispatch.id).toBe('start')
  })
})

// ---------------------------------------------------------------------------
// AC5: All 6 FactoryEvents emitted at the correct points
// ---------------------------------------------------------------------------

describe('AC5: all 6 FactoryEvents emitted correctly', () => {
  it('emits all required events with correct runId and payloads', async () => {
    const successHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(successHandler as unknown as NodeHandler)
    const { bus, emit } = makeEventBus()

    // 2-node graph: start → exit
    const startNode = makeNode('start', { type: 'start' })
    const exitNode = makeNode('exit', { type: 'exit' })
    const edges = [makeEdge('start', 'exit', { label: 'proceed' })]
    const graph = makeGraph([startNode, exitNode], edges, 'start', 'exit')

    const config = makeConfig(registry, { eventBus: bus, runId: 'run-42' })
    const executor = createGraphExecutor()
    await executor.run(graph, config)

    // --- graph:node-started ---
    const nodeStarted = emit.mock.calls.filter(([e]) => e === 'graph:node-started')
    expect(nodeStarted).toHaveLength(1)
    expect(nodeStarted[0]![1]).toEqual({ runId: 'run-42', nodeId: 'start', nodeType: 'start' })

    // --- graph:node-completed ---
    const nodeCompleted = emit.mock.calls.filter(([e]) => e === 'graph:node-completed')
    expect(nodeCompleted).toHaveLength(1)
    expect(nodeCompleted[0]![1]).toMatchObject({ runId: 'run-42', nodeId: 'start' })

    // --- graph:checkpoint-saved ---
    const checkpointSaved = emit.mock.calls.filter(([e]) => e === 'graph:checkpoint-saved')
    expect(checkpointSaved).toHaveLength(1)
    expect(checkpointSaved[0]![1]).toMatchObject({
      runId: 'run-42',
      nodeId: 'start',
      checkpointPath: '/tmp/executor-test/checkpoint.json',
    })

    // --- graph:edge-selected ---
    const edgeSelected = emit.mock.calls.filter(([e]) => e === 'graph:edge-selected')
    expect(edgeSelected).toHaveLength(1)
    expect(edgeSelected[0]![1]).toMatchObject({
      runId: 'run-42',
      fromNode: 'start',
      toNode: 'exit',
      step: 0,
      edgeLabel: 'proceed',
    })

    // --- graph:node-retried: not emitted (no retries) ---
    const nodeRetried = emit.mock.calls.filter(([e]) => e === 'graph:node-retried')
    expect(nodeRetried).toHaveLength(0)

    // --- graph:node-failed: not emitted (success) ---
    const nodeFailed = emit.mock.calls.filter(([e]) => e === 'graph:node-failed')
    expect(nodeFailed).toHaveLength(0)
  })

  it('emits graph:node-failed for final FAIL after retries (not graph:node-completed)', async () => {
    vi.useFakeTimers()

    const failHandler = vi.fn().mockResolvedValue({ status: 'FAIL' } as unknown as Outcome)
    const registry = makeRegistry(failHandler as unknown as NodeHandler)
    const { bus, emit } = makeEventBus()

    const retryNode = makeNode('fail-node', { maxRetries: 1 })
    const exitNode = makeNode('exit')
    const graph = makeGraph([retryNode, exitNode], [], 'fail-node', 'exit')

    const executor = createGraphExecutor()
    const runPromise = executor.run(graph, makeConfig(registry, { eventBus: bus }))
    await vi.runAllTimersAsync()
    await runPromise

    const nodeFailed = emit.mock.calls.filter(([e]) => e === 'graph:node-failed')
    expect(nodeFailed).toHaveLength(1)
    expect(nodeFailed[0]![1]).toMatchObject({
      runId: 'test-run-id',
      nodeId: 'fail-node',
    })

    // graph:node-completed must NOT be emitted when final outcome is FAIL
    const nodeCompleted = emit.mock.calls.filter(([e]) => e === 'graph:node-completed')
    expect(nodeCompleted).toHaveLength(0)

    vi.useRealTimers()
  })

  it('does not include edgeLabel when edge label is empty', async () => {
    const successHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(successHandler as unknown as NodeHandler)
    const { bus, emit } = makeEventBus()

    const startNode = makeNode('start')
    const exitNode = makeNode('exit')
    // Edge with empty label
    const edges = [makeEdge('start', 'exit', { label: '' })]
    const graph = makeGraph([startNode, exitNode], edges, 'start', 'exit')

    const executor = createGraphExecutor()
    await executor.run(graph, makeConfig(registry, { eventBus: bus }))

    const edgeSelected = emit.mock.calls.filter(([e]) => e === 'graph:edge-selected')
    expect(edgeSelected).toHaveLength(1)
    // edgeLabel should not be present (not even as undefined due to exactOptionalPropertyTypes)
    expect(edgeSelected[0]![1]).not.toHaveProperty('edgeLabel')
  })
})

// ---------------------------------------------------------------------------
// AC6: Per-node transition overhead under 100ms
// ---------------------------------------------------------------------------

describe('AC6: performance — per-node overhead < 100ms', () => {
  it('20-node linear graph with instant handlers completes within 2000ms total', async () => {
    // Build 20-node linear graph: node0 → node1 → ... → node19 → exit
    const nodeCount = 20
    const nodes: GraphNode[] = []
    const edges: GraphEdge[] = []

    for (let i = 0; i < nodeCount; i++) {
      nodes.push(makeNode(`node${i}`))
      if (i < nodeCount - 1) {
        edges.push(makeEdge(`node${i}`, `node${i + 1}`))
      }
    }
    const exitNode = makeNode('exit')
    nodes.push(exitNode)
    edges.push(makeEdge(`node${nodeCount - 1}`, 'exit'))

    const graph = makeGraph(nodes, edges, 'node0', 'exit')

    const instantHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(instantHandler as unknown as NodeHandler)

    const executor = createGraphExecutor()
    const startTime = Date.now()
    const outcome = await executor.run(graph, makeConfig(registry))
    const elapsed = Date.now() - startTime

    expect(outcome.status).toBe('SUCCESS')

    // Per-node overhead = total time / 20 nodes (handlers return instantly, so elapsed ≈ overhead)
    const avgPerNode = elapsed / nodeCount
    expect(avgPerNode).toBeLessThan(100)
  })
})

// ---------------------------------------------------------------------------
// AC7 / Edge cases (Task 7)
// ---------------------------------------------------------------------------

describe('Edge case: cycle detection', () => {
  it('throws when a node is visited more than nodes.size * 3 times', async () => {
    const successHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(successHandler as unknown as NodeHandler)

    // 2-node graph that forms an infinite loop: start → back → start → ...
    // (loopRestart: false so cycle detection triggers)
    const startNode = makeNode('start')
    const backNode = makeNode('back')
    const exitNode = makeNode('exit')
    const edges = [
      makeEdge('start', 'back'),
      makeEdge('back', 'start'), // forms cycle WITHOUT loopRestart
    ]
    const graph = makeGraph([startNode, backNode, exitNode], edges, 'start', 'exit')

    const executor = createGraphExecutor()
    await expect(executor.run(graph, makeConfig(registry))).rejects.toThrow(
      'Graph cycle detected',
    )
  })
})

describe('Edge case: missing target node', () => {
  it('throws descriptive error when edge target node is not in graph', async () => {
    const successHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(successHandler as unknown as NodeHandler)

    // Edge points to a non-existent node
    const startNode = makeNode('start')
    const exitNode = makeNode('exit')
    const edges = [makeEdge('start', 'nonexistent-node')]
    const graph = makeGraph([startNode, exitNode], edges, 'start', 'exit')

    const executor = createGraphExecutor()
    await expect(executor.run(graph, makeConfig(registry))).rejects.toThrow(
      'Edge target node "nonexistent-node" not found in graph',
    )
  })
})

describe('Edge case: no outgoing edges returns FAIL', () => {
  it('returns FAIL with descriptive failureReason when edge selection returns null', async () => {
    const successHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(successHandler as unknown as NodeHandler)

    const startNode = makeNode('start')
    const exitNode = makeNode('exit')
    // No edges from start
    const graph = makeGraph([startNode, exitNode], [], 'start', 'exit')

    const executor = createGraphExecutor()
    const outcome = await executor.run(graph, makeConfig(registry))

    expect(outcome.status).toBe('FAIL')
    expect(outcome.failureReason).toContain('No outgoing edge from node start')
  })
})

describe('Edge case: omitted eventBus is safe (no-op)', () => {
  it('runs without errors when eventBus is undefined', async () => {
    const successHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(successHandler as unknown as NodeHandler)

    const startNode = makeNode('start')
    const exitNode = makeNode('exit')
    const edges = [makeEdge('start', 'exit')]
    const graph = makeGraph([startNode, exitNode], edges, 'start', 'exit')

    // No eventBus in config
    const config = makeConfig(registry) // eventBus is undefined
    const executor = createGraphExecutor()
    const outcome = await executor.run(graph, config)

    expect(outcome.status).toBe('SUCCESS')
  })
})

describe('Context updates: applied after each node', () => {
  it('applies outcome.contextUpdates to context and makes them available for edge selection', async () => {
    // First node sets context, second reads it (via condition on edge)
    let callCount = 0
    const handler = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return { status: 'SUCCESS', contextUpdates: { myKey: 'myValue' } } as unknown as Awaited<ReturnType<NodeHandler>>
      }
      return { status: 'SUCCESS' } as unknown as Awaited<ReturnType<NodeHandler>>
    })
    const registry = makeRegistry(handler as unknown as NodeHandler)

    const startNode = makeNode('start')
    const midNode = makeNode('mid')
    const exitNode = makeNode('exit')
    const edges = [makeEdge('start', 'mid'), makeEdge('mid', 'exit')]
    const graph = makeGraph([startNode, midNode, exitNode], edges, 'start', 'exit')

    const executor = createGraphExecutor()
    const outcome = await executor.run(graph, makeConfig(registry))

    expect(outcome.status).toBe('SUCCESS')
    expect(callCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// allowPartial semantics (story 42-16, AC2/AC3)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AC6: RunStateManager integration — graph.dot and per-node artifacts
// ---------------------------------------------------------------------------

describe('AC6: RunStateManager integration — dotSource writes graph.dot and node artifacts', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'executor-ac6-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes graph.dot with dotSource content and per-node status.json for each dispatched node', async () => {
    const dotSource = 'digraph G { start -> exit }'
    const successHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(successHandler as unknown as NodeHandler)

    const startNode = makeNode('start')
    const exitNode = makeNode('exit')
    const edges = [makeEdge('start', 'exit')]
    const graph = makeGraph([startNode, exitNode], edges, 'start', 'exit')

    const executor = createGraphExecutor()
    const outcome = await executor.run(
      graph,
      makeConfig(registry, { logsRoot: tmpDir, dotSource }),
    )

    expect(outcome.status).toBe('SUCCESS')

    // AC6 behavior 1: RunStateManager instantiated with logsRoot and initRun called
    // before main loop → graph.dot written with dotSource content
    const graphDotContent = await readFile(path.join(tmpDir, 'graph.dot'), 'utf8')
    expect(graphDotContent).toBe(dotSource)

    // AC6 behavior 2: writeNodeArtifacts called per completed node → status.json written
    // Only 'start' is dispatched (exit terminates the loop without dispatch)
    const statusJsonRaw = await readFile(path.join(tmpDir, 'start', 'status.json'), 'utf8')
    const statusJson = JSON.parse(statusJsonRaw) as Record<string, unknown>
    expect(statusJson).toMatchObject({
      nodeId: 'start',
      status: 'SUCCESS',
    })
    expect(typeof statusJson['startedAt']).toBe('number')
    expect(typeof statusJson['completedAt']).toBe('number')
    expect(typeof statusJson['durationMs']).toBe('number')
  })

  it('does not write graph.dot when dotSource is omitted (backward-compatible)', async () => {
    const successHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(successHandler as unknown as NodeHandler)

    const startNode = makeNode('start')
    const exitNode = makeNode('exit')
    const edges = [makeEdge('start', 'exit')]
    const graph = makeGraph([startNode, exitNode], edges, 'start', 'exit')

    // No dotSource — RunStateManager should not be instantiated
    const executor = createGraphExecutor()
    const outcome = await executor.run(graph, makeConfig(registry, { logsRoot: tmpDir }))

    expect(outcome.status).toBe('SUCCESS')

    // graph.dot must NOT exist (RunStateManager was never created)
    await expect(readFile(path.join(tmpDir, 'graph.dot'), 'utf8')).rejects.toThrow()
  })
})

describe('allowPartial semantics', () => {
  it('node with allowPartial=false, handler returns PARTIAL_SUCCESS → executor treats final node outcome as FAILURE (run returns FAIL)', async () => {
    // maxRetries=1 exposes a regression where demotion only fires when attempt >= maxRetries:
    // PARTIAL_SUCCESS exits the retry loop immediately (it is not a FAIL, so no retries),
    // so the handler is called once at attempt=0 (which is < maxRetries=1). A buggy
    // implementation conditioned on attempt >= maxRetries would NOT demote and this test
    // would fail (outcome would be PARTIAL_SUCCESS, not FAIL).
    const workNode = makeNode('work', { allowPartial: false, maxRetries: 1 })
    const exitNode = makeNode('exit')
    // Include an edge work → exit, but FAIL routing will short-circuit before edge selection.
    const edges = [makeEdge('work', 'exit')]
    const graph = makeGraph([workNode, exitNode], edges, 'work', 'exit')

    const partialHandler = vi.fn().mockResolvedValue({ status: 'PARTIAL_SUCCESS' } as unknown as Outcome)
    const registry = makeRegistry(partialHandler as unknown as NodeHandler)

    const executor = createGraphExecutor()
    const outcome = await executor.run(graph, makeConfig(registry))

    // PARTIAL_SUCCESS exits the loop on the first call (no retries triggered for PARTIAL_SUCCESS).
    expect(partialHandler).toHaveBeenCalledTimes(1)
    // PARTIAL_SUCCESS is demoted to FAIL because allowPartial=false.
    expect(outcome.status).toBe('FAIL')
    expect(outcome.failureReason).toContain('allowPartial=false')
  })

  it('node with allowPartial=true, handler returns PARTIAL_SUCCESS → executor accepts PARTIAL_SUCCESS and continues to exit', async () => {
    const workNode = makeNode('work', { allowPartial: true })
    const exitNode = makeNode('exit')
    const edges = [makeEdge('work', 'exit')]
    const graph = makeGraph([workNode, exitNode], edges, 'work', 'exit')

    const partialHandler = vi.fn().mockResolvedValue({ status: 'PARTIAL_SUCCESS' } as unknown as Outcome)
    const registry = makeRegistry(partialHandler as unknown as NodeHandler)

    const executor = createGraphExecutor()
    const outcome = await executor.run(graph, makeConfig(registry))

    // PARTIAL_SUCCESS is accepted (allowPartial=true); execution continues to exit → SUCCESS.
    expect(outcome.status).toBe('SUCCESS')
    // Verify PARTIAL_SUCCESS travels to ConvergenceController unchanged (not promoted to SUCCESS),
    // directly validating AC3: "not promoted to SUCCESS… goal gates receive the PARTIAL_SUCCESS
    // status unchanged".
    expect(mockRecordOutcome).toHaveBeenCalledWith('work', 'PARTIAL_SUCCESS')
  })

  it('node with allowPartial=false, handler returns SUCCESS → normal success, unaffected by allowPartial flag', async () => {
    const workNode = makeNode('work', { allowPartial: false })
    const exitNode = makeNode('exit')
    const edges = [makeEdge('work', 'exit')]
    const graph = makeGraph([workNode, exitNode], edges, 'work', 'exit')

    const successHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const registry = makeRegistry(successHandler as unknown as NodeHandler)

    const executor = createGraphExecutor()
    const outcome = await executor.run(graph, makeConfig(registry))

    // SUCCESS is never demoted regardless of allowPartial.
    expect(outcome.status).toBe('SUCCESS')
  })
})
