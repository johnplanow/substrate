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
import type { Graph, GraphNode, IGraphContext } from '../../graph/types.js'
import { TypedEventBusImpl } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'

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

// ---------------------------------------------------------------------------
// resolveRetryTarget — 4-level priority chain (Story 45-2)
// ---------------------------------------------------------------------------

/** Build a node with specific retry fields; other fields default to minimalNode. */
function makeNodeWithRetry(id: string, retryTarget: string, fallbackRetryTarget: string): GraphNode {
  return { ...minimalNode, id, retryTarget, fallbackRetryTarget }
}

describe('resolveRetryTarget — AC1: node.retryTarget resolves (existing node)', () => {
  it('returns node.retryTarget when target node exists in graph', () => {
    const failedNode = makeNodeWithRetry('failing', 'dev_story', '')
    const targetNode = makeNonGateNode('dev_story')
    const graph = makeGraph([failedNode, targetNode])

    const result = controller.resolveRetryTarget(failedNode, graph)

    expect(result).toBe('dev_story')
  })
})

describe('resolveRetryTarget — AC2: node.fallbackRetryTarget resolves when retryTarget absent', () => {
  it('returns node.fallbackRetryTarget when retryTarget is absent but fallback exists', () => {
    const failedNode = makeNodeWithRetry('failing', '', 'start_over')
    const targetNode = makeNonGateNode('start_over')
    const graph = makeGraph([failedNode, targetNode])

    const result = controller.resolveRetryTarget(failedNode, graph)

    expect(result).toBe('start_over')
  })
})

describe('resolveRetryTarget — AC3: graph.retryTarget resolves when both node-level fields absent', () => {
  it('returns graph.retryTarget when both node-level fields are empty', () => {
    const failedNode = makeNodeWithRetry('failing', '', '')
    const targetNode = makeNonGateNode('global_retry')
    const graph = { ...makeGraph([failedNode, targetNode]), retryTarget: 'global_retry' }

    const result = controller.resolveRetryTarget(failedNode, graph)

    expect(result).toBe('global_retry')
  })
})

describe('resolveRetryTarget — AC4: graph.fallbackRetryTarget resolves at level 4', () => {
  it('returns graph.fallbackRetryTarget when levels 1–3 are absent', () => {
    const failedNode = makeNodeWithRetry('failing', '', '')
    const targetNode = makeNonGateNode('last_resort')
    const graph = { ...makeGraph([failedNode, targetNode]), retryTarget: '', fallbackRetryTarget: 'last_resort' }

    const result = controller.resolveRetryTarget(failedNode, graph)

    expect(result).toBe('last_resort')
  })
})

describe('resolveRetryTarget — AC5: returns null when no valid target exists at any level', () => {
  it('returns null when all four fields are empty', () => {
    const failedNode = makeNodeWithRetry('failing', '', '')
    const graph = makeGraph([failedNode])

    const result = controller.resolveRetryTarget(failedNode, graph)

    expect(result).toBeNull()
  })

  it('returns null when all four fields reference non-existent nodes', () => {
    const failedNode = makeNodeWithRetry('failing', 'ghost1', 'ghost2')
    const graph = { ...makeGraph([failedNode]), retryTarget: 'ghost3', fallbackRetryTarget: 'ghost4' }

    const result = controller.resolveRetryTarget(failedNode, graph)

    expect(result).toBeNull()
  })
})

describe('resolveRetryTarget — AC6: non-existent node reference falls through to next level', () => {
  it('falls through ghost node.retryTarget to graph.retryTarget', () => {
    const failedNode = makeNodeWithRetry('failing', 'ghost_node', '')
    const targetNode = makeNonGateNode('global_retry')
    const graph = { ...makeGraph([failedNode, targetNode]), retryTarget: 'global_retry' }

    const result = controller.resolveRetryTarget(failedNode, graph)

    expect(result).toBe('global_retry')
  })
})

describe('resolveRetryTarget — AC7: empty string treated as "not set"', () => {
  it('AC7a: empty string in node.retryTarget skips to node.fallbackRetryTarget', () => {
    const failedNode = makeNodeWithRetry('failing', '', 'fallback_node')
    const targetNode = makeNonGateNode('fallback_node')
    const graph = makeGraph([failedNode, targetNode])

    const result = controller.resolveRetryTarget(failedNode, graph)

    expect(result).toBe('fallback_node')
  })

  it('AC7b: empty string in ALL four fields → returns null', () => {
    const failedNode = makeNodeWithRetry('failing', '', '')
    const graph = { ...makeGraph([failedNode]), retryTarget: '', fallbackRetryTarget: '' }

    const result = controller.resolveRetryTarget(failedNode, graph)

    expect(result).toBeNull()
  })
})

describe('resolveRetryTarget — priority: only highest-priority valid target is returned', () => {
  it('returns level 1 (node.retryTarget) even when lower levels are also valid', () => {
    const failedNode = makeNodeWithRetry('failing', 'level1_target', 'level2_target')
    const level1 = makeNonGateNode('level1_target')
    const level2 = makeNonGateNode('level2_target')
    const level3 = makeNonGateNode('level3_target')
    const level4 = makeNonGateNode('level4_target')
    const graph = {
      ...makeGraph([failedNode, level1, level2, level3, level4]),
      retryTarget: 'level3_target',
      fallbackRetryTarget: 'level4_target',
    }

    const result = controller.resolveRetryTarget(failedNode, graph)

    expect(result).toBe('level1_target')
  })
})

// ---------------------------------------------------------------------------
// checkGoalGates() — Story 45-1
// ---------------------------------------------------------------------------

describe('checkGoalGates()', () => {
  // AC1: SUCCESS outcome satisfies gate
  it('AC1: sole goalGate=true node with SUCCESS outcome → {satisfied: true, failedGates: []}', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])

    controller.recordOutcome('gate-node', 'SUCCESS')
    const result = controller.checkGoalGates(graph, 'test-run')

    expect(result.satisfied).toBe(true)
    expect(result.failedGates).toEqual([])
  })

  // AC2: FAILURE outcome fails gate
  it('AC2: sole goalGate=true node with FAILURE outcome → {satisfied: false, failedGates: ["gate-node"]}', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])

    controller.recordOutcome('gate-node', 'FAILURE')
    const result = controller.checkGoalGates(graph, 'test-run')

    expect(result.satisfied).toBe(false)
    expect(result.failedGates).toContain('gate-node')
  })

  // AC3a: two goal gates, first SUCCESS, second FAILURE → satisfied false, only failing in failedGates
  it('AC3a: two gates — SUCCESS then FAILURE → satisfied: false, only failing node in failedGates', () => {
    const gate1 = makeGateNode('gate-pass')
    const gate2 = makeGateNode('gate-fail')
    const graph = makeGraph([gate1, gate2])

    controller.recordOutcome('gate-pass', 'SUCCESS')
    controller.recordOutcome('gate-fail', 'FAILURE')
    const result = controller.checkGoalGates(graph, 'test-run')

    expect(result.satisfied).toBe(false)
    expect(result.failedGates).toContain('gate-fail')
    expect(result.failedGates).not.toContain('gate-pass')
  })

  // AC3b: two goal gates, first FAILURE, second SUCCESS → satisfied false, failing node in failedGates
  it('AC3b: two gates — FAILURE then SUCCESS → satisfied: false, failing node in failedGates, passing node absent', () => {
    const gate1 = makeGateNode('gate-fail')
    const gate2 = makeGateNode('gate-pass')
    const graph = makeGraph([gate1, gate2])

    controller.recordOutcome('gate-fail', 'FAILURE')
    controller.recordOutcome('gate-pass', 'SUCCESS')
    const result = controller.checkGoalGates(graph, 'test-run')

    expect(result.satisfied).toBe(false)
    expect(result.failedGates).toContain('gate-fail')
    expect(result.failedGates).not.toContain('gate-pass')
  })

  // AC4: PARTIAL_SUCCESS satisfies gate
  it('AC4: PARTIAL_SUCCESS outcome on sole goalGate node → {satisfied: true, failedGates: []}', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])

    controller.recordOutcome('gate-node', 'PARTIAL_SUCCESS')
    const result = controller.checkGoalGates(graph, 'test-run')

    expect(result.satisfied).toBe(true)
    expect(result.failedGates).toEqual([])
  })

  // AC5a: one goalGate node → exactly one event emitted
  it('AC5a: one goalGate node → exactly one graph:goal-gate-checked event emitted', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])
    const eventBus = new TypedEventBusImpl<FactoryEvents>()
    const emitted: Array<{ nodeId: string; satisfied: boolean }> = []
    eventBus.on('graph:goal-gate-checked', (payload) => {
      emitted.push({ nodeId: payload.nodeId, satisfied: payload.satisfied })
    })

    controller.recordOutcome('gate-node', 'SUCCESS')
    controller.checkGoalGates(graph, 'test-run', eventBus)

    expect(emitted).toHaveLength(1)
  })

  // AC5b: event payload contains runId, nodeId, satisfied
  it('AC5b: event payload contains runId === "test-run", nodeId === "gate-node", satisfied === true', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])
    const eventBus = new TypedEventBusImpl<FactoryEvents>()
    const emitted: Array<{ runId: string; nodeId: string; satisfied: boolean }> = []
    eventBus.on('graph:goal-gate-checked', (payload) => {
      emitted.push({ runId: payload.runId, nodeId: payload.nodeId, satisfied: payload.satisfied })
    })

    controller.recordOutcome('gate-node', 'SUCCESS')
    controller.checkGoalGates(graph, 'test-run', eventBus)

    expect(emitted[0]?.runId).toBe('test-run')
    expect(emitted[0]?.nodeId).toBe('gate-node')
    expect(emitted[0]?.satisfied).toBe(true)
  })

  // AC5c: FAILURE gate → event emitted with satisfied: false
  it('AC5c: FAILURE gate → graph:goal-gate-checked event emitted with satisfied: false', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])
    const eventBus = new TypedEventBusImpl<FactoryEvents>()
    const emitted: Array<{ nodeId: string; satisfied: boolean }> = []
    eventBus.on('graph:goal-gate-checked', (payload) => {
      emitted.push({ nodeId: payload.nodeId, satisfied: payload.satisfied })
    })

    controller.recordOutcome('gate-node', 'FAILURE')
    controller.checkGoalGates(graph, 'test-run', eventBus)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.satisfied).toBe(false)
  })

  // AC5d: no eventBus argument → completes without throwing
  it('AC5d: no eventBus argument → method completes without throwing', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])

    controller.recordOutcome('gate-node', 'SUCCESS')
    expect(() => controller.checkGoalGates(graph, 'test-run')).not.toThrow()
  })

  // AC6: graph with no goalGate nodes → vacuous satisfaction, zero events
  it('AC6: graph with no goalGate nodes → {satisfied: true, failedGates: []}, zero events', () => {
    const nonGate1 = makeNonGateNode('node1')
    const nonGate2 = makeNonGateNode('node2')
    const graph = makeGraph([nonGate1, nonGate2])
    const eventBus = new TypedEventBusImpl<FactoryEvents>()
    const emitted: Array<{ nodeId: string; satisfied: boolean }> = []
    eventBus.on('graph:goal-gate-checked', (payload) => {
      emitted.push({ nodeId: payload.nodeId, satisfied: payload.satisfied })
    })

    controller.recordOutcome('node1', 'SUCCESS')
    controller.recordOutcome('node2', 'FAILURE')
    const result = controller.checkGoalGates(graph, 'test-run', eventBus)

    expect(result.satisfied).toBe(true)
    expect(result.failedGates).toEqual([])
    expect(emitted).toHaveLength(0)
  })

  // Additional: two goal gates both SUCCESS → both satisfied
  it('two goalGate nodes both with SUCCESS → satisfied: true, failedGates: []', () => {
    const gate1 = makeGateNode('gate1')
    const gate2 = makeGateNode('gate2')
    const graph = makeGraph([gate1, gate2])

    controller.recordOutcome('gate1', 'SUCCESS')
    controller.recordOutcome('gate2', 'SUCCESS')
    const result = controller.checkGoalGates(graph, 'test-run')

    expect(result.satisfied).toBe(true)
    expect(result.failedGates).toEqual([])
  })

  // Additional: two goal gates → two events emitted
  it('two goalGate nodes → exactly two graph:goal-gate-checked events emitted', () => {
    const gate1 = makeGateNode('gate1')
    const gate2 = makeGateNode('gate2')
    const graph = makeGraph([gate1, gate2])
    const eventBus = new TypedEventBusImpl<FactoryEvents>()
    const emitted: Array<{ nodeId: string; satisfied: boolean }> = []
    eventBus.on('graph:goal-gate-checked', (payload) => {
      emitted.push({ nodeId: payload.nodeId, satisfied: payload.satisfied })
    })

    controller.recordOutcome('gate1', 'SUCCESS')
    controller.recordOutcome('gate2', 'PARTIAL_SUCCESS')
    controller.checkGoalGates(graph, 'test-run', eventBus)

    expect(emitted).toHaveLength(2)
  })

  // Additional: gate with no recorded outcome → not satisfied
  it('goalGate node with no recorded outcome → satisfied: false', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])

    const result = controller.checkGoalGates(graph, 'test-run')

    expect(result.satisfied).toBe(false)
    expect(result.failedGates).toContain('gate-node')
  })
})

// ---------------------------------------------------------------------------
// checkGoalGates() — satisfaction threshold (story 46-2)
// ---------------------------------------------------------------------------

describe("checkGoalGates() — satisfaction threshold (story 46-2)", () => {
  /** Map-backed IGraphContext helper — avoids cross-package import of GraphContext class. */
  function makeContext(score: number): IGraphContext {
    const store = new Map<string, unknown>([['satisfaction_score', score]])
    return {
      get: (k) => store.get(k),
      set: (k, v) => { store.set(k, v) },
      getString: (k, d = '') => String(store.get(k) ?? d),
      getNumber: (k, d = 0) => Number(store.get(k) ?? d),
      getBoolean: (k, d = false) => Boolean(store.get(k) ?? d),
      applyUpdates: (u) => { for (const [k, v] of Object.entries(u)) store.set(k, v) },
      snapshot: () => Object.fromEntries(store),
      clone: () => makeContext(score),
    }
  }

  // AC1: score below threshold fails gate
  it('AC1: score=0.79 below threshold=0.8 → satisfied: false, gate node in failedGates', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])
    const ctx = makeContext(0.79)

    const result = controller.checkGoalGates(graph, 'run-1', undefined, {
      context: ctx,
      satisfactionThreshold: 0.8,
    })

    expect(result.satisfied).toBe(false)
    expect(result.failedGates).toContain('gate-node')
  })

  // AC2: score at threshold passes (>= not >)
  it('AC2: score=0.80 at threshold=0.8 → satisfied: true, failedGates: []', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])
    const ctx = makeContext(0.80)

    const result = controller.checkGoalGates(graph, 'run-1', undefined, {
      context: ctx,
      satisfactionThreshold: 0.8,
    })

    expect(result.satisfied).toBe(true)
    expect(result.failedGates).toEqual([])
  })

  // AC2b: score exactly equals threshold (0.5)
  it('AC2b: score=0.5 at threshold=0.5 → satisfied: true (inclusive boundary)', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])
    const ctx = makeContext(0.5)

    const result = controller.checkGoalGates(graph, 'run-1', undefined, {
      context: ctx,
      satisfactionThreshold: 0.5,
    })

    expect(result.satisfied).toBe(true)
    expect(result.failedGates).toEqual([])
  })

  // AC3: relaxed threshold passes with lower score
  it('AC3: score=0.6 above relaxed threshold=0.5 → satisfied: true', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])
    const ctx = makeContext(0.6)

    const result = controller.checkGoalGates(graph, 'run-1', undefined, {
      context: ctx,
      satisfactionThreshold: 0.5,
    })

    expect(result.satisfied).toBe(true)
    expect(result.failedGates).toEqual([])
  })

  // AC4: hot-reload — threshold read fresh on each call (no caching)
  it('AC4a: threshold=0.8 score=0.6 → satisfied: false', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])
    const ctx = makeContext(0.6)

    const result = controller.checkGoalGates(graph, 'run-1', undefined, {
      context: ctx,
      satisfactionThreshold: 0.8,
    })

    expect(result.satisfied).toBe(false)
  })

  it('AC4b: same controller — threshold=0.5 score=0.6 → satisfied: true (no cached threshold)', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])
    const ctx = makeContext(0.6)

    // First call with high threshold (fails)
    controller.checkGoalGates(graph, 'run-1', undefined, {
      context: ctx,
      satisfactionThreshold: 0.8,
    })

    // Second call with lower threshold (passes)
    const result = controller.checkGoalGates(graph, 'run-1', undefined, {
      context: ctx,
      satisfactionThreshold: 0.5,
    })

    expect(result.satisfied).toBe(true)
  })

  // AC6: backward compatibility — no options uses outcome-status path
  it('AC6a: no options, goalGate node with SUCCESS outcome → satisfied: true (outcome-status path)', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])

    controller.recordOutcome('gate-node', 'SUCCESS')
    const result = controller.checkGoalGates(graph, 'run-1')

    expect(result.satisfied).toBe(true)
    expect(result.failedGates).toEqual([])
  })

  it('AC6b: no options, goalGate node with FAILURE outcome → satisfied: false (outcome-status path preserved)', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])

    controller.recordOutcome('gate-node', 'FAILURE')
    const result = controller.checkGoalGates(graph, 'run-1')

    expect(result.satisfied).toBe(false)
    expect(result.failedGates).toContain('gate-node')
  })

  // AC7: score included in event when threshold is used
  it('AC7: score=0.65, threshold=0.7 → event payload has score=0.65 and satisfied=false', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])
    const eventBus = new TypedEventBusImpl<FactoryEvents>()
    const emitted: Array<{ runId: string; nodeId: string; satisfied: boolean; score?: number }> = []
    eventBus.on('graph:goal-gate-checked', (payload) => {
      emitted.push({ runId: payload.runId, nodeId: payload.nodeId, satisfied: payload.satisfied, ...(payload.score !== undefined ? { score: payload.score } : {}) })
    })
    const ctx = makeContext(0.65)

    controller.checkGoalGates(graph, 'run-1', eventBus, {
      context: ctx,
      satisfactionThreshold: 0.7,
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.score).toBe(0.65)
    expect(emitted[0]?.satisfied).toBe(false)
  })

  // AC7b: backward-compat path — event emitted without score field
  it('AC7b: no threshold (backward-compat) → event emitted without score (or score is undefined)', () => {
    const gate = makeGateNode('gate-node')
    const graph = makeGraph([gate])
    const eventBus = new TypedEventBusImpl<FactoryEvents>()
    const emitted: Array<{ score?: number }> = []
    eventBus.on('graph:goal-gate-checked', (payload) => {
      emitted.push({ ...(payload.score !== undefined ? { score: payload.score } : {}) })
    })

    controller.recordOutcome('gate-node', 'SUCCESS')
    controller.checkGoalGates(graph, 'run-1', eventBus)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.score).toBeUndefined()
  })
})
