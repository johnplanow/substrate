/**
 * Integration tests for parallel fan-out/fan-in execution.
 * Story 50-11 AC1.
 *
 * Tests cover:
 *   - wait_all, first_success, quorum join policies
 *   - Bounded concurrency (maxParallel)
 *   - Fan-in heuristic and LLM-based winner selection
 *   - Context isolation between branches
 *   - Event emission (graph:parallel-* events)
 *   - Absent eventBus handling
 *   - Edge cases (empty parallel, all-fail)
 *
 * Test approach:
 *   Handler chain tests: call parallel + fan_in handlers directly on parsed graph nodes.
 *     Advantage: can inspect context state after handler returns.
 *   Full executor tests: use createGraphExecutor for event emission verification.
 *
 * ≥15 `it(...)` cases required (AC7).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import crypto from 'node:crypto'

import { parseGraph } from '../../graph/parser.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { GraphContext } from '../../graph/context.js'
import { HandlerRegistry } from '../../handlers/registry.js'
import { startHandler } from '../../handlers/start.js'
import { exitHandler } from '../../handlers/exit.js'
import { createParallelHandler } from '../../handlers/parallel.js'
import { createFanInHandler, rankBranches } from '../../handlers/fan-in.js'
import type { BranchResult as FanInBranchResult } from '../../handlers/fan-in.js'
import type { GraphNode, Graph, IGraphContext } from '../../graph/types.js'
import type { NodeHandler, IHandlerRegistry } from '../../handlers/types.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'

import {
  PARALLEL_FAN_OUT_DOT,
  FIRST_SUCCESS_POLICY_DOT,
  QUORUM_POLICY_DOT,
  BOUNDED_CONCURRENCY_DOT,
} from '../fixtures/parallel-fan-out-fan-in.dot.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a unique temp directory for executor logsRoot. */
async function makeTmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `parallel-test-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function cleanDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** Captured event entry */
interface SpyEvent {
  event: string
  payload: unknown
}

/** Creates a mock event bus that records all emitted events. */
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

/**
 * Build a HandlerRegistry with real parallel/fan_in handlers and per-node branch mocks.
 * The `setDefault` handler dispatches to per-node mocks via node.id lookup.
 */
function makeParallelRegistry(
  branchMocks: Map<string, NodeHandler>,
  opts?: {
    eventBus?: TypedEventBus<FactoryEvents>
    runId?: string
    fanInLlmCall?: (prompt: string) => Promise<string>
  }
): HandlerRegistry {
  const registry = new HandlerRegistry()

  registry.register('start', startHandler)
  registry.register('exit', exitHandler)
  registry.register(
    'parallel',
    createParallelHandler({
      handlerRegistry: registry,
      ...(opts?.eventBus !== undefined ? { eventBus: opts.eventBus } : {}),
      ...(opts?.runId !== undefined ? { runId: opts.runId } : {}),
    })
  )
  registry.register(
    'parallel.fan_in',
    createFanInHandler(
      opts?.fanInLlmCall !== undefined ? { llmCall: opts.fanInLlmCall } : undefined
    )
  )

  const defaultHandler: NodeHandler = async (
    node: GraphNode,
    context: IGraphContext,
    graph: Graph
  ) => {
    const h = branchMocks.get(node.id)
    if (h) return h(node, context, graph)
    return { status: 'SUCCESS' as const }
  }
  registry.setDefault(defaultHandler)

  return registry
}

/**
 * Build a minimal IHandlerRegistry for handler chain tests (no start/exit needed).
 * Resolves branch handlers by node.id.
 */
function makeChainRegistry(
  branchMocks: Map<string, NodeHandler>,
  opts?: {
    eventBus?: TypedEventBus<FactoryEvents>
    runId?: string
  }
): IHandlerRegistry {
  // We need a HandlerRegistry instance so we can pass handlerRegistry: registry to parallel
  const registry = new HandlerRegistry()

  const defaultHandler: NodeHandler = async (
    node: GraphNode,
    context: IGraphContext,
    graph: Graph
  ) => {
    const h = branchMocks.get(node.id)
    if (h) return h(node, context, graph)
    return { status: 'SUCCESS' as const }
  }
  registry.setDefault(defaultHandler)

  // These are NOT needed for direct parallel handler calls, but register them for safety
  registry.register('start', startHandler)
  registry.register('exit', exitHandler)
  registry.register(
    'parallel',
    createParallelHandler({
      handlerRegistry: registry,
      ...(opts?.eventBus !== undefined ? { eventBus: opts.eventBus } : {}),
      ...(opts?.runId !== undefined ? { runId: opts.runId } : {}),
    })
  )
  registry.register('parallel.fan_in', createFanInHandler())

  return registry
}

// ---------------------------------------------------------------------------
// AC1: wait_all policy tests
// ---------------------------------------------------------------------------

describe('parallel fan-out/fan-in — wait_all policy', () => {
  it('3-branch wait_all: all branches succeed → pipeline returns SUCCESS', async () => {
    const graph = parseGraph(PARALLEL_FAN_OUT_DOT)
    const mocks = new Map<string, NodeHandler>()
    mocks.set('branch_a', vi.fn().mockResolvedValue({ status: 'SUCCESS' }))
    mocks.set('branch_b', vi.fn().mockResolvedValue({ status: 'SUCCESS' }))
    mocks.set('branch_c', vi.fn().mockResolvedValue({ status: 'SUCCESS' }))

    const fanOutNode = graph.nodes.get('fan_out')!
    const fanInNode = graph.nodes.get('fan_in')!
    const registry = makeChainRegistry(mocks)
    const parallelHandler = registry.resolve(fanOutNode)
    const fanInHandler = registry.resolve(fanInNode)

    const context = new GraphContext({ __runId: 'test-wait-all' })

    const parallelOutcome = await parallelHandler(fanOutNode, context, graph)
    expect(parallelOutcome.status).toBe('SUCCESS')

    const results = context.get('parallel.results') as FanInBranchResult[]
    expect(Array.isArray(results)).toBe(true)
    expect(results).toHaveLength(3)

    const fanInOutcome = await fanInHandler(fanInNode, context, graph)
    expect(fanInOutcome.status).toBe('SUCCESS')

    const bestId = context.get('parallel.fan_in.best_id')
    expect(bestId).toBeDefined()
  })

  it('wait_all: 1 branch fails, 2 succeed → fan_in picks best of successful branches', async () => {
    const graph = parseGraph(PARALLEL_FAN_OUT_DOT)
    const mocks = new Map<string, NodeHandler>()
    mocks.set('branch_a', vi.fn().mockResolvedValue({ status: 'FAILURE' }))
    mocks.set('branch_b', vi.fn().mockResolvedValue({ status: 'SUCCESS' }))
    mocks.set('branch_c', vi.fn().mockResolvedValue({ status: 'SUCCESS' }))

    const fanOutNode = graph.nodes.get('fan_out')!
    const fanInNode = graph.nodes.get('fan_in')!
    const registry = makeChainRegistry(mocks)
    const parallelHandler = registry.resolve(fanOutNode)
    const fanInHandler = registry.resolve(fanInNode)

    const context = new GraphContext({ __runId: 'test-1-fail' })

    await parallelHandler(fanOutNode, context, graph)

    const fanInOutcome = await fanInHandler(fanInNode, context, graph)
    expect(fanInOutcome.status).toBe('SUCCESS')

    const bestId = context.get('parallel.fan_in.best_id') as number
    // branch_b and branch_c succeed (indices 1 and 2); fan_in picks lowest branch_id among eligible
    expect([1, 2]).toContain(bestId)
  })

  it('wait_all: all 3 branches fail → fan_in returns FAILURE', async () => {
    const graph = parseGraph(PARALLEL_FAN_OUT_DOT)
    const mocks = new Map<string, NodeHandler>()
    mocks.set('branch_a', vi.fn().mockResolvedValue({ status: 'FAILURE' }))
    mocks.set('branch_b', vi.fn().mockResolvedValue({ status: 'FAILURE' }))
    mocks.set('branch_c', vi.fn().mockResolvedValue({ status: 'FAILURE' }))

    const fanOutNode = graph.nodes.get('fan_out')!
    const fanInNode = graph.nodes.get('fan_in')!
    const registry = makeChainRegistry(mocks)
    const parallelHandler = registry.resolve(fanOutNode)
    const fanInHandler = registry.resolve(fanInNode)

    const context = new GraphContext({ __runId: 'test-all-fail' })

    await parallelHandler(fanOutNode, context, graph)

    const fanInOutcome = await fanInHandler(fanInNode, context, graph)
    expect(fanInOutcome.status).toBe('FAILURE')
    expect(fanInOutcome.failureReason).toContain('all branches failed')
  })

  it('wait_all: winning branch context_updates merged into parent context', async () => {
    const graph = parseGraph(PARALLEL_FAN_OUT_DOT)
    const mocks = new Map<string, NodeHandler>()
    // Branch_a (index 0) sets a unique key in its context
    mocks.set(
      'branch_a',
      vi.fn(async (_node: GraphNode, ctx: IGraphContext) => {
        ctx.set('winner_key', 'from_branch_a')
        return { status: 'SUCCESS' as const }
      })
    )
    mocks.set('branch_b', vi.fn().mockResolvedValue({ status: 'FAILURE' }))
    mocks.set('branch_c', vi.fn().mockResolvedValue({ status: 'FAILURE' }))

    const fanOutNode = graph.nodes.get('fan_out')!
    const fanInNode = graph.nodes.get('fan_in')!
    const registry = makeChainRegistry(mocks)
    const parallelHandler = registry.resolve(fanOutNode)
    const fanInHandler = registry.resolve(fanInNode)

    const context = new GraphContext({ __runId: 'test-merge' })

    await parallelHandler(fanOutNode, context, graph)
    await fanInHandler(fanInNode, context, graph)

    // branch_a is the only SUCCESS, so it wins; its context snapshot is merged
    expect(context.get('winner_key')).toBe('from_branch_a')
  })
})

// ---------------------------------------------------------------------------
// first_success policy tests
// ---------------------------------------------------------------------------

describe('parallel fan-out/fan-in — first_success policy', () => {
  it('first_success: first branch to succeed resolves immediately → SUCCESS', async () => {
    const graph = parseGraph(FIRST_SUCCESS_POLICY_DOT)

    let resolveA: (v: void) => void
    const blockA = new Promise<void>((resolve) => {
      resolveA = resolve
    })

    // branch_a is delayed; branch_b resolves immediately
    const mocks = new Map<string, NodeHandler>()
    mocks.set(
      'branch_a',
      vi.fn(async () => {
        await blockA
        return { status: 'SUCCESS' as const }
      })
    )
    mocks.set('branch_b', vi.fn().mockResolvedValue({ status: 'SUCCESS' }))

    // Unblock branch_a after branch_b has resolved
    setTimeout(() => resolveA!(undefined), 50)

    const fanOutNode = graph.nodes.get('fan_out')!
    // Set a short drain timeout so the test doesn't wait 5000ms (default drain)
    fanOutNode.attrs = { cancel_drain_timeout_ms: '10' }
    const registry = makeChainRegistry(mocks)
    const parallelHandler = registry.resolve(fanOutNode)

    const context = new GraphContext({ __runId: 'test-first-success' })
    const outcome = await parallelHandler(fanOutNode, context, graph)

    expect(outcome.status).toBe('SUCCESS')

    const results = context.get('parallel.results') as FanInBranchResult[]
    const successCount = results.filter((r) => r.status === 'SUCCESS').length
    expect(successCount).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// quorum policy tests
// ---------------------------------------------------------------------------

describe('parallel fan-out/fan-in — quorum policy', () => {
  it('quorum=2: 2 of 3 branches succeed → SUCCESS', async () => {
    const graph = parseGraph(QUORUM_POLICY_DOT)
    // Post-process: add quorum_size + short drain timeout to fan_out.attrs
    const fanOutNode = graph.nodes.get('fan_out')!
    fanOutNode.attrs = { quorum_size: '2', cancel_drain_timeout_ms: '10' }

    const mocks = new Map<string, NodeHandler>()
    mocks.set('branch_a', vi.fn().mockResolvedValue({ status: 'SUCCESS' }))
    mocks.set('branch_b', vi.fn().mockResolvedValue({ status: 'SUCCESS' }))
    mocks.set('branch_c', vi.fn().mockResolvedValue({ status: 'FAILURE' }))

    const registry = makeChainRegistry(mocks)
    const parallelHandler = registry.resolve(fanOutNode)

    const context = new GraphContext({ __runId: 'test-quorum-pass' })
    const outcome = await parallelHandler(fanOutNode, context, graph)

    expect(outcome.status).toBe('SUCCESS')
    const quorumReached = context.get('parallel.quorum_reached') as number
    expect(quorumReached).toBeGreaterThanOrEqual(2)
  })

  it('quorum=2: only 1 of 3 branches succeeds → FAILURE', async () => {
    const graph = parseGraph(QUORUM_POLICY_DOT)
    const fanOutNode = graph.nodes.get('fan_out')!
    fanOutNode.attrs = { quorum_size: '2', cancel_drain_timeout_ms: '10' }

    const mocks = new Map<string, NodeHandler>()
    mocks.set('branch_a', vi.fn().mockResolvedValue({ status: 'SUCCESS' }))
    mocks.set('branch_b', vi.fn().mockResolvedValue({ status: 'FAILURE' }))
    mocks.set('branch_c', vi.fn().mockResolvedValue({ status: 'FAILURE' }))

    const registry = makeChainRegistry(mocks)
    const parallelHandler = registry.resolve(fanOutNode)

    const context = new GraphContext({ __runId: 'test-quorum-fail' })
    const outcome = await parallelHandler(fanOutNode, context, graph)

    expect(outcome.status).toBe('FAILURE')
  })
})

// ---------------------------------------------------------------------------
// Bounded concurrency
// ---------------------------------------------------------------------------

describe('parallel fan-out/fan-in — bounded concurrency', () => {
  it('maxParallel=2 with 4 branches: at most 2 handlers running concurrently', async () => {
    const graph = parseGraph(BOUNDED_CONCURRENCY_DOT)
    const fanOutNode = graph.nodes.get('fan_out')!
    // maxParallel is set via DOT attribute [maxParallel=2], parsed to node.maxParallel=2

    let concurrent = 0
    let maxConcurrent = 0
    const resolvers: Array<() => void> = []

    const delayedHandler = vi.fn(async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise<void>((resolve) => resolvers.push(resolve))
      concurrent--
      return { status: 'SUCCESS' as const }
    })

    const mocks = new Map<string, NodeHandler>()
    mocks.set('branch_a', delayedHandler)
    mocks.set('branch_b', delayedHandler)
    mocks.set('branch_c', delayedHandler)
    mocks.set('branch_d', delayedHandler)

    const registry = makeChainRegistry(mocks)
    const parallelHandler = registry.resolve(fanOutNode)

    const context = new GraphContext({ __runId: 'test-bounded' })

    // Start execution then progressively release branches
    const runPromise = parallelHandler(fanOutNode, context, graph)

    // Release 2 at a time to verify bounded concurrency
    await new Promise<void>((r) => setTimeout(r, 10))
    while (resolvers.length > 0) {
      const r = resolvers.shift()
      r?.()
      await new Promise<void>((r2) => setTimeout(r2, 5))
    }

    await runPromise
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// Fan-in heuristic selection
// ---------------------------------------------------------------------------

describe('fan-in — heuristic winner selection', () => {
  it('rankBranches: SUCCESS beats FAILURE; picks lowest branch_id on tie', () => {
    const results: FanInBranchResult[] = [
      { branch_id: 0, status: 'FAILURE', failure_reason: 'err' },
      { branch_id: 1, status: 'SUCCESS' },
      { branch_id: 2, status: 'SUCCESS' },
    ]
    const winner = rankBranches(results)
    expect(winner).not.toBeNull()
    expect(winner!.status).toBe('SUCCESS')
    expect(winner!.branch_id).toBe(1) // lowest branch_id among SUCCESS
  })

  it('rankBranches: score descending as secondary sort criterion', () => {
    const results: FanInBranchResult[] = [
      { branch_id: 0, status: 'SUCCESS', score: 5 },
      { branch_id: 1, status: 'SUCCESS', score: 10 },
      { branch_id: 2, status: 'SUCCESS', score: 7 },
    ]
    const winner = rankBranches(results)
    expect(winner!.branch_id).toBe(1) // highest score
  })

  it('fan-in LLM mode: mock LLM returns branch_id 2 → that branch wins', async () => {
    const graph = parseGraph(PARALLEL_FAN_OUT_DOT)
    const mocks = new Map<string, NodeHandler>()
    mocks.set('branch_a', vi.fn().mockResolvedValue({ status: 'SUCCESS' }))
    mocks.set('branch_b', vi.fn().mockResolvedValue({ status: 'SUCCESS' }))
    mocks.set('branch_c', vi.fn().mockResolvedValue({ status: 'SUCCESS' }))

    const fanOutNode = graph.nodes.get('fan_out')!
    const fanInNode = graph.nodes.get('fan_in')!
    // fan_in node needs a prompt for LLM selection
    fanInNode.prompt = 'Select the best implementation branch'

    const mockLlmCall = vi.fn().mockResolvedValue('2') // LLM picks branch_id=2
    const registry = makeChainRegistry(mocks, {})
    const parallelHandler = registry.resolve(fanOutNode)
    const fanInHandler = createFanInHandler({ llmCall: mockLlmCall })

    const context = new GraphContext({ __runId: 'test-llm-fan-in' })

    await parallelHandler(fanOutNode, context, graph)
    const outcome = await fanInHandler(fanInNode, context, graph)

    expect(outcome.status).toBe('SUCCESS')
    expect(context.get('parallel.fan_in.best_id')).toBe(2)
    expect(mockLlmCall).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Context isolation between branches
// ---------------------------------------------------------------------------

describe('parallel fan-out/fan-in — context isolation', () => {
  it('mutations in branch_a context are not visible in branch_b context', async () => {
    const graph = parseGraph(PARALLEL_FAN_OUT_DOT)
    const mocks = new Map<string, NodeHandler>()

    mocks.set(
      'branch_a',
      vi.fn(async (_node: GraphNode, ctx: IGraphContext) => {
        ctx.set('key_a', 'value_from_a')
        return { status: 'SUCCESS' as const }
      })
    )
    mocks.set(
      'branch_b',
      vi.fn(async (_node: GraphNode, ctx: IGraphContext) => {
        ctx.set('key_b', 'value_from_b')
        return { status: 'SUCCESS' as const }
      })
    )
    mocks.set('branch_c', vi.fn().mockResolvedValue({ status: 'SUCCESS' }))

    const fanOutNode = graph.nodes.get('fan_out')!
    const registry = makeChainRegistry(mocks)
    const parallelHandler = registry.resolve(fanOutNode)

    const context = new GraphContext({ __runId: 'test-isolation' })
    await parallelHandler(fanOutNode, context, graph)

    const results = context.get('parallel.results') as Array<Record<string, unknown>>
    // branch_a snapshot (index 0) should have key_a but NOT key_b
    const branchAResult = results.find((r) => r['branch_id'] === 0)
    const branchAContext = branchAResult?.['context_updates'] as Record<string, unknown> | undefined
    expect(branchAContext?.['key_a']).toBe('value_from_a')
    expect(branchAContext?.['key_b']).toBeUndefined()

    // branch_b snapshot (index 1) should have key_b but NOT key_a
    const branchBResult = results.find((r) => r['branch_id'] === 1)
    const branchBContext = branchBResult?.['context_updates'] as Record<string, unknown> | undefined
    expect(branchBContext?.['key_b']).toBe('value_from_b')
    expect(branchBContext?.['key_a']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Event emission tests (full executor runs)
// ---------------------------------------------------------------------------

describe('parallel fan-out/fan-in — event emission', () => {
  let logsRoot: string

  beforeEach(async () => {
    logsRoot = await makeTmpDir()
  })

  afterEach(async () => {
    await cleanDir(logsRoot)
  })

  it('graph:parallel-started emitted once with correct branchCount=3', async () => {
    const graph = parseGraph(PARALLEL_FAN_OUT_DOT)
    const { bus, events } = makeEventSpy()

    const registry = makeParallelRegistry(new Map(), { eventBus: bus, runId: 'evt-test' })
    const result = await createGraphExecutor().run(graph, {
      runId: 'evt-test',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
    })

    expect(result.status).toBe('SUCCESS')

    const parallelStarted = events.filter((e) => e.event === 'graph:parallel-started')
    expect(parallelStarted).toHaveLength(1)

    const payload = parallelStarted[0]!.payload as {
      branchCount: number
      policy: string
      runId: string
    }
    expect(payload.branchCount).toBe(3)
    expect(payload.policy).toBe('wait_all')
    expect(payload.runId).toBe('evt-test')
  })

  it('graph:parallel-branch-started emitted once per branch (3 times)', async () => {
    const graph = parseGraph(PARALLEL_FAN_OUT_DOT)
    const { bus, events } = makeEventSpy()

    const registry = makeParallelRegistry(new Map(), { eventBus: bus, runId: 'evt-branch-start' })
    await createGraphExecutor().run(graph, {
      runId: 'evt-branch-start',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
    })

    const branchStarted = events.filter((e) => e.event === 'graph:parallel-branch-started')
    expect(branchStarted).toHaveLength(3)

    const indices = branchStarted.map((e) => (e.payload as { branchIndex: number }).branchIndex)
    expect(indices).toContain(0)
    expect(indices).toContain(1)
    expect(indices).toContain(2)
  })

  it('graph:parallel-branch-completed emitted once per branch with durationMs >= 0', async () => {
    const graph = parseGraph(PARALLEL_FAN_OUT_DOT)
    const { bus, events } = makeEventSpy()

    const registry = makeParallelRegistry(new Map(), { eventBus: bus, runId: 'evt-branch-done' })
    await createGraphExecutor().run(graph, {
      runId: 'evt-branch-done',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
    })

    const branchCompleted = events.filter((e) => e.event === 'graph:parallel-branch-completed')
    expect(branchCompleted).toHaveLength(3)

    for (const evt of branchCompleted) {
      const p = evt.payload as { durationMs: number }
      expect(p.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('graph:parallel-completed emitted once; completedCount + cancelledCount === 3', async () => {
    const graph = parseGraph(PARALLEL_FAN_OUT_DOT)
    const { bus, events } = makeEventSpy()

    const registry = makeParallelRegistry(new Map(), { eventBus: bus, runId: 'evt-parallel-done' })
    await createGraphExecutor().run(graph, {
      runId: 'evt-parallel-done',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
    })

    const parallelCompleted = events.filter((e) => e.event === 'graph:parallel-completed')
    expect(parallelCompleted).toHaveLength(1)

    const payload = parallelCompleted[0]!.payload as {
      completedCount: number
      cancelledCount: number
    }
    expect(payload.completedCount + payload.cancelledCount).toBe(3)
  })

  it('graph:parallel-started appears before graph:parallel-branch-started in event stream', async () => {
    const graph = parseGraph(PARALLEL_FAN_OUT_DOT)
    const { bus, events } = makeEventSpy()

    const registry = makeParallelRegistry(new Map(), { eventBus: bus, runId: 'evt-order' })
    await createGraphExecutor().run(graph, {
      runId: 'evt-order',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
    })

    const types = events.map((e) => e.event)
    const parallelStartIdx = types.indexOf('graph:parallel-started')
    const firstBranchStartIdx = types.indexOf('graph:parallel-branch-started')
    expect(parallelStartIdx).toBeGreaterThanOrEqual(0)
    expect(firstBranchStartIdx).toBeGreaterThanOrEqual(0)
    expect(parallelStartIdx).toBeLessThan(firstBranchStartIdx)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('parallel fan-out/fan-in — edge cases', () => {
  it('absent eventBus: parallel handler runs without TypeError', async () => {
    const graph = parseGraph(PARALLEL_FAN_OUT_DOT)
    const fanOutNode = graph.nodes.get('fan_out')!
    const registry = makeChainRegistry(new Map())
    const parallelHandler = registry.resolve(fanOutNode)

    const context = new GraphContext({ __runId: 'test-no-bus' })
    await expect(parallelHandler(fanOutNode, context, graph)).resolves.not.toThrow()
  })

  it('empty parallel node (0 branches): returns SUCCESS without crash', async () => {
    // Build a graph with a parallel node that has no outgoing edges
    const emptyParallelDot = `
      digraph empty_parallel {
        start   [type="start"];
        fan_out [type="parallel"];
        exit    [type="exit"];
        start   -> fan_out;
        fan_out -> exit;
      }
    `
    const graph = parseGraph(emptyParallelDot)
    const fanOutNode = graph.nodes.get('fan_out')!

    // Override outgoingEdges for fan_out to return empty (fan_out only has edge to exit)
    // Actually fan_out has 1 edge to exit — parallel handler sees that as 1 branch
    // For truly empty, we create a stub with no outgoing edges from fan_out
    const emptyGraph = {
      ...graph,
      outgoingEdges: (nodeId: string) => {
        if (nodeId === 'fan_out') return []
        return graph.outgoingEdges(nodeId)
      },
    } as Graph

    const registry = makeChainRegistry(new Map())
    const parallelHandler = registry.resolve(fanOutNode)

    const context = new GraphContext({ __runId: 'test-empty' })
    const outcome = await parallelHandler(fanOutNode, context, emptyGraph)

    expect(outcome.status).toBe('SUCCESS')
  })
})
