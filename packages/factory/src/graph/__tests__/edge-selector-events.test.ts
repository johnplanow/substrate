/**
 * Unit tests for graph:llm-edge-evaluated event emission in selectEdge (story 50-9).
 *
 * Covers AC3 / AC7:
 *   - graph:llm-edge-evaluated emitted when LLM condition evaluates to true
 *   - graph:llm-edge-evaluated emitted when LLM condition evaluates to false
 *   - graph:llm-edge-evaluated emitted on error-fallback path with result: false
 *   - No-op when eventBus is absent (no TypeError)
 */

import { describe, it, expect, vi } from 'vitest'
import { selectEdge } from '../edge-selector.js'
import { GraphContext } from '../context.js'
import type { GraphEdge, GraphNode, Graph, Outcome } from '../types.js'
import type { FactoryEvents } from '../../events.js'
import type { TypedEventBus } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string): GraphNode {
  return {
    id,
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

function makeGraph(edges: GraphEdge[]): Graph {
  return {
    id: '',
    goal: '',
    label: '',
    modelStylesheet: '',
    defaultMaxRetries: 0,
    retryTarget: '',
    fallbackRetryTarget: '',
    defaultFidelity: '',
    nodes: new Map(),
    edges,
    outgoingEdges: (nodeId: string) => edges.filter((e) => e.fromNode === nodeId),
    startNode: () => { throw new Error('not implemented') },
    exitNode: () => { throw new Error('not implemented') },
  }
}

const emptyOutcome: Outcome = { status: 'SUCCESS' }

function makeMockEventBus(): { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn() }
}

// ---------------------------------------------------------------------------
// AC7 — LLM edge evaluation events
// ---------------------------------------------------------------------------

describe('graph:llm-edge-evaluated — affirmative result', () => {
  it('is emitted with result: true when LLM condition evaluates affirmatively', async () => {
    const node = makeNode('nodeA')
    const edge = makeEdge('nodeA', 'nodeB', { condition: 'llm: Is the build passing?' })
    const graph = makeGraph([edge])
    const context = new GraphContext()
    const mockBus = makeMockEventBus()

    await selectEdge(node, emptyOutcome, context, graph, {
      llmCall: vi.fn().mockResolvedValue('yes'),
      eventBus: mockBus as unknown as TypedEventBus<FactoryEvents>,
      runId: 'test-run',
    })

    const evalCalls = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'graph:llm-edge-evaluated'
    )
    expect(evalCalls).toHaveLength(1)
    expect(evalCalls[0]![1]).toMatchObject({
      runId: 'test-run',
      nodeId: 'nodeA',
      question: 'Is the build passing?',
      result: true,
    })
  })
})

describe('graph:llm-edge-evaluated — negative result', () => {
  it('is emitted with result: false when LLM condition evaluates negatively', async () => {
    const node = makeNode('nodeA')
    const edge = makeEdge('nodeA', 'nodeB', { condition: 'llm: Is the build passing?' })
    const graph = makeGraph([edge])
    const context = new GraphContext()
    const mockBus = makeMockEventBus()

    await selectEdge(node, emptyOutcome, context, graph, {
      llmCall: vi.fn().mockResolvedValue('no'),
      eventBus: mockBus as unknown as TypedEventBus<FactoryEvents>,
      runId: 'test-run',
    })

    const evalCalls = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'graph:llm-edge-evaluated'
    )
    expect(evalCalls).toHaveLength(1)
    expect(evalCalls[0]![1]).toMatchObject({
      runId: 'test-run',
      nodeId: 'nodeA',
      question: 'Is the build passing?',
      result: false,
    })
  })
})

describe('graph:llm-edge-evaluated — error fallback', () => {
  it('is emitted with result: false when LLM call throws an error', async () => {
    const node = makeNode('nodeA')
    const edge = makeEdge('nodeA', 'nodeB', { condition: 'llm: Is the build passing?' })
    const graph = makeGraph([edge])
    const context = new GraphContext()
    const mockBus = makeMockEventBus()

    await selectEdge(node, emptyOutcome, context, graph, {
      llmCall: vi.fn().mockRejectedValue(new Error('LLM service unavailable')),
      eventBus: mockBus as unknown as TypedEventBus<FactoryEvents>,
      runId: 'test-run',
    })

    const evalCalls = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'graph:llm-edge-evaluated'
    )
    expect(evalCalls).toHaveLength(1)
    expect(evalCalls[0]![1]).toMatchObject({
      runId: 'test-run',
      nodeId: 'nodeA',
      question: 'Is the build passing?',
      result: false,
    })
  })
})

describe('selectEdge without eventBus', () => {
  it('evaluates LLM condition and returns edge without TypeError when eventBus is absent', async () => {
    const node = makeNode('nodeA')
    const edge = makeEdge('nodeA', 'nodeB', { condition: 'llm: Should we proceed?' })
    const graph = makeGraph([edge])
    const context = new GraphContext()

    // No eventBus — should not throw
    const result = await selectEdge(node, emptyOutcome, context, graph, {
      llmCall: vi.fn().mockResolvedValue('yes'),
      runId: 'test-run',
    })

    // LLM returned 'yes', so the edge should be selected
    expect(result).toBeDefined()
    expect(result?.toNode).toBe('nodeB')
  })
})

describe('graph:llm-edge-evaluated payload type conformance to FactoryEvents', () => {
  it('emitted payload has field types matching FactoryEvents declaration for graph:llm-edge-evaluated', async () => {
    const node = makeNode('nodeA')
    const edge = makeEdge('nodeA', 'nodeB', { condition: 'llm: Is the build passing?' })
    const graph = makeGraph([edge])
    const context = new GraphContext()
    const mockBus = makeMockEventBus()

    await selectEdge(node, emptyOutcome, context, graph, {
      llmCall: vi.fn().mockResolvedValue('yes'),
      eventBus: mockBus as unknown as TypedEventBus<FactoryEvents>,
      runId: 'conformance-run',
    })

    const evalCalls = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'graph:llm-edge-evaluated'
    )
    expect(evalCalls).toHaveLength(1)

    // Verify all fields match FactoryEvents type declaration:
    // { runId: string; nodeId: string; question: string; result: boolean }
    const payload = evalCalls[0]![1] as Record<string, unknown>
    expect(typeof payload['runId']).toBe('string')
    expect(typeof payload['nodeId']).toBe('string')
    expect(typeof payload['question']).toBe('string')
    expect(typeof payload['result']).toBe('boolean')

    // Verify the payload has exactly the declared fields (no missing required fields)
    expect(Object.keys(payload)).toEqual(expect.arrayContaining(['runId', 'nodeId', 'question', 'result']))
  })
})
