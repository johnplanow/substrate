/**
 * Integration test: AC1 — 5-node conditional pipeline
 *
 * Verifies that parse → validate → execute works end-to-end for a conditional
 * branching graph, routing through the correct path based on context values.
 *
 * Story 42-15.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseGraph } from '../../graph/parser.js'
import { createValidator } from '../../graph/validator.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { makeTmpDir, cleanDir, makeMockRegistry, makeEventSpy, getNodeStartedIds, countCheckpointSaved } from './helpers.js'
import { FIVE_NODE_CONDITIONAL_DOT } from './graphs.js'

describe('AC1: 5-node conditional pipeline — parse, validate, execute end-to-end', () => {
  let logsRoot: string

  beforeEach(async () => {
    logsRoot = await makeTmpDir()
  })

  afterEach(async () => {
    await cleanDir(logsRoot)
  })

  it('routes through success path and emits expected events', async () => {
    // --- Parse ---
    const graph = parseGraph(FIVE_NODE_CONDITIONAL_DOT)
    expect(graph.nodes.size).toBe(5)

    // --- Validate (zero error violations expected) ---
    const validator = createValidator()
    const diagnostics = validator.validate(graph)
    const errors = diagnostics.filter((d) => d.severity === 'error')
    expect(errors).toHaveLength(0)

    // --- Build mock registry ---
    // `analyze` returns contextUpdates: { status: 'success' } so the condition
    // `status=success` on the analyze → report edge evaluates to true.
    const { registry } = makeMockRegistry({
      analyze: { contextUpdates: { status: 'success' } },
    })

    // --- Event spy ---
    const { bus, events } = makeEventSpy()

    // --- Execute ---
    const executor = createGraphExecutor()
    const outcome = await executor.run(graph, {
      runId: 'test-run-ac1',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
    })

    // --- Assertions ---

    // Outcome should be SUCCESS
    expect(outcome.status).toBe('SUCCESS')

    // node-started events: start → analyze → report (exit skipped — executor
    // returns before emitting node-started for the exit node)
    const nodeIds = getNodeStartedIds(events)
    expect(nodeIds).toEqual(['start', 'analyze', 'report'])

    // Fallback node must NOT have been visited
    expect(nodeIds).not.toContain('fallback')

    // checkpoint-saved events: one per non-exit completed node (start, analyze, report)
    const checkpointCount = countCheckpointSaved(events)
    expect(checkpointCount).toBe(3)
  })

  it('routes through failure path when context has status=failure', async () => {
    const graph = parseGraph(FIVE_NODE_CONDITIONAL_DOT)

    // `analyze` returns contextUpdates: { status: 'failure' } → routes to fallback
    const { registry } = makeMockRegistry({
      analyze: { contextUpdates: { status: 'failure' } },
    })
    const { bus, events } = makeEventSpy()

    const outcome = await createGraphExecutor().run(graph, {
      runId: 'test-run-ac1-failure',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
    })

    expect(outcome.status).toBe('SUCCESS')

    const nodeIds = getNodeStartedIds(events)
    expect(nodeIds).toEqual(['start', 'analyze', 'fallback'])
    expect(nodeIds).not.toContain('report')
  })

  it('parses the graph to exactly 5 nodes with correct ids', () => {
    const graph = parseGraph(FIVE_NODE_CONDITIONAL_DOT)
    expect(graph.nodes.has('start')).toBe(true)
    expect(graph.nodes.has('analyze')).toBe(true)
    expect(graph.nodes.has('report')).toBe(true)
    expect(graph.nodes.has('fallback')).toBe(true)
    expect(graph.nodes.has('exit')).toBe(true)
  })

  it('run twice sequentially produces SUCCESS both times', async () => {
    const graph = parseGraph(FIVE_NODE_CONDITIONAL_DOT)
    const { registry } = makeMockRegistry({
      analyze: { contextUpdates: { status: 'success' } },
    })

    const o1 = await createGraphExecutor().run(graph, {
      runId: 'test-sequential-1',
      logsRoot,
      handlerRegistry: registry,
    })
    const o2 = await createGraphExecutor().run(graph, {
      runId: 'test-sequential-2',
      logsRoot,
      handlerRegistry: registry,
    })
    expect(o1.status).toBe('SUCCESS')
    expect(o2.status).toBe('SUCCESS')
  })
})
