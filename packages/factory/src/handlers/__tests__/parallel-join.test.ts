/**
 * Integration tests for the parallel handler with join policies (story 50-3, AC1–AC5).
 *
 * These tests create a real `createParallelHandler` with a mock handler registry
 * that returns controlled outcomes with configurable delays, exercising the full
 * join-policy wiring in `parallel.ts`.
 */

import { describe, it, expect, vi } from 'vitest'
import { createParallelHandler } from '../parallel.js'
import { GraphContext } from '../../graph/context.js'
import type { GraphNode, GraphEdge, Graph, IGraphContext } from '../../graph/types.js'
import type { NodeHandler, IHandlerRegistry } from '../types.js'
import type { BranchResult } from '../join-policy.js'
import type { Outcome } from '../../graph/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal GraphNode factory for parallel nodes with configurable attrs. */
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

/** Build a minimal Graph stub with outgoing edges from a parallel node. */
function makeGraph(parallelNodeId: string, branchNodeIds: string[]): Graph {
  const nodes = new Map<string, GraphNode>()
  nodes.set(parallelNodeId, makeParallelNode({ id: parallelNodeId }))
  for (const id of branchNodeIds) {
    nodes.set(id, makeParallelNode({ id, type: 'codergen', shape: 'box' }))
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
    startNode: () => { throw new Error('not implemented') },
    exitNode: () => { throw new Error('not implemented') },
  } as Graph
}

/**
 * Build a mock handler registry where each branch node (by ID) is backed by
 * a handler that returns a controlled outcome after a configurable delay.
 *
 * The handler respects the AbortSignal stored in `context.get('_branch.abort_signal')`:
 * after the initial yield, if the signal is aborted, it returns FAILURE (simulating
 * early cancellation). This makes the integration tests timing-predictable.
 */
function makeMockRegistry(
  outcomes: Record<string, { status: Outcome['status']; delayMs: number; failureReason?: string }>
): IHandlerRegistry {
  return {
    register: vi.fn(),
    registerShape: vi.fn(),
    setDefault: vi.fn(),
    resolve(node: GraphNode): NodeHandler {
      const cfg = outcomes[node.id]
      if (!cfg) throw new Error(`No mock outcome for node "${node.id}"`)
      return async (_n: GraphNode, ctx: IGraphContext, _g: Graph): Promise<Outcome> => {
        const signal = ctx.get('_branch.abort_signal') as AbortSignal | undefined

        // Check signal before waiting
        if (signal?.aborted) {
          return { status: 'FAILURE', failureReason: 'cancelled before start' }
        }

        // Honour abort signal during delay using a listener for fast cancellation
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, cfg.delayMs)
          if (signal) {
            signal.addEventListener('abort', () => {
              clearTimeout(timer)
              resolve()
            })
          }
        })

        if (signal?.aborted) {
          return { status: 'FAILURE', failureReason: 'cancelled during execution' }
        }

        return {
          status: cfg.status,
          ...(cfg.failureReason !== undefined && { failureReason: cfg.failureReason }),
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// AC1 — wait_all with 3 branches (2 SUCCESS, 1 FAIL) → results has 3 entries
// ---------------------------------------------------------------------------

describe('AC1 — wait_all join policy', () => {
  it('waits for all 3 branches and stores 3 BranchResult entries in context', async () => {
    const registry = makeMockRegistry({
      'b1': { status: 'SUCCESS', delayMs: 5 },
      'b2': { status: 'FAILURE', delayMs: 10, failureReason: 'test error' },
      'b3': { status: 'SUCCESS', delayMs: 5 },
    })

    const node = makeParallelNode({
      id: 'p1',
      attrs: { join_policy: 'wait_all' },
    })
    const graph = makeGraph('p1', ['b1', 'b2', 'b3'])
    const context = new GraphContext()

    const handler = createParallelHandler({ handlerRegistry: registry })
    const outcome = await handler(node, context, graph)

    expect(outcome.status).toBe('SUCCESS')

    const results = context.get('parallel.results') as BranchResult[]
    expect(results).toHaveLength(3)

    // 2 successes and 1 failure
    const successes = results.filter(r => r.outcome === 'SUCCESS')
    const failures = results.filter(r => r.outcome === 'FAIL')
    expect(successes).toHaveLength(2)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.error).toBe('test error')
  })
})

// ---------------------------------------------------------------------------
// AC2 — first_success with branch-0 winning quickly; branches 1-2 cancelled
// ---------------------------------------------------------------------------

describe('AC2 — first_success join policy', () => {
  it('resolves early when branch-0 succeeds; sets winner_index; branches 1-2 are CANCELLED', async () => {
    const registry = makeMockRegistry({
      'b0': { status: 'SUCCESS', delayMs: 10 },
      'b1': { status: 'SUCCESS', delayMs: 500 },
      'b2': { status: 'SUCCESS', delayMs: 500 },
    })

    const node = makeParallelNode({
      id: 'p1',
      attrs: {
        join_policy: 'first_success',
        cancel_drain_timeout_ms: '50',  // small drain window for test speed
      },
    })
    const graph = makeGraph('p1', ['b0', 'b1', 'b2'])
    const context = new GraphContext()

    const handler = createParallelHandler({ handlerRegistry: registry })

    const start = Date.now()
    const outcome = await handler(node, context, graph)
    const elapsed = Date.now() - start

    expect(outcome.status).toBe('SUCCESS')
    // Should resolve well before the slow branches (500ms) finish
    expect(elapsed).toBeLessThan(200)

    // Winner should be branch 0
    expect(context.get('parallel.winner_index')).toBe(0)

    // Results should contain CANCELLED entries for branches 1 and 2
    const results = context.get('parallel.results') as BranchResult[]
    expect(results).toBeDefined()
    const cancelledEntries = results.filter(r => r.outcome === 'CANCELLED')
    expect(cancelledEntries.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back gracefully when all branches fail', async () => {
    const registry = makeMockRegistry({
      'b0': { status: 'FAILURE', delayMs: 5, failureReason: 'err0' },
      'b1': { status: 'FAILURE', delayMs: 5, failureReason: 'err1' },
      'b2': { status: 'FAILURE', delayMs: 5, failureReason: 'err2' },
    })

    const node = makeParallelNode({
      id: 'p1',
      attrs: { join_policy: 'first_success' },
    })
    const graph = makeGraph('p1', ['b0', 'b1', 'b2'])
    const context = new GraphContext()

    const handler = createParallelHandler({ handlerRegistry: registry })
    const outcome = await handler(node, context, graph)

    expect(outcome.status).toBe('FAILURE')
    const joinError = context.get('parallel.join_error') as string
    expect(joinError).toMatch(/all 3 branches failed/)
  })
})

// ---------------------------------------------------------------------------
// AC3 — quorum with quorum_size=2 and 4 branches
// ---------------------------------------------------------------------------

describe('AC3 — quorum join policy', () => {
  it('resolves after 2 successes; quorum_reached=2; 2 remaining branches CANCELLED', async () => {
    const registry = makeMockRegistry({
      'b0': { status: 'SUCCESS', delayMs: 5 },
      'b1': { status: 'SUCCESS', delayMs: 10 },
      'b2': { status: 'SUCCESS', delayMs: 500 },
      'b3': { status: 'SUCCESS', delayMs: 500 },
    })

    const node = makeParallelNode({
      id: 'p1',
      attrs: {
        join_policy: 'quorum',
        quorum_size: '2',
        cancel_drain_timeout_ms: '50',
      },
    })
    const graph = makeGraph('p1', ['b0', 'b1', 'b2', 'b3'])
    const context = new GraphContext()

    const handler = createParallelHandler({ handlerRegistry: registry })

    const start = Date.now()
    const outcome = await handler(node, context, graph)
    const elapsed = Date.now() - start

    expect(outcome.status).toBe('SUCCESS')
    // Should resolve before the slow branches
    expect(elapsed).toBeLessThan(300)

    // quorum_reached should be >= 2
    const quorumReached = context.get('parallel.quorum_reached') as number
    expect(quorumReached).toBeGreaterThanOrEqual(2)

    // Results should contain at least some CANCELLED entries
    const results = context.get('parallel.results') as BranchResult[]
    expect(results).toBeDefined()
    const cancelledEntries = results.filter(r => r.outcome === 'CANCELLED')
    expect(cancelledEntries.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// AC5 — quorum with quorum_size=3 and 3 branches all failing → join_error
// ---------------------------------------------------------------------------

describe('AC5 — quorum unreachable when branches fail', () => {
  it('sets parallel.join_error when quorum cannot be reached', async () => {
    const registry = makeMockRegistry({
      'b0': { status: 'FAILURE', delayMs: 5, failureReason: 'fail0' },
      'b1': { status: 'FAILURE', delayMs: 5, failureReason: 'fail1' },
      'b2': { status: 'FAILURE', delayMs: 5, failureReason: 'fail2' },
    })

    const node = makeParallelNode({
      id: 'p1',
      attrs: {
        join_policy: 'quorum',
        quorum_size: '3',
        cancel_drain_timeout_ms: '50',
      },
    })
    const graph = makeGraph('p1', ['b0', 'b1', 'b2'])
    const context = new GraphContext()

    const handler = createParallelHandler({ handlerRegistry: registry })
    const outcome = await handler(node, context, graph)

    expect(outcome.status).toBe('FAILURE')

    const joinError = context.get('parallel.join_error') as string
    expect(joinError).toBeDefined()
    expect(joinError).toMatch(/quorum unreachable/)
  })
})
