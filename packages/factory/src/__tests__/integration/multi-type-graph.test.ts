/**
 * Integration test: AC2 — 10-node multi-type graph
 *
 * Verifies that all node types execute with mock handlers and the
 * completedNodes checkpoint reflects the correct count.
 *
 * Story 42-15.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseGraph } from '../../graph/parser.js'
import { createValidator } from '../../graph/validator.js'
import { createGraphExecutor } from '../../graph/executor.js'
import {
  makeTmpDir,
  cleanDir,
  makeMockRegistry,
  makeEventSpy,
  getNodeStartedIds,
} from './helpers.js'
import { TEN_NODE_MULTI_TYPE_DOT } from './graphs.js'

describe('AC2: 10-node multi-type graph — all node types execute with mock handlers', () => {
  let logsRoot: string

  beforeEach(async () => {
    logsRoot = await makeTmpDir()
  })

  afterEach(async () => {
    await cleanDir(logsRoot)
  })

  it('all non-exit nodes appear in node-started events and completedNodes length is 9', async () => {
    // --- Parse ---
    const graph = parseGraph(TEN_NODE_MULTI_TYPE_DOT)
    expect(graph.nodes.size).toBe(10)

    // --- Validate (zero error violations required) ---
    const validator = createValidator()
    const errors = validator.validate(graph).filter((d) => d.severity === 'error')
    expect(errors).toHaveLength(0)

    // --- Build mock registry ---
    // wait_human returns preferredLabel: 'Yes' to simulate user selection.
    const { registry } = makeMockRegistry({
      wait_human: { preferredLabel: 'Yes' },
    })

    const { bus, events } = makeEventSpy()

    // --- Execute ---
    const outcome = await createGraphExecutor().run(graph, {
      runId: 'test-run-ac2',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
    })

    // --- Outcome must be SUCCESS ---
    expect(outcome.status).toBe('SUCCESS')

    // --- All 9 non-exit node IDs must appear in node-started events ---
    // (The existing executor returns SUCCESS when it reaches the exit node,
    //  without emitting graph:node-started for the exit node itself.)
    const nodeIds = getNodeStartedIds(events)
    const expectedNodeIds = [
      'start',
      'cgen1',
      'cgen2',
      'tool1',
      'tool2',
      'cond1',
      'wait_human',
      'router1',
      'router2',
    ]
    for (const id of expectedNodeIds) {
      expect(nodeIds).toContain(id)
    }
    // exit node: not expected in node-started (executor returns before emitting it)
    expect(nodeIds).not.toContain('exit')

    // --- completedNodes from last checkpoint save has length 9 ---
    // The executor saves checkpoints for all non-exit nodes.
    const checkpointPath = path.join(logsRoot, 'checkpoint.json')
    const raw = await readFile(checkpointPath, 'utf-8')
    const checkpoint = JSON.parse(raw) as { completedNodes: string[] }
    expect(checkpoint.completedNodes).toHaveLength(9)
    // Confirm all 9 non-exit nodes are in completedNodes
    for (const id of expectedNodeIds) {
      expect(checkpoint.completedNodes).toContain(id)
    }
    expect(checkpoint.completedNodes).not.toContain('exit')
  })

  it('parses graph with correct node types', () => {
    const graph = parseGraph(TEN_NODE_MULTI_TYPE_DOT)
    expect(graph.nodes.get('cgen1')?.type).toBe('codergen')
    expect(graph.nodes.get('cgen2')?.type).toBe('codergen')
    expect(graph.nodes.get('tool1')?.type).toBe('tool')
    expect(graph.nodes.get('tool2')?.type).toBe('tool')
    expect(graph.nodes.get('cond1')?.type).toBe('conditional')
    expect(graph.nodes.get('wait_human')?.type).toBe('wait.human')
    expect(graph.nodes.get('start')?.shape).toBe('Mdiamond')
    expect(graph.nodes.get('exit')?.shape).toBe('Msquare')
  })

  it('all 10 nodes are reachable from start (zero reachability errors)', () => {
    const graph = parseGraph(TEN_NODE_MULTI_TYPE_DOT)
    const validator = createValidator()
    const reachabilityErrors = validator
      .validate(graph)
      .filter((d) => d.ruleId === 'reachability')
    expect(reachabilityErrors).toHaveLength(0)
  })
})
