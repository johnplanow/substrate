/**
 * Integration tests for subgraph execution handler.
 * Story 50-11 AC3.
 *
 * Tests cover:
 *   - Basic subgraph execution (happy path → SUCCESS)
 *   - Missing graph_file attribute → FAILURE
 *   - graphFileLoader throws → FAILURE with load error
 *   - Invalid child DOT → FAILURE with parse error
 *   - Max-depth guard → FAILURE when depth >= maxDepth
 *   - graph:subgraph-started emitted with correct payload
 *   - graph:subgraph-completed emitted on success
 *   - Event ordering (started before completed)
 *   - Absent eventBus handling
 *   - runId resolution from context.__runId
 *   - Custom maxDepth option honoured
 *
 * Test approach: invoke `createSubgraphHandler(options)` directly with an
 * injectable `graphFileLoader` — no real disk access.
 *
 * ≥12 `it(...)` cases required (AC7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'node:os'

import { parseGraph } from '../../graph/parser.js'
import { GraphContext } from '../../graph/context.js'
import { HandlerRegistry } from '../../handlers/registry.js'
import { startHandler } from '../../handlers/start.js'
import { exitHandler } from '../../handlers/exit.js'
import { createSubgraphHandler } from '../../handlers/subgraph.js'
import type { Graph } from '../../graph/types.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'

import {
  SUBGRAPH_PARENT_DOT,
  CHILD_GRAPH_DOT,
} from '../fixtures/subgraph-parent.dot.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Captured event entry */
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

/**
 * Build a HandlerRegistry suitable for executing the child DOT graphs in tests.
 * Registers start/exit plus a default SUCCESS handler for any other node type.
 */
function makeChildRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry()
  registry.register('start', startHandler)
  registry.register('exit', exitHandler)
  registry.setDefault(vi.fn().mockResolvedValue({ status: 'SUCCESS' }))
  return registry
}

/** Parsed parent graph with sg_node.attrs post-processed for a given graph_file path. */
function makeParentGraph(graphFile = '/test/child.dot'): { graph: Graph; sgNodeId: string } {
  const graph = parseGraph(SUBGRAPH_PARENT_DOT)
  const sgNode = graph.nodes.get('sg_node')!
  sgNode.attrs = { graph_file: graphFile }
  return { graph, sgNodeId: 'sg_node' }
}

// ---------------------------------------------------------------------------
// AC3: Subgraph basic execution
// ---------------------------------------------------------------------------

describe('subgraph execution — basic success path', () => {
  it('handler returns SUCCESS when child graph executes successfully', async () => {
    const { graph, sgNodeId } = makeParentGraph()
    const sgNode = graph.nodes.get(sgNodeId)!
    const registry = makeChildRegistry()

    const handler = createSubgraphHandler({
      handlerRegistry: registry,
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
    })

    const context = new GraphContext({ __runId: 'test-sg-basic' })
    const outcome = await handler(sgNode, context, graph)

    expect(outcome.status).toBe('SUCCESS')
  })

  it('handler returns FAILURE when node.attrs is missing graph_file', async () => {
    const graph = parseGraph(SUBGRAPH_PARENT_DOT)
    const sgNode = graph.nodes.get('sg_node')!
    // Intentionally do NOT set sgNode.attrs

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
    })

    const context = new GraphContext({ __runId: 'test-no-attr' })
    const outcome = await handler(sgNode, context, graph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toContain('missing required attribute graph_file')
  })

  it('handler returns FAILURE when graphFileLoader throws', async () => {
    const { graph, sgNodeId } = makeParentGraph()
    const sgNode = graph.nodes.get(sgNodeId)!

    const failingLoader = vi.fn().mockRejectedValue(new Error('file not found'))
    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: failingLoader,
    })

    const context = new GraphContext({ __runId: 'test-loader-fail' })
    const outcome = await handler(sgNode, context, graph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toContain('failed to load')
    expect(outcome.failureReason).toContain('file not found')
  })

  it('handler returns FAILURE when child DOT string is invalid (parse error)', async () => {
    const { graph, sgNodeId } = makeParentGraph()
    const sgNode = graph.nodes.get(sgNodeId)!

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue('THIS IS NOT VALID DOT SYNTAX @@@###'),
    })

    const context = new GraphContext({ __runId: 'test-invalid-dot' })
    const outcome = await handler(sgNode, context, graph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toContain('failed to parse')
  })
})

// ---------------------------------------------------------------------------
// Depth guard tests
// ---------------------------------------------------------------------------

describe('subgraph execution — depth guard', () => {
  it('returns FAILURE when subgraph._depth >= maxDepth (default 5)', async () => {
    const { graph, sgNodeId } = makeParentGraph()
    const sgNode = graph.nodes.get(sgNodeId)!

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      // maxDepth defaults to 5
    })

    // Set depth to 5 — equals maxDepth (5) → guard fires
    const context = new GraphContext({ __runId: 'test-depth-max', 'subgraph._depth': 5 })
    const outcome = await handler(sgNode, context, graph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toContain('depth limit exceeded')
  })

  it('custom maxDepth=2: depth=1 succeeds, depth=2 fails', async () => {
    const { graph, sgNodeId } = makeParentGraph()
    const sgNode = graph.nodes.get(sgNodeId)!

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      maxDepth: 2,
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
    })

    // depth=1 < maxDepth=2 → should succeed
    const contextOk = new GraphContext({ __runId: 'test-custom-depth-ok', 'subgraph._depth': 1 })
    const successOutcome = await handler(sgNode, contextOk, graph)
    expect(successOutcome.status).toBe('SUCCESS')

    // depth=2 >= maxDepth=2 → should fail
    const contextFail = new GraphContext({ __runId: 'test-custom-depth-fail', 'subgraph._depth': 2 })
    const failOutcome = await handler(sgNode, contextFail, graph)
    expect(failOutcome.status).toBe('FAILURE')
    expect(failOutcome.failureReason).toContain('depth limit exceeded')
  })
})

// ---------------------------------------------------------------------------
// Event emission tests
// ---------------------------------------------------------------------------

describe('subgraph execution — event emission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('graph:subgraph-started emitted once with correct nodeId', async () => {
    const { bus, events } = makeEventSpy()
    const { graph, sgNodeId } = makeParentGraph()
    const sgNode = graph.nodes.get(sgNodeId)!

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      eventBus: bus,
      runId: 'evt-test',
    })

    const context = new GraphContext({ __runId: 'evt-test' })
    await handler(sgNode, context, graph)

    const started = events.filter((e) => e.event === 'graph:subgraph-started')
    expect(started).toHaveLength(1)
    expect((started[0]!.payload as { nodeId: string }).nodeId).toBe('sg_node')
  })

  it('graph:subgraph-completed emitted once on success', async () => {
    const { bus, events } = makeEventSpy()
    const { graph, sgNodeId } = makeParentGraph()
    const sgNode = graph.nodes.get(sgNodeId)!

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      eventBus: bus,
      runId: 'evt-test',
    })

    const context = new GraphContext({ __runId: 'evt-test' })
    await handler(sgNode, context, graph)

    const completed = events.filter((e) => e.event === 'graph:subgraph-completed')
    expect(completed).toHaveLength(1)
    expect((completed[0]!.payload as { status: string }).status).toBe('SUCCESS')
  })

  it('graph:subgraph-completed has durationMs >= 0', async () => {
    const { bus, events } = makeEventSpy()
    const { graph, sgNodeId } = makeParentGraph()
    const sgNode = graph.nodes.get(sgNodeId)!

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      eventBus: bus,
    })

    const context = new GraphContext({ __runId: 'evt-duration' })
    await handler(sgNode, context, graph)

    const completed = events.filter((e) => e.event === 'graph:subgraph-completed')
    const durationMs = (completed[0]!.payload as { durationMs: number }).durationMs
    expect(typeof durationMs).toBe('number')
    expect(durationMs).toBeGreaterThanOrEqual(0)
  })

  it('graph:subgraph-started emitted before graph:subgraph-completed', async () => {
    const { bus, events } = makeEventSpy()
    const { graph, sgNodeId } = makeParentGraph()
    const sgNode = graph.nodes.get(sgNodeId)!

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      eventBus: bus,
    })

    const context = new GraphContext({ __runId: 'evt-order' })
    await handler(sgNode, context, graph)

    const types = events.map((e) => e.event)
    const startIdx = types.indexOf('graph:subgraph-started')
    const endIdx = types.indexOf('graph:subgraph-completed')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(endIdx).toBeGreaterThanOrEqual(0)
    expect(startIdx).toBeLessThan(endIdx)
  })

  it('graph:subgraph-started carries depth=0 for un-nested (root) subgraph', async () => {
    const { bus, events } = makeEventSpy()
    const { graph, sgNodeId } = makeParentGraph()
    const sgNode = graph.nodes.get(sgNodeId)!

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      eventBus: bus,
    })

    // No subgraph._depth in context → defaults to 0
    const context = new GraphContext({ __runId: 'evt-depth-root' })
    await handler(sgNode, context, graph)

    const started = events.find((e) => e.event === 'graph:subgraph-started')
    expect((started!.payload as { depth: number }).depth).toBe(0)
  })

  it('runId from context.__runId flows into subgraph event payloads', async () => {
    const { bus, events } = makeEventSpy()
    const { graph, sgNodeId } = makeParentGraph()
    const sgNode = graph.nodes.get(sgNodeId)!

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      eventBus: bus,
      // No runId in options — should fall back to context.__runId
    })

    const context = new GraphContext({ __runId: 'my-run-42' })
    await handler(sgNode, context, graph)

    const started = events.find((e) => e.event === 'graph:subgraph-started')
    expect((started!.payload as { runId: string }).runId).toBe('my-run-42')
  })

  it('absent eventBus: handler completes without crash', async () => {
    const { graph, sgNodeId } = makeParentGraph()
    const sgNode = graph.nodes.get(sgNodeId)!

    const handler = createSubgraphHandler({
      handlerRegistry: makeChildRegistry(),
      baseDir: '/test',
      graphFileLoader: vi.fn().mockResolvedValue(CHILD_GRAPH_DOT),
      logsRoot: os.tmpdir(),
      // No eventBus
    })

    const context = new GraphContext({ __runId: 'no-bus' })
    await expect(handler(sgNode, context, graph)).resolves.toMatchObject({ status: 'SUCCESS' })
  })
})
