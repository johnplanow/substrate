/**
 * Executor-level integration tests for scenario-primary quality mode (story 46-6).
 *
 * AC2: scenario-primary + score 0.9 + NEEDS_MAJOR_REWORK → executor returns SUCCESS and
 *      graph:goal-gate-checked is emitted with satisfied:true, score:0.9
 * AC3: scenario-primary + score 0.6 + SHIP_IT → executor returns FAIL and
 *      graph:goal-gate-checked is emitted with satisfied:false, score:0.6
 *
 * These tests exercise the full executor exit-node path, verifying that in
 * scenario-primary mode the satisfaction score (not code review verdict) is the
 * authoritative signal for goal gate evaluation.
 *
 * The review feedback (NEEDS_MINOR_FIXES) identified missing executor-level coverage
 * for AC2 and AC3 — this file provides that coverage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGraphExecutor } from '../../graph/executor.js'
import type { Graph, GraphNode, GraphEdge, Outcome as GraphOutcome } from '../../graph/types.js'
import { makeTmpDir, cleanDir, makeEventSpy } from './helpers.js'

// ---------------------------------------------------------------------------
// Mini-graph helpers — mirrors pattern in convergence-validation.test.ts
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

function makeEdge(fromNode: string, toNode: string): GraphEdge {
  return {
    fromNode,
    toNode,
    label: '',
    condition: '',
    weight: 0,
    fidelity: '',
    threadId: '',
    loopRestart: false,
  }
}

function makeMiniGraph(
  nodeList: GraphNode[],
  edgeList: GraphEdge[],
  startNodeId: string,
  exitNodeId: string,
): Graph {
  const nodeMap = new Map(nodeList.map((n) => [n.id, n]))
  return {
    id: 'mini-test',
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

function makeRegistry(handlerMap: Record<string, ReturnType<typeof vi.fn>>) {
  return {
    register: vi.fn(),
    registerShape: vi.fn(),
    setDefault: vi.fn(),
    resolve: vi.fn().mockImplementation((node: GraphNode) => {
      const handler = handlerMap[node.id]
      if (!handler) throw new Error(`No handler for node "${node.id}"`)
      return handler
    }),
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let logsRoot: string

beforeEach(async () => {
  logsRoot = await makeTmpDir()
  vi.clearAllMocks()
})

afterEach(async () => {
  await cleanDir(logsRoot)
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Shared graph builder for AC2/AC3 tests
//
// Graph topology:
//   start → exit          (traversal path)
//   goalGateNode          (in graph.nodes with goalGate=true, NOT in traversal path)
//
// The start handler writes satisfaction_score and factory.codeReviewVerdict to
// context via contextUpdates. When execution reaches the exit node, the executor
// evaluates the goal gate using satisfaction_score (in scenario-primary mode).
// ---------------------------------------------------------------------------

function makeScenarioPrimaryGraph(params: {
  satisfactionScore: number
  codeReviewVerdict: string
}) {
  const goalGateNode = makeNode('goalGateNode', { goalGate: true })
  const startH = vi.fn().mockResolvedValue({
    status: 'SUCCESS',
    contextUpdates: {
      satisfaction_score: params.satisfactionScore,
      'factory.codeReviewVerdict': params.codeReviewVerdict,
    },
  } as GraphOutcome)

  const registry = makeRegistry({ start: startH })
  const graph = makeMiniGraph(
    [makeNode('start'), goalGateNode, makeNode('exit')],
    [makeEdge('start', 'exit')],
    'start',
    'exit',
  )

  return { graph, registry }
}

// ---------------------------------------------------------------------------
// AC2: scenario passes (score 0.9 >= 0.8), code review fails (NEEDS_MAJOR_REWORK)
// → goal gate is satisfied → executor returns SUCCESS
// ---------------------------------------------------------------------------

describe('AC2: scenario-primary — score passes, code review fails → executor gate passes', () => {
  it('AC2a: executor returns SUCCESS when score=0.9 >= 0.8 despite NEEDS_MAJOR_REWORK verdict', async () => {
    const { graph, registry } = makeScenarioPrimaryGraph({
      satisfactionScore: 0.9,
      codeReviewVerdict: 'NEEDS_MAJOR_REWORK',
    })

    const result = await createGraphExecutor().run(graph, {
      runId: 'ac2a-test',
      logsRoot,
      handlerRegistry: registry as never,
      qualityMode: 'scenario-primary',
      satisfactionThreshold: 0.8,
    })

    // gateResult.satisfied===true → executor returns SUCCESS (not FAIL)
    expect(result.status).toBe('SUCCESS')
  })

  it('AC2b: graph:goal-gate-checked emitted with satisfied:true, score:0.9', async () => {
    const { graph, registry } = makeScenarioPrimaryGraph({
      satisfactionScore: 0.9,
      codeReviewVerdict: 'NEEDS_MAJOR_REWORK',
    })
    const { bus, events } = makeEventSpy()

    await createGraphExecutor().run(graph, {
      runId: 'ac2b-test',
      logsRoot,
      handlerRegistry: registry as never,
      eventBus: bus,
      qualityMode: 'scenario-primary',
      satisfactionThreshold: 0.8,
    })

    const gateEvents = events.filter(e => e.event === 'graph:goal-gate-checked')
    expect(gateEvents).toHaveLength(1)
    const payload = gateEvents[0]!.payload as { satisfied: boolean; score: number }
    expect(payload.satisfied).toBe(true)
    expect(payload.score).toBeCloseTo(0.9)
  })

  it('AC2c: no failureReason on SUCCESS — gate was satisfied by score', async () => {
    const { graph, registry } = makeScenarioPrimaryGraph({
      satisfactionScore: 0.9,
      codeReviewVerdict: 'NEEDS_MAJOR_REWORK',
    })

    const result = await createGraphExecutor().run(graph, {
      runId: 'ac2c-test',
      logsRoot,
      handlerRegistry: registry as never,
      qualityMode: 'scenario-primary',
      satisfactionThreshold: 0.8,
    })

    expect(result.status).toBe('SUCCESS')
    expect(result.failureReason).toBeUndefined()
  })

  it('AC2d: advisory event scenario:advisory-computed is emitted alongside gate-checked', async () => {
    const { graph, registry } = makeScenarioPrimaryGraph({
      satisfactionScore: 0.9,
      codeReviewVerdict: 'NEEDS_MAJOR_REWORK',
    })
    const { bus, events } = makeEventSpy()

    await createGraphExecutor().run(graph, {
      runId: 'ac2d-test',
      logsRoot,
      handlerRegistry: registry as never,
      eventBus: bus,
      qualityMode: 'scenario-primary',
      satisfactionThreshold: 0.8,
    })

    // Advisory event must be present (code review verdict was in context)
    const advisoryEvents = events.filter(e => e.event === 'scenario:advisory-computed')
    expect(advisoryEvents).toHaveLength(1)
    const advisory = advisoryEvents[0]!.payload as {
      verdict: string
      codeReviewPassed: boolean
      score: number
      threshold: number
      agreement: string
    }
    expect(advisory.verdict).toBe('NEEDS_MAJOR_REWORK')
    expect(advisory.codeReviewPassed).toBe(false)
    expect(advisory.score).toBeCloseTo(0.9)
    expect(advisory.threshold).toBeCloseTo(0.8)
    expect(advisory.agreement).toBe('DISAGREE')
  })
})

// ---------------------------------------------------------------------------
// AC3: scenario fails (score 0.6 < 0.8), code review passes (SHIP_IT)
// → goal gate is NOT satisfied → executor returns FAIL
// ---------------------------------------------------------------------------

describe('AC3: scenario-primary — score fails, code review passes → executor gate fails', () => {
  it('AC3a: executor returns FAIL when score=0.6 < 0.8 despite SHIP_IT verdict', async () => {
    const { graph, registry } = makeScenarioPrimaryGraph({
      satisfactionScore: 0.6,
      codeReviewVerdict: 'SHIP_IT',
    })

    const result = await createGraphExecutor().run(graph, {
      runId: 'ac3a-test',
      logsRoot,
      handlerRegistry: registry as never,
      qualityMode: 'scenario-primary',
      satisfactionThreshold: 0.8,
    })

    // gateResult.satisfied===false → executor returns FAIL
    expect(result.status).toBe('FAIL')
  })

  it('AC3b: graph:goal-gate-checked emitted with satisfied:false, score:0.6', async () => {
    const { graph, registry } = makeScenarioPrimaryGraph({
      satisfactionScore: 0.6,
      codeReviewVerdict: 'SHIP_IT',
    })
    const { bus, events } = makeEventSpy()

    await createGraphExecutor().run(graph, {
      runId: 'ac3b-test',
      logsRoot,
      handlerRegistry: registry as never,
      eventBus: bus,
      qualityMode: 'scenario-primary',
      satisfactionThreshold: 0.8,
    })

    const gateEvents = events.filter(e => e.event === 'graph:goal-gate-checked')
    expect(gateEvents).toHaveLength(1)
    const payload = gateEvents[0]!.payload as { satisfied: boolean; score: number }
    expect(payload.satisfied).toBe(false)
    expect(payload.score).toBeCloseTo(0.6)
  })

  it('AC3c: failureReason contains "Goal gate" when gate fails on low score', async () => {
    const { graph, registry } = makeScenarioPrimaryGraph({
      satisfactionScore: 0.6,
      codeReviewVerdict: 'SHIP_IT',
    })

    const result = await createGraphExecutor().run(graph, {
      runId: 'ac3c-test',
      logsRoot,
      handlerRegistry: registry as never,
      qualityMode: 'scenario-primary',
      satisfactionThreshold: 0.8,
    })

    expect(result.status).toBe('FAIL')
    expect(result.failureReason).toContain('Goal gate')
  })

  it('AC3d: advisory event scenario:advisory-computed still emitted even when gate fails', async () => {
    const { graph, registry } = makeScenarioPrimaryGraph({
      satisfactionScore: 0.6,
      codeReviewVerdict: 'SHIP_IT',
    })
    const { bus, events } = makeEventSpy()

    await createGraphExecutor().run(graph, {
      runId: 'ac3d-test',
      logsRoot,
      handlerRegistry: registry as never,
      eventBus: bus,
      qualityMode: 'scenario-primary',
      satisfactionThreshold: 0.8,
    })

    // Advisory event emitted before the gate result is acted upon
    const advisoryEvents = events.filter(e => e.event === 'scenario:advisory-computed')
    expect(advisoryEvents).toHaveLength(1)
    const advisory = advisoryEvents[0]!.payload as {
      verdict: string
      codeReviewPassed: boolean
      score: number
      agreement: string
    }
    expect(advisory.verdict).toBe('SHIP_IT')
    expect(advisory.codeReviewPassed).toBe(true)
    expect(advisory.score).toBeCloseTo(0.6)
    expect(advisory.agreement).toBe('DISAGREE')
  })
})
