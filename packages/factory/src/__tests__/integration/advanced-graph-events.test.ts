/**
 * Integration tests for advanced graph event stream patterns.
 * Story 50-11 AC5.
 *
 * Tests cover event payload completeness and multi-handler event sequencing:
 *   - graph:subgraph-started payload fields (nodeId, graphFile, depth, runId)
 *   - graph:subgraph-completed payload fields (status, durationMs, graphFile, depth)
 *   - Event ordering: started before completed
 *   - Depth tracking in event payloads (root vs nested)
 *   - runId resolution: context.__runId vs options.runId fallback
 *   - Absent eventBus: handlers run without crash
 *   - LLM edge event: graph:llm-edge-evaluated carries nodeId + question + result + runId
 *   - Combined: LLM edge and subgraph events in the same bus (cross-feature coexistence)
 *   - Event bus receives events from both selectEdge and subgraph handler in one test
 *
 * ≥8 `it(...)` cases required (AC7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'node:os'

import { parseGraph } from '../../graph/parser.js'
import { GraphContext } from '../../graph/context.js'
import { HandlerRegistry } from '../../handlers/registry.js'
import { startHandler } from '../../handlers/start.js'
import { exitHandler } from '../../handlers/exit.js'
import { createSubgraphHandler } from '../../handlers/subgraph.js'
import { selectEdge } from '../../graph/edge-selector.js'
import type { Graph, GraphNode, GraphEdge } from '../../graph/types.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'

import { SUBGRAPH_PARENT_DOT, CHILD_GRAPH_DOT } from '../fixtures/subgraph-parent.dot.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SpyEvent {
  event: string
  payload: unknown
}

function makeEventSpy(): { bus: TypedEventBus<FactoryEvents>; events: SpyEvent[] } {
  const events: SpyEvent[] = []
  const bus: TypedEventBus<FactoryEvents> = {
    emit<K extends keyof FactoryEvents>(event: K, payload: FactoryEvents[K]): void {
      events.push({ event: event as string, payload })
    },
    on(): void {},
    off(): void {},
  }
  return { bus, events }
}

function makeChildRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry()
  registry.register('start', startHandler)
  registry.register('exit', exitHandler)
  registry.setDefault(vi.fn().mockResolvedValue({ status: 'SUCCESS' }))
  return registry
}

function makeParentGraphWithSg(graphFile = '/test/child.dot'): { graph: Graph; sgNode: GraphNode } {
  const graph = parseGraph(SUBGRAPH_PARENT_DOT)
  const sgNode = graph.nodes.get('sg_node')!
  sgNode.attrs = { graph_file: graphFile }
  return { graph, sgNode }
}

function makeNode(id: string, type = 'codergen'): GraphNode {
  return {
    id,
    label: '',
    shape: 'box',
    type,
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
}

function makeEdge(
  fromNode: string,
  toNode: string,
  opts?: { condition?: string; label?: string }
): GraphEdge {
  return {
    fromNode,
    toNode,
    label: opts?.label ?? '',
    condition: opts?.condition ?? '',
    weight: 0,
    fidelity: '',
    threadId: '',
    loopRestart: false,
  }
}

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  const nodeMap = new Map<string, GraphNode>(nodes.map((n) => [n.id, n]))
  return {
    id: 'test',
    goal: '',
    label: '',
    modelStylesheet: '',
    defaultMaxRetries: 0,
    retryTarget: '',
    fallbackRetryTarget: '',
    defaultFidelity: '',
    nodes: nodeMap,
    edges,
    outgoingEdges: (nodeId: string) => edges.filter((e) => e.fromNode === nodeId),
    startNode: () => {
      throw new Error('not needed')
    },
    exitNode: () => {
      throw new Error('not needed')
    },
  } as Graph
}

const SUCCESS_OUTCOME = { status: 'SUCCESS' as const }

// ---------------------------------------------------------------------------
// AC5: Subgraph event payload details
// ---------------------------------------------------------------------------

describe('advanced graph events — subgraph event payload details', () => {
  beforeEach(() => vi.clearAllMocks())

  it('graph:subgraph-started payload contains nodeId, graphFile, depth, and runId', async () => {
    const { bus, events } = makeEventSpy()
    const { graph, sgNode } = makeParentGraphWithSg('/test/child.dot')

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      eventBus: bus,
      runId: 'run-abc',
    })

    const context = new GraphContext({ __runId: 'run-abc' })
    await handler(sgNode, context, graph)

    const started = events.find((e) => e.event === 'graph:subgraph-started')
    const p = started!.payload as {
      nodeId: string
      graphFile: string
      depth: number
      runId: string
    }
    expect(p.nodeId).toBe('sg_node')
    expect(p.graphFile).toBe('/test/child.dot')
    expect(p.depth).toBe(0)
    expect(p.runId).toBe('run-abc')
  })

  it('graph:subgraph-completed payload contains status, durationMs, graphFile, depth', async () => {
    const { bus, events } = makeEventSpy()
    const { graph, sgNode } = makeParentGraphWithSg('/test/child.dot')

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      eventBus: bus,
    })

    const context = new GraphContext({ __runId: 'run-completed' })
    await handler(sgNode, context, graph)

    const completed = events.find((e) => e.event === 'graph:subgraph-completed')
    const p = completed!.payload as {
      status: string
      durationMs: number
      graphFile: string
      depth: number
    }
    expect(p.status).toBe('SUCCESS')
    expect(typeof p.durationMs).toBe('number')
    expect(p.durationMs).toBeGreaterThanOrEqual(0)
    expect(p.graphFile).toBe('/test/child.dot')
    expect(p.depth).toBe(0)
  })

  it('depth=1 in subgraph-started when parent context has subgraph._depth=1', async () => {
    const { bus, events } = makeEventSpy()
    const { graph, sgNode } = makeParentGraphWithSg('/test/child.dot')

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      maxDepth: 5,
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      eventBus: bus,
    })

    // Simulate a parent subgraph handler calling a nested subgraph at depth=1
    const context = new GraphContext({ __runId: 'run-depth-1', 'subgraph._depth': 1 })
    await handler(sgNode, context, graph)

    const started = events.find((e) => e.event === 'graph:subgraph-started')
    const p = started!.payload as { depth: number }
    expect(p.depth).toBe(1)
  })

  it('runId from options.runId used when context has no __runId', async () => {
    const { bus, events } = makeEventSpy()
    const { graph, sgNode } = makeParentGraphWithSg('/test/child.dot')

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      eventBus: bus,
      runId: 'options-run-id',
    })

    // No __runId in context — should fall back to options.runId
    const context = new GraphContext({})
    await handler(sgNode, context, graph)

    const started = events.find((e) => e.event === 'graph:subgraph-started')
    const p = started!.payload as { runId: string }
    expect(p.runId).toBe('options-run-id')
  })

  it('absent eventBus for subgraph handler: completes without crash', async () => {
    const { graph, sgNode } = makeParentGraphWithSg('/test/child.dot')

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      // No eventBus
    })

    const context = new GraphContext({ __runId: 'no-bus-test' })
    await expect(handler(sgNode, context, graph)).resolves.toMatchObject({ status: 'SUCCESS' })
  })
})

// ---------------------------------------------------------------------------
// AC5: LLM edge event payload details
// ---------------------------------------------------------------------------

describe('advanced graph events — LLM edge evaluation event details', () => {
  it('graph:llm-edge-evaluated payload contains runId, nodeId, question, result', async () => {
    const { bus, events } = makeEventSpy()
    const decisionNode = makeNode('decision')
    const edges = [
      makeEdge('decision', 'refine', { condition: 'llm:is refinement needed?' }),
      makeEdge('decision', 'exit'),
    ]
    const graph = makeGraph([decisionNode, makeNode('refine'), makeNode('exit', 'exit')], edges)
    const context = new GraphContext()

    await selectEdge(decisionNode, SUCCESS_OUTCOME, context, graph, {
      llmCall: vi.fn().mockResolvedValue('yes'),
      eventBus: bus,
      runId: 'llm-run-1',
    })

    const evt = events.find((e) => e.event === 'graph:llm-edge-evaluated')
    const p = evt!.payload as { runId: string; nodeId: string; question: string; result: boolean }
    expect(p.runId).toBe('llm-run-1')
    expect(p.nodeId).toBe('decision')
    expect(p.question).toBe('is refinement needed?')
    expect(p.result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC5: Cross-feature event coexistence
// ---------------------------------------------------------------------------

describe('advanced graph events — cross-feature event coexistence', () => {
  it('LLM edge selectEdge + subgraph handler: both event types in same event bus', async () => {
    const { bus, events } = makeEventSpy()

    // Step 1: Emit LLM edge evaluation via selectEdge
    const decisionNode = makeNode('decision')
    const edges = [
      makeEdge('decision', 'next', { condition: 'llm:should we proceed?' }),
      makeEdge('decision', 'exit'),
    ]
    const graph = makeGraph([decisionNode, makeNode('next'), makeNode('exit', 'exit')], edges)
    const ctx1 = new GraphContext()

    await selectEdge(decisionNode, SUCCESS_OUTCOME, ctx1, graph, {
      llmCall: vi.fn().mockResolvedValue('no'),
      eventBus: bus,
      runId: 'combined-run',
    })

    // Step 2: Emit subgraph events via createSubgraphHandler
    const parentGraph = parseGraph(SUBGRAPH_PARENT_DOT)
    const sgNode = parentGraph.nodes.get('sg_node')!
    sgNode.attrs = { graph_file: '/test/child.dot' }

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      eventBus: bus,
      runId: 'combined-run',
    })

    const ctx2 = new GraphContext({ __runId: 'combined-run' })
    await handler(sgNode, ctx2, parentGraph)

    // Both event types should be in the stream
    const eventNames = new Set(events.map((e) => e.event))
    expect(eventNames.has('graph:llm-edge-evaluated')).toBe(true)
    expect(eventNames.has('graph:subgraph-started')).toBe(true)
    expect(eventNames.has('graph:subgraph-completed')).toBe(true)
  })

  it('runId is consistent across LLM edge event and subgraph events in same run', async () => {
    const { bus, events } = makeEventSpy()
    const runId = 'consistent-run-xyz'

    // Emit LLM edge event
    const node = makeNode('n1')
    const llmEdges = [makeEdge('n1', 'n2', { condition: 'llm:check?' }), makeEdge('n1', 'n3')]
    const g = makeGraph([node, makeNode('n2'), makeNode('n3')], llmEdges)
    await selectEdge(node, SUCCESS_OUTCOME, new GraphContext(), g, {
      llmCall: vi.fn().mockResolvedValue('yes'),
      eventBus: bus,
      runId,
    })

    // Emit subgraph events
    const parentGraph = parseGraph(SUBGRAPH_PARENT_DOT)
    const sgNode = parentGraph.nodes.get('sg_node')!
    sgNode.attrs = { graph_file: '/test/child.dot' }
    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      eventBus: bus,
      runId,
    })
    await handler(sgNode, new GraphContext({ __runId: runId }), parentGraph)

    // All events in this stream should have the same runId
    const advancedEvents = events.filter((e) =>
      ['graph:llm-edge-evaluated', 'graph:subgraph-started', 'graph:subgraph-completed'].includes(
        e.event
      )
    )
    expect(advancedEvents.length).toBeGreaterThan(0)
    for (const evt of advancedEvents) {
      expect((evt.payload as { runId: string }).runId).toBe(runId)
    }
  })

  it('event ordering: subgraph-started always before subgraph-completed in stream', async () => {
    const { bus, events } = makeEventSpy()
    const parentGraph = parseGraph(SUBGRAPH_PARENT_DOT)
    const sgNode = parentGraph.nodes.get('sg_node')!
    sgNode.attrs = { graph_file: '/test/child.dot' }

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      eventBus: bus,
    })

    await handler(sgNode, new GraphContext({ __runId: 'order-check' }), parentGraph)

    const types = events.map((e) => e.event)
    const startIdx = types.indexOf('graph:subgraph-started')
    const endIdx = types.indexOf('graph:subgraph-completed')
    expect(startIdx).toBeLessThan(endIdx)
  })
})
