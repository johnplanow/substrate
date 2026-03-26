/**
 * Unit tests for packages/factory/src/graph/fidelity.ts
 *
 * Covers AC1 (parseFidelityLevel mapping table) and AC2 (resolveFidelity precedence chain).
 * Story 49-5.
 */

import { describe, it, expect } from 'vitest'
import { parseFidelityLevel, resolveFidelity } from '../fidelity.js'
import type { GraphNode, GraphEdge, Graph } from '../types.js'

// ---------------------------------------------------------------------------
// Minimal stubs
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
  backend: '',
}

function makeNode(fidelity: string): GraphNode {
  return { ...minimalNode, fidelity }
}

function makeEdge(fidelity: string): GraphEdge {
  return {
    fromNode: 'a',
    toNode: 'b',
    label: '',
    condition: '',
    weight: 0,
    fidelity,
    threadId: '',
    loopRestart: false,
  }
}

function makeGraph(defaultFidelity: '' | 'high' | 'medium' | 'low' | 'draft'): Graph {
  const nodes = new Map<string, GraphNode>()
  return {
    id: '',
    goal: '',
    label: '',
    modelStylesheet: '',
    defaultMaxRetries: 0,
    retryTarget: '',
    fallbackRetryTarget: '',
    defaultFidelity,
    nodes,
    edges: [],
    outgoingEdges: () => [],
    startNode: () => minimalNode,
    exitNode: () => minimalNode,
  }
}

// ---------------------------------------------------------------------------
// parseFidelityLevel tests (AC1 — 10 cases)
// ---------------------------------------------------------------------------

describe('parseFidelityLevel', () => {
  it("returns null for '' (empty string)", () => {
    expect(parseFidelityLevel('')).toBeNull()
  })

  it("returns null for 'full' (explicit no-op)", () => {
    expect(parseFidelityLevel('full')).toBeNull()
  })

  it("returns null for unrecognized value 'unrecognized-xyz'", () => {
    expect(parseFidelityLevel('unrecognized-xyz')).toBeNull()
  })

  it("returns 'high' for 'high'", () => {
    expect(parseFidelityLevel('high')).toBe('high')
  })

  it("returns 'high' for 'summary:high' (checkpoint-resume format)", () => {
    expect(parseFidelityLevel('summary:high')).toBe('high')
  })

  it("returns 'medium' for 'medium'", () => {
    expect(parseFidelityLevel('medium')).toBe('medium')
  })

  it("returns 'medium' for 'summary:medium'", () => {
    expect(parseFidelityLevel('summary:medium')).toBe('medium')
  })

  it("returns 'low' for 'low'", () => {
    expect(parseFidelityLevel('low')).toBe('low')
  })

  it("returns 'low' for 'draft' (Attractor spec legacy mode)", () => {
    expect(parseFidelityLevel('draft')).toBe('low')
  })

  it("returns 'low' for 'summary:low'", () => {
    expect(parseFidelityLevel('summary:low')).toBe('low')
  })
})

// ---------------------------------------------------------------------------
// resolveFidelity tests (AC2 — 4 cases)
// ---------------------------------------------------------------------------

describe('resolveFidelity', () => {
  it('edge fidelity takes precedence over node fidelity and graph default', () => {
    const node = makeNode('high')
    const edge = makeEdge('low')
    const graph = makeGraph('medium')
    expect(resolveFidelity(node, edge, graph)).toBe('low')
  })

  it('falls back to node.fidelity when edge is undefined', () => {
    const node = makeNode('high')
    const graph = makeGraph('medium')
    expect(resolveFidelity(node, undefined, graph)).toBe('high')
  })

  it('falls back to node.fidelity when edge.fidelity is empty', () => {
    const node = makeNode('high')
    const edge = makeEdge('')
    const graph = makeGraph('medium')
    expect(resolveFidelity(node, edge, graph)).toBe('high')
  })

  it('falls back to graph.defaultFidelity when node.fidelity is empty', () => {
    const node = makeNode('')
    const edge = makeEdge('')
    const graph = makeGraph('medium')
    expect(resolveFidelity(node, edge, graph)).toBe('medium')
  })

  it("returns '' when all sources are empty or unset", () => {
    const node = makeNode('')
    const graph = makeGraph('')
    expect(resolveFidelity(node, undefined, graph)).toBe('')
  })
})
