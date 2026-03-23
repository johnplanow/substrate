/**
 * Unit tests for ConvergenceController (story 42-16).
 *
 * Covers all goal gate evaluation ACs:
 *   AC1 — PARTIAL_SUCCESS satisfies goal gates
 *   AC4 — multiple goal gates with mixed SUCCESS/PARTIAL_SUCCESS are all satisfied
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createConvergenceController } from '../controller.js'
import type { ConvergenceController } from '../controller.js'
import type { Graph, GraphNode } from '../../graph/types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const minimalNode: GraphNode = {
  id: '',
  label: '',
  shape: '',
  type: '',
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
}

/** Create a node with goalGate=true */
function makeGateNode(id: string): GraphNode {
  return { ...minimalNode, id, goalGate: true }
}

/** Create a node with goalGate=false */
function makeNonGateNode(id: string): GraphNode {
  return { ...minimalNode, id, goalGate: false }
}

/** Build a minimal Graph stub with the given nodes. evaluateGates only reads graph.nodes. */
function makeGraph(nodeList: GraphNode[]): Graph {
  const nodes = new Map(nodeList.map((n) => [n.id, n]))
  return {
    id: '',
    goal: '',
    label: '',
    modelStylesheet: '',
    defaultMaxRetries: 0,
    retryTarget: '',
    fallbackRetryTarget: '',
    defaultFidelity: '',
    nodes,
    edges: [],
    outgoingEdges: () => [],
    startNode: () => { throw new Error('not used in these tests') },
    exitNode: () => { throw new Error('not used in these tests') },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let controller: ConvergenceController

beforeEach(() => {
  controller = createConvergenceController()
})

// ---------------------------------------------------------------------------
// AC1: PARTIAL_SUCCESS satisfies goal gates
// ---------------------------------------------------------------------------

describe('AC1: PARTIAL_SUCCESS satisfies goal gates', () => {
  it('single goalGate=true node with PARTIAL_SUCCESS recorded → satisfied', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])

    controller.recordOutcome('gate-node', 'PARTIAL_SUCCESS')
    const result = controller.evaluateGates(graph)

    expect(result.satisfied).toBe(true)
    expect(result.failingNodes).toEqual([])
  })

  it('single goalGate=true node with SUCCESS recorded → satisfied', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])

    controller.recordOutcome('gate-node', 'SUCCESS')
    const result = controller.evaluateGates(graph)

    expect(result.satisfied).toBe(true)
    expect(result.failingNodes).toEqual([])
  })

  it('single goalGate=true node with FAILURE recorded → not satisfied', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])

    controller.recordOutcome('gate-node', 'FAILURE')
    const result = controller.evaluateGates(graph)

    expect(result.satisfied).toBe(false)
    expect(result.failingNodes).toContain('gate-node')
  })
})

// ---------------------------------------------------------------------------
// AC4: Multiple goal gates with mixed SUCCESS and PARTIAL_SUCCESS are all satisfied
// ---------------------------------------------------------------------------

describe('AC4: multiple goal gates with mixed outcomes', () => {
  it('two goalGate nodes — one SUCCESS, one PARTIAL_SUCCESS → both satisfied', () => {
    const gate1 = makeGateNode('gate1')
    const gate2 = makeGateNode('gate2')
    const graph = makeGraph([gate1, gate2])

    controller.recordOutcome('gate1', 'SUCCESS')
    controller.recordOutcome('gate2', 'PARTIAL_SUCCESS')
    const result = controller.evaluateGates(graph)

    expect(result.satisfied).toBe(true)
    expect(result.failingNodes).toEqual([])
  })

  it('two goalGate nodes — one SUCCESS, one FAILURE → not satisfied, failingNodes contains failing node', () => {
    const gate1 = makeGateNode('gate1')
    const gate2 = makeGateNode('gate2')
    const graph = makeGraph([gate1, gate2])

    controller.recordOutcome('gate1', 'SUCCESS')
    controller.recordOutcome('gate2', 'FAILURE')
    const result = controller.evaluateGates(graph)

    expect(result.satisfied).toBe(false)
    expect(result.failingNodes).toContain('gate2')
    expect(result.failingNodes).not.toContain('gate1')
  })
})

// ---------------------------------------------------------------------------
// Goal gate node with no recorded outcome → not satisfied
// ---------------------------------------------------------------------------

describe('goal gate node with no recorded outcome', () => {
  it('returns satisfied=false when a goalGate node has no recorded outcome', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])

    // No recordOutcome call
    const result = controller.evaluateGates(graph)

    expect(result.satisfied).toBe(false)
    expect(result.failingNodes).toContain('gate-node')
  })
})

// ---------------------------------------------------------------------------
// Graph with no goal gate nodes → vacuously satisfied
// ---------------------------------------------------------------------------

describe('graph with no goal gate nodes', () => {
  it('returns satisfied=true and empty failingNodes when no nodes have goalGate=true', () => {
    const nonGate1 = makeNonGateNode('node1')
    const nonGate2 = makeNonGateNode('node2')
    const graph = makeGraph([nonGate1, nonGate2])

    controller.recordOutcome('node1', 'SUCCESS')
    controller.recordOutcome('node2', 'FAILURE') // doesn't matter — no goal gates
    const result = controller.evaluateGates(graph)

    expect(result.satisfied).toBe(true)
    expect(result.failingNodes).toEqual([])
  })

  it('returns satisfied=true for an empty graph (no nodes)', () => {
    const graph = makeGraph([])
    const result = controller.evaluateGates(graph)

    expect(result.satisfied).toBe(true)
    expect(result.failingNodes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// recordOutcome / evaluateGates consistency
// ---------------------------------------------------------------------------

describe('recordOutcome updates are reflected in evaluateGates', () => {
  it('overwriting an outcome changes the evaluation result', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])

    controller.recordOutcome('gate-node', 'FAILURE')
    expect(controller.evaluateGates(graph).satisfied).toBe(false)

    // Overwrite with SUCCESS
    controller.recordOutcome('gate-node', 'SUCCESS')
    expect(controller.evaluateGates(graph).satisfied).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Non-goalGate nodes are ignored in evaluateGates
// ---------------------------------------------------------------------------

describe('non-goalGate nodes are ignored in evaluateGates', () => {
  it('FAILURE outcome on a non-goalGate node does not affect gate evaluation', () => {
    const gate = makeGateNode('gate-node')
    const nonGate = makeNonGateNode('work-node')
    const graph = makeGraph([gate, nonGate])

    controller.recordOutcome('gate-node', 'SUCCESS')
    controller.recordOutcome('work-node', 'FAILURE') // should be ignored
    const result = controller.evaluateGates(graph)

    expect(result.satisfied).toBe(true)
    expect(result.failingNodes).toEqual([])
  })
})
