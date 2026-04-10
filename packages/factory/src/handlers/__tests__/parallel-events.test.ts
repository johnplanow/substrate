/**
 * Unit tests for parallel handler event emission (story 50-9).
 *
 * Covers AC1 / AC7:
 *   - graph:parallel-started emitted once with branchCount
 *   - graph:parallel-branch-started emitted once per branch
 *   - graph:parallel-branch-completed emitted once per branch with durationMs >= 0
 *   - graph:parallel-completed emitted once with completedCount and cancelledCount
 *   - No-op when eventBus absent (no TypeError)
 */

import { describe, it, expect, vi } from 'vitest'
import { createParallelHandler } from '../parallel.js'
import { GraphContext } from '../../graph/context.js'
import type { GraphNode, GraphEdge, Graph, IGraphContext } from '../../graph/types.js'
import type { NodeHandler, IHandlerRegistry } from '../types.js'
import type { FactoryEvents } from '../../events.js'
import type { TypedEventBus } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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
      throw new Error('not implemented')
    },
    exitNode: () => {
      throw new Error('not implemented')
    },
  } as Graph
}

function makeRegistry(handlers: Map<string, NodeHandler>): IHandlerRegistry {
  return {
    register: () => {},
    registerShape: () => {},
    setDefault: () => {},
    resolve: (node: GraphNode): NodeHandler => {
      const h = handlers.get(node.id)
      if (!h) throw new Error(`No handler for node "${node.id}"`)
      return h
    },
  }
}

function makeContext(runId = 'test-run-id'): IGraphContext {
  const ctx = new GraphContext()
  ctx.set('__runId', runId)
  return ctx
}

function makeMockEventBus(): { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn() }
}

// ---------------------------------------------------------------------------
// AC7 — Parallel lifecycle events
// ---------------------------------------------------------------------------

describe('graph:parallel-started', () => {
  it('is emitted once before branches launch with branchCount and policy', async () => {
    const handlerA = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const handlerB = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const registry = makeRegistry(
      new Map([
        ['branch-a', handlerA],
        ['branch-b', handlerB],
      ])
    )
    const mockBus = makeMockEventBus()

    const handler = createParallelHandler({
      handlerRegistry: registry,
      eventBus: mockBus as unknown as TypedEventBus<FactoryEvents>,
    })

    await handler(
      makeParallelNode({ id: 'p1' }),
      makeContext(),
      makeGraph('p1', ['branch-a', 'branch-b'])
    )

    const startedCalls = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'graph:parallel-started'
    )
    expect(startedCalls).toHaveLength(1)
    expect(startedCalls[0]![1]).toMatchObject({
      runId: 'test-run-id',
      nodeId: 'p1',
      branchCount: 2,
      policy: 'wait_all',
    })
  })
})

describe('graph:parallel-branch-started', () => {
  it('is emitted once per branch (2 branches → 2 events)', async () => {
    const handlerA = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const handlerB = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const registry = makeRegistry(
      new Map([
        ['branch-a', handlerA],
        ['branch-b', handlerB],
      ])
    )
    const mockBus = makeMockEventBus()

    const handler = createParallelHandler({
      handlerRegistry: registry,
      eventBus: mockBus as unknown as TypedEventBus<FactoryEvents>,
    })

    await handler(
      makeParallelNode({ id: 'p1' }),
      makeContext(),
      makeGraph('p1', ['branch-a', 'branch-b'])
    )

    const branchStartedCalls = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'graph:parallel-branch-started'
    )
    expect(branchStartedCalls).toHaveLength(2)
    const indices = branchStartedCalls.map(
      (c: unknown[]) => (c[1] as { branchIndex: number }).branchIndex
    )
    expect(indices).toContain(0)
    expect(indices).toContain(1)
  })
})

describe('graph:parallel-branch-completed', () => {
  it('is emitted once per branch with durationMs >= 0', async () => {
    const handlerA = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const handlerB = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const registry = makeRegistry(
      new Map([
        ['branch-a', handlerA],
        ['branch-b', handlerB],
      ])
    )
    const mockBus = makeMockEventBus()

    const handler = createParallelHandler({
      handlerRegistry: registry,
      eventBus: mockBus as unknown as TypedEventBus<FactoryEvents>,
    })

    await handler(
      makeParallelNode({ id: 'p1' }),
      makeContext(),
      makeGraph('p1', ['branch-a', 'branch-b'])
    )

    const branchCompletedCalls = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'graph:parallel-branch-completed'
    )
    expect(branchCompletedCalls).toHaveLength(2)
    for (const call of branchCompletedCalls) {
      const payload = call[1] as { durationMs: number; status: string }
      expect(payload.durationMs).toBeGreaterThanOrEqual(0)
      expect(payload.status).toBe('SUCCESS')
    }
  })
})

describe('graph:parallel-completed', () => {
  it('is emitted once with completedCount=2 and cancelledCount=0 for wait_all policy', async () => {
    const handlerA = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const handlerB = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const registry = makeRegistry(
      new Map([
        ['branch-a', handlerA],
        ['branch-b', handlerB],
      ])
    )
    const mockBus = makeMockEventBus()

    const handler = createParallelHandler({
      handlerRegistry: registry,
      eventBus: mockBus as unknown as TypedEventBus<FactoryEvents>,
    })

    await handler(
      makeParallelNode({ id: 'p1' }),
      makeContext(),
      makeGraph('p1', ['branch-a', 'branch-b'])
    )

    const completedCalls = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'graph:parallel-completed'
    )
    expect(completedCalls).toHaveLength(1)
    expect(completedCalls[0]![1]).toMatchObject({
      runId: 'test-run-id',
      nodeId: 'p1',
      completedCount: 2,
      cancelledCount: 0,
      policy: 'wait_all',
    })
  })
})

describe('parallel handler without eventBus', () => {
  it('executes successfully without TypeError when eventBus is absent', async () => {
    const handlerA = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const handlerB = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const registry = makeRegistry(
      new Map([
        ['branch-a', handlerA],
        ['branch-b', handlerB],
      ])
    )

    // No eventBus provided
    const handler = createParallelHandler({ handlerRegistry: registry })
    const outcome = await handler(
      makeParallelNode({ id: 'p1' }),
      makeContext(),
      makeGraph('p1', ['branch-a', 'branch-b'])
    )

    expect(outcome.status).toBe('SUCCESS')
  })
})

describe('parallel event payload type conformance to FactoryEvents', () => {
  it('all emitted parallel event payloads have field types matching FactoryEvents declarations', async () => {
    const handlerA = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const handlerB = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    const registry = makeRegistry(
      new Map([
        ['branch-a', handlerA],
        ['branch-b', handlerB],
      ])
    )
    const mockBus = makeMockEventBus()

    const handler = createParallelHandler({
      handlerRegistry: registry,
      eventBus: mockBus as unknown as TypedEventBus<FactoryEvents>,
    })

    await handler(
      makeParallelNode({ id: 'p1' }),
      makeContext(),
      makeGraph('p1', ['branch-a', 'branch-b'])
    )

    const calls = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls

    // graph:parallel-started payload: { runId: string; nodeId: string; branchCount: number; maxParallel: number; policy: string }
    const startedPayload = calls.find(
      (c: unknown[]) => c[0] === 'graph:parallel-started'
    )?.[1] as Record<string, unknown>
    expect(typeof startedPayload['runId']).toBe('string')
    expect(typeof startedPayload['nodeId']).toBe('string')
    expect(typeof startedPayload['branchCount']).toBe('number')
    expect(typeof startedPayload['maxParallel']).toBe('number')
    expect(typeof startedPayload['policy']).toBe('string')

    // graph:parallel-branch-completed payload: { runId: string; nodeId: string; branchIndex: number; status: StageStatus; durationMs: number }
    const branchCompletedPayload = calls.find(
      (c: unknown[]) => c[0] === 'graph:parallel-branch-completed'
    )?.[1] as Record<string, unknown>
    expect(typeof branchCompletedPayload['runId']).toBe('string')
    expect(typeof branchCompletedPayload['nodeId']).toBe('string')
    expect(typeof branchCompletedPayload['branchIndex']).toBe('number')
    expect(typeof branchCompletedPayload['status']).toBe('string')
    expect(typeof branchCompletedPayload['durationMs']).toBe('number')

    // graph:parallel-completed payload: { runId: string; nodeId: string; completedCount: number; cancelledCount: number; policy: string }
    const completedPayload = calls.find(
      (c: unknown[]) => c[0] === 'graph:parallel-completed'
    )?.[1] as Record<string, unknown>
    expect(typeof completedPayload['runId']).toBe('string')
    expect(typeof completedPayload['nodeId']).toBe('string')
    expect(typeof completedPayload['completedCount']).toBe('number')
    expect(typeof completedPayload['cancelledCount']).toBe('number')
    expect(typeof completedPayload['policy']).toBe('string')
  })
})
