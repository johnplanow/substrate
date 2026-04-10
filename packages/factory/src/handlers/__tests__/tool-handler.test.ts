/**
 * Unit tests for the tool handler (story 42-11).
 *
 * Covers:
 *   AC1 – Successful command returns SUCCESS with stdout in context
 *   AC2 – Failing command returns FAILURE with stderr as failureReason
 *   AC3 – Working directory resolved from context (or defaultWorkingDir option)
 *   AC7 – All unit tests pass
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

// vi.mock is hoisted automatically by Vitest.
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'child_process'
import { GraphContext } from '../../graph/context.js'
import type { GraphNode, Graph } from '../../graph/types.js'
import { createToolHandler } from '../tool.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSpawn = vi.mocked(spawn)

/** Minimal GraphNode factory for tool nodes. */
function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'tool',
    label: 'Run Command',
    shape: 'box',
    type: 'tool',
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
    toolCommand: 'echo hello',
    backend: '',
    ...overrides,
  }
}

/** Minimal Graph stub — not needed by the tool handler. */
const stubGraph = {} as Graph

/**
 * Create a mock child process that emits stdout/stderr data and closes with
 * the given exit code. Data is emitted asynchronously via process.nextTick.
 */
function createMockProcess(options: { stdout?: string; stderr?: string; exitCode?: number }) {
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  const procEmitter = new EventEmitter()

  const mockProc = {
    stdout: stdoutEmitter,
    stderr: stderrEmitter,
    on: procEmitter.on.bind(procEmitter),
  }

  process.nextTick(() => {
    if (options.stdout) {
      stdoutEmitter.emit('data', Buffer.from(options.stdout))
    }
    if (options.stderr) {
      stderrEmitter.emit('data', Buffer.from(options.stderr))
    }
    procEmitter.emit('close', options.exitCode ?? 0)
  })

  return mockProc
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// AC1 – Successful command returns SUCCESS with stdout in context
// ---------------------------------------------------------------------------

describe('tool handler – success path (AC1)', () => {
  it('returns status SUCCESS when process exits with code 0', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: 'hello\n', exitCode: 0 }) as ReturnType<typeof spawn>
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const result = await handler(
      makeNode({ id: 'tool', toolCommand: 'echo hello' }),
      ctx,
      stubGraph
    )
    expect(result.status).toBe('SUCCESS')
  })

  it('trims trailing whitespace from stdout', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: 'hello\n', exitCode: 0 }) as ReturnType<typeof spawn>
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const result = await handler(
      makeNode({ id: 'tool', toolCommand: 'echo hello' }),
      ctx,
      stubGraph
    )
    expect(result.contextUpdates?.['tool.output']).toBe('hello')
  })

  it('stores stdout under {node.id}.output context key', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: 'world\n', exitCode: 0 }) as ReturnType<typeof spawn>
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const result = await handler(
      makeNode({ id: 'my_tool', toolCommand: 'echo world' }),
      ctx,
      stubGraph
    )
    expect(result.contextUpdates?.['my_tool.output']).toBe('world')
  })

  it('does not set failureReason on success', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: 'ok\n', exitCode: 0 }) as ReturnType<typeof spawn>
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const result = await handler(makeNode(), ctx, stubGraph)
    expect(result.failureReason).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC2 – Failing command returns FAILURE with stderr as failureReason
// ---------------------------------------------------------------------------

describe('tool handler – failure path (AC2)', () => {
  it('returns status FAILURE when process exits with code 1', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stderr: 'bad thing', exitCode: 1 }) as ReturnType<typeof spawn>
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const result = await handler(makeNode(), ctx, stubGraph)
    expect(result.status).toBe('FAILURE')
  })

  it('sets failureReason to stderr content on non-zero exit', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stderr: 'bad thing', exitCode: 1 }) as ReturnType<typeof spawn>
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const result = await handler(makeNode(), ctx, stubGraph)
    expect(result.failureReason).toBe('bad thing')
  })

  it('does not set contextUpdates on failure', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stderr: 'error', exitCode: 1 }) as ReturnType<typeof spawn>
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const result = await handler(makeNode(), ctx, stubGraph)
    expect(result.contextUpdates).toBeUndefined()
  })

  it('uses exit code in failureReason when stderr is empty', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stderr: '', exitCode: 2 }) as ReturnType<typeof spawn>
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const result = await handler(makeNode(), ctx, stubGraph)
    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('2')
  })
})

// ---------------------------------------------------------------------------
// AC3 – Working directory resolved from context / defaultWorkingDir
// ---------------------------------------------------------------------------

describe('tool handler – working directory (AC3)', () => {
  it('uses defaultWorkingDir option when no context value is set', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: 'ok', exitCode: 0 }) as ReturnType<typeof spawn>
    )
    const handler = createToolHandler({ defaultWorkingDir: '/tmp' })
    const ctx = new GraphContext()
    await handler(makeNode(), ctx, stubGraph)
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: '/tmp' })
    )
  })

  it('uses workingDirectory from context, overriding defaultWorkingDir', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: 'ok', exitCode: 0 }) as ReturnType<typeof spawn>
    )
    const handler = createToolHandler({ defaultWorkingDir: '/tmp' })
    const ctx = new GraphContext({ workingDirectory: '/custom/path' })
    await handler(makeNode(), ctx, stubGraph)
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: '/custom/path' })
    )
  })

  it('passes shell: true to spawn', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: 'ok', exitCode: 0 }) as ReturnType<typeof spawn>
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    await handler(makeNode(), ctx, stubGraph)
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ shell: true })
    )
  })

  it('passes node.toolCommand as the command', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: 'result', exitCode: 0 }) as ReturnType<typeof spawn>
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    await handler(makeNode({ toolCommand: 'ls -la' }), ctx, stubGraph)
    expect(mockSpawn).toHaveBeenCalledWith('ls -la', expect.any(Array), expect.any(Object))
  })
})
