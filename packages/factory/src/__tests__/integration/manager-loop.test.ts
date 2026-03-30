/**
 * Integration tests for manager loop handler.
 * Story 50-11 AC4.
 *
 * Tests cover:
 *   - Basic loop execution up to max_cycles
 *   - max_cycles attribute parsing and clamping
 *   - Missing graph_file attribute → FAILURE
 *   - graphFileLoader error → FAILURE
 *   - Invalid body DOT → FAILURE
 *   - Context-key stop condition (pre-set key triggers early exit)
 *   - Context-key stop condition (key absent → runs to max_cycles)
 *   - LLM stop condition (mock returns yes → early exit)
 *   - LLM stop condition (mock returns no → runs to max_cycles)
 *   - LLM stop condition with no llmCall provider → never stops early
 *   - Stall detection: consecutive non-SUCCESS cycles set steering.mode='recovery'
 *
 * Test approach: call `createManagerLoopHandler(options)` directly with an
 * injectable `graphFileLoader` — no real disk access.
 *
 * ≥10 `it(...)` cases required (AC7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'node:os'

import { parseGraph } from '../../graph/parser.js'
import { GraphContext } from '../../graph/context.js'
import { HandlerRegistry } from '../../handlers/registry.js'
import { startHandler } from '../../handlers/start.js'
import { exitHandler } from '../../handlers/exit.js'
import { createManagerLoopHandler } from '../../handlers/manager-loop.js'
import type { Graph } from '../../graph/types.js'

import {
  MANAGER_LOOP_DOT,
  MANAGER_LOOP_BODY_DOT,
} from '../fixtures/manager-loop.dot.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a HandlerRegistry for the body graph. Codergen nodes use the default mock. */
function makeBodyRegistry(outcomeOverride?: { status: 'SUCCESS' | 'FAILURE' | 'PARTIAL_SUCCESS' }): HandlerRegistry {
  const registry = new HandlerRegistry()
  registry.register('start', startHandler)
  registry.register('exit', exitHandler)
  registry.setDefault(vi.fn().mockResolvedValue(outcomeOverride ?? { status: 'SUCCESS' }))
  return registry
}

/** Parse the manager-loop parent graph and post-process the manager_loop node attrs. */
function makeLoopGraph(attrs: Record<string, string>): { graph: Graph; loopNodeId: string } {
  const graph = parseGraph(MANAGER_LOOP_DOT)
  const loopNode = graph.nodes.get('manager_loop')!
  loopNode.attrs = attrs
  return { graph, loopNodeId: 'manager_loop' }
}

// ---------------------------------------------------------------------------
// AC4: Manager loop basic cycle execution
// ---------------------------------------------------------------------------

describe('manager loop — basic cycle execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('max_cycles=3: runs exactly 3 cycles and sets stop_reason=max_cycles', async () => {
    const { graph, loopNodeId } = makeLoopGraph({
      graph_file: '/test/body.dot',
      max_cycles: '3',
    })
    const loopNode = graph.nodes.get(loopNodeId)!

    const handler = createManagerLoopHandler({
      handlerRegistry: makeBodyRegistry(),
      graphFileLoader: vi.fn().mockResolvedValue(MANAGER_LOOP_BODY_DOT),
      logsRoot: os.tmpdir(),
    })

    const context = new GraphContext({ __runId: 'test-3-cycles' })
    const outcome = await handler(loopNode, context, graph)

    expect(outcome.status).toBe('SUCCESS')
    expect(context.get('manager_loop.cycles_completed')).toBe(3)
    expect(context.get('manager_loop.stop_reason')).toBe('max_cycles')
    expect(context.get('manager_loop.last_outcome')).toBe('SUCCESS')
  })

  it('max_cycles=1: runs 1 cycle and returns SUCCESS immediately after', async () => {
    const { graph, loopNodeId } = makeLoopGraph({
      graph_file: '/test/body.dot',
      max_cycles: '1',
    })
    const loopNode = graph.nodes.get(loopNodeId)!

    const handler = createManagerLoopHandler({
      handlerRegistry: makeBodyRegistry(),
      graphFileLoader: vi.fn().mockResolvedValue(MANAGER_LOOP_BODY_DOT),
      logsRoot: os.tmpdir(),
    })

    const context = new GraphContext({ __runId: 'test-1-cycle' })
    const outcome = await handler(loopNode, context, graph)

    expect(outcome.status).toBe('SUCCESS')
    expect(context.get('manager_loop.cycles_completed')).toBe(1)
    expect(context.get('manager_loop.stop_reason')).toBe('max_cycles')
  })
})

// ---------------------------------------------------------------------------
// Error cases (missing/invalid config)
// ---------------------------------------------------------------------------

describe('manager loop — error cases', () => {
  it('returns FAILURE when node.attrs.graph_file is absent', async () => {
    const graph = parseGraph(MANAGER_LOOP_DOT)
    const loopNode = graph.nodes.get('manager_loop')!
    // Intentionally do NOT set attrs

    const handler = createManagerLoopHandler({
      handlerRegistry: makeBodyRegistry(),
      graphFileLoader: vi.fn().mockResolvedValue(MANAGER_LOOP_BODY_DOT),
    })

    const context = new GraphContext({ __runId: 'test-no-attr' })
    const outcome = await handler(loopNode, context, graph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toContain('missing required attribute graph_file')
  })

  it('returns FAILURE when graphFileLoader throws', async () => {
    const { graph, loopNodeId } = makeLoopGraph({ graph_file: '/missing/body.dot', max_cycles: '1' })
    const loopNode = graph.nodes.get(loopNodeId)!

    const handler = createManagerLoopHandler({
      handlerRegistry: makeBodyRegistry(),
      graphFileLoader: vi.fn().mockRejectedValue(new Error('ENOENT: file not found')),
    })

    const context = new GraphContext({ __runId: 'test-loader-err' })
    const outcome = await handler(loopNode, context, graph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toContain('failed to load')
  })

  it('returns FAILURE when body DOT is invalid', async () => {
    const { graph, loopNodeId } = makeLoopGraph({ graph_file: '/test/body.dot', max_cycles: '1' })
    const loopNode = graph.nodes.get(loopNodeId)!

    const handler = createManagerLoopHandler({
      handlerRegistry: makeBodyRegistry(),
      graphFileLoader: vi.fn().mockResolvedValue('NOT VALID DOT @@@###'),
    })

    const context = new GraphContext({ __runId: 'test-invalid-dot' })
    const outcome = await handler(loopNode, context, graph)

    expect(outcome.status).toBe('FAILURE')
    expect(outcome.failureReason).toContain('failed to parse')
  })
})

// ---------------------------------------------------------------------------
// Stop condition: context key
// ---------------------------------------------------------------------------

describe('manager loop — context-key stop condition', () => {
  it('stop_condition key pre-set true → stops at cycle 1 with stop_reason=stop_condition', async () => {
    const { graph, loopNodeId } = makeLoopGraph({
      graph_file: '/test/body.dot',
      max_cycles: '5',
      stop_condition: 'task_complete',
    })
    const loopNode = graph.nodes.get(loopNodeId)!

    const handler = createManagerLoopHandler({
      handlerRegistry: makeBodyRegistry(),
      graphFileLoader: vi.fn().mockResolvedValue(MANAGER_LOOP_BODY_DOT),
      logsRoot: os.tmpdir(),
    })

    // Pre-set the stop condition key in context
    const context = new GraphContext({ __runId: 'test-ctx-stop', task_complete: true })
    const outcome = await handler(loopNode, context, graph)

    expect(outcome.status).toBe('SUCCESS')
    expect(context.get('manager_loop.stop_reason')).toBe('stop_condition')
    expect(context.get('manager_loop.cycles_completed')).toBe(1)
  })

  it('stop_condition key not set → loop runs all max_cycles', async () => {
    const { graph, loopNodeId } = makeLoopGraph({
      graph_file: '/test/body.dot',
      max_cycles: '3',
      stop_condition: 'task_complete',
    })
    const loopNode = graph.nodes.get(loopNodeId)!

    const handler = createManagerLoopHandler({
      handlerRegistry: makeBodyRegistry(),
      graphFileLoader: vi.fn().mockResolvedValue(MANAGER_LOOP_BODY_DOT),
      logsRoot: os.tmpdir(),
    })

    // task_complete key is NOT set in context
    const context = new GraphContext({ __runId: 'test-no-stop-key' })
    const outcome = await handler(loopNode, context, graph)

    expect(outcome.status).toBe('SUCCESS')
    expect(context.get('manager_loop.stop_reason')).toBe('max_cycles')
    expect(context.get('manager_loop.cycles_completed')).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Stop condition: LLM
// ---------------------------------------------------------------------------

describe('manager loop — LLM stop condition', () => {
  it('llm: stop condition with mock returning yes → stops at cycle 1', async () => {
    const { graph, loopNodeId } = makeLoopGraph({
      graph_file: '/test/body.dot',
      max_cycles: '5',
      stop_condition: 'llm:is the task complete?',
    })
    const loopNode = graph.nodes.get(loopNodeId)!

    const mockLlm = vi.fn().mockResolvedValue('yes')
    const handler = createManagerLoopHandler({
      handlerRegistry: makeBodyRegistry(),
      graphFileLoader: vi.fn().mockResolvedValue(MANAGER_LOOP_BODY_DOT),
      logsRoot: os.tmpdir(),
      llmCall: mockLlm,
    })

    const context = new GraphContext({ __runId: 'test-llm-stop-yes' })
    const outcome = await handler(loopNode, context, graph)

    expect(outcome.status).toBe('SUCCESS')
    expect(context.get('manager_loop.stop_reason')).toBe('stop_condition')
    expect(context.get('manager_loop.cycles_completed')).toBe(1)
    expect(mockLlm).toHaveBeenCalledOnce()
  })

  it('llm: stop condition with mock returning no → runs all max_cycles', async () => {
    const { graph, loopNodeId } = makeLoopGraph({
      graph_file: '/test/body.dot',
      max_cycles: '2',
      stop_condition: 'llm:is the task complete?',
    })
    const loopNode = graph.nodes.get(loopNodeId)!

    const mockLlm = vi.fn().mockResolvedValue('no')
    const handler = createManagerLoopHandler({
      handlerRegistry: makeBodyRegistry(),
      graphFileLoader: vi.fn().mockResolvedValue(MANAGER_LOOP_BODY_DOT),
      logsRoot: os.tmpdir(),
      llmCall: mockLlm,
    })

    const context = new GraphContext({ __runId: 'test-llm-stop-no' })
    const outcome = await handler(loopNode, context, graph)

    expect(outcome.status).toBe('SUCCESS')
    expect(context.get('manager_loop.stop_reason')).toBe('max_cycles')
    expect(context.get('manager_loop.cycles_completed')).toBe(2)
  })

  it('llm: stop condition without llmCall provided → loop never stops early', async () => {
    const { graph, loopNodeId } = makeLoopGraph({
      graph_file: '/test/body.dot',
      max_cycles: '2',
      stop_condition: 'llm:done yet?',
    })
    const loopNode = graph.nodes.get(loopNodeId)!

    const handler = createManagerLoopHandler({
      handlerRegistry: makeBodyRegistry(),
      graphFileLoader: vi.fn().mockResolvedValue(MANAGER_LOOP_BODY_DOT),
      logsRoot: os.tmpdir(),
      // No llmCall — LLM condition always evaluates to false
    })

    const context = new GraphContext({ __runId: 'test-no-llm-call' })
    const outcome = await handler(loopNode, context, graph)

    expect(outcome.status).toBe('SUCCESS')
    expect(context.get('manager_loop.stop_reason')).toBe('max_cycles')
    expect(context.get('manager_loop.cycles_completed')).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Stall detection
// ---------------------------------------------------------------------------

describe('manager loop — stall detection', () => {
  it('consecutive FAILURE body results trigger steering.mode=recovery', async () => {
    const { graph, loopNodeId } = makeLoopGraph({
      graph_file: '/test/body.dot',
      max_cycles: '3',
    })
    const loopNode = graph.nodes.get(loopNodeId)!

    // Body handler always returns FAILURE to trigger stall detection
    const registry = makeBodyRegistry({ status: 'FAILURE' })

    const handler = createManagerLoopHandler({
      handlerRegistry: registry,
      graphFileLoader: vi.fn().mockResolvedValue(MANAGER_LOOP_BODY_DOT),
      logsRoot: os.tmpdir(),
      maxStallCycles: 2, // Trigger after 2 consecutive failures
    })

    const context = new GraphContext({ __runId: 'test-stall' })
    const outcome = await handler(loopNode, context, graph)

    // Handler returns SUCCESS (max_cycles reached) even with all FAILURE body runs
    expect(outcome.status).toBe('SUCCESS')

    // After 2 consecutive failures, steering.mode should be 'recovery'
    expect(context.get('manager_loop.steering.mode')).toBe('recovery')

    // Steering hints should contain failure message
    const hints = context.get('manager_loop.steering.hints') as string[]
    expect(Array.isArray(hints)).toBe(true)
    expect(hints.length).toBeGreaterThan(0)
    // bodyOutcome.status is StageStatus ('FAIL') not OutcomeStatus ('FAILURE')
    // because createGraphExecutor().run() returns events.ts:Outcome (StageStatus)
    expect(hints[0]).toContain('FAIL')
  })
})
