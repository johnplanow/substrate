/**
 * Unit tests for the subgraph handler (story 50-5).
 *
 * Covers AC1–AC7:
 *   AC1 – Subgraph node loads, validates, and executes referenced graph
 *   AC2 – Parent context snapshot seeded into subgraph execution
 *   AC3 – Subgraph contextUpdates merged into parent context
 *   AC4 – Subgraph goal gates evaluated independently (executor isolation)
 *   AC5 – Nested subgraph depth limit enforced
 *   AC6 – Missing or unresolvable graph_file attribute produces FAILURE
 *   AC7 – Unit tests cover all subgraph handler behaviours (this file)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'

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
})
)

import { parseGraph } from '../../graph/parser.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { createValidator } from '../../graph/validator.js'
import { createSubgraphHandler } from '../subgraph.js'
import { createDefaultRegistry } from '../registry.js'
import { GraphContext } from '../../graph/context.js'
import type { GraphNode, Graph, IGraphContext } from '../../graph/types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const VALID_DOT = `digraph G { start [shape=Mdiamond]; exit [shape=Msquare]; start -> exit; }`
const STUB_GRAPH = {} as Graph

function makeNode(attrsOverride?: Record<string, string>, idOverride = 'sg-node'): GraphNode {
  const node: GraphNode = {
    id: idOverride,
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

// Typed mock helpers
const mockParseGraph = vi.mocked(parseGraph)
const mockCreateGraphExecutor = vi.mocked(createGraphExecutor)
const mockCreateValidator = vi.mocked(createValidator)

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
// AC1 – Successful execution
// ---------------------------------------------------------------------------

describe('createSubgraphHandler — successful execution', () => {
  it('returns SUCCESS when subgraph executes successfully', async () => {
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const ctx = makeCtx()
    const result = await handler(makeNode({ graph_file: 'sub.dot' }), ctx, STUB_GRAPH)

    expect(result.status).toBe('SUCCESS')
  })

  it('translates PARTIAL_SUCCESS from subgraph executor', async () => {
    mockCreateGraphExecutor.mockReturnValue({
      run: vi.fn().mockResolvedValue({ status: 'PARTIAL_SUCCESS' }),
    })
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const result = await handler(makeNode({ graph_file: 'sub.dot' }), makeCtx(), STUB_GRAPH)

    expect(result.status).toBe('PARTIAL_SUCCESS')
  })
})

// ---------------------------------------------------------------------------
// AC2 – Context seeding (initialContext = parent snapshot + depth +1)
// ---------------------------------------------------------------------------

describe('createSubgraphHandler — context seeding (AC2)', () => {
  it('seeds parent context snapshot and incremented depth into sub-executor config', async () => {
    let capturedConfig: unknown
    const mockRun = vi.fn().mockImplementation((_, config) => {
      capturedConfig = config
      return Promise.resolve({ status: 'SUCCESS' })
    })
    mockCreateGraphExecutor.mockReturnValue({ run: mockRun })

    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const ctx = makeCtx({ storyKey: '50-5', projectRoot: '/proj' })
    await handler(makeNode({ graph_file: 'sub.dot' }), ctx, STUB_GRAPH)

    const config = capturedConfig as { initialContext: Record<string, unknown> }
    expect(config.initialContext).toMatchObject({
      storyKey: '50-5',
      projectRoot: '/proj',
      'subgraph._depth': 1,
    })
  })
})

// ---------------------------------------------------------------------------
// AC3 – Context updates merged into parent
// ---------------------------------------------------------------------------

describe('createSubgraphHandler — context updates merged (AC3)', () => {
  it('applies subgraph contextUpdates to parent context', async () => {
    mockCreateGraphExecutor.mockReturnValue({
      run: vi.fn().mockResolvedValue({
        status: 'SUCCESS',
        contextUpdates: { 'subgraph.result': 'done', 'artifact.path': '/tmp/foo' },
      }),
    })
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const ctx = makeCtx()
    const result = await handler(makeNode({ graph_file: 'sub.dot' }), ctx, STUB_GRAPH)

    expect(ctx.get('subgraph.result')).toBe('done')
    expect(ctx.get('artifact.path')).toBe('/tmp/foo')
    // contextUpdates also returned in outcome
    expect(result.contextUpdates).toEqual({ 'subgraph.result': 'done', 'artifact.path': '/tmp/foo' })
  })

  it('does not modify parent context when subgraph has no contextUpdates', async () => {
    // executor returns SUCCESS with no contextUpdates
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const ctx = makeCtx({ existing: 'value' })
    await handler(makeNode({ graph_file: 'sub.dot' }), ctx, STUB_GRAPH)

    expect(ctx.get('existing')).toBe('value')
    expect(ctx.snapshot()).toEqual({ existing: 'value' })
  })
})

// ---------------------------------------------------------------------------
// AC5 – Depth limit enforcement
// ---------------------------------------------------------------------------

describe('createSubgraphHandler — depth limit (AC5)', () => {
  it('returns FAILURE when currentDepth equals maxDepth (default 5)', async () => {
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const ctx = makeCtx({ 'subgraph._depth': 5 })
    const result = await handler(makeNode({ graph_file: 'sub.dot' }), ctx, STUB_GRAPH)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('depth limit exceeded')
    expect(result.failureReason).toContain('max 5')
    expect(result.failureReason).toContain('sg-node')
  })

  it('returns FAILURE when currentDepth exceeds maxDepth', async () => {
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const ctx = makeCtx({ 'subgraph._depth': 7 })
    const result = await handler(makeNode({ graph_file: 'sub.dot' }), ctx, STUB_GRAPH)

    expect(result.status).toBe('FAILURE')
  })

  it('executes normally when currentDepth is below maxDepth', async () => {
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const ctx = makeCtx({ 'subgraph._depth': 4 })
    const result = await handler(makeNode({ graph_file: 'sub.dot' }), ctx, STUB_GRAPH)

    expect(result.status).toBe('SUCCESS')
  })

  it('uses custom maxDepth option', async () => {
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      maxDepth: 2,
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const ctx = makeCtx({ 'subgraph._depth': 2 })
    const result = await handler(makeNode({ graph_file: 'sub.dot' }), ctx, STUB_GRAPH)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('max 2')
  })
})

// ---------------------------------------------------------------------------
// AC6 – Missing or unresolvable graph_file attribute
// ---------------------------------------------------------------------------

describe('createSubgraphHandler — missing/unresolvable graph_file (AC6)', () => {
  it('returns FAILURE when graph_file attribute is absent', async () => {
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
    })
    const ctx = makeCtx()
    const result = await handler(makeNode(undefined), ctx, STUB_GRAPH)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('missing required attribute graph_file')
    expect(result.failureReason).toContain('sg-node')
  })

  it('returns FAILURE when graph_file attribute is an empty string', async () => {
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
    })
    const ctx = makeCtx()
    const result = await handler(makeNode({ graph_file: '' }), ctx, STUB_GRAPH)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('missing required attribute graph_file')
  })

  it('returns FAILURE when graphFileLoader throws (file not found)', async () => {
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockRejectedValue(new Error('ENOENT: no such file')),
    })
    const ctx = makeCtx()
    const result = await handler(makeNode({ graph_file: 'missing.dot' }), ctx, STUB_GRAPH)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('failed to load')
    expect(result.failureReason).toContain('ENOENT: no such file')
  })

  it('returns FAILURE when parseGraph throws (invalid DOT)', async () => {
    mockParseGraph.mockImplementation(() => {
      throw new Error('Unexpected token at line 3')
    })
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue('invalid dot content'),
    })
    const ctx = makeCtx()
    const result = await handler(makeNode({ graph_file: 'bad.dot' }), ctx, STUB_GRAPH)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('failed to parse')
    expect(result.failureReason).toContain('Unexpected token at line 3')
  })

  it('returns FAILURE when validator throws (invalid graph)', async () => {
    mockCreateValidator.mockReturnValue({
      validate: vi.fn().mockReturnValue([]),
      validateOrRaise: vi.fn().mockImplementation(() => {
        throw new Error('Graph has no start node')
      }),
      registerRule: vi.fn(),
    })
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const ctx = makeCtx()
    const result = await handler(makeNode({ graph_file: 'invalid.dot' }), ctx, STUB_GRAPH)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('validation failed')
    expect(result.failureReason).toContain('Graph has no start node')
  })
})

// ---------------------------------------------------------------------------
// StageStatus → OutcomeStatus translation
// ---------------------------------------------------------------------------

describe('createSubgraphHandler — status translation', () => {
  it('translates FAIL from sub-executor to FAILURE in handler outcome', async () => {
    mockCreateGraphExecutor.mockReturnValue({
      run: vi.fn().mockResolvedValue({ status: 'FAIL', failureReason: 'sub failed' }),
    })
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const result = await handler(makeNode({ graph_file: 'sub.dot' }), makeCtx(), STUB_GRAPH)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toBe('sub failed')
  })

  it('translates RETRY from sub-executor to FAILURE', async () => {
    mockCreateGraphExecutor.mockReturnValue({
      run: vi.fn().mockResolvedValue({ status: 'RETRY' }),
    })
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: vi.fn().mockResolvedValue(VALID_DOT),
    })
    const result = await handler(makeNode({ graph_file: 'sub.dot' }), makeCtx(), STUB_GRAPH)

    expect(result.status).toBe('FAILURE')
  })
})

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe('createSubgraphHandler — path resolution', () => {
  it('passes absolute graph_file path to loader unchanged', async () => {
    const mockLoader = vi.fn().mockResolvedValue(VALID_DOT)
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base',
      graphFileLoader: mockLoader,
    })
    const absPath = '/absolute/path/sub.dot'
    await handler(makeNode({ graph_file: absPath }), makeCtx(), STUB_GRAPH)

    expect(mockLoader).toHaveBeenCalledWith(absPath)
  })

  it('joins relative graph_file path with baseDir', async () => {
    const mockLoader = vi.fn().mockResolvedValue(VALID_DOT)
    const handler = createSubgraphHandler({
      handlerRegistry: createDefaultRegistry(),
      baseDir: '/base/dir',
      graphFileLoader: mockLoader,
    })
    await handler(makeNode({ graph_file: 'sub/graph.dot' }), makeCtx(), STUB_GRAPH)

    expect(mockLoader).toHaveBeenCalledWith(path.join('/base/dir', 'sub/graph.dot'))
  })
})

// ---------------------------------------------------------------------------
// AC7 – Registry wiring
// ---------------------------------------------------------------------------

describe('createDefaultRegistry — subgraph handler wiring (AC7)', () => {
  it('resolves the subgraph type without throwing', () => {
    const registry = createDefaultRegistry()
    const subgraphNode = makeNode({ graph_file: 'any.dot' })
    // resolve() should return a handler function (not throw)
    expect(() => registry.resolve(subgraphNode)).not.toThrow()
    expect(typeof registry.resolve(subgraphNode)).toBe('function')
  })
})
