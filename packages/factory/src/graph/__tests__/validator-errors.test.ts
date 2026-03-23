/**
 * Unit tests for GraphValidator — 8 error rules (story 42-4)
 *
 * Covers:
 *  AC1 — start_node error rule
 *  AC2 — terminal_node error rule
 *  AC3 — reachability error rule
 *  AC4 — edge_target_exists error rule
 *  AC5 — start_no_incoming and exit_no_outgoing error rules
 *  AC6 — condition_syntax error rule
 *  AC7 — validateOrRaise throws on errors, not on warnings
 *  AC8 — all tests pass, no regressions
 */

import { describe, it, expect } from 'vitest'
import { createValidator, isStartNode, isExitNode } from '../validator.js'
import type { Graph, GraphEdge, GraphNode, LintRule } from '../types.js'

// ---------------------------------------------------------------------------
// Test helper — build a minimal Graph object conforming to the Graph interface
// ---------------------------------------------------------------------------

type MinimalNode = { id: string; shape?: string; type?: string }
type MinimalEdge = { fromNode: string; toNode: string; condition?: string }

function makeGraph(
  nodes: MinimalNode[],
  edges: MinimalEdge[],
  modelStylesheet?: string,
): Graph {
  const nodeMap = new Map<string, GraphNode>()
  for (const n of nodes) {
    nodeMap.set(n.id, {
      id: n.id,
      label: n.id,
      shape: n.shape ?? 'box',
      type: n.type ?? '',
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
    })
  }

  const graphEdges: GraphEdge[] = edges.map((e) => ({
    fromNode: e.fromNode,
    toNode: e.toNode,
    label: '',
    condition: e.condition ?? '',
    weight: 1,
    fidelity: '',
    threadId: '',
    loopRestart: false,
  }))

  return {
    id: 'test',
    goal: '',
    label: '',
    modelStylesheet: modelStylesheet ?? '',
    defaultMaxRetries: 0,
    retryTarget: '',
    fallbackRetryTarget: '',
    defaultFidelity: '',
    nodes: nodeMap,
    edges: graphEdges,
    outgoingEdges(nodeId: string): GraphEdge[] {
      return graphEdges.filter((e) => e.fromNode === nodeId)
    },
    startNode(): GraphNode {
      for (const node of nodeMap.values()) {
        if (node.shape === 'Mdiamond' || node.id === 'start' || node.id === 'Start') return node
      }
      throw new Error('No start node')
    },
    exitNode(): GraphNode {
      for (const node of nodeMap.values()) {
        if (node.shape === 'Msquare' || node.id === 'exit' || node.id === 'end') return node
      }
      throw new Error('No exit node')
    },
  }
}

/** A minimal valid graph with one start, one exit, and a connecting edge. */
function makeValidGraph(): Graph {
  return makeGraph(
    [
      { id: 'start', shape: 'Mdiamond' },
      { id: 'work', shape: 'box' },
      { id: 'exit', shape: 'Msquare' },
    ],
    [
      { fromNode: 'start', toNode: 'work' },
      { fromNode: 'work', toNode: 'exit' },
    ],
  )
}

// ---------------------------------------------------------------------------
// isStartNode / isExitNode helper exports (sanity checks)
// ---------------------------------------------------------------------------

describe('isStartNode / isExitNode helpers', () => {
  it('isStartNode: detects shape=Mdiamond', () => {
    expect(isStartNode({ shape: 'Mdiamond', id: 'x' } as GraphNode)).toBe(true)
  })
  it('isStartNode: detects id=start', () => {
    expect(isStartNode({ shape: 'box', id: 'start' } as GraphNode)).toBe(true)
  })
  it('isStartNode: detects id=Start', () => {
    expect(isStartNode({ shape: 'box', id: 'Start' } as GraphNode)).toBe(true)
  })
  it('isStartNode: returns false for regular node', () => {
    expect(isStartNode({ shape: 'box', id: 'work' } as GraphNode)).toBe(false)
  })

  it('isExitNode: detects shape=Msquare', () => {
    expect(isExitNode({ shape: 'Msquare', id: 'x' } as GraphNode)).toBe(true)
  })
  it('isExitNode: detects id=exit', () => {
    expect(isExitNode({ shape: 'box', id: 'exit' } as GraphNode)).toBe(true)
  })
  it('isExitNode: detects id=end', () => {
    expect(isExitNode({ shape: 'box', id: 'end' } as GraphNode)).toBe(true)
  })
  it('isExitNode: returns false for regular node', () => {
    expect(isExitNode({ shape: 'box', id: 'work' } as GraphNode)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC1: start_node rule
// ---------------------------------------------------------------------------

describe('start_node rule', () => {
  it('happy path: exactly one start node (shape=Mdiamond) → no diagnostics', () => {
    const graph = makeValidGraph()
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'start_node')
    expect(diags).toHaveLength(0)
  })

  it('violation: zero start nodes → error diagnostic', () => {
    const graph = makeGraph(
      [
        { id: 'work', shape: 'box' },
        { id: 'exit', shape: 'Msquare' },
      ],
      [{ fromNode: 'work', toNode: 'exit' }],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'start_node')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.message).toMatch(/0/)
  })

  it('violation: two start nodes → error diagnostic', () => {
    const graph = makeGraph(
      [
        { id: 'start1', shape: 'Mdiamond' },
        { id: 'start2', shape: 'Mdiamond' },
        { id: 'exit', shape: 'Msquare' },
      ],
      [
        { fromNode: 'start1', toNode: 'exit' },
        { fromNode: 'start2', toNode: 'exit' },
      ],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'start_node')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.message).toMatch(/2/)
  })

  it('happy path: start node identified by id=start (no shape)', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'box' },
        { id: 'exit', shape: 'Msquare' },
      ],
      [{ fromNode: 'start', toNode: 'exit' }],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'start_node')
    expect(diags).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC2: terminal_node rule
// ---------------------------------------------------------------------------

describe('terminal_node rule', () => {
  it('happy path: exactly one exit node (shape=Msquare) → no diagnostics', () => {
    const graph = makeValidGraph()
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'terminal_node')
    expect(diags).toHaveLength(0)
  })

  it('violation: zero exit nodes → error diagnostic', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'work', shape: 'box' },
      ],
      [{ fromNode: 'start', toNode: 'work' }],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'terminal_node')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.message).toMatch(/0/)
  })

  it('violation: two exit nodes → error diagnostic', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'exit1', shape: 'Msquare' },
        { id: 'exit2', shape: 'Msquare' },
      ],
      [
        { fromNode: 'start', toNode: 'exit1' },
        { fromNode: 'start', toNode: 'exit2' },
      ],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'terminal_node')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.message).toMatch(/2/)
  })

  it('happy path: exit node identified by id=end (no shape)', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'end', shape: 'box' },
      ],
      [{ fromNode: 'start', toNode: 'end' }],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'terminal_node')
    expect(diags).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC5: start_no_incoming rule
// ---------------------------------------------------------------------------

describe('start_no_incoming rule', () => {
  it('happy path: no edges target the start node → no diagnostics', () => {
    const graph = makeValidGraph()
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'start_no_incoming')
    expect(diags).toHaveLength(0)
  })

  it('violation: an edge targets the start node → error diagnostic with edgeIndex', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'work', shape: 'box' },
        { id: 'exit', shape: 'Msquare' },
      ],
      [
        { fromNode: 'start', toNode: 'work' },
        { fromNode: 'work', toNode: 'exit' },
        { fromNode: 'work', toNode: 'start' }, // incoming to start — violates rule
      ],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'start_no_incoming')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.edgeIndex).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// AC5: exit_no_outgoing rule
// ---------------------------------------------------------------------------

describe('exit_no_outgoing rule', () => {
  it('happy path: no edges originate from the exit node → no diagnostics', () => {
    const graph = makeValidGraph()
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'exit_no_outgoing')
    expect(diags).toHaveLength(0)
  })

  it('violation: an edge originates from the exit node → error diagnostic with edgeIndex', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'work', shape: 'box' },
        { id: 'exit', shape: 'Msquare' },
      ],
      [
        { fromNode: 'start', toNode: 'work' },
        { fromNode: 'exit', toNode: 'work' }, // outgoing from exit — violates rule
        { fromNode: 'work', toNode: 'exit' },
      ],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'exit_no_outgoing')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.edgeIndex).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// AC4: edge_target_exists rule
// ---------------------------------------------------------------------------

describe('edge_target_exists rule', () => {
  it('happy path: all edge targets exist in nodes map → no diagnostics', () => {
    const graph = makeValidGraph()
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'edge_target_exists')
    expect(diags).toHaveLength(0)
  })

  it('violation: edge targets non-existent node → error diagnostic with edgeIndex', () => {
    // Build a graph manually with an edge pointing to a node not in the map
    const nodeMap = new Map<string, GraphNode>()
    nodeMap.set('start', {
      id: 'start',
      shape: 'Mdiamond',
      label: 'start',
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
    })
    nodeMap.set('exit', {
      id: 'exit',
      shape: 'Msquare',
      label: 'exit',
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
    })

    const edges: GraphEdge[] = [
      { fromNode: 'start', toNode: 'ghost', label: '', condition: '', weight: 1, fidelity: '', threadId: '', loopRestart: false },
      { fromNode: 'start', toNode: 'exit', label: '', condition: '', weight: 1, fidelity: '', threadId: '', loopRestart: false },
    ]

    const graph: Graph = {
      id: 'test',
      goal: '',
      label: '',
      modelStylesheet: '',
      defaultMaxRetries: 0,
      retryTarget: '',
      fallbackRetryTarget: '',
      defaultFidelity: '',
      nodes: nodeMap,
      edges,
      outgoingEdges(nodeId: string) { return edges.filter((e) => e.fromNode === nodeId) },
      startNode() { return nodeMap.get('start')! },
      exitNode() { return nodeMap.get('exit')! },
    }

    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'edge_target_exists')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.edgeIndex).toBe(0)
    expect(diags[0]!.message).toMatch(/ghost/)
  })
})

// ---------------------------------------------------------------------------
// AC3: reachability rule
// ---------------------------------------------------------------------------

describe('reachability rule', () => {
  it('fully-connected graph → no reachability diagnostics', () => {
    const graph = makeValidGraph()
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'reachability')
    expect(diags).toHaveLength(0)
  })

  it('single orphan node → one reachability error with correct nodeId', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'work', shape: 'box' },
        { id: 'exit', shape: 'Msquare' },
        { id: 'orphan', shape: 'box' }, // not reachable from start
      ],
      [
        { fromNode: 'start', toNode: 'work' },
        { fromNode: 'work', toNode: 'exit' },
        // orphan has no incoming edges from start chain
      ],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'reachability')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.nodeId).toBe('orphan')
    expect(diags[0]!.message).toMatch(/orphan/)
  })

  it('two orphan nodes → two reachability errors with correct nodeIds', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'work', shape: 'box' },
        { id: 'exit', shape: 'Msquare' },
        { id: 'orphan1', shape: 'box' },
        { id: 'orphan2', shape: 'box' },
      ],
      [
        { fromNode: 'start', toNode: 'work' },
        { fromNode: 'work', toNode: 'exit' },
      ],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'reachability')
    expect(diags).toHaveLength(2)
    const nodeIds = diags.map((d) => d.nodeId)
    expect(nodeIds).toContain('orphan1')
    expect(nodeIds).toContain('orphan2')
  })
})

// ---------------------------------------------------------------------------
// AC6: condition_syntax rule
// ---------------------------------------------------------------------------

describe('condition_syntax rule', () => {
  it('valid: outcome=success → no diagnostics', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'exit', shape: 'Msquare' },
      ],
      [{ fromNode: 'start', toNode: 'exit', condition: 'outcome=success' }],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'condition_syntax')
    expect(diags).toHaveLength(0)
  })

  it('valid: outcome!=fail → no diagnostics', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'exit', shape: 'Msquare' },
      ],
      [{ fromNode: 'start', toNode: 'exit', condition: 'outcome!=fail' }],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'condition_syntax')
    expect(diags).toHaveLength(0)
  })

  it('valid: outcome=success && iteration!=0 → no diagnostics', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'exit', shape: 'Msquare' },
      ],
      [{ fromNode: 'start', toNode: 'exit', condition: 'outcome=success && iteration!=0' }],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'condition_syntax')
    expect(diags).toHaveLength(0)
  })

  it('invalid: outcome==success (double-equals) → error at correct edgeIndex', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'work', shape: 'box' },
        { id: 'exit', shape: 'Msquare' },
      ],
      [
        { fromNode: 'start', toNode: 'work', condition: '' }, // index 0, no condition
        { fromNode: 'work', toNode: 'exit', condition: 'outcome==success' }, // index 1, bad condition
      ],
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'condition_syntax')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.edgeIndex).toBe(1)
    expect(diags[0]!.message).toMatch(/outcome==success/)
  })

  it('empty condition string → no diagnostics (edge has no condition)', () => {
    const graph = makeValidGraph() // edges have no conditions
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'condition_syntax')
    expect(diags).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// stylesheet_syntax rule (stub for story 42-7)
// ---------------------------------------------------------------------------

describe('stylesheet_syntax rule', () => {
  it('empty modelStylesheet → no diagnostics', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'exit', shape: 'Msquare' },
      ],
      [{ fromNode: 'start', toNode: 'exit' }],
      '', // empty stylesheet
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'stylesheet_syntax')
    expect(diags).toHaveLength(0)
  })

  it('valid stylesheet content → no diagnostics', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'exit', shape: 'Msquare' },
      ],
      [{ fromNode: 'start', toNode: 'exit' }],
      'box { llm_model: claude-3-5-sonnet; }',
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'stylesheet_syntax')
    expect(diags).toHaveLength(0)
  })

  it('malformed stylesheet (missing braces) → error diagnostic', () => {
    const graph = makeGraph(
      [
        { id: 'start', shape: 'Mdiamond' },
        { id: 'exit', shape: 'Msquare' },
      ],
      [{ fromNode: 'start', toNode: 'exit' }],
      'box llm_model: claude;', // missing braces
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'stylesheet_syntax')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.ruleId).toBe('stylesheet_syntax')
  })
})

// ---------------------------------------------------------------------------
// AC7: validateOrRaise
// ---------------------------------------------------------------------------

describe('validateOrRaise', () => {
  it('graph with error diagnostics → throws with ruleId in message', () => {
    // Graph with no start node — triggers start_node error
    const graph = makeGraph(
      [
        { id: 'work', shape: 'box' },
        { id: 'exit', shape: 'Msquare' },
      ],
      [{ fromNode: 'work', toNode: 'exit' }],
    )
    const validator = createValidator()
    expect(() => validator.validateOrRaise(graph)).toThrow(/start_node/)
  })

  it('graph with errors → thrown message lists all ruleIds', () => {
    // No start node AND no exit node — two errors
    const graph = makeGraph([{ id: 'work', shape: 'box' }], [])
    const validator = createValidator()
    let thrownMessage = ''
    try {
      validator.validateOrRaise(graph)
    } catch (err) {
      thrownMessage = (err as Error).message
    }
    expect(thrownMessage).toMatch(/Graph validation failed/)
    expect(thrownMessage).toMatch(/start_node/)
    expect(thrownMessage).toMatch(/terminal_node/)
  })

  it('graph with warnings only → does NOT throw', () => {
    // Use a valid graph (passes all 8 error rules), add a warning rule
    const graph = makeValidGraph()
    const validator = createValidator()
    const warningRule: LintRule = {
      id: 'test_warning',
      severity: 'warning',
      check: () => [
        {
          ruleId: 'test_warning',
          severity: 'warning',
          message: 'a test warning',
        },
      ],
    }
    validator.registerRule(warningRule)
    // Should not throw — only warning diagnostics, no errors
    expect(() => validator.validateOrRaise(graph)).not.toThrow()
  })

  it('valid graph (no errors, no warnings) → validate returns empty array', () => {
    const graph = makeValidGraph()
    const validator = createValidator()
    const diags = validator.validate(graph)
    expect(diags).toHaveLength(0)
  })

  it('valid graph → validateOrRaise does not throw and returns undefined', () => {
    const graph = makeValidGraph()
    const validator = createValidator()
    expect(() => validator.validateOrRaise(graph)).not.toThrow()
    expect(validator.validateOrRaise(graph)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// registerRule
// ---------------------------------------------------------------------------

describe('registerRule', () => {
  it('registered rule diagnostics appear in validate() output', () => {
    const graph = makeValidGraph()
    const validator = createValidator()
    const customRule: LintRule = {
      id: 'custom_rule',
      severity: 'error',
      check: () => [
        {
          ruleId: 'custom_rule',
          severity: 'error',
          message: 'custom error fired',
        },
      ],
    }
    validator.registerRule(customRule)
    const diags = validator.validate(graph)
    const custom = diags.find((d) => d.ruleId === 'custom_rule')
    expect(custom).toBeDefined()
    expect(custom!.message).toBe('custom error fired')
  })
})
