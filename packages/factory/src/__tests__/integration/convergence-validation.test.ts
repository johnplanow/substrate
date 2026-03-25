/**
 * Convergence loop cross-project validation integration tests.
 * Story 45-10: validates trycycle.dot fixture, two-iteration convergence via
 * conditional routing, pipeline budget cap, plateau detection, and remediation
 * context injection — all using real convergence implementations.
 *
 * AC2 — trycycle.dot fixture parses and validates without errors (5 nodes, correct attributes).
 * AC3 — two-iteration convergence: goal gate fails (score<0.8) then passes (score=1.0).
 * AC4 — pipeline budget cap halts the convergence loop.
 * AC5 — plateau detection halts the loop after constant scores fill the window.
 * AC6 — remediation context is injected before the retry dispatch at the exit goal gate.
 */

// vi.mock is hoisted — must appear before imports that use the mocked module.
// Use importOriginal to preserve exec/execFile/etc. used by @substrate-ai/core.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: vi.fn(),
  }
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawn } from 'child_process'
import { parseGraph } from '../../graph/parser.js'
import { createValidator } from '../../graph/validator.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { getRemediationContext } from '../../convergence/remediation.js'
import { HandlerRegistry } from '../../handlers/registry.js'
import { startHandler } from '../../handlers/start.js'
import { exitHandler } from '../../handlers/exit.js'
import { conditionalHandler } from '../../handlers/conditional.js'
import { createToolHandler } from '../../handlers/tool.js'
import type { Graph, GraphNode, GraphEdge, IGraphContext, Outcome as GraphOutcome } from '../../graph/types.js'
import type { Outcome } from '../../events.js'
import {
  makeTmpDir,
  cleanDir,
  buildScenarioRunResult,
  createMockSpawnProcess,
  readNamedFixtureDot,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSpawn = vi.mocked(spawn)

/**
 * Build a registry for trycycle.dot tests.
 * - Real handlers for start, exit, conditional, tool (validate).
 * - Spy for codergen (shape=box → implement node).
 */
function createTrycycleRegistry(
  implementSpy: ReturnType<typeof vi.fn>,
): HandlerRegistry {
  const registry = new HandlerRegistry()
  registry.register('start', startHandler)
  registry.register('exit', exitHandler)
  registry.register('conditional', conditionalHandler)
  registry.register('tool', createToolHandler())
  registry.register('codergen', implementSpy as never)
  registry.registerShape('Mdiamond', 'start')
  registry.registerShape('Msquare', 'exit')
  registry.registerShape('diamond', 'conditional')
  registry.registerShape('box', 'codergen')
  registry.registerShape('parallelogram', 'tool')
  registry.setDefault(implementSpy as never)
  return registry
}

// ---------------------------------------------------------------------------
// Mini-graph helpers for goal-gate-failure path tests (AC5, AC6)
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

function makeMiniGraph(
  nodeList: GraphNode[],
  edgeList: GraphEdge[],
  startNodeId: string,
  exitNodeId: string,
  graphRetryTarget?: string,
): Graph {
  const nodeMap = new Map(nodeList.map((n) => [n.id, n]))
  return {
    id: 'mini-test',
    goal: '',
    label: '',
    modelStylesheet: '',
    defaultMaxRetries: 0,
    retryTarget: graphRetryTarget ?? '',
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
// Setup / teardown for trycycle.dot-based tests
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
// AC2: trycycle.dot fixture parses and validates
// ---------------------------------------------------------------------------

describe('AC2: trycycle.dot fixture parses and validates', () => {
  it('AC2a: trycycle.dot parses without errors and validates with zero error diagnostics', () => {
    const dotSource = readNamedFixtureDot('trycycle.dot')
    const graph = parseGraph(dotSource)
    const validator = createValidator()
    // Should not throw
    expect(() => validator.validateOrRaise(graph)).not.toThrow()
    const diagnostics = validator.validate(graph)
    const errors = diagnostics.filter((d) => d.severity === 'error')
    expect(errors).toHaveLength(0)
  })

  it('AC2a: trycycle.dot graph has exactly 5 nodes', () => {
    const graph = parseGraph(readNamedFixtureDot('trycycle.dot'))
    expect(graph.nodes.size).toBe(5)
  })

  it('AC2a: trycycle.dot implement node has goalGate=true', () => {
    const graph = parseGraph(readNamedFixtureDot('trycycle.dot'))
    const implementNode = graph.nodes.get('implement')
    expect(implementNode).toBeDefined()
    expect(implementNode!.goalGate).toBe(true)
  })

  it('AC2b: trycycle.dot implement node has retryTarget=implement', () => {
    const graph = parseGraph(readNamedFixtureDot('trycycle.dot'))
    const implementNode = graph.nodes.get('implement')
    expect(implementNode).toBeDefined()
    expect(implementNode!.retryTarget).toBe('implement')
  })

  it('AC2a: trycycle.dot graph-level retryTarget attribute is "implement"', () => {
    const graph = parseGraph(readNamedFixtureDot('trycycle.dot'))
    expect(graph.retryTarget).toBe('implement')
  })
})

// ---------------------------------------------------------------------------
// AC3: Two-iteration convergence via conditional routing
// ---------------------------------------------------------------------------

describe('AC3: two-iteration convergence via conditional routing', () => {
  it('AC3a: executor returns SUCCESS after two iterations (score 0.667 then 1.0)', async () => {
    const result1 = buildScenarioRunResult(2, 3)
    const result2 = buildScenarioRunResult(3, 3)
    mockSpawn
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result1), exitCode: 0 }),
      )
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result2), exitCode: 0 }),
      )

    const graph = parseGraph(readNamedFixtureDot('trycycle.dot'))
    const implementSpy = vi.fn().mockResolvedValue({ status: 'SUCCESS' } as GraphOutcome)
    const registry = createTrycycleRegistry(implementSpy)

    const result = await createGraphExecutor().run(graph, {
      runId: 'test-ac3a',
      logsRoot,
      handlerRegistry: registry,
      plateauWindow: 3,
      plateauThreshold: 0.05,
    })

    expect(result.status).toBe('SUCCESS')
  })

  it('AC3b: validate (tool) handler invoked exactly twice across both iterations', async () => {
    const result1 = buildScenarioRunResult(2, 3)
    const result2 = buildScenarioRunResult(3, 3)
    mockSpawn
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result1), exitCode: 0 }),
      )
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result2), exitCode: 0 }),
      )

    const graph = parseGraph(readNamedFixtureDot('trycycle.dot'))
    const implementSpy = vi.fn().mockResolvedValue({ status: 'SUCCESS' } as GraphOutcome)
    const registry = createTrycycleRegistry(implementSpy)

    await createGraphExecutor().run(graph, {
      runId: 'test-ac3b',
      logsRoot,
      handlerRegistry: registry,
      plateauWindow: 3,
      plateauThreshold: 0.05,
    })

    // spawn is called once per validate invocation
    expect(mockSpawn).toHaveBeenCalledTimes(2)
  })

  it('AC3c: implement (goal_gate) handler dispatched exactly twice', async () => {
    const result1 = buildScenarioRunResult(2, 3)
    const result2 = buildScenarioRunResult(3, 3)
    mockSpawn
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result1), exitCode: 0 }),
      )
      .mockImplementationOnce(() =>
        createMockSpawnProcess({ stdout: JSON.stringify(result2), exitCode: 0 }),
      )

    const graph = parseGraph(readNamedFixtureDot('trycycle.dot'))
    const implementSpy = vi.fn().mockResolvedValue({ status: 'SUCCESS' } as GraphOutcome)
    const registry = createTrycycleRegistry(implementSpy)

    await createGraphExecutor().run(graph, {
      runId: 'test-ac3c',
      logsRoot,
      handlerRegistry: registry,
      plateauWindow: 3,
      plateauThreshold: 0.05,
    })

    // implement is dispatched once initially and once as retry target (via conditional routing)
    expect(implementSpy).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// AC4: Pipeline budget cap halts convergence loop
// ---------------------------------------------------------------------------

describe('AC4: pipeline budget cap halts convergence loop', () => {
  it('AC4a: budget cap halts when accumulated cost exceeds pipelineBudgetCapUsd', async () => {
    // validate always returns score=0 so conditional routes back to implement
    const result0 = buildScenarioRunResult(0, 3)
    mockSpawn.mockImplementation(() =>
      createMockSpawnProcess({ stdout: JSON.stringify(result0), exitCode: 0 }),
    )

    const graph = parseGraph(readNamedFixtureDot('trycycle.dot'))
    // implement returns SUCCESS with $0.04 per-dispatch cost
    const implementSpy = vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      contextUpdates: { 'factory.lastNodeCostUsd': '0.04' },
    } as GraphOutcome)
    const registry = createTrycycleRegistry(implementSpy)

    const result = await createGraphExecutor().run(graph, {
      runId: 'test-ac4a',
      logsRoot,
      handlerRegistry: registry,
      pipelineBudgetCapUsd: 0.05,
    })

    expect(result.status).toBe('FAIL')
    expect(result.failureReason).toContain('Pipeline budget exceeded')
  })

  it('AC4b: implement handler called at most twice before budget halts', async () => {
    const result0 = buildScenarioRunResult(0, 3)
    mockSpawn.mockImplementation(() =>
      createMockSpawnProcess({ stdout: JSON.stringify(result0), exitCode: 0 }),
    )

    const graph = parseGraph(readNamedFixtureDot('trycycle.dot'))
    const implementSpy = vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      contextUpdates: { 'factory.lastNodeCostUsd': '0.04' },
    } as GraphOutcome)
    const registry = createTrycycleRegistry(implementSpy)

    await createGraphExecutor().run(graph, {
      runId: 'test-ac4b',
      logsRoot,
      handlerRegistry: registry,
      pipelineBudgetCapUsd: 0.05,
    })

    // Accumulated cost exceeds $0.05 after second implement dispatch ($0.08 > $0.05),
    // so budget check fires before the third dispatch. implement called ≤ 2 times.
    expect(implementSpy.mock.calls.length).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// AC5: Plateau detection halts loop when scores stop improving
//
// These tests use a custom mini-graph with a separate node named 'goalGate'
// (goalGate=true) that is never dispatched. Since goalGate is never visited,
// the goal-gate check always fails, and the convergence retry path fires on
// each iteration — the only path where plateau detection runs.
// ---------------------------------------------------------------------------

describe('AC5: plateau detection via goal-gate failure path (mini-graph)', () => {
  it('AC5a: executor returns FAIL with plateau message after window fills with identical scores', async () => {
    // Graph: start → exit directly; a separate 'goalGate' node has goalGate=true but is NOT in
    // the traversal path (never dispatched). retryTarget='implement' on graph.
    // At exit each iteration: goalGate is unsatisfied (never dispatched, outcome=undefined).
    // The executor routes to implement (retry target) → exit → ... repeat.
    // convergence.satisfactionScore defaults to 0.0 each iteration (never set).
    // plateauWindow=3, plateauThreshold=0.5 → plateau fires after 3 iterations with [0,0,0].
    //
    // Trace:
    //   iter1: start→exit: goalGate unsatisfied → record 0.0 → [0.0], not full → retry=implement
    //   iter2: implement→exit: goalGate unsatisfied → record 0.0 → [0.0, 0.0], not full → retry
    //   iter3: implement→exit: goalGate unsatisfied → record 0.0 → [0.0, 0.0, 0.0], window full → FAIL plateau

    const goalGateNode = makeNode('goalGate', { goalGate: true })
    const startH = vi.fn().mockResolvedValue({ status: 'SUCCESS' } as Outcome)
    const implementH = vi.fn().mockResolvedValue({ status: 'SUCCESS' } as Outcome)

    const registry = makeRegistry({ start: startH, implement: implementH })

    const graph = makeMiniGraph(
      [makeNode('start'), goalGateNode, makeNode('implement'), makeNode('exit')],
      [
        makeEdge('start', 'exit'),
        makeEdge('implement', 'exit'),
      ],
      'start',
      'exit',
      'implement', // graph.retryTarget
    )

    const result = await createGraphExecutor().run(graph, {
      runId: 'test-ac5a',
      logsRoot,
      handlerRegistry: registry as never,
      plateauWindow: 3,
      plateauThreshold: 0.5,
    })

    expect(result.status).toBe('FAIL')
    expect(result.failureReason).toContain('Convergence plateau detected')
  })

  it('AC5b: plateau failure reason includes score history', async () => {
    const goalGateNode = makeNode('goalGate', { goalGate: true })
    const startH = vi.fn().mockResolvedValue({ status: 'SUCCESS' } as Outcome)
    const implementH = vi.fn().mockResolvedValue({ status: 'SUCCESS' } as Outcome)

    const registry = makeRegistry({ start: startH, implement: implementH })

    const graph = makeMiniGraph(
      [makeNode('start'), goalGateNode, makeNode('implement'), makeNode('exit')],
      [
        makeEdge('start', 'exit'),
        makeEdge('implement', 'exit'),
      ],
      'start',
      'exit',
      'implement',
    )

    const result = await createGraphExecutor().run(graph, {
      runId: 'test-ac5b',
      logsRoot,
      handlerRegistry: registry as never,
      plateauWindow: 3,
      plateauThreshold: 0.5,
    })

    // failure message format: "scores plateaued at [X, Y, Z]"
    // convergence.satisfactionScore defaults to 0.0 → scores are [0, 0, 0]
    expect(result.failureReason).toContain('iteration(s)')
    // The failure reason includes the bracketed score array
    expect(result.failureReason).toMatch(/\[.*\]/)
  })

  it('AC5c: plateau does NOT fire before window is filled (window=4, only 3 iterations)', async () => {
    // plateauWindow=4 → need 4 iterations to fill window. We stop after 3 via budget cap.
    // implement costs $0.04 per call; cap=$0.09 → budget exceeded after 3rd dispatch
    // (accumulated: $0.04 after iter1, $0.08 after iter2, $0.12 > $0.09 check fires after iter3 cost)
    // Wait: budget check is BEFORE dispatch. accumulated=$0.08 > $0.09? NO. dispatch iter3 cost=$0.04.
    // accumulated=$0.12. Budget check BEFORE iter4 dispatch: $0.12 > $0.09? YES → FAIL 'budget exceeded'.
    // So 3 goal-gate failures occur, window=[0.0,0.0,0.0] (3 entries < window=4), no plateau.

    const goalGateNode = makeNode('goalGate', { goalGate: true })
    const startH = vi.fn().mockResolvedValue({ status: 'SUCCESS' } as Outcome)
    const implementH = vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      contextUpdates: { 'factory.lastNodeCostUsd': '0.04' },
    } as Outcome)

    const registry = makeRegistry({ start: startH, implement: implementH })

    const graph = makeMiniGraph(
      [makeNode('start'), goalGateNode, makeNode('implement'), makeNode('exit')],
      [
        makeEdge('start', 'exit'),
        makeEdge('implement', 'exit'),
      ],
      'start',
      'exit',
      'implement',
    )

    const result = await createGraphExecutor().run(graph, {
      runId: 'test-ac5c',
      logsRoot,
      handlerRegistry: registry as never,
      plateauWindow: 4,
      plateauThreshold: 0.5,
      pipelineBudgetCapUsd: 0.09,
    })

    // Should fail due to budget exceeded, NOT plateau
    expect(result.status).toBe('FAIL')
    expect(result.failureReason).not.toContain('plateau')
    expect(result.failureReason).not.toContain('Plateau')
  })
})

// ---------------------------------------------------------------------------
// AC6: Remediation context injected before retry dispatch
//
// Uses a mini-graph where the goal-gate failure path fires at the exit node,
// injects remediation context, then routes to 'implement' as the retry target.
// The implement handler captures the context on its second invocation.
// ---------------------------------------------------------------------------

describe('AC6: remediation context injected on goal-gate retry dispatch', () => {
  it('AC6a: getRemediationContext returns non-null with iterationCount=1 on retry dispatch', async () => {
    // Graph: start → exit directly. implement[goalGate=true] is NOT in the start→exit path.
    // graph.retryTarget='implement'. implement → exit.
    //
    // Trace:
    //   start → exit: goal gate check → implement unsatisfied (never dispatched) → iter=1
    //                 → inject remediation context → route to implement (first dispatch)
    //   implement → exit: goal gate check → implement = SUCCESS → passes → return SUCCESS
    //
    // implement is dispatched ONCE (as the retry target after goal gate fails).
    // The remediation context is injected into the graph context BEFORE implement is dispatched.

    const implementGoalGate = makeNode('implement', { goalGate: true })

    let capturedContextOnRetry: IGraphContext | undefined

    const implementH = vi.fn().mockImplementation(async (_node: GraphNode, context: IGraphContext) => {
      // Capture context on the first (and only) dispatch — this is the retry dispatch
      capturedContextOnRetry = context
      return { status: 'SUCCESS' } as Outcome
    })

    const startH = vi.fn().mockResolvedValue({ status: 'SUCCESS' } as Outcome)

    const registry = makeRegistry({ start: startH, implement: implementH })

    const graph = makeMiniGraph(
      [makeNode('start'), implementGoalGate, makeNode('exit')],
      [
        makeEdge('start', 'exit'),
        makeEdge('implement', 'exit'),
      ],
      'start',
      'exit',
      'implement', // graph.retryTarget — routes to implement on goal gate failure
    )

    const result = await createGraphExecutor().run(graph, {
      runId: 'test-ac6a',
      logsRoot,
      handlerRegistry: registry as never,
    })

    // Graph converges to SUCCESS: start→exit (goal gate fails) → implement→exit (passes)
    expect(result.status).toBe('SUCCESS')

    // implement was dispatched exactly once (as retry target after goal gate failure)
    expect(implementH).toHaveBeenCalledTimes(1)

    // Remediation context was injected before the implement retry dispatch
    expect(capturedContextOnRetry).toBeDefined()
    const remediation = getRemediationContext(capturedContextOnRetry!)
    expect(remediation).toBeDefined()
    expect(remediation!.iterationCount).toBe(1)
    expect(remediation!.previousFailureReason).toBeTruthy()
    expect(remediation!.previousFailureReason.length).toBeGreaterThan(0)
  })

  it('AC6b: remediation previousFailureReason mentions the failing goal gate node id', async () => {
    const implementGoalGate = makeNode('implement', { goalGate: true })

    let capturedContextOnRetry: IGraphContext | undefined

    const implementH = vi.fn().mockImplementation(async (_node: GraphNode, context: IGraphContext) => {
      capturedContextOnRetry = context
      return { status: 'SUCCESS' } as Outcome
    })

    const startH = vi.fn().mockResolvedValue({ status: 'SUCCESS' } as Outcome)

    const registry = makeRegistry({ start: startH, implement: implementH })

    const graph = makeMiniGraph(
      [makeNode('start'), implementGoalGate, makeNode('exit')],
      [
        makeEdge('start', 'exit'),
        makeEdge('implement', 'exit'),
      ],
      'start',
      'exit',
      'implement',
    )

    await createGraphExecutor().run(graph, {
      runId: 'test-ac6b',
      logsRoot,
      handlerRegistry: registry as never,
    })

    expect(capturedContextOnRetry).toBeDefined()
    const remediation = getRemediationContext(capturedContextOnRetry!)
    expect(remediation).toBeDefined()
    // The previousFailureReason should contain the failing goal gate node id ('implement')
    expect(remediation!.previousFailureReason).toContain('implement')
  })
})
