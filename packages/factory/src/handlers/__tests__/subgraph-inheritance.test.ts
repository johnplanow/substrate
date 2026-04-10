/**
 * Integration tests for stylesheet inheritance through subgraph boundaries.
 *
 * Verifies that the subgraph handler correctly propagates a parent graph's
 * model_stylesheet to the sub-executor via the inheritedStylesheet config field.
 *
 * Story 50-6 (AC6, AC7).
 *
 * Covers:
 *  AC6 — subgraph nodes inherit parent graph's stylesheet
 *  AC7 — subgraph's own stylesheet overrides inherited parent rules
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock is hoisted automatically by Vitest so the mocks are in place
// before any module imports are resolved.
vi.mock('../../graph/parser.js', () => ({
  parseGraph: vi.fn(),
}))
vi.mock('../../graph/executor.js', () => ({
  createGraphExecutor: vi.fn(),
}))
vi.mock('../../graph/validator.js', () => ({
  createValidator: vi.fn(),
}))

import { parseGraph } from '../../graph/parser.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { createValidator } from '../../graph/validator.js'
import { createSubgraphHandler } from '../subgraph.js'
import { createDefaultRegistry } from '../registry.js'
import { GraphContext } from '../../graph/context.js'
import { parseStylesheet } from '../../stylesheet/parser.js'
import { applyStylesheet } from '../../graph/transformer.js'
import type { Graph, GraphNode, GraphEdge } from '../../graph/types.js'
import type { GraphExecutorConfig } from '../../graph/executor.js'

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

/** Build a minimal subgraph node referencing a graph file. */
function makeSubgraphNode(graphFile: string): GraphNode {
  return makeNode({
    id: 'sg-node',
    type: 'subgraph',
    attrs: { graph_file: graphFile },
  })
}

/** Build a minimal parent Graph with optional modelStylesheet. */
function makeParentGraph(modelStylesheet: string): Graph {
  const nodeMap = new Map<string, GraphNode>()
  nodeMap.set('start', makeNode({ id: 'start', shape: 'Mdiamond' }))
  nodeMap.set('exit', makeNode({ id: 'exit', shape: 'Msquare' }))
  nodeMap.set('sg-node', makeSubgraphNode('sub.dot'))
  const edges: GraphEdge[] = [
    {
      fromNode: 'start',
      toNode: 'sg-node',
      label: '',
      condition: '',
      weight: 1,
      fidelity: '',
      threadId: '',
      loopRestart: false,
    },
    {
      fromNode: 'sg-node',
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
    id: 'parent',
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
}

/** Minimal stub graph returned by mocked parseGraph. */
const STUB_SUBGRAPH = {} as Graph

const VALID_DOT = `digraph G { start [shape=Mdiamond]; exit [shape=Msquare]; start -> exit; }`

// Typed mock helpers
const mockParseGraph = vi.mocked(parseGraph)
const mockCreateGraphExecutor = vi.mocked(createGraphExecutor)
const mockCreateValidator = vi.mocked(createValidator)

// ---------------------------------------------------------------------------
// Default mock setup — reset before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()

  // parseGraph: returns stub subgraph by default
  mockParseGraph.mockReturnValue(STUB_SUBGRAPH)

  // createValidator: returns a no-op validator by default
  mockCreateValidator.mockReturnValue({
    validate: vi.fn().mockReturnValue([]),
    validateOrRaise: vi.fn(),
    registerRule: vi.fn(),
  })

  // createGraphExecutor: returns executor that resolves SUCCESS by default
  mockCreateGraphExecutor.mockReturnValue({
    run: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
  })
})

// ---------------------------------------------------------------------------
// AC6 — Subgraph nodes inherit parent graph's stylesheet
// ---------------------------------------------------------------------------

describe('subgraph stylesheet inheritance (AC6)', () => {
  it('AC6: passes parsed parent stylesheet as inheritedStylesheet to sub-executor config', async () => {
    let capturedConfig: GraphExecutorConfig | undefined
    const mockRun = vi.fn().mockImplementation((_subgraph, config: GraphExecutorConfig) => {
      capturedConfig = config
      return Promise.resolve({ status: 'SUCCESS' })
    })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    const parentGraph = makeParentGraph('* { llm_model: parent-model; }')
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const ctx = new GraphContext()
    await handler(makeSubgraphNode('sub.dot'), ctx, parentGraph)

    // The sub-executor should receive an inheritedStylesheet derived from the parent's model_stylesheet
    expect(capturedConfig).toBeDefined()
    const inherited = capturedConfig!.inheritedStylesheet
    expect(inherited).toBeDefined()
    expect(Array.isArray(inherited)).toBe(true)
    expect(inherited!.length).toBeGreaterThan(0)

    // The inherited stylesheet should be equivalent to parseStylesheet of the parent's modelStylesheet
    const expected = parseStylesheet('* { llm_model: parent-model; }')
    expect(inherited).toEqual(expected)
  })

  it('AC6: inherited stylesheet applies to subgraph nodes (transformer integration)', () => {
    // Simulate what the sub-executor would do: run applyStylesheet with inheritedStylesheet
    const subNode = makeNode({ id: 'work', shape: 'box' })
    const subNodeMap = new Map<string, GraphNode>([['work', subNode]])
    const subgraphWithNoStylesheet: Graph = {
      id: 'sub',
      goal: '',
      label: '',
      modelStylesheet: '', // no local stylesheet
      defaultMaxRetries: 0,
      retryTarget: '',
      fallbackRetryTarget: '',
      defaultFidelity: '',
      nodes: subNodeMap,
      edges: [],
      outgoingEdges() {
        return []
      },
      startNode() {
        return subNode
      },
      exitNode() {
        return subNode
      },
    }

    const inheritedStylesheet = parseStylesheet('* { llm_model: parent-model; }')
    applyStylesheet(subgraphWithNoStylesheet, inheritedStylesheet)

    expect(subNode.llmModel).toBe('parent-model')
  })
})

// ---------------------------------------------------------------------------
// AC7 — Subgraph's own stylesheet overrides inherited parent rules
// ---------------------------------------------------------------------------

describe('subgraph own stylesheet overrides parent (AC7)', () => {
  it('AC7: child model_stylesheet rules win over inherited parent rules at equal specificity', () => {
    // Simulate what the sub-executor does: applyStylesheet(subgraph, inheritedStylesheet)
    const subNode = makeNode({ id: 'work', shape: 'box' })
    const subNodeMap = new Map<string, GraphNode>([['work', subNode]])
    const subgraphWithOwnStylesheet: Graph = {
      id: 'sub',
      goal: '',
      label: '',
      modelStylesheet: '* { llm_model: child-model; }', // subgraph has its own rules
      defaultMaxRetries: 0,
      retryTarget: '',
      fallbackRetryTarget: '',
      defaultFidelity: '',
      nodes: subNodeMap,
      edges: [],
      outgoingEdges() {
        return []
      },
      startNode() {
        return subNode
      },
      exitNode() {
        return subNode
      },
    }

    const inheritedStylesheet = parseStylesheet('* { llm_model: parent-model; }')
    applyStylesheet(subgraphWithOwnStylesheet, inheritedStylesheet)

    // Child rules appear after parent rules in effectiveStylesheet → child wins
    expect(subNode.llmModel).toBe('child-model')
  })
})

// ---------------------------------------------------------------------------
// No parent stylesheet — inheritedStylesheet is undefined
// ---------------------------------------------------------------------------

describe('subgraph handler with no parent stylesheet', () => {
  it('passes undefined inheritedStylesheet when parent has no modelStylesheet', async () => {
    let capturedConfig: GraphExecutorConfig | undefined
    const mockRun = vi.fn().mockImplementation((_subgraph, config: GraphExecutorConfig) => {
      capturedConfig = config
      return Promise.resolve({ status: 'SUCCESS' })
    })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    // Parent graph has empty modelStylesheet
    const parentGraph = makeParentGraph('')
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const ctx = new GraphContext()
    await handler(makeSubgraphNode('sub.dot'), ctx, parentGraph)

    // inheritedStylesheet should be undefined (no parent stylesheet)
    expect(capturedConfig).toBeDefined()
    expect(capturedConfig!.inheritedStylesheet).toBeUndefined()
  })

  it('subgraph executes normally (SUCCESS) when parent has no modelStylesheet', async () => {
    const parentGraph = makeParentGraph('')
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const ctx = new GraphContext()
    const result = await handler(makeSubgraphNode('sub.dot'), ctx, parentGraph)

    expect(result.status).toBe('SUCCESS')
  })
})

// ---------------------------------------------------------------------------
// Transformer: applyStylesheet with empty local + non-empty inherited
// ---------------------------------------------------------------------------

describe('applyStylesheet with empty local stylesheet and non-empty inheritedStylesheet', () => {
  it('populates nodes from inherited rules when graph has no local modelStylesheet', () => {
    const node = makeNode({ id: 'n1', shape: 'box' })
    const nodeMap = new Map<string, GraphNode>([['n1', node]])
    const graph: Graph = {
      id: 'sub',
      goal: '',
      label: '',
      modelStylesheet: '',
      defaultMaxRetries: 0,
      retryTarget: '',
      fallbackRetryTarget: '',
      defaultFidelity: '',
      nodes: nodeMap,
      edges: [],
      outgoingEdges() {
        return []
      },
      startNode() {
        return node
      },
      exitNode() {
        return node
      },
    }

    const inherited = parseStylesheet('* { llm_model: inherited-model; llm_provider: openai; }')
    applyStylesheet(graph, inherited)

    expect(node.llmModel).toBe('inherited-model')
    expect(node.llmProvider).toBe('openai')
  })
})
