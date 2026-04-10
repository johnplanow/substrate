/**
 * Convergence controller integration tests for the graph executor.
 * Story 45-8: tests that all convergence components are wired into the
 * execution loop (goal gate resolution, retry routing, budget enforcement,
 * plateau detection, and remediation context injection).
 *
 * DO NOT modify executor.test.ts — this file is the focused integration
 * test for the convergence loop wiring. The existing executor.test.ts
 * mocks out the convergence module entirely; these tests use real implementations.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Graph, GraphNode, GraphEdge, IGraphContext } from '../types.js'
import type { IHandlerRegistry } from '../../handlers/types.js'
import type { GraphExecutorConfig } from '../executor.js'
import type { FactoryEvents } from '../../events.js'
import type { TypedEventBus } from '@substrate-ai/core'
import { getRemediationContext } from '../../convergence/remediation.js'
import { createGraphExecutor } from '../executor.js'

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
  backend: '',
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

interface GraphOpts {
  retryTarget?: string
  fallbackRetryTarget?: string
}

/**
 * Build a minimal Graph stub conforming to the Graph interface.
 * startNodeId/exitNodeId designate which nodes play those roles.
 * opts.retryTarget sets the graph-level retry target.
 */
function makeGraph(
  nodeList: GraphNode[],
  edgeList: GraphEdge[],
  startNodeId: string,
  exitNodeId: string,
  opts?: GraphOpts
): Graph {
  const nodeMap = new Map(nodeList.map((n) => [n.id, n]))
  return {
    id: '',
    goal: '',
    label: '',
    modelStylesheet: '',
    defaultMaxRetries: 0,
    retryTarget: opts?.retryTarget ?? '',
    fallbackRetryTarget: opts?.fallbackRetryTarget ?? '',
    defaultFidelity: '',
    nodes: nodeMap,
    edges: edgeList,
    outgoingEdges: (nodeId: string) => edgeList.filter((e) => e.fromNode === nodeId),
    startNode: () => nodeMap.get(startNodeId)!,
    exitNode: () => nodeMap.get(exitNodeId)!,
  }
}

/** Build an IHandlerRegistry that dispatches to per-node handler mocks by node id. */
function makeRegistry(handlerMap: Record<string, ReturnType<typeof vi.fn>>): IHandlerRegistry {
  return {
    register: vi.fn(),
    registerShape: vi.fn(),
    setDefault: vi.fn(),
    resolve: vi.fn().mockImplementation((node: GraphNode) => {
      const handler = handlerMap[node.id]
      if (!handler) throw new Error(`No handler registered for node "${node.id}"`)
      return handler
    }),
  }
}

/** Build a minimal GraphExecutorConfig with test defaults. */
function makeConfig(
  registry: IHandlerRegistry,
  overrides?: Partial<GraphExecutorConfig>
): GraphExecutorConfig {
  return {
    runId: 'convergence-test-run',
    logsRoot: '/tmp/convergence-test',
    handlerRegistry: registry,
    ...overrides,
  }
}

/** Build a mock TypedEventBus that records all emitted events by key. */
function makeEventBus(): TypedEventBus<FactoryEvents> & { emitted: Record<string, unknown[]> } {
  const emitted: Record<string, unknown[]> = {}
  return {
    emitted,
    emit: vi.fn().mockImplementation((event: string, payload: unknown) => {
      if (!emitted[event]) emitted[event] = []
      emitted[event].push(payload)
    }),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TypedEventBus<FactoryEvents> & { emitted: Record<string, unknown[]> }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// AC1: Session budget halt takes highest priority
// ---------------------------------------------------------------------------

describe('AC1: Session budget halt takes highest priority', () => {
  it('returns FAIL before dispatching any handler when wallClockCapMs is exceeded', async () => {
    // Spy on Date.now() so we can control elapsed time deterministically.
    // Call #1: SessionBudgetManager constructor records startTime = 0.
    // Call #2+: checkBudget() → getElapsedMs() → Date.now() returns 200ms.
    // With wallClockCapMs=100, elapsedMs=200 > 100 → budget exceeded before first dispatch.
    let nowCallCount = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCallCount++
      return nowCallCount === 1 ? 0 : 200
    })

    const handler = vi.fn()
    const registry = makeRegistry({ start: handler })
    const graph = makeGraph(
      [makeNode('start'), makeNode('exit')],
      [makeEdge('start', 'exit')],
      'start',
      'exit'
    )

    const executor = createGraphExecutor()
    const result = await executor.run(graph, makeConfig(registry, { wallClockCapMs: 100 }))

    expect(result.status).toBe('FAIL')
    expect(result.failureReason).toContain('Session budget exceeded')
    // No handler was dispatched — budget check fires before dispatch
    expect(handler).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC2: Pipeline budget halt takes second priority
// ---------------------------------------------------------------------------

describe('AC2: Pipeline budget halt takes second priority', () => {
  it('accumulates per-node cost and halts the next dispatch when cap is exceeded', async () => {
    // start handler sets 'factory.lastNodeCostUsd': 0.02 → pipelineManager accumulates $0.02.
    // On the next loop iteration, pipelineManager.checkBudget(0.01) → 0.02 > 0.01 → FAIL.
    const startHandler = vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      contextUpdates: { 'factory.lastNodeCostUsd': 0.02 },
    })
    const nextHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })

    const registry = makeRegistry({ start: startHandler, next: nextHandler })
    const graph = makeGraph(
      [makeNode('start'), makeNode('next'), makeNode('exit')],
      [makeEdge('start', 'next'), makeEdge('next', 'exit')],
      'start',
      'exit'
    )

    const executor = createGraphExecutor()
    const result = await executor.run(graph, makeConfig(registry, { pipelineBudgetCapUsd: 0.01 }))

    expect(result.status).toBe('FAIL')
    expect(result.failureReason).toContain('Pipeline budget exceeded')
    // start was dispatched (cost accumulated); next was NOT dispatched (budget halts first)
    expect(startHandler).toHaveBeenCalledTimes(1)
    expect(nextHandler).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC3: Retry target resolved via controller.resolveRetryTarget() at exit node
// ---------------------------------------------------------------------------

describe('AC3: resolveRetryTarget at exit node routes to retry target', () => {
  it('routes to fix→goalGate→exit on second iteration when goalGate was unsatisfied', async () => {
    // goalGate has goalGate=true but is NOT in the initial start→exit path.
    // At exit: goalGate is unsatisfied (never dispatched).
    // resolveRetryTarget(goalGate, graph) returns 'fix' via graph.retryTarget.
    // fix→goalGate→exit: goalGate dispatched successfully → satisfied → SUCCESS.
    const goalGateNode = makeNode('goalGate', { goalGate: true })
    const startHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const fixHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const goalGateHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })

    const registry = makeRegistry({
      start: startHandler,
      fix: fixHandler,
      goalGate: goalGateHandler,
    })

    const graph = makeGraph(
      [makeNode('start'), goalGateNode, makeNode('fix'), makeNode('exit')],
      [makeEdge('start', 'exit'), makeEdge('fix', 'goalGate'), makeEdge('goalGate', 'exit')],
      'start',
      'exit',
      { retryTarget: 'fix' }
    )

    const executor = createGraphExecutor()
    const result = await executor.run(graph, makeConfig(registry))

    expect(result.status).toBe('SUCCESS')
    expect(startHandler).toHaveBeenCalledTimes(1)
    expect(fixHandler).toHaveBeenCalledTimes(1)
    expect(goalGateHandler).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// AC4: No retry target resolves to FAIL return
// ---------------------------------------------------------------------------

describe('AC4: no retry target resolves to FAIL', () => {
  it('returns FAIL with "Goal gate failed: no retry target" when no retryTarget is set', async () => {
    // goalGate has goalGate=true but no retryTarget exists at any level.
    // resolveRetryTarget returns null → FAIL immediately.
    const goalGateNode = makeNode('goalGate', { goalGate: true })
    const startHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })

    const registry = makeRegistry({ start: startHandler })

    const graph = makeGraph(
      [makeNode('start'), goalGateNode, makeNode('exit')],
      [makeEdge('start', 'exit')],
      'start',
      'exit'
      // No retryTarget at any level
    )

    const executor = createGraphExecutor()
    const result = await executor.run(graph, makeConfig(registry))

    expect(result.status).toBe('FAIL')
    expect(result.failureReason).toBe('Goal gate failed: no retry target')
  })
})

// ---------------------------------------------------------------------------
// AC5: Plateau detection halts convergence loop with FAIL
// ---------------------------------------------------------------------------

describe('AC5: Plateau detection halts convergence loop', () => {
  it('returns FAIL with plateau message after window fills with identical scores', async () => {
    // goalGate is in graph (goalGate=true) but NOT in any execution path.
    // satisfactionScore defaults to 0.0 (never set in context).
    // plateauWindow=2, plateauThreshold=0.5 → plateau fires after 2 retries with score=0.0.
    //
    // Trace:
    //   start→exit: goalGate unsatisfied → iter=1 → record(1, 0.0) → [0.0] → no plateau → route to fix
    //   fix→exit:   goalGate still unsatisfied → iter=2 → record(2, 0.0) → [0.0, 0.0] → plateau! → FAIL
    const goalGateNode = makeNode('goalGate', { goalGate: true })
    const startHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const fixHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })

    const registry = makeRegistry({ start: startHandler, fix: fixHandler })

    const graph = makeGraph(
      [makeNode('start'), goalGateNode, makeNode('fix'), makeNode('exit')],
      [makeEdge('start', 'exit'), makeEdge('fix', 'exit')],
      'start',
      'exit',
      { retryTarget: 'fix' }
    )

    const executor = createGraphExecutor()
    const result = await executor.run(
      graph,
      makeConfig(registry, {
        plateauWindow: 2,
        plateauThreshold: 0.5,
      })
    )

    expect(result.status).toBe('FAIL')
    expect(result.failureReason).toContain('Convergence plateau detected')
    expect(result.failureReason).toContain('2 iteration(s)')
    // fix handler was called once (after first retry), then plateau fired on second retry
    expect(fixHandler).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// AC6: Remediation context injected into IGraphContext before retry dispatch
// ---------------------------------------------------------------------------

describe('AC6: Remediation context injected before retry dispatch', () => {
  it('injects RemediationContext with correct iterationCount and previousFailureReason', async () => {
    // fix handler reads the remediation context and stores it for assertion.
    let capturedRemediation: ReturnType<typeof getRemediationContext> | undefined

    const goalGateNode = makeNode('goalGate', { goalGate: true })
    const startHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const goalGateHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const fixHandler = vi.fn().mockImplementation(async (_node: GraphNode, ctx: IGraphContext) => {
      capturedRemediation = getRemediationContext(ctx)
      return { status: 'SUCCESS' }
    })

    const registry = makeRegistry({
      start: startHandler,
      fix: fixHandler,
      goalGate: goalGateHandler,
    })

    const graph = makeGraph(
      [makeNode('start'), goalGateNode, makeNode('fix'), makeNode('exit')],
      [makeEdge('start', 'exit'), makeEdge('fix', 'goalGate'), makeEdge('goalGate', 'exit')],
      'start',
      'exit',
      { retryTarget: 'fix' }
    )

    const executor = createGraphExecutor()
    const result = await executor.run(graph, makeConfig(registry))

    // Converges to SUCCESS on second iteration (fix→goalGate→exit)
    expect(result.status).toBe('SUCCESS')

    // Remediation context was injected before fix ran
    expect(capturedRemediation).toBeDefined()
    expect(capturedRemediation!.iterationCount).toBe(1)
    // previousFailureReason contains the failing gate node id
    expect(capturedRemediation!.previousFailureReason).toContain('goalGate')
  })
})

// ---------------------------------------------------------------------------
// AC7: Convergence loop exits SUCCESS when goal gates are satisfied
// ---------------------------------------------------------------------------

describe('AC7: Convergence loop exits SUCCESS on convergence', () => {
  it('returns SUCCESS after goal gate is satisfied on second iteration', async () => {
    // Identical to AC3: verifies that the executor correctly exits with SUCCESS
    // rather than continuing to retry after the goal gate is satisfied.
    const goalGateNode = makeNode('goalGate', { goalGate: true })
    const startHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const fixHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const goalGateHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })

    const registry = makeRegistry({
      start: startHandler,
      fix: fixHandler,
      goalGate: goalGateHandler,
    })

    const graph = makeGraph(
      [makeNode('start'), goalGateNode, makeNode('fix'), makeNode('exit')],
      [makeEdge('start', 'exit'), makeEdge('fix', 'goalGate'), makeEdge('goalGate', 'exit')],
      'start',
      'exit',
      { retryTarget: 'fix' }
    )

    const executor = createGraphExecutor()
    const result = await executor.run(graph, makeConfig(registry))

    // Iteration 1: start → exit (goalGate unsatisfied → retry to fix)
    // Iteration 2: fix → goalGate (SUCCESS) → exit (goalGate satisfied → SUCCESS)
    expect(result.status).toBe('SUCCESS')
    expect(startHandler).toHaveBeenCalledTimes(1)
    expect(fixHandler).toHaveBeenCalledTimes(1)
    expect(goalGateHandler).toHaveBeenCalledTimes(1)
  })

  it('does not retry again after SUCCESS on second iteration (no infinite loop)', async () => {
    // Ensures the executor terminates and does not re-enter the convergence loop.
    const goalGateNode = makeNode('goalGate', { goalGate: true })
    const startHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const fixHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const goalGateHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })

    const registry = makeRegistry({
      start: startHandler,
      fix: fixHandler,
      goalGate: goalGateHandler,
    })

    const graph = makeGraph(
      [makeNode('start'), goalGateNode, makeNode('fix'), makeNode('exit')],
      [makeEdge('start', 'exit'), makeEdge('fix', 'goalGate'), makeEdge('goalGate', 'exit')],
      'start',
      'exit',
      { retryTarget: 'fix' }
    )

    const executor = createGraphExecutor()
    const result = await executor.run(graph, makeConfig(registry))

    expect(result.status).toBe('SUCCESS')
    // Each handler called exactly once — no extra iterations
    expect(fixHandler).toHaveBeenCalledTimes(1)
    expect(goalGateHandler).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// BUG 1 regression: satisfaction_score key flows from tool handler to plateau
// ---------------------------------------------------------------------------

describe('Satisfaction score key alignment (BUG 1 regression)', () => {
  it('reads satisfaction_score from context for plateau detection', async () => {
    // Tool handler writes satisfaction_score to context (via contextUpdates).
    // The executor reads satisfaction_score (not convergence.satisfactionScore)
    // for plateau detection. With window=2 and threshold=0.05, two identical
    // scores trigger a plateau. If the key was wrong, score would default to
    // 0.0 and plateau would still fire — but on the *wrong* value. We verify
    // the actual score value appears in the failure message.
    const goalGateNode = makeNode('goalGate', { goalGate: true })

    // toolNode returns SUCCESS with satisfaction_score: 0.42 (mimics tool handler output)
    const startHandler = vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      contextUpdates: { satisfaction_score: 0.42 },
    })
    const fixHandler = vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      contextUpdates: { satisfaction_score: 0.42 },
    })

    const registry = makeRegistry({ start: startHandler, fix: fixHandler })

    const graph = makeGraph(
      [makeNode('start'), goalGateNode, makeNode('fix'), makeNode('exit')],
      [makeEdge('start', 'exit'), makeEdge('fix', 'exit')],
      'start',
      'exit',
      { retryTarget: 'fix' }
    )

    const executor = createGraphExecutor()
    const result = await executor.run(
      graph,
      makeConfig(registry, {
        plateauWindow: 2,
        plateauThreshold: 0.05,
      })
    )

    expect(result.status).toBe('FAIL')
    expect(result.failureReason).toContain('Convergence plateau detected')
    // The actual score (0.42) must appear in the message — proves the executor
    // read the correct context key, not 0.0 (the default when key is missing).
    expect(result.failureReason).toContain('0.42')
  })
})

// ---------------------------------------------------------------------------
// BUG 2 regression: convergence:budget-exhausted event emission
// ---------------------------------------------------------------------------

describe('convergence:budget-exhausted event emission (BUG 2 regression)', () => {
  it('emits convergence:budget-exhausted with level=session when session budget is exceeded', async () => {
    // Mock Date.now so SessionBudgetManager sees elapsed > cap
    let nowCallCount = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCallCount++
      return nowCallCount === 1 ? 0 : 200
    })

    const handler = vi.fn()
    const registry = makeRegistry({ start: handler })
    const eventBus = makeEventBus()
    const graph = makeGraph(
      [makeNode('start'), makeNode('exit')],
      [makeEdge('start', 'exit')],
      'start',
      'exit'
    )

    const executor = createGraphExecutor()
    const result = await executor.run(
      graph,
      makeConfig(registry, {
        wallClockCapMs: 100,
        eventBus,
      })
    )

    expect(result.status).toBe('FAIL')
    // Verify the event was emitted
    const budgetEvents = eventBus.emitted['convergence:budget-exhausted'] ?? []
    expect(budgetEvents).toHaveLength(1)
    expect(budgetEvents[0]).toEqual({
      runId: 'convergence-test-run',
      level: 'session',
      reason: 'wall clock budget exhausted',
    })
  })

  it('emits convergence:budget-exhausted with level=pipeline when pipeline budget is exceeded', async () => {
    // start handler sets cost that exceeds pipeline cap
    const startHandler = vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      contextUpdates: { 'factory.lastNodeCostUsd': 0.02 },
    })
    const nextHandler = vi.fn().mockResolvedValue({ status: 'SUCCESS' })

    const registry = makeRegistry({ start: startHandler, next: nextHandler })
    const eventBus = makeEventBus()
    const graph = makeGraph(
      [makeNode('start'), makeNode('next'), makeNode('exit')],
      [makeEdge('start', 'next'), makeEdge('next', 'exit')],
      'start',
      'exit'
    )

    const executor = createGraphExecutor()
    const result = await executor.run(
      graph,
      makeConfig(registry, {
        pipelineBudgetCapUsd: 0.01,
        eventBus,
      })
    )

    expect(result.status).toBe('FAIL')
    // Verify the event was emitted
    const budgetEvents = eventBus.emitted['convergence:budget-exhausted'] ?? []
    expect(budgetEvents).toHaveLength(1)
    expect(budgetEvents[0]).toEqual({
      runId: 'convergence-test-run',
      level: 'pipeline',
      reason: expect.stringContaining('pipeline budget exhausted'),
    })
  })
})
