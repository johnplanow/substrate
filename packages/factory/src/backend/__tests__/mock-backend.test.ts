/**
 * Unit and integration tests for MockCodergenBackend.
 *
 * Story 42-18 — AC1 through AC6.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockCodergenBackend } from '../mock-backend.js'
import type { GraphNode, IGraphContext } from '../../graph/types.js'
import { parseGraph } from '../../graph/parser.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { createCodergenHandler } from '../../handlers/codergen-handler.js'
import { HandlerRegistry } from '../../handlers/registry.js'
import { startHandler } from '../../handlers/start.js'
import { exitHandler } from '../../handlers/exit.js'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeNode(overrides?: Partial<GraphNode>): GraphNode {
  return {
    id: 'test_node',
    label: 'Test Node',
    shape: 'box',
    type: 'codergen',
    prompt: 'Do something',
    maxRetries: 0,
    goalGate: false,
    retryTarget: '',
    fallbackRetryTarget: '',
    fidelity: 'medium',
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

function makeContext(): IGraphContext {
  const store = new Map<string, unknown>()
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    getString: (key: string, defaultValue = '') => {
      const v = store.get(key)
      return v !== undefined ? String(v) : defaultValue
    },
    getNumber: (key: string, defaultValue = 0) => {
      const v = store.get(key)
      if (v === undefined) return defaultValue
      const n = Number(v)
      return isNaN(n) ? defaultValue : n
    },
    getBoolean: (key: string, defaultValue = false) => {
      const v = store.get(key)
      return v !== undefined ? Boolean(v) : defaultValue
    },
    applyUpdates: (updates: Record<string, unknown>) => {
      for (const [k, val] of Object.entries(updates)) store.set(k, val)
    },
    snapshot: () => Object.fromEntries(store.entries()),
    clone: () => makeContext(),
  }
}

async function makeTmpDir(): Promise<string> {
  const dirPath = `${os.tmpdir()}/mock-backend-test-${crypto.randomUUID()}`
  await mkdir(dirPath, { recursive: true })
  return dirPath
}

async function cleanDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// AC1: Configurable Response Sequence
// ---------------------------------------------------------------------------

describe('AC1 — configurable response sequence', () => {
  it('returns configured responses in order, repeating last when exhausted', async () => {
    const mock = createMockCodergenBackend({
      responses: [
        { status: 'NEEDS_RETRY', contextUpdates: { step: '1' } },
        { status: 'SUCCESS', contextUpdates: { step: '2' } },
      ],
    })
    const node = makeNode()
    const ctx = makeContext()

    const r1 = await mock.run(node, 'prompt', ctx)
    const r2 = await mock.run(node, 'prompt', ctx)
    const r3 = await mock.run(node, 'prompt', ctx) // beyond list — repeats last

    expect(r1.status).toBe('NEEDS_RETRY')
    expect((r1.contextUpdates as Record<string, string>)?.step).toBe('1')

    expect(r2.status).toBe('SUCCESS')
    expect((r2.contextUpdates as Record<string, string>)?.step).toBe('2')

    // Call 3 exceeds responses.length (2) → repeats last response
    expect(r3.status).toBe('SUCCESS')
    expect((r3.contextUpdates as Record<string, string>)?.step).toBe('2')
  })

  it('returns SUCCESS by default when no config is provided', async () => {
    const mock = createMockCodergenBackend()
    const result = await mock.run(makeNode(), 'prompt', makeContext())
    expect(result.status).toBe('SUCCESS')
  })
})

// ---------------------------------------------------------------------------
// AC2: Injectable Per-Call Failures
// ---------------------------------------------------------------------------

describe('AC2 — injectable per-call failures', () => {
  it('returns FAILURE on specified call indices, SUCCESS otherwise', async () => {
    const mock = createMockCodergenBackend({
      failOnCall: [1, 3],
      responses: [{ status: 'SUCCESS' }],
    })
    const node = makeNode()
    const ctx = makeContext()

    const r1 = await mock.run(node, 'p', ctx) // call 1 → FAILURE
    const r2 = await mock.run(node, 'p', ctx) // call 2 → SUCCESS
    const r3 = await mock.run(node, 'p', ctx) // call 3 → FAILURE

    expect(r1.status).toBe('FAILURE')
    expect(r2.status).toBe('SUCCESS')
    expect(r3.status).toBe('FAILURE')
  })
})

// ---------------------------------------------------------------------------
// AC3: Configurable Artificial Delay
// ---------------------------------------------------------------------------

describe('AC3 — configurable artificial delay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits approximately delay ms before resolving', async () => {
    const mock = createMockCodergenBackend({ delay: 500 })
    const node = makeNode()
    const ctx = makeContext()

    let resolved = false
    const p = mock.run(node, 'prompt', ctx).then((r) => {
      resolved = true
      return r
    })

    // Before advancing timers, should not have resolved
    expect(resolved).toBe(false)

    // Advance fake timers by 500ms
    await vi.runAllTimersAsync()

    const result = await p
    expect(resolved).toBe(true)
    expect(result.status).toBe('SUCCESS')
  })
})

// ---------------------------------------------------------------------------
// AC4: Call Argument Recording
// ---------------------------------------------------------------------------

describe('AC4 — call argument recording', () => {
  it('records all call arguments with correct callIndex', async () => {
    const mock = createMockCodergenBackend()
    const nodeA = makeNode({ id: 'nodeA' })
    const ctx = makeContext()

    await mock.run(nodeA, 'prompt text', ctx)
    await mock.run(nodeA, 'prompt text', ctx)

    expect(mock.calls).toHaveLength(2)
    expect(mock.calls[0]!.prompt).toBe('prompt text')
    expect(mock.calls[0]!.callIndex).toBe(1)
    expect(mock.calls[1]!.callIndex).toBe(2)
    expect(mock.calls[0]!.node.id).toBe('nodeA')
  })

  it('records the context object reference', async () => {
    const mock = createMockCodergenBackend()
    const ctx = makeContext()
    ctx.set('foo', 'bar')

    await mock.run(makeNode(), 'p', ctx)

    expect(mock.calls[0]!.context).toBe(ctx)
    expect(mock.calls[0]!.context.getString('foo')).toBe('bar')
  })
})

// ---------------------------------------------------------------------------
// contextUpdates passthrough
// ---------------------------------------------------------------------------

describe('contextUpdates passthrough', () => {
  it('includes contextUpdates from configured response in returned Outcome', async () => {
    const mock = createMockCodergenBackend({
      responses: [{ status: 'SUCCESS', contextUpdates: { foo: 'bar' } }],
    })

    const result = await mock.run(makeNode(), 'prompt', makeContext())

    expect(result.status).toBe('SUCCESS')
    expect((result.contextUpdates as Record<string, string>)?.foo).toBe('bar')
  })

  it('returns empty contextUpdates object when none configured', async () => {
    const mock = createMockCodergenBackend({
      responses: [{ status: 'SUCCESS' }],
    })

    const result = await mock.run(makeNode(), 'prompt', makeContext())
    expect(result.contextUpdates).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

describe('isolation between test instances', () => {
  it('fresh instances have empty calls and reset callCount', async () => {
    const mock1 = createMockCodergenBackend()
    const mock2 = createMockCodergenBackend()

    await mock1.run(makeNode(), 'p', makeContext())
    await mock1.run(makeNode(), 'p', makeContext())

    // mock2 is completely independent
    expect(mock2.calls).toHaveLength(0)
    await mock2.run(makeNode(), 'p', makeContext())
    expect(mock2.calls[0]!.callIndex).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// AC6: Integration test — retry logic with graph executor
// ---------------------------------------------------------------------------

describe('AC6 — MockCodergenBackend — integration with graph executor', () => {
  let logsRoot: string

  beforeEach(async () => {
    logsRoot = await makeTmpDir()
  })

  afterEach(async () => {
    await cleanDir(logsRoot)
  })

  const THREE_NODE_DOT = `
digraph test_mock_backend {
  graph [goal="Mock backend retry integration test"]
  start [shape=Mdiamond]
  codergen_node [type=codergen, prompt="Generate code", max_retries=2]
  exit [shape=Msquare]

  start -> codergen_node
  codergen_node -> exit
}
`

  it('retries on NEEDS_RETRY and succeeds on second attempt', async () => {
    // Build mock with [NEEDS_RETRY, SUCCESS] responses
    const mock = createMockCodergenBackend({
      responses: [
        { status: 'NEEDS_RETRY' },
        { status: 'SUCCESS', contextUpdates: { result: 'done' } },
      ],
    })

    // Build registry: start, exit, and codergen with mock backend
    const registry = new HandlerRegistry()
    registry.register('start', startHandler)
    registry.register('exit', exitHandler)
    registry.register('codergen', createCodergenHandler({ backend: mock }))
    registry.registerShape('Mdiamond', 'start')
    registry.registerShape('Msquare', 'exit')

    const graph = parseGraph(THREE_NODE_DOT)
    const executor = createGraphExecutor()
    const outcome = await executor.run(graph, {
      runId: 'test-mock-backend-retry',
      logsRoot,
      handlerRegistry: registry,
    })

    // Final outcome should be SUCCESS
    expect(outcome.status).toBe('SUCCESS')

    // Mock was called exactly twice: call 1 (NEEDS_RETRY → FAIL → retry), call 2 (SUCCESS)
    expect(mock.calls).toHaveLength(2)

    // Both calls received the same context object (updates applied after dispatch, not between retries)
    expect(mock.calls[0]!.context).toBe(mock.calls[1]!.context)

    // Call indices are 1-based
    expect(mock.calls[0]!.callIndex).toBe(1)
    expect(mock.calls[1]!.callIndex).toBe(2)
  })
})
