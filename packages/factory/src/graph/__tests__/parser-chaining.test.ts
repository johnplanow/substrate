/**
 * Unit tests for parseGraph() — story 42-3
 *
 * Covers:
 *  AC1 — Chained edge expansion (A -> B -> C produces two GraphEdge objects)
 *  AC2 — Node default block attribute inheritance
 *  AC3 — Subgraph flattening with class derivation
 *  AC4 — Edge default block attribute inheritance
 *  AC5 — outgoingEdges() Graph helper
 *  AC6 — Default block scoping — later block overrides earlier
 */

import { describe, it, expect } from 'vitest'
import { parseGraph } from '../parser.js'

// ---------------------------------------------------------------------------
// AC1: Chained edge expansion — A -> B -> C produces two GraphEdge objects
// ---------------------------------------------------------------------------

describe('parseGraph — AC1: chained edge expansion', () => {
  it('produces two GraphEdge objects for A -> B -> C', () => {
    const dot = `digraph G { A -> B -> C [label="x"] }`
    const graph = parseGraph(dot)
    expect(graph.edges).toHaveLength(2)

    const edgeAB = graph.edges[0]!
    const edgeBC = graph.edges[1]!
    expect(edgeAB.fromNode).toBe('A')
    expect(edgeAB.toNode).toBe('B')
    expect(edgeBC.fromNode).toBe('B')
    expect(edgeBC.toNode).toBe('C')
  })

  it('copies edge-level attributes to all pairwise edges in a chain (GE-P5)', () => {
    const dot = `digraph G { A -> B -> C [label="x"] }`
    const graph = parseGraph(dot)
    expect(graph.edges).toHaveLength(2)

    // label="x" must be on both generated edges
    const edgeAB = graph.edges[0]!
    const edgeBC = graph.edges[1]!
    expect(edgeAB.label).toBe('x')
    expect(edgeBC.label).toBe('x')
  })
})

// ---------------------------------------------------------------------------
// AC2: Node default block attribute inheritance (GE-P6)
// ---------------------------------------------------------------------------

describe('parseGraph — AC2: node default block inheritance', () => {
  it('applies node [shape=diamond] default to a node with no explicit shape', () => {
    const dot = `
      digraph G {
        node [shape=diamond]
        my_node [label="test"]
      }
    `
    const graph = parseGraph(dot)
    const node = graph.nodes.get('my_node')!
    expect(node).toBeDefined()
    expect(node.shape).toBe('diamond')
  })

  it('applies node [max_retries=3] default to a node with no explicit max_retries', () => {
    const dot = `
      digraph G {
        node [shape=diamond, max_retries=3]
        my_node [label="test"]
      }
    `
    const graph = parseGraph(dot)
    const node = graph.nodes.get('my_node')!
    expect(node).toBeDefined()
    expect(node.shape).toBe('diamond')
    expect(node.maxRetries).toBe(3)
  })

  it('allows explicit node attr to override the default (explicit wins)', () => {
    const dot = `
      digraph G {
        node [shape=diamond]
        explicit_node [shape=box]
      }
    `
    const graph = parseGraph(dot)
    const node = graph.nodes.get('explicit_node')!
    expect(node.shape).toBe('box')
  })
})

// ---------------------------------------------------------------------------
// AC4: Edge default block attribute inheritance (GE-P5 / GE-P6)
// ---------------------------------------------------------------------------

describe('parseGraph — AC4: edge default block inheritance', () => {
  it('applies edge [weight=5] default to subsequent edges', () => {
    const dot = `
      digraph G {
        edge [weight=5]
        A -> B
      }
    `
    const graph = parseGraph(dot)
    const edge = graph.edges[0]!
    expect(edge.weight).toBe(5)
  })

  it('applies edge [fidelity=summary] default to subsequent edges', () => {
    const dot = `
      digraph G {
        edge [weight=5, fidelity=summary]
        A -> B
      }
    `
    const graph = parseGraph(dot)
    const edge = graph.edges[0]!
    expect(edge.weight).toBe(5)
    expect(edge.fidelity).toBe('summary')
  })

  it('allows explicit edge attr to override the edge default', () => {
    const dot = `
      digraph G {
        edge [weight=5]
        A -> B [weight=10]
      }
    `
    const graph = parseGraph(dot)
    const edge = graph.edges[0]!
    expect(edge.weight).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// AC3: Subgraph flattening with class derivation (GE-P7)
// ---------------------------------------------------------------------------

describe('parseGraph — AC3: subgraph flattening', () => {
  it('nodes inside a labelled subgraph get class derived from the label', () => {
    const dot = `
      digraph G {
        subgraph cluster_loop {
          label="Loop A"
          node_x
          node_y
        }
      }
    `
    const graph = parseGraph(dot)

    const nx = graph.nodes.get('node_x')!
    const ny = graph.nodes.get('node_y')!
    expect(nx).toBeDefined()
    expect(ny).toBeDefined()
    expect(nx.class).toBe('loop-a')
    expect(ny.class).toBe('loop-a')

    // subgraph itself must NOT appear as a node
    expect(graph.nodes.has('cluster_loop')).toBe(false)
  })

  it('nodes in a subgraph without a label get no class assignment', () => {
    const dot = `
      digraph G {
        subgraph cluster_empty {
          no_label_node
        }
      }
    `
    const graph = parseGraph(dot)
    const node = graph.nodes.get('no_label_node')!
    expect(node).toBeDefined()
    // class should be the default empty string (no label → no class)
    expect(node.class).toBe('')
  })

  it('explicit class attribute on a node inside a subgraph wins over derived class', () => {
    const dot = `
      digraph G {
        subgraph cluster_loop {
          label="Loop A"
          override_node [class="custom"]
        }
      }
    `
    const graph = parseGraph(dot)
    const node = graph.nodes.get('override_node')!
    expect(node).toBeDefined()
    expect(node.class).toBe('custom')
  })
})

// ---------------------------------------------------------------------------
// AC5: outgoingEdges() Graph helper
// ---------------------------------------------------------------------------

describe('parseGraph — AC5: outgoingEdges() helper', () => {
  it('returns all edges originating from a given node', () => {
    const dot = `
      digraph G {
        A -> B
        A -> C
        B -> C
      }
    `
    const graph = parseGraph(dot)
    const outA = graph.outgoingEdges('A')
    expect(outA).toHaveLength(2)
    expect(outA.every((e) => e.fromNode === 'A')).toBe(true)
  })

  it('returns an empty array for an unknown node id', () => {
    const dot = `digraph G { A -> B }`
    const graph = parseGraph(dot)
    expect(graph.outgoingEdges('unknown')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC6: Default block scoping — later block overrides earlier
// ---------------------------------------------------------------------------

describe('parseGraph — AC6: sequential default blocks', () => {
  it('later node default block wins for the same attribute key', () => {
    const dot = `
      digraph G {
        node [shape=box]
        node [shape=ellipse]
        late_node [label="test"]
      }
    `
    const graph = parseGraph(dot)
    const node = graph.nodes.get('late_node')!
    expect(node).toBeDefined()
    // The second node [shape=ellipse] overwrites the first node [shape=box]
    expect(node.shape).toBe('ellipse')
  })
})
