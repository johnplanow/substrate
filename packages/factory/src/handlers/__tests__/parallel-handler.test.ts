/**
 * Unit tests for the parallel handler (story 50-1, updated by story 50-3).
 *
 * Covers:
 *   AC1 – Concurrent branch execution via IHandlerRegistry
 *   AC2 – Bounded concurrency via maxParallel attribute
 *   AC3 – Context isolation between branches
 *   AC4 – Results stored in parallel.results as BranchResult[] (updated 50-3)
 *   AC5 – wait_all join policy: all branches complete even when one fails
 *   AC6 – GraphNode extended with maxParallel and joinPolicy (parser end-to-end)
 *   AC7 – parallel handler registered in default registry
 */

import { describe, it, expect, vi } from 'vitest'
import { createParallelHandler } from '../parallel.js'
import { createDefaultRegistry } from '../registry.js'
import { GraphContext } from '../../graph/context.js'
import { parseGraph } from '../../graph/parser.js'
import type { GraphNode, GraphEdge, Graph, IGraphContext } from '../../graph/types.js'
import type { NodeHandler, IHandlerRegistry } from '../types.js'
import type { BranchResult } from '../join-policy.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal GraphNode factory for parallel nodes. */
function makeParallelNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'parallel-node',
    label: 'Fan-Out',
    shape: 'component',
    type: 'parallel',
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
    maxParallel: 0,
    joinPolicy: '',
    ...overrides,
  }
}

/** Minimal GraphNode factory for branch nodes. */
function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'branch',
    label: '',
    shape: 'box',
    type: 'codergen',
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

/**
 * Build a minimal Graph stub whose `outgoingEdges(parallelNodeId)` returns
 * edges targeting each of the given branch node IDs.
 */
function makeGraph(parallelNodeId: string, branchNodeIds: string[]): Graph {
  const nodes = new Map<string, GraphNode>()
  nodes.set(parallelNodeId, makeParallelNode({ id: parallelNodeId }))
  for (const id of branchNodeIds) {
    nodes.set(id, makeNode({ id }))
  }

  const edges: GraphEdge[] = branchNodeIds.map((id) => ({
    fromNode: parallelNodeId,
    toNode: id,
    label: '',
    condition: '',
    weight: 0,
    fidelity: '',
    threadId: '',
    loopRestart: false,
  }))

  return {
    id: '',
    goal: '',
    label: '',
    modelStylesheet: '',
    defaultMaxRetries: 0,
    retryTarget: '',
    fallbackRetryTarget: '',
    defaultFidelity: '',
    nodes,
    edges,
    outgoingEdges: (nodeId: string) => edges.filter((e) => e.fromNode === nodeId),
    startNode: () => {
      throw new Error('not implemented in test stub')
    },
    exitNode: () => {
      throw new Error('not implemented in test stub')
    },
  } as Graph
}

/**
 * Build a minimal IHandlerRegistry stub that maps node ID → handler.
 */
function makeRegistry(handlers: Map<string, NodeHandler>): IHandlerRegistry {
  return {
    register: () => {},
    registerShape: () => {},
    setDefault: () => {},
    resolve: (node: GraphNode): NodeHandler => {
      const h = handlers.get(node.id)
      if (!h) throw new Error(`No handler registered for node "${node.id}"`)
      return h
    },
  }
}

// ---------------------------------------------------------------------------
// AC1 – Concurrent branch execution
// ---------------------------------------------------------------------------

describe('AC1 – concurrent branch execution', () => {
  it('calls all 3 branch handlers and returns SUCCESS', async () => {
    const handlerA = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const handlerB = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const handlerC = vi.fn().mockResolvedValue({ status: 'SUCCESS' })

    const handlers = new Map<string, NodeHandler>([
      ['branch-a', handlerA],
      ['branch-b', handlerB],
      ['branch-c', handlerC],
    ])
    const registry = makeRegistry(handlers)
    const parallelHandler = createParallelHandler({ handlerRegistry: registry })

    const node = makeParallelNode({ id: 'p1' })
    const graph = makeGraph('p1', ['branch-a', 'branch-b', 'branch-c'])
    const context = new GraphContext()

    const outcome = await parallelHandler(node, context, graph)

    expect(outcome.status).toBe('SUCCESS')
    expect(handlerA).toHaveBeenCalledOnce()
    expect(handlerB).toHaveBeenCalledOnce()
    expect(handlerC).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// AC2 – Bounded concurrency via maxParallel
// ---------------------------------------------------------------------------

describe('AC2 – maxParallel=2 limits concurrency to at most 2', () => {
  it('never exceeds 2 concurrent branch executions', async () => {
    let concurrent = 0
    let maxObserved = 0

    const makeSlowHandler = (): NodeHandler =>
      vi.fn(async () => {
        concurrent++
        if (concurrent > maxObserved) maxObserved = concurrent
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        concurrent--
        return { status: 'SUCCESS' as const }
      })

    const handlers = new Map<string, NodeHandler>([
      ['b1', makeSlowHandler()],
      ['b2', makeSlowHandler()],
      ['b3', makeSlowHandler()],
    ])
    const registry = makeRegistry(handlers)
    const parallelHandler = createParallelHandler({ handlerRegistry: registry })

    const node = makeParallelNode({ id: 'p1', maxParallel: 2 })
    const graph = makeGraph('p1', ['b1', 'b2', 'b3'])
    const context = new GraphContext()

    const outcome = await parallelHandler(node, context, graph)

    expect(outcome.status).toBe('SUCCESS')
    expect(maxObserved).toBeLessThanOrEqual(2)
    // All 3 branches must have run — check via context
    const results = context.get('parallel.results') as BranchResult[]
    expect(results).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// AC3 – Context isolation
// ---------------------------------------------------------------------------

describe('AC3 – context isolation between branches', () => {
  it('branch mutations do not affect the parent context or each other', async () => {
    const handlerA: NodeHandler = vi.fn(async (_node, ctx) => {
      ctx.set('output', 'A')
      return { status: 'SUCCESS' as const }
    })
    const handlerB: NodeHandler = vi.fn(async (_node, ctx) => {
      ctx.set('output', 'B')
      return { status: 'SUCCESS' as const }
    })

    const handlers = new Map<string, NodeHandler>([
      ['branch-a', handlerA],
      ['branch-b', handlerB],
    ])
    const registry = makeRegistry(handlers)
    const parallelHandler = createParallelHandler({ handlerRegistry: registry })

    const node = makeParallelNode({ id: 'p1' })
    const graph = makeGraph('p1', ['branch-a', 'branch-b'])
    const context = new GraphContext()

    await parallelHandler(node, context, graph)

    // Parent context must be unaffected
    expect(context.get('output')).toBeUndefined()

    // Each branch result must capture only its own mutation
    const results = context.get('parallel.results') as BranchResult[]
    // branch-a is index 0, branch-b is index 1
    const resultA = results.find((r) => r.index === 0)!
    const resultB = results.find((r) => r.index === 1)!

    expect(resultA.contextSnapshot?.['output']).toBe('A')
    expect(resultB.contextSnapshot?.['output']).toBe('B')
  })
})

// ---------------------------------------------------------------------------
// AC4 – Results stored in parallel.results
// ---------------------------------------------------------------------------

describe('AC4 – results stored in parallel.results as BranchResult[]', () => {
  it('context["parallel.results"] is an array with index, outcome, contextSnapshot', async () => {
    const handlers = new Map<string, NodeHandler>([
      ['b1', vi.fn().mockResolvedValue({ status: 'SUCCESS' })],
      ['b2', vi.fn().mockResolvedValue({ status: 'SUCCESS' })],
      ['b3', vi.fn().mockResolvedValue({ status: 'SUCCESS' })],
    ])
    const registry = makeRegistry(handlers)
    const parallelHandler = createParallelHandler({ handlerRegistry: registry })

    const node = makeParallelNode({ id: 'p1' })
    const graph = makeGraph('p1', ['b1', 'b2', 'b3'])
    const context = new GraphContext()

    await parallelHandler(node, context, graph)

    const results = context.get('parallel.results') as BranchResult[]
    expect(Array.isArray(results)).toBe(true)
    expect(results).toHaveLength(3)

    for (const r of results) {
      expect(r).toHaveProperty('index')
      expect(r).toHaveProperty('outcome')
      expect(r).toHaveProperty('contextSnapshot')
      expect(typeof r.index).toBe('number')
      expect(['SUCCESS', 'FAIL', 'CANCELLED']).toContain(r.outcome)
      expect(typeof r.contextSnapshot).toBe('object')
    }
  })
})

// ---------------------------------------------------------------------------
// AC5 – wait_all: all branches complete even when one fails
// ---------------------------------------------------------------------------

describe('AC5 – wait_all: handler returns SUCCESS even when a branch fails', () => {
  it('all 3 results captured; failing branch has outcome FAIL with error', async () => {
    const handlers = new Map<string, NodeHandler>([
      ['b1', vi.fn().mockResolvedValue({ status: 'SUCCESS' })],
      ['b2', vi.fn().mockResolvedValue({ status: 'FAILURE', failureReason: 'oops' })],
      ['b3', vi.fn().mockResolvedValue({ status: 'SUCCESS' })],
    ])
    const registry = makeRegistry(handlers)
    const parallelHandler = createParallelHandler({ handlerRegistry: registry })

    const node = makeParallelNode({ id: 'p1' })
    const graph = makeGraph('p1', ['b1', 'b2', 'b3'])
    const context = new GraphContext()

    const outcome = await parallelHandler(node, context, graph)

    // Parallel handler itself returns SUCCESS (wait_all semantics)
    expect(outcome.status).toBe('SUCCESS')

    const results = context.get('parallel.results') as BranchResult[]
    expect(results).toHaveLength(3)

    // b2 is at index 1 (second edge in the outgoing list)
    const failResult = results.find((r) => r.outcome === 'FAIL')!
    expect(failResult).toBeDefined()
    expect(failResult.error).toBe('oops')
    expect(failResult.index).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// AC6 – GraphNode extended with maxParallel and joinPolicy (parser end-to-end)
// ---------------------------------------------------------------------------

describe('AC6 – parseGraph extracts maxParallel and joinPolicy into GraphNode', () => {
  it('parses maxParallel and joinPolicy from a DOT node definition', () => {
    const dot = `
digraph test_parallel_attrs {
  graph [goal="Test parallel attributes"]
  start [shape=Mdiamond]
  fan_out [shape=component, type=parallel, maxParallel=2, joinPolicy="wait_all"]
  branch_a [shape=box]
  exit [shape=Msquare]
  start -> fan_out
  fan_out -> branch_a
  branch_a -> exit
}
`
    const graph = parseGraph(dot)
    const fanOut = graph.nodes.get('fan_out')
    expect(fanOut).toBeDefined()
    expect(fanOut!.maxParallel).toBe(2)
    expect(fanOut!.joinPolicy).toBe('wait_all')
  })

  it('defaults maxParallel to 0 and joinPolicy to empty string when attributes are absent', () => {
    const dot = `
digraph test_parallel_defaults {
  graph [goal="Test parallel defaults"]
  start [shape=Mdiamond]
  plain_node [shape=box]
  exit [shape=Msquare]
  start -> plain_node -> exit
}
`
    const graph = parseGraph(dot)
    const plainNode = graph.nodes.get('plain_node')
    expect(plainNode).toBeDefined()
    expect(plainNode!.maxParallel).toBe(0)
    expect(plainNode!.joinPolicy).toBe('')
  })
})

// ---------------------------------------------------------------------------
// AC7 – parallel handler registered in default registry
// ---------------------------------------------------------------------------

describe('AC7 – parallel handler registered in default registry', () => {
  it('resolve({ type: "parallel" }) returns a function', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ id: 'p', type: 'parallel', shape: 'component' })
    const handler = registry.resolve(node)
    expect(typeof handler).toBe('function')
  })

  it('resolve via shape=component also returns the parallel handler', () => {
    const registry = createDefaultRegistry()
    // No explicit type — resolved via shape mapping
    const node = makeNode({ id: 'p', type: '', shape: 'component' })
    const handler = registry.resolve(node)
    expect(typeof handler).toBe('function')
  })
})
