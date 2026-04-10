/**
 * Unit tests for subgraph handler event emission (story 50-9).
 *
 * Covers AC2 / AC7:
 *   - graph:subgraph-started emitted before sub-executor runs with graphFile and depth
 *   - graph:subgraph-completed emitted after sub-executor returns with status and durationMs >= 0
 *   - No-op when eventBus absent (no TypeError)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock is hoisted automatically by Vitest so mocks are in place before imports
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
import { GraphContext } from '../../graph/context.js'
import type { GraphNode, Graph, IGraphContext } from '../../graph/types.js'
import type { IHandlerRegistry } from '../types.js'
import type { FactoryEvents } from '../../events.js'
import type { TypedEventBus } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_DOT = `digraph G { start [type="start"]; exit [type="exit"]; start -> exit; }`
const STUB_GRAPH = {} as Graph

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNode(attrsOverride?: Record<string, string>, id = 'sg-node'): GraphNode {
  const node: GraphNode = {
    id,
    label: '',
    shape: '',
    type: 'subgraph',
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
  if (attrsOverride !== undefined) {
    node.attrs = attrsOverride
  }
  return node
}

function makeCtx(snapshot?: Record<string, unknown>): IGraphContext {
  return new GraphContext(snapshot)
}

function makeCtxWithRunId(runId = 'test-run-sg'): IGraphContext {
  const ctx = new GraphContext()
  ctx.set('__runId', runId)
  return ctx
}

function makeStubRegistry(): IHandlerRegistry {
  return {
    register: vi.fn(),
    registerShape: vi.fn(),
    setDefault: vi.fn(),
    resolve: vi.fn(),
  }
}

function makeMockEventBus(): { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn() }
}

// Typed mock helpers
const mockParseGraph = vi.mocked(parseGraph)
const mockCreateGraphExecutor = vi.mocked(createGraphExecutor)
const mockCreateValidator = vi.mocked(createValidator)

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()

  mockParseGraph.mockReturnValue(STUB_GRAPH)

  mockCreateValidator.mockReturnValue({
    validate: vi.fn().mockReturnValue([]),
    validateOrRaise: vi.fn(),
    registerRule: vi.fn(),
  })

  mockCreateGraphExecutor.mockReturnValue({
    run: vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      contextUpdates: { 'sub.result': 'done' },
    }),
  })
})

// ---------------------------------------------------------------------------
// AC7 — Subgraph lifecycle events
// ---------------------------------------------------------------------------

describe('graph:subgraph-started', () => {
  it('is emitted before sub-executor runs with correct graphFile and depth=0', async () => {
    const mockBus = makeMockEventBus()
    const handler = createSubgraphHandler({
      handlerRegistry: makeStubRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
      eventBus: mockBus as unknown as TypedEventBus<FactoryEvents>,
    })

    const node = makeNode({ graph_file: 'sub.dot' })
    const ctx = makeCtxWithRunId('sg-run-1')

    await handler(node, ctx, STUB_GRAPH)

    const startedCalls = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'graph:subgraph-started'
    )
    expect(startedCalls).toHaveLength(1)
    expect(startedCalls[0]![1]).toMatchObject({
      runId: 'sg-run-1',
      nodeId: 'sg-node',
      graphFile: '/base/sub.dot',
      depth: 0,
    })
  })
})

describe('graph:subgraph-completed', () => {
  it('is emitted after sub-executor returns with status=SUCCESS and durationMs >= 0', async () => {
    const mockBus = makeMockEventBus()
    const handler = createSubgraphHandler({
      handlerRegistry: makeStubRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
      eventBus: mockBus as unknown as TypedEventBus<FactoryEvents>,
    })

    const node = makeNode({ graph_file: 'sub.dot' })
    const ctx = makeCtxWithRunId('sg-run-2')

    await handler(node, ctx, STUB_GRAPH)

    const completedCalls = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'graph:subgraph-completed'
    )
    expect(completedCalls).toHaveLength(1)
    const payload = completedCalls[0]![1] as { status: string; durationMs: number }
    expect(payload.status).toBe('SUCCESS')
    expect(payload.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('subgraph handler without eventBus', () => {
  it('executes successfully without TypeError when eventBus is absent', async () => {
    const handler = createSubgraphHandler({
      handlerRegistry: makeStubRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
      // No eventBus
    })

    const node = makeNode({ graph_file: 'sub.dot' })
    const ctx = makeCtxWithRunId('sg-run-3')

    const outcome = await handler(node, ctx, STUB_GRAPH)

    expect(outcome.status).toBe('SUCCESS')
  })
})

describe('subgraph event payload type conformance to FactoryEvents', () => {
  it('all emitted subgraph event payloads have field types matching FactoryEvents declarations', async () => {
    const mockBus = makeMockEventBus()
    const handler = createSubgraphHandler({
      handlerRegistry: makeStubRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
      eventBus: mockBus as unknown as TypedEventBus<FactoryEvents>,
    })

    const node = makeNode({ graph_file: 'sub.dot' })
    const ctx = makeCtxWithRunId('sg-run-conf')

    await handler(node, ctx, STUB_GRAPH)

    const calls = (mockBus.emit as ReturnType<typeof vi.fn>).mock.calls

    // graph:subgraph-started payload: { runId: string; nodeId: string; graphFile: string; depth: number }
    const startedPayload = calls.find(
      (c: unknown[]) => c[0] === 'graph:subgraph-started'
    )?.[1] as Record<string, unknown>
    expect(typeof startedPayload['runId']).toBe('string')
    expect(typeof startedPayload['nodeId']).toBe('string')
    expect(typeof startedPayload['graphFile']).toBe('string')
    expect(typeof startedPayload['depth']).toBe('number')

    // graph:subgraph-completed payload: { runId: string; nodeId: string; graphFile: string; depth: number; status: StageStatus; durationMs: number }
    const completedPayload = calls.find(
      (c: unknown[]) => c[0] === 'graph:subgraph-completed'
    )?.[1] as Record<string, unknown>
    expect(typeof completedPayload['runId']).toBe('string')
    expect(typeof completedPayload['nodeId']).toBe('string')
    expect(typeof completedPayload['graphFile']).toBe('string')
    expect(typeof completedPayload['depth']).toBe('number')
    expect(typeof completedPayload['status']).toBe('string')
    expect(typeof completedPayload['durationMs']).toBe('number')
  })
})
