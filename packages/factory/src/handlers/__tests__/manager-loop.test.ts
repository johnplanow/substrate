/**
 * Unit tests for the manager loop handler (story 50-8).
 *
 * Covers AC1–AC7:
 *   AC1 – Body graph executes each cycle, contextUpdates merged into parent
 *   AC2 – max_cycles enforcement terminates the loop
 *   AC3 – Stop condition (context key truthiness) exits early
 *   AC4 – LLM stop condition evaluated with/without llmCall
 *   AC5 – Cycle telemetry written to context each iteration
 *   AC6 – Stall detection injects/clears steering hints
 *   AC7 – ≥12 test cases (this file)
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
import { createManagerLoopHandler } from '../manager-loop.js'
import type { ManagerLoopHandlerOptions } from '../manager-loop.js'
import { createDefaultRegistry } from '../registry.js'
import { GraphContext } from '../../graph/context.js'
import type { GraphNode, Graph, IGraphContext } from '../../graph/types.js'

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const VALID_DOT = `digraph G { start [shape=Mdiamond]; exit [shape=Msquare]; start -> exit; }`
const STUB_GRAPH = {} as Graph

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockParseGraph = vi.mocked(parseGraph)
const mockCreateGraphExecutor = vi.mocked(createGraphExecutor)
const mockCreateValidator = vi.mocked(createValidator)

// ---------------------------------------------------------------------------
// Helper: makeNode
// ---------------------------------------------------------------------------

function makeNode(attrs?: Record<string, string>): GraphNode {
  const node: GraphNode = {
    id: 'manager_loop_1',
    label: '',
    shape: '',
    type: 'stack.manager_loop',
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
  if (attrs !== undefined) {
    node.attrs = attrs
  }
  return node
}

// ---------------------------------------------------------------------------
// Helper: makeCtx
// ---------------------------------------------------------------------------

function makeCtx(snapshot?: Record<string, unknown>): IGraphContext {
  return new GraphContext(snapshot)
}

// ---------------------------------------------------------------------------
// Helper: makeOptions
// ---------------------------------------------------------------------------

function makeOptions(overrides?: Partial<ManagerLoopHandlerOptions>): ManagerLoopHandlerOptions {
  return {
    handlerRegistry: createDefaultRegistry(),
    graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Default mock setup — reset before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()

  // parseGraph: returns stub graph by default
  mockParseGraph.mockReturnValue(STUB_GRAPH)

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
// AC1 – Single cycle, body executes once
// ---------------------------------------------------------------------------

describe('createManagerLoopHandler — single cycle (AC1)', () => {
  it('executes body once and returns SUCCESS when max_cycles=1', async () => {
    const handler = createManagerLoopHandler(makeOptions())
    const ctx = makeCtx()
    const result = await handler(
      makeNode({ graph_file: 'body.dot', max_cycles: '1' }),
      ctx,
      STUB_GRAPH,
    )

    expect(result.status).toBe('SUCCESS')
    expect(mockCreateGraphExecutor).toHaveBeenCalledTimes(1)
    expect(ctx.get('manager_loop.cycles_completed')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// AC2 – max_cycles enforcement
// ---------------------------------------------------------------------------

describe('createManagerLoopHandler — max_cycles enforcement (AC2)', () => {
  it('runs exactly 3 cycles when max_cycles="3" and sets stop_reason to max_cycles', async () => {
    const mockRun = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    const handler = createManagerLoopHandler(makeOptions())
    const ctx = makeCtx()
    const result = await handler(
      makeNode({ graph_file: 'body.dot', max_cycles: '3' }),
      ctx,
      STUB_GRAPH,
    )

    expect(result.status).toBe('SUCCESS')
    expect(mockRun).toHaveBeenCalledTimes(3)
    expect(ctx.get('manager_loop.cycles_completed')).toBe(3)
    expect(ctx.get('manager_loop.stop_reason')).toBe('max_cycles')
  })

  it('defaults to 10 cycles when max_cycles attribute is absent', async () => {
    const mockRun = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    const handler = createManagerLoopHandler(makeOptions())
    const ctx = makeCtx()
    await handler(makeNode({ graph_file: 'body.dot' }), ctx, STUB_GRAPH)

    expect(mockRun).toHaveBeenCalledTimes(10)
    expect(ctx.get('manager_loop.stop_reason')).toBe('max_cycles')
  })

  it('defaults to 10 cycles when max_cycles is NaN', async () => {
    const mockRun = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    const handler = createManagerLoopHandler(makeOptions())
    const ctx = makeCtx()
    await handler(makeNode({ graph_file: 'body.dot', max_cycles: 'notanumber' }), ctx, STUB_GRAPH)

    expect(mockRun).toHaveBeenCalledTimes(10)
  })
})

// ---------------------------------------------------------------------------
// AC3 – Stop condition: context key truthiness
// ---------------------------------------------------------------------------

describe('createManagerLoopHandler — stop_condition context key (AC3)', () => {
  it('exits early when stop_condition key is truthy after a cycle', async () => {
    // Body sets 'done' = true in contextUpdates
    const mockRun = vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      contextUpdates: { done: true },
    })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    const handler = createManagerLoopHandler(makeOptions())
    const ctx = makeCtx()
    const result = await handler(
      makeNode({ graph_file: 'body.dot', max_cycles: '5', stop_condition: 'done' }),
      ctx,
      STUB_GRAPH,
    )

    expect(result.status).toBe('SUCCESS')
    expect(mockRun).toHaveBeenCalledTimes(1)
    expect(ctx.get('manager_loop.stop_reason')).toBe('stop_condition')
  })

  it('runs all cycles when stop_condition key is never set (falsy)', async () => {
    const mockRun = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    const handler = createManagerLoopHandler(makeOptions())
    const ctx = makeCtx()
    await handler(
      makeNode({ graph_file: 'body.dot', max_cycles: '3', stop_condition: 'done' }),
      ctx,
      STUB_GRAPH,
    )

    expect(mockRun).toHaveBeenCalledTimes(3)
    expect(ctx.get('manager_loop.stop_reason')).toBe('max_cycles')
  })
})

// ---------------------------------------------------------------------------
// AC4 – Stop condition: LLM-evaluated
// ---------------------------------------------------------------------------

describe('createManagerLoopHandler — stop_condition llm: prefix (AC4)', () => {
  it('exits early when llmCall returns affirmative for llm: stop_condition', async () => {
    const mockRun = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    const llmCall = vi.fn().mockResolvedValue('yes')
    const handler = createManagerLoopHandler(
      makeOptions({ llmCall, graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT) }),
    )
    const ctx = makeCtx()
    const result = await handler(
      makeNode({ graph_file: 'body.dot', max_cycles: '5', stop_condition: 'llm: Is done?' }),
      ctx,
      STUB_GRAPH,
    )

    expect(result.status).toBe('SUCCESS')
    expect(mockRun).toHaveBeenCalledTimes(1)
    expect(ctx.get('manager_loop.stop_reason')).toBe('stop_condition')
    expect(llmCall).toHaveBeenCalledTimes(1)
  })

  it('continues all cycles when llmCall returns negative for llm: stop_condition', async () => {
    const mockRun = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    const llmCall = vi.fn().mockResolvedValue('no')
    const handler = createManagerLoopHandler(
      makeOptions({ llmCall, graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT) }),
    )
    const ctx = makeCtx()
    await handler(
      makeNode({ graph_file: 'body.dot', max_cycles: '3', stop_condition: 'llm: Is done?' }),
      ctx,
      STUB_GRAPH,
    )

    expect(mockRun).toHaveBeenCalledTimes(3)
    expect(ctx.get('manager_loop.stop_reason')).toBe('max_cycles')
  })

  it('continues all cycles when no llmCall provided (llm: condition is always false)', async () => {
    const mockRun = vi.fn().mockResolvedValue({ status: 'SUCCESS' })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    // No llmCall in options — omit the field entirely (exactOptionalPropertyTypes: true)
    const handler = createManagerLoopHandler(
      makeOptions({ graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT) }),
    )
    const ctx = makeCtx()
    await handler(
      makeNode({ graph_file: 'body.dot', max_cycles: '3', stop_condition: 'llm: Is done?' }),
      ctx,
      STUB_GRAPH,
    )

    expect(mockRun).toHaveBeenCalledTimes(3)
    expect(ctx.get('manager_loop.stop_reason')).toBe('max_cycles')
  })
})

// ---------------------------------------------------------------------------
// AC5 – Cycle telemetry
// ---------------------------------------------------------------------------

describe('createManagerLoopHandler — cycle telemetry (AC5)', () => {
  it('updates cycle, cycles_completed, and last_outcome after each cycle', async () => {
    let capturedCycleAtRun2 = 0
    let callCount = 0
    const mockRun = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.resolve({ status: callCount === 1 ? 'SUCCESS' : 'FAIL' })
    })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    const handler = createManagerLoopHandler(makeOptions())
    const ctx = makeCtx()
    await handler(
      makeNode({ graph_file: 'body.dot', max_cycles: '2' }),
      ctx,
      STUB_GRAPH,
    )

    // After 2 cycles
    expect(ctx.get('manager_loop.cycle')).toBe(2)
    expect(ctx.get('manager_loop.cycles_completed')).toBe(2)
    expect(ctx.get('manager_loop.last_outcome')).toBe('FAIL')
  })
})

// ---------------------------------------------------------------------------
// AC6 – Stall detection
// ---------------------------------------------------------------------------

describe('createManagerLoopHandler — stall detection (AC6)', () => {
  it('injects recovery steering after 2 consecutive non-SUCCESS cycles', async () => {
    const mockRun = vi.fn().mockResolvedValue({ status: 'FAIL' })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    const handler = createManagerLoopHandler(
      makeOptions({ maxStallCycles: 2, graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT) }),
    )
    const ctx = makeCtx()
    await handler(
      makeNode({ graph_file: 'body.dot', max_cycles: '3' }),
      ctx,
      STUB_GRAPH,
    )

    expect(ctx.get('manager_loop.steering.mode')).toBe('recovery')
    const hints = ctx.get('manager_loop.steering.hints') as string[]
    expect(Array.isArray(hints)).toBe(true)
    expect(hints.length).toBeGreaterThan(0)
  })

  it('clears steering to normal after a SUCCESS cycle following failures', async () => {
    let callCount = 0
    const mockRun = vi.fn().mockImplementation(() => {
      callCount++
      // First 2 cycles fail, 3rd succeeds
      return Promise.resolve({ status: callCount <= 2 ? 'FAIL' : 'SUCCESS' })
    })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    const handler = createManagerLoopHandler(
      makeOptions({ maxStallCycles: 2, graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT) }),
    )
    const ctx = makeCtx()
    await handler(
      makeNode({ graph_file: 'body.dot', max_cycles: '3' }),
      ctx,
      STUB_GRAPH,
    )

    expect(ctx.get('manager_loop.steering.mode')).toBe('normal')
    expect(ctx.get('manager_loop.steering.hints')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Missing graph_file attribute
// ---------------------------------------------------------------------------

describe('createManagerLoopHandler — missing graph_file (error handling)', () => {
  it('returns FAILURE with descriptive failureReason when graph_file is absent', async () => {
    const handler = createManagerLoopHandler(makeOptions())
    const ctx = makeCtx()
    // No attrs at all
    const result = await handler(makeNode(undefined), ctx, STUB_GRAPH)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('missing required attribute graph_file')
    expect(result.failureReason).toContain('manager_loop_1')
  })

  it('returns FAILURE when graph_file is an empty string', async () => {
    const handler = createManagerLoopHandler(makeOptions())
    const ctx = makeCtx()
    const result = await handler(makeNode({ graph_file: '' }), ctx, STUB_GRAPH)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('missing required attribute graph_file')
  })
})

// ---------------------------------------------------------------------------
// Body executor non-SUCCESS updates last_outcome, loop continues
// ---------------------------------------------------------------------------

describe('createManagerLoopHandler — non-SUCCESS body outcome (AC5 complement)', () => {
  it('records FAIL last_outcome and continues loop without stopping', async () => {
    let callCount = 0
    const mockRun = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.resolve({ status: callCount < 3 ? 'FAIL' : 'SUCCESS' })
    })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    const handler = createManagerLoopHandler(makeOptions())
    const ctx = makeCtx()
    const result = await handler(
      makeNode({ graph_file: 'body.dot', max_cycles: '3' }),
      ctx,
      STUB_GRAPH,
    )

    expect(result.status).toBe('SUCCESS')
    expect(mockRun).toHaveBeenCalledTimes(3)
    // Last outcome was SUCCESS (3rd cycle)
    expect(ctx.get('manager_loop.last_outcome')).toBe('SUCCESS')
  })
})

// ---------------------------------------------------------------------------
// Registry wiring — createDefaultRegistry resolves stack.manager_loop
// ---------------------------------------------------------------------------

describe('createDefaultRegistry — stack.manager_loop handler wiring (AC7)', () => {
  it('resolves the stack.manager_loop type without throwing', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ graph_file: 'any.dot' })
    // resolve() should return a handler function (not throw)
    expect(() => registry.resolve(node)).not.toThrow()
    expect(typeof registry.resolve(node)).toBe('function')
  })
})
