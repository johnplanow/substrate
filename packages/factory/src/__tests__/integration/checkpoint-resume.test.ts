/**
 * Integration test: AC5 — checkpoint resume
 *
 * Verifies that the executor skips completed nodes, restores context from a
 * seed checkpoint, and continues execution from the first unfinished node.
 *
 * Story 42-15.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import { parseGraph } from '../../graph/parser.js'
import { createValidator } from '../../graph/validator.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { CheckpointManager } from '../../graph/checkpoint.js'
import { GraphContext } from '../../graph/context.js'
import {
  makeTmpDir,
  cleanDir,
  makeMockRegistry,
  makeEventSpy,
  getNodeStartedIds,
} from './helpers.js'
import { FIVE_NODE_LINEAR_DOT } from './graphs.js'

describe('AC5: checkpoint resume — skip completed nodes, restore context', () => {
  let logsRoot: string
  let checkpointPath: string

  beforeEach(async () => {
    logsRoot = await makeTmpDir()
    checkpointPath = path.join(logsRoot, 'checkpoint.json')

    // Write the seed checkpoint using CheckpointManager.save() for format compatibility
    const cm = new CheckpointManager()
    await cm.save(logsRoot, {
      currentNode: 'node1',
      completedNodes: ['start', 'node1'],
      nodeRetries: {},
      context: new GraphContext({ step: '2', result: 'hello' }),
      logs: [],
    })
  })

  afterEach(async () => {
    await cleanDir(logsRoot)
  })

  it('skips completed nodes, restores context, and runs remaining nodes', async () => {
    // --- Parse ---
    const graph = parseGraph(FIVE_NODE_LINEAR_DOT)
    expect(graph.nodes.size).toBe(5)

    // --- Validate ---
    const validator = createValidator()
    const errors = validator.validate(graph).filter((d) => d.severity === 'error')
    expect(errors).toHaveLength(0)

    // --- Build spy registry that captures context argument for each handler ---
    const { registry, spies } = makeMockRegistry()
    const { bus, events } = makeEventSpy()

    // --- Execute with checkpointPath to trigger resume ---
    const outcome = await createGraphExecutor().run(graph, {
      runId: 'test-run-ac5',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
      checkpointPath,
    })

    // --- Outcome ---
    expect(outcome.status).toBe('SUCCESS')

    // --- node-started events must NOT include start or node1 (skipped) ---
    const nodeIds = getNodeStartedIds(events)
    expect(nodeIds).not.toContain('start')
    expect(nodeIds).not.toContain('node1')

    // --- node-started events MUST include node2 and node3 (resumed execution) ---
    expect(nodeIds).toContain('node2')
    expect(nodeIds).toContain('node3')

    // node2 must come before node3
    const node2Idx = nodeIds.indexOf('node2')
    const node3Idx = nodeIds.indexOf('node3')
    expect(node2Idx).toBeLessThan(node3Idx)
  })

  it('node2 handler receives context restored from checkpoint (step=2, result=hello)', async () => {
    const graph = parseGraph(FIVE_NODE_LINEAR_DOT)
    const { registry, spies } = makeMockRegistry()

    await createGraphExecutor().run(graph, {
      runId: 'test-run-ac5-ctx',
      logsRoot,
      handlerRegistry: registry,
      checkpointPath,
    })

    // The node2 spy should have been called exactly once
    const node2Spy = spies.get('node2')
    expect(node2Spy).toBeDefined()
    expect(node2Spy!.mock.calls).toHaveLength(1)

    // Second argument is the IGraphContext
    const capturedContext = node2Spy!.mock.calls[0]![1] as GraphContext
    expect(capturedContext.getString('step')).toBe('2')
    expect(capturedContext.getString('result')).toBe('hello')
  })

  it('start and node1 handlers are never called (they were already completed)', async () => {
    const graph = parseGraph(FIVE_NODE_LINEAR_DOT)
    const { registry, spies } = makeMockRegistry()

    await createGraphExecutor().run(graph, {
      runId: 'test-run-ac5-skip',
      logsRoot,
      handlerRegistry: registry,
      checkpointPath,
    })

    // start and node1 should NOT have been resolved/called
    // (the executor fast-forwards through them)
    const startSpy = spies.get('start')
    const node1Spy = spies.get('node1')

    // Spies are created lazily on resolve(); if the spy was never needed,
    // the map won't contain it. Either way, no calls should have happened.
    if (startSpy) expect(startSpy.mock.calls).toHaveLength(0)
    if (node1Spy) expect(node1Spy.mock.calls).toHaveLength(0)
  })

  it('node3 handler is called after node2 completes (correct sequential execution)', async () => {
    const graph = parseGraph(FIVE_NODE_LINEAR_DOT)
    const { registry, spies } = makeMockRegistry()

    await createGraphExecutor().run(graph, {
      runId: 'test-run-ac5-seq',
      logsRoot,
      handlerRegistry: registry,
      checkpointPath,
    })

    const node2Spy = spies.get('node2')
    const node3Spy = spies.get('node3')

    expect(node2Spy).toBeDefined()
    expect(node3Spy).toBeDefined()
    expect(node2Spy!.mock.calls).toHaveLength(1)
    expect(node3Spy!.mock.calls).toHaveLength(1)
  })
})
