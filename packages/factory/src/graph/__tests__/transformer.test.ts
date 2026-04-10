/**
 * Unit tests for `applyStylesheet` (transformer.ts).
 *
 * Covers:
 *  AC1 — shape selector resolves to matching node's LLM properties
 *  AC2 — class rule overrides shape rule at higher specificity
 *  AC3 — multiple classes use source-order tie-breaking
 *  AC4 — nodes with explicit llmModel are not overwritten; empty string nodes are
 *  AC5 — executor stylesheet applied before execution (transformer behaviour)
 *  AC6 — subgraph inherits parent stylesheet (transformer behaviour)
 *  AC7 — subgraph's own stylesheet overrides inherited parent rules (merge logic)
 *
 * Story 50-6.
 */

import { describe, it, expect, vi } from 'vitest'
import { applyStylesheet } from '../transformer.js'
import { parseStylesheet } from '../../stylesheet/parser.js'
import type { Graph, GraphNode, GraphEdge, ParsedStylesheet } from '../types.js'

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest) — needed for the AC5 executor integration test.
// These mocks stub out file I/O and convergence internals so the real executor
// can run in-process without external dependencies.
// ---------------------------------------------------------------------------

vi.mock('../checkpoint.js', () => ({
  CheckpointManager: vi.fn().mockImplementation(() => ({
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(),
    resume: vi.fn(),
  })),
}))

vi.mock('../../convergence/index.js', () => ({
  createConvergenceController: vi.fn().mockImplementation(() => ({
    evaluateGates: vi.fn().mockReturnValue({ satisfied: true, failingNodes: [] }),
    recordOutcome: vi.fn(),
    checkGoalGates: vi.fn().mockReturnValue({ satisfied: true, failedGates: [] }),
    resolveRetryTarget: vi.fn().mockReturnValue(null),
    recordIterationContext: vi.fn(),
    prepareForIteration: vi.fn().mockResolvedValue([]),
    getStoredContexts: vi.fn().mockReturnValue([]),
  })),
  SessionBudgetManager: vi.fn().mockImplementation(() => ({
    checkBudget: vi.fn().mockReturnValue({ allowed: true }),
    getElapsedMs: vi.fn().mockReturnValue(0),
    reset: vi.fn(),
  })),
  PipelineBudgetManager: vi.fn().mockImplementation(() => ({
    checkBudget: vi.fn().mockReturnValue({ allowed: true }),
    addCost: vi.fn(),
    getTotalCost: vi.fn().mockReturnValue(0),
    reset: vi.fn(),
  })),
  createPlateauDetector: vi.fn().mockReturnValue({
    recordScore: vi.fn(),
    isPlateaued: vi.fn().mockReturnValue(false),
    getWindow: vi.fn().mockReturnValue(3),
    getScores: vi.fn().mockReturnValue([]),
  }),
  checkPlateauAndEmit: vi.fn().mockReturnValue({ plateaued: false, scores: [] }),
  buildRemediationContext: vi.fn().mockReturnValue({
    previousFailureReason: '',
    scenarioDiff: '',
    iterationCount: 0,
    satisfactionScoreHistory: [],
    fixScope: '',
  }),
  injectRemediationContext: vi.fn(),
  computeBackoffDelay: vi
    .fn()
    .mockImplementation((attempt: number) => Math.min(1000 * 2 ** attempt, 30000)),
  createDualSignalCoordinator: vi.fn().mockReturnValue({ evaluate: vi.fn() }),
  CONTEXT_KEY_CODE_REVIEW_VERDICT: 'factory.codeReviewVerdict',
}))

// Import the real executor AFTER mocks are declared so the hoisted vi.mock()
// intercepts its transitive dependencies (CheckpointManager, convergence).
import { createGraphExecutor } from '../executor.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal GraphNode with defaults for all required fields. */
function makeNode(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: 'test_node',
    label: 'Test Node',
    shape: 'box',
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
    ...overrides,
  }
}

/** Build a minimal Graph containing the given nodes and modelStylesheet. */
function makeGraph(modelStylesheet: string, nodes: GraphNode[]): Graph {
  const nodeMap = new Map<string, GraphNode>()
  for (const node of nodes) {
    nodeMap.set(node.id, node)
  }
  // Ensure there are start/exit nodes to satisfy potential structural expectations
  if (!nodeMap.has('start')) {
    nodeMap.set('start', makeNode({ id: 'start', shape: 'Mdiamond' }))
  }
  if (!nodeMap.has('exit')) {
    nodeMap.set('exit', makeNode({ id: 'exit', shape: 'Msquare' }))
  }
  const edges: GraphEdge[] = [
    {
      fromNode: 'start',
      toNode: 'exit',
      label: '',
      condition: '',
      weight: 1,
      fidelity: '',
      threadId: '',
      loopRestart: false,
    },
  ]
  return {
    id: 'test_graph',
    goal: '',
    label: '',
    modelStylesheet,
    defaultMaxRetries: 0,
    retryTarget: '',
    fallbackRetryTarget: '',
    defaultFidelity: '',
    nodes: nodeMap,
    edges,
    outgoingEdges(nodeId: string): GraphEdge[] {
      return edges.filter((e) => e.fromNode === nodeId)
    },
    startNode(): GraphNode {
      return nodeMap.get('start')!
    },
    exitNode(): GraphNode {
      return nodeMap.get('exit')!
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyStylesheet', () => {
  // Universal rule applies to all nodes
  it('applies universal rule to all nodes', () => {
    const node1 = makeNode({ id: 'n1', shape: 'box' })
    const node2 = makeNode({ id: 'n2', shape: 'circle' })
    const graph = makeGraph('* { llm_model: x; }', [node1, node2])

    applyStylesheet(graph)

    expect(graph.nodes.get('n1')!.llmModel).toBe('x')
    expect(graph.nodes.get('n2')!.llmModel).toBe('x')
  })

  // AC1 — shape selector resolves to matching node's LLM properties
  it('AC1: shape selector applies to matching-shape node (specificity 1)', () => {
    const node = makeNode({ id: 'n1', shape: 'box' })
    const graph = makeGraph('box { llm_model: claude-sonnet-4-5; }', [node])

    applyStylesheet(graph)

    expect(graph.nodes.get('n1')!.llmModel).toBe('claude-sonnet-4-5')
  })

  it('shape selector does NOT apply to non-matching shape', () => {
    const node = makeNode({ id: 'n1', shape: 'circle' })
    const graph = makeGraph('box { llm_model: claude-sonnet-4-5; }', [node])

    applyStylesheet(graph)

    expect(graph.nodes.get('n1')!.llmModel).toBe('')
  })

  // AC2 — class rule overrides shape rule at higher specificity
  it('AC2: class rule (specificity 2) overrides shape rule (specificity 1) on the same node', () => {
    const node = makeNode({ id: 'n1', shape: 'box', class: 'critical' })
    const graph = makeGraph('box { llm_model: x; } .critical { llm_model: y; }', [node])

    applyStylesheet(graph)

    expect(graph.nodes.get('n1')!.llmModel).toBe('y')
  })

  // AC3 — multiple classes use source-order tie-breaking
  it('AC3: two equal-specificity class rules — later rule in stylesheet wins', () => {
    const node = makeNode({ id: 'n1', shape: 'box', class: 'critical,expensive' })
    const graph = makeGraph('.critical { llm_model: a; } .expensive { llm_model: b; }', [node])

    applyStylesheet(graph)

    expect(graph.nodes.get('n1')!.llmModel).toBe('b')
  })

  // AC4 — node with explicit llmModel (non-empty string) is NOT overwritten
  it('AC4: node with explicit non-empty llmModel is NOT overwritten', () => {
    const node = makeNode({ id: 'n1', shape: 'box', llmModel: 'already-set' })
    const graph = makeGraph('* { llm_model: override-attempt; }', [node])

    applyStylesheet(graph)

    expect(graph.nodes.get('n1')!.llmModel).toBe('already-set')
  })

  // AC4 — node with empty string llmModel IS overwritten
  it('AC4: node with empty string llmModel IS overwritten by stylesheet', () => {
    const node = makeNode({ id: 'n1', shape: 'box', llmModel: '' })
    const graph = makeGraph('* { llm_model: haiku; }', [node])

    applyStylesheet(graph)

    expect(graph.nodes.get('n1')!.llmModel).toBe('haiku')
  })

  // AC4 — applies llmProvider and reasoningEffort as well
  it('applies llmProvider and reasoningEffort from stylesheet rules', () => {
    const node = makeNode({ id: 'n1', shape: 'box' })
    const graph = makeGraph('* { llm_provider: anthropic; reasoning_effort: high; }', [node])

    applyStylesheet(graph)

    expect(graph.nodes.get('n1')!.llmProvider).toBe('anthropic')
    expect(graph.nodes.get('n1')!.reasoningEffort).toBe('high')
  })

  // Empty/absent stylesheet is a no-op
  it('empty modelStylesheet is a no-op (no changes to nodes)', () => {
    const node = makeNode({ id: 'n1', shape: 'box' })
    const graph = makeGraph('', [node])

    applyStylesheet(graph)

    expect(graph.nodes.get('n1')!.llmModel).toBe('')
    expect(graph.nodes.get('n1')!.llmProvider).toBe('')
    expect(graph.nodes.get('n1')!.reasoningEffort).toBe('')
  })

  // No stylesheet at all is a no-op
  it('no inheritedStylesheet and no modelStylesheet is a no-op', () => {
    const node = makeNode({ id: 'n1', shape: 'box' })
    const graph = makeGraph('', [node])

    applyStylesheet(graph, undefined)

    expect(graph.nodes.get('n1')!.llmModel).toBe('')
  })

  // inheritedStylesheet rules apply when graph has no local stylesheet
  it('inheritedStylesheet rules apply when graph has no local model_stylesheet', () => {
    const node = makeNode({ id: 'n1', shape: 'box' })
    const graph = makeGraph('', [node])
    const inherited: ParsedStylesheet = parseStylesheet('* { llm_model: parent-model; }')

    applyStylesheet(graph, inherited)

    expect(graph.nodes.get('n1')!.llmModel).toBe('parent-model')
  })

  // AC7 — local rules win over inherited at equal specificity
  it('AC7: local model_stylesheet rules win over inheritedStylesheet at equal specificity', () => {
    const node = makeNode({ id: 'n1', shape: 'box' })
    const graph = makeGraph('* { llm_model: child-model; }', [node])
    const inherited: ParsedStylesheet = parseStylesheet('* { llm_model: parent-model; }')

    applyStylesheet(graph, inherited)

    // Local rule appears later in effectiveStylesheet → wins at equal specificity (both universal = 0)
    expect(graph.nodes.get('n1')!.llmModel).toBe('child-model')
  })

  // Higher-specificity inherited rules should still be overrideable by local higher-specificity rules
  it('local class rule wins over inherited class rule at equal specificity via source order', () => {
    const node = makeNode({ id: 'n1', shape: 'box', class: 'critical' })
    const graph = makeGraph('.critical { llm_model: local-critical; }', [node])
    const inherited: ParsedStylesheet = parseStylesheet('.critical { llm_model: parent-critical; }')

    applyStylesheet(graph, inherited)

    expect(graph.nodes.get('n1')!.llmModel).toBe('local-critical')
  })

  // Idempotency: calling applyStylesheet twice does not change the result
  it('is idempotent — calling applyStylesheet twice produces the same result', () => {
    const node = makeNode({ id: 'n1', shape: 'box' })
    const graph = makeGraph('* { llm_model: haiku; }', [node])

    applyStylesheet(graph)
    applyStylesheet(graph)

    expect(graph.nodes.get('n1')!.llmModel).toBe('haiku')
  })
})

// ---------------------------------------------------------------------------
// AC5 — Executor integration: applyStylesheet runs before first handler dispatch
// ---------------------------------------------------------------------------

describe('AC5 — executor integration: applyStylesheet called before handler dispatch', () => {
  /**
   * Creates a 3-node graph (start → work → exit) with the given modelStylesheet.
   * The work node has no explicit llmModel so the stylesheet rule can fill it.
   */
  function makeExecutorGraph(modelStylesheet: string): { graph: Graph; workNode: GraphNode } {
    const startNode = makeNode({ id: 'start', shape: 'Mdiamond' })
    const workNode = makeNode({ id: 'work', shape: 'box', llmModel: '' })
    const exitNode = makeNode({ id: 'exit', shape: 'Msquare' })
    const nodeMap = new Map<string, GraphNode>([
      ['start', startNode],
      ['work', workNode],
      ['exit', exitNode],
    ])
    const edges: GraphEdge[] = [
      {
        fromNode: 'start',
        toNode: 'work',
        label: '',
        condition: '',
        weight: 1,
        fidelity: '',
        threadId: '',
        loopRestart: false,
      },
      {
        fromNode: 'work',
        toNode: 'exit',
        label: '',
        condition: '',
        weight: 1,
        fidelity: '',
        threadId: '',
        loopRestart: false,
      },
    ]
    const graph: Graph = {
      id: 'ac5-graph',
      goal: '',
      label: '',
      modelStylesheet,
      defaultMaxRetries: 0,
      retryTarget: '',
      fallbackRetryTarget: '',
      defaultFidelity: '',
      nodes: nodeMap,
      edges,
      outgoingEdges(nodeId: string) {
        return edges.filter((e) => e.fromNode === nodeId)
      },
      startNode() {
        return nodeMap.get('start')!
      },
      exitNode() {
        return nodeMap.get('exit')!
      },
    }
    return { graph, workNode }
  }

  it('AC5: work node handler receives node.llmModel already resolved by applyStylesheet', async () => {
    const capturedLlmModel = { value: '' }

    // Minimal registry: every handler returns SUCCESS; captures llmModel for the work node.
    const registry = {
      resolve(node: GraphNode) {
        return async (n: GraphNode) => {
          if (n.id === 'work') capturedLlmModel.value = n.llmModel
          return { status: 'SUCCESS' as const }
        }
      },
      register: () => {},
      registerShape: () => {},
      setDefault: () => {},
    }

    const { graph } = makeExecutorGraph('* { llm_model: haiku; }')

    const outcome = await createGraphExecutor().run(graph, {
      runId: 'ac5-test',
      logsRoot: '/tmp',
      handlerRegistry: registry,
    })

    // Executor should succeed end-to-end
    expect(outcome.status).toBe('SUCCESS')
    // Handler must have been called with llmModel pre-set by applyStylesheet
    expect(capturedLlmModel.value).toBe('haiku')
  })

  it('AC5: work node with explicit llmModel is not overwritten before handler dispatch', async () => {
    const capturedLlmModel = { value: '' }

    const registry = {
      resolve(node: GraphNode) {
        return async (n: GraphNode) => {
          if (n.id === 'work') capturedLlmModel.value = n.llmModel
          return { status: 'SUCCESS' as const }
        }
      },
      register: () => {},
      registerShape: () => {},
      setDefault: () => {},
    }

    const { graph, workNode } = makeExecutorGraph('* { llm_model: haiku; }')
    // Override work node with an explicit model — applyStylesheet must not overwrite it
    workNode.llmModel = 'explicit-model'

    await createGraphExecutor().run(graph, {
      runId: 'ac5-preserve-test',
      logsRoot: '/tmp',
      handlerRegistry: registry,
    })

    expect(capturedLlmModel.value).toBe('explicit-model')
  })
})
