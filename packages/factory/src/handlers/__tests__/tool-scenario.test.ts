/**
 * Unit tests for the tool handler — scenario result detection (story 44-5).
 *
 * Covers:
 *   AC2 — tool handler detects ScenarioRunResult JSON via duck-typing
 *   AC3 — 3/4 pass → satisfaction_score 0.75, no {node.id}.output key
 *   AC4 — 0/2 pass → satisfaction_score 0.0, status SUCCESS
 *   Non-scenario JSON / plain text → falls through to {node.id}.output path
 *   Non-zero exit → FAILURE (existing behavior unchanged)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// vi.mock is hoisted automatically by Vitest.
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'child_process'
import { GraphContext } from '../../graph/context.js'
import type { GraphNode, Graph } from '../../graph/types.js'
import { createToolHandler } from '../tool.js'
import type { ScenarioRunResult } from '../../events.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSpawn = vi.mocked(spawn)

/** Minimal GraphNode factory for tool nodes. */
function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'validate',
    label: 'Validate Scenarios',
    shape: 'parallelogram',
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
    toolCommand: 'substrate scenarios run --format json',
    ...overrides,
  }
}

/** Minimal Graph stub — not needed by tool handler. */
const stubGraph = {} as Graph

/**
 * Create a mock child process that emits stdout/stderr and closes with exitCode.
 * Events fire asynchronously via setImmediate (matching the story test spec).
 */
function createMockProcess(options: {
  stdout?: string
  stderr?: string
  exitCode?: number
}) {
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  const procEmitter = new EventEmitter()

  const mockProc = {
    stdout: stdoutEmitter,
    stderr: stderrEmitter,
    on: procEmitter.on.bind(procEmitter),
  }

  setImmediate(() => {
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

/** Build a ScenarioRunResult stub for testing. */
function makeScenarioRunResult(total: number, passed: number): ScenarioRunResult {
  return {
    scenarios: [],
    summary: { total, passed, failed: total - passed },
    durationMs: 10,
  }
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
// AC2 / AC3 — ScenarioRunResult JSON → satisfaction_score in context
// ---------------------------------------------------------------------------

describe('tool handler — scenario JSON detection (AC2, AC3)', () => {
  it('writes satisfaction_score to context when stdout is valid ScenarioRunResult JSON', async () => {
    const resultJson = JSON.stringify(makeScenarioRunResult(4, 3))
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: resultJson, exitCode: 0 }) as ReturnType<typeof spawn>,
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const outcome = await handler(makeNode(), ctx, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.contextUpdates?.['satisfaction_score']).toBe(0.75)
  })

  it('does NOT set {node.id}.output when scenario JSON is detected (AC3)', async () => {
    const resultJson = JSON.stringify(makeScenarioRunResult(4, 3))
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: resultJson, exitCode: 0 }) as ReturnType<typeof spawn>,
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const outcome = await handler(makeNode({ id: 'validate' }), ctx, stubGraph)

    expect(outcome.contextUpdates?.['validate.output']).toBeUndefined()
  })

  it('writes satisfaction_score 0.0 when 0 of 2 scenarios pass (AC4)', async () => {
    const resultJson = JSON.stringify(makeScenarioRunResult(2, 0))
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: resultJson, exitCode: 0 }) as ReturnType<typeof spawn>,
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const outcome = await handler(makeNode(), ctx, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.contextUpdates?.['satisfaction_score']).toBe(0.0)
  })

  it('status is SUCCESS even when satisfaction_score is 0.0 (AC4 — downstream conditional routes)', async () => {
    const resultJson = JSON.stringify(makeScenarioRunResult(2, 0))
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: resultJson, exitCode: 0 }) as ReturnType<typeof spawn>,
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const outcome = await handler(makeNode(), ctx, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.failureReason).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Non-scenario stdout → falls through to {node.id}.output
// ---------------------------------------------------------------------------

describe('tool handler — non-scenario stdout falls through to default path', () => {
  it('stores plain text stdout as {node.id}.output when not ScenarioRunResult JSON', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: 'deployment done\n', exitCode: 0 }) as ReturnType<typeof spawn>,
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const outcome = await handler(makeNode({ id: 'deploy' }), ctx, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.contextUpdates?.['deploy.output']).toBe('deployment done')
    expect(outcome.contextUpdates?.['satisfaction_score']).toBeUndefined()
  })

  it('stores non-ScenarioRunResult JSON as {node.id}.output', async () => {
    const otherJson = JSON.stringify({ result: 'ok', count: 5 })
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stdout: otherJson, exitCode: 0 }) as ReturnType<typeof spawn>,
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const outcome = await handler(makeNode({ id: 'other_tool' }), ctx, stubGraph)

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.contextUpdates?.['other_tool.output']).toBe(otherJson)
    expect(outcome.contextUpdates?.['satisfaction_score']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Non-zero exit code — existing FAILURE behavior unchanged
// ---------------------------------------------------------------------------

describe('tool handler — non-zero exit code → FAILURE (existing behavior)', () => {
  it('returns FAILURE with stderr as failureReason on non-zero exit code', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stderr: 'command not found', exitCode: 1 }) as ReturnType<typeof spawn>,
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const outcome = await handler(makeNode(), ctx, stubGraph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toBe('command not found')
  })

  it('does not set contextUpdates on non-zero exit code', async () => {
    mockSpawn.mockReturnValueOnce(
      createMockProcess({ stderr: 'error', exitCode: 2 }) as ReturnType<typeof spawn>,
    )
    const handler = createToolHandler()
    const ctx = new GraphContext()
    const outcome = await handler(makeNode(), ctx, stubGraph)

    expect(outcome.contextUpdates).toBeUndefined()
  })
})
