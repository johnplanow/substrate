/**
 * Unit tests for GraphValidator — 5 warning rules (story 42-5)
 *
 * Covers:
 *  AC1 — type_known warning rule
 *  AC2 — fidelity_valid warning rule
 *  AC3 — retry_target_exists warning rule
 *  AC4 — goal_gate_has_retry warning rule
 *  AC5 — prompt_on_llm_nodes warning rule
 *  AC6 — custom rule via registerRule()
 *  AC7 — warnings do not block validateOrRaise()
 *  AC8 — all tests pass, no regressions
 */

import { describe, it, expect } from 'vitest'
import { createValidator } from '../validator.js'
import type { Graph, GraphEdge, GraphNode, LintRule } from '../types.js'

// ---------------------------------------------------------------------------
// Test helper — build a minimal Graph object conforming to the Graph interface
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    shape: overrides.shape ?? 'box',
    type: overrides.type ?? '',
    prompt: overrides.prompt ?? '',
    maxRetries: overrides.maxRetries ?? 0,
    goalGate: overrides.goalGate ?? false,
    retryTarget: overrides.retryTarget ?? '',
    fallbackRetryTarget: overrides.fallbackRetryTarget ?? '',
    fidelity: overrides.fidelity ?? '',
    threadId: overrides.threadId ?? '',
    class: overrides.class ?? '',
    timeout: overrides.timeout ?? 0,
    llmModel: overrides.llmModel ?? '',
    llmProvider: overrides.llmProvider ?? '',
    reasoningEffort: overrides.reasoningEffort ?? '',
    autoStatus: overrides.autoStatus ?? false,
    allowPartial: overrides.allowPartial ?? false,
    toolCommand: overrides.toolCommand ?? '',
    backend: overrides.backend ?? '',
  }
}

/**
 * Build a minimal valid Graph that passes all 8 error rules.
 * Nodes: start (Mdiamond) → work (box, label='work') → exit (Msquare)
 * Graph-level retryTarget/fallbackRetryTarget are empty by default.
 */
function makeValidGraph(overrides?: {
  extraNodes?: GraphNode[]
  graphRetryTarget?: string
  graphFallbackRetryTarget?: string
}): Graph {
  const startNode = makeNode({ id: 'start', shape: 'Mdiamond', label: 'start' })
  const workNode = makeNode({ id: 'work', shape: 'box', label: 'work task', prompt: 'do work' })
  const exitNode = makeNode({ id: 'exit', shape: 'Msquare', label: 'exit' })

  const allNodes = [startNode, workNode, exitNode, ...(overrides?.extraNodes ?? [])]
  const nodeMap = new Map<string, GraphNode>()
  for (const n of allNodes) {
    nodeMap.set(n.id, n)
  }

  const edges: GraphEdge[] = [
    { fromNode: 'start', toNode: 'work', label: '', condition: '', weight: 1, fidelity: '', threadId: '', loopRestart: false },
    { fromNode: 'work', toNode: 'exit', label: '', condition: '', weight: 1, fidelity: '', threadId: '', loopRestart: false },
  ]

  return {
    id: 'test',
    goal: '',
    label: '',
    modelStylesheet: '',
    defaultMaxRetries: 0,
    retryTarget: overrides?.graphRetryTarget ?? '',
    fallbackRetryTarget: overrides?.graphFallbackRetryTarget ?? '',
    defaultFidelity: '',
    nodes: nodeMap,
    edges,
    outgoingEdges(nodeId: string): GraphEdge[] {
      return edges.filter((e) => e.fromNode === nodeId)
    },
    startNode(): GraphNode {
      return nodeMap.get('start')!
    },
    exitNode(): GraphNode {
      return nodeMap.get('exit')!
    },
  }
}

// ---------------------------------------------------------------------------
// AC1: type_known rule
// ---------------------------------------------------------------------------

describe('type_known rule', () => {
  it('node with empty type → no warning', () => {
    const graph = makeValidGraph()
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'type_known')
    expect(diags).toHaveLength(0)
  })

  it('node with type=codergen (known) → no warning', () => {
    const graph = makeValidGraph({
      extraNodes: [makeNode({ id: 'coder1', type: 'codergen', label: 'coder', prompt: 'generate code' })],
    })
    // Also add an edge so reachability passes
    const coder1 = graph.nodes.get('coder1')!
    coder1.type = 'codergen'
    // coder1 is unreachable, let's put it in the graph reachably
    // Rebuild the graph with coder1 reachable
    const nodeMap = new Map<string, GraphNode>([
      ['start', makeNode({ id: 'start', shape: 'Mdiamond', label: 'start' })],
      ['coder1', makeNode({ id: 'coder1', type: 'codergen', label: 'coder', prompt: 'gen' })],
      ['exit', makeNode({ id: 'exit', shape: 'Msquare', label: 'exit' })],
    ])
    const edges: GraphEdge[] = [
      { fromNode: 'start', toNode: 'coder1', label: '', condition: '', weight: 1, fidelity: '', threadId: '', loopRestart: false },
      { fromNode: 'coder1', toNode: 'exit', label: '', condition: '', weight: 1, fidelity: '', threadId: '', loopRestart: false },
    ]
    const g: Graph = {
      id: 'test', goal: '', label: '', modelStylesheet: '', defaultMaxRetries: 0,
      retryTarget: '', fallbackRetryTarget: '', defaultFidelity: '',
      nodes: nodeMap, edges,
      outgoingEdges(nodeId: string) { return edges.filter((e) => e.fromNode === nodeId) },
      startNode() { return nodeMap.get('start')! },
      exitNode() { return nodeMap.get('exit')! },
    }
    const validator = createValidator()
    const diags = validator.validate(g).filter((d) => d.ruleId === 'type_known')
    expect(diags).toHaveLength(0)
  })

  it('node with type=unknown_handler (unknown) → 1 warning with correct ruleId and nodeId', () => {
    // Put the unknown-type node in the valid graph as the work node
    const graph = makeValidGraph()
    graph.nodes.get('work')!.type = 'unknown_handler'
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'type_known')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('warning')
    expect(diags[0]!.ruleId).toBe('type_known')
    expect(diags[0]!.nodeId).toBe('work')
    expect(diags[0]!.message).toMatch(/unknown_handler/)
  })
})

// ---------------------------------------------------------------------------
// AC2: fidelity_valid rule
// ---------------------------------------------------------------------------

describe('fidelity_valid rule', () => {
  it('node with empty fidelity → no warning', () => {
    const graph = makeValidGraph()
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'fidelity_valid')
    expect(diags).toHaveLength(0)
  })

  it('node with fidelity=high (valid) → no warning', () => {
    const graph = makeValidGraph()
    graph.nodes.get('work')!.fidelity = 'high'
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'fidelity_valid')
    expect(diags).toHaveLength(0)
  })

  it('node with fidelity=ultra (invalid) → 1 warning with correct ruleId and nodeId', () => {
    const graph = makeValidGraph()
    graph.nodes.get('work')!.fidelity = 'ultra'
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'fidelity_valid')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('warning')
    expect(diags[0]!.ruleId).toBe('fidelity_valid')
    expect(diags[0]!.nodeId).toBe('work')
    expect(diags[0]!.message).toMatch(/ultra/)
  })
})

// ---------------------------------------------------------------------------
// AC3: retry_target_exists rule
// ---------------------------------------------------------------------------

describe('retry_target_exists rule', () => {
  it('node with empty retryTarget → no warning', () => {
    const graph = makeValidGraph()
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'retry_target_exists')
    expect(diags).toHaveLength(0)
  })

  it('node with retryTarget pointing to existing node → no warning', () => {
    const graph = makeValidGraph()
    graph.nodes.get('work')!.retryTarget = 'start'
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'retry_target_exists')
    expect(diags).toHaveLength(0)
  })

  it('node with retryTarget pointing to ghost_node → 1 warning', () => {
    const graph = makeValidGraph()
    graph.nodes.get('work')!.retryTarget = 'ghost_node'
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'retry_target_exists')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('warning')
    expect(diags[0]!.ruleId).toBe('retry_target_exists')
    expect(diags[0]!.message).toMatch(/ghost_node/)
  })

  it('node with fallbackRetryTarget pointing to ghost_node → 1 warning', () => {
    const graph = makeValidGraph()
    graph.nodes.get('work')!.fallbackRetryTarget = 'ghost_node'
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'retry_target_exists')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('warning')
    expect(diags[0]!.message).toMatch(/ghost_node/)
  })

  it('graph.retryTarget pointing to ghost_node → 1 warning', () => {
    const graph = makeValidGraph({ graphRetryTarget: 'ghost_node' })
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'retry_target_exists')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('warning')
    expect(diags[0]!.message).toMatch(/ghost_node/)
  })

  it('graph.fallbackRetryTarget pointing to ghost_node → 1 warning', () => {
    const graph = makeValidGraph({ graphFallbackRetryTarget: 'ghost_node' })
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'retry_target_exists')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('warning')
    expect(diags[0]!.message).toMatch(/ghost_node/)
  })
})

// ---------------------------------------------------------------------------
// AC4: goal_gate_has_retry rule
// ---------------------------------------------------------------------------

describe('goal_gate_has_retry rule', () => {
  it('goalGate=false → no warning', () => {
    const graph = makeValidGraph()
    graph.nodes.get('work')!.goalGate = false
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'goal_gate_has_retry')
    expect(diags).toHaveLength(0)
  })

  it('goalGate=true with node-level retryTarget set → no warning', () => {
    const graph = makeValidGraph()
    graph.nodes.get('work')!.goalGate = true
    graph.nodes.get('work')!.retryTarget = 'start'
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'goal_gate_has_retry')
    expect(diags).toHaveLength(0)
  })

  it('goalGate=true with graph-level retryTarget set → no warning', () => {
    const graph = makeValidGraph({ graphRetryTarget: 'start' })
    graph.nodes.get('work')!.goalGate = true
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'goal_gate_has_retry')
    expect(diags).toHaveLength(0)
  })

  it('goalGate=true, node retryTarget empty, no graph-level default → 1 warning', () => {
    const graph = makeValidGraph()
    graph.nodes.get('work')!.goalGate = true
    // retryTarget remains '', graph.retryTarget remains ''
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'goal_gate_has_retry')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('warning')
    expect(diags[0]!.ruleId).toBe('goal_gate_has_retry')
    expect(diags[0]!.nodeId).toBe('work')
    expect(diags[0]!.message).toMatch(/goal_gate/)
  })
})

// ---------------------------------------------------------------------------
// AC5: prompt_on_llm_nodes rule
// ---------------------------------------------------------------------------

describe('prompt_on_llm_nodes rule', () => {
  it('shape=box with prompt set → no warning', () => {
    const graph = makeValidGraph()
    // work node already has shape=box and prompt='do work'
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'prompt_on_llm_nodes')
    expect(diags).toHaveLength(0)
  })

  it('shape=box with label set (no prompt) → no warning', () => {
    const graph = makeValidGraph()
    graph.nodes.get('work')!.prompt = ''
    graph.nodes.get('work')!.label = 'My Task'
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'prompt_on_llm_nodes')
    expect(diags).toHaveLength(0)
  })

  it('shape=box with both prompt and label empty → 1 warning', () => {
    const graph = makeValidGraph()
    graph.nodes.get('work')!.prompt = ''
    graph.nodes.get('work')!.label = ''
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'prompt_on_llm_nodes')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('warning')
    expect(diags[0]!.ruleId).toBe('prompt_on_llm_nodes')
    expect(diags[0]!.nodeId).toBe('work')
    expect(diags[0]!.message).toMatch(/no prompt or label/)
  })

  it('shape=diamond (non-codergen) with both empty → no warning', () => {
    // Use a non-box, non-codergen shape; add it as an extra node to a valid graph
    // We need to make it reachable from start, so we rebuild the graph
    const nodeMap = new Map<string, GraphNode>([
      ['start', makeNode({ id: 'start', shape: 'Mdiamond', label: 'start' })],
      ['diamond_node', makeNode({ id: 'diamond_node', shape: 'diamond', label: '', prompt: '' })],
      ['exit', makeNode({ id: 'exit', shape: 'Msquare', label: 'exit' })],
    ])
    const edges: GraphEdge[] = [
      { fromNode: 'start', toNode: 'diamond_node', label: '', condition: '', weight: 1, fidelity: '', threadId: '', loopRestart: false },
      { fromNode: 'diamond_node', toNode: 'exit', label: '', condition: '', weight: 1, fidelity: '', threadId: '', loopRestart: false },
    ]
    const g: Graph = {
      id: 'test', goal: '', label: '', modelStylesheet: '', defaultMaxRetries: 0,
      retryTarget: '', fallbackRetryTarget: '', defaultFidelity: '',
      nodes: nodeMap, edges,
      outgoingEdges(nodeId: string) { return edges.filter((e) => e.fromNode === nodeId) },
      startNode() { return nodeMap.get('start')! },
      exitNode() { return nodeMap.get('exit')! },
    }
    const validator = createValidator()
    const diags = validator.validate(g).filter((d) => d.ruleId === 'prompt_on_llm_nodes')
    expect(diags).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC6: Custom rule via registerRule()
// ---------------------------------------------------------------------------

describe('registerRule()', () => {
  it('registered custom rule diagnostics appear in validate() output alongside built-in results', () => {
    const graph = makeValidGraph()
    const validator = createValidator()

    const customRule: LintRule = {
      id: 'custom_warning_rule',
      severity: 'warning',
      check: () => [
        {
          ruleId: 'custom_warning_rule',
          severity: 'warning',
          message: 'custom warning fired',
          nodeId: 'work',
        },
      ],
    }

    validator.registerRule(customRule)
    const diags = validator.validate(graph)

    const custom = diags.find((d) => d.ruleId === 'custom_warning_rule')
    expect(custom).toBeDefined()
    expect(custom!.severity).toBe('warning')
    expect(custom!.message).toBe('custom warning fired')
    expect(custom!.nodeId).toBe('work')
  })
})

// ---------------------------------------------------------------------------
// AC7: Warnings do not block validateOrRaise()
// ---------------------------------------------------------------------------

describe('validateOrRaise() with warnings only', () => {
  it('graph with warnings but no errors → validateOrRaise does NOT throw', () => {
    // Trigger type_known warning by setting an unknown type on the work node
    const graph = makeValidGraph()
    graph.nodes.get('work')!.type = 'some_unknown_type'
    graph.nodes.get('work')!.prompt = 'do work' // keep prompt to avoid prompt_on_llm_nodes warning
    // Also clear the label on start/exit so only type_known fires on work
    const validator = createValidator()

    // Confirm there is at least one warning
    const diags = validator.validate(graph)
    const warnings = diags.filter((d) => d.severity === 'warning')
    const errors = diags.filter((d) => d.severity === 'error')
    expect(warnings.length).toBeGreaterThan(0)
    expect(errors).toHaveLength(0)

    // validateOrRaise should NOT throw
    expect(() => validator.validateOrRaise(graph)).not.toThrow()
    expect(validator.validateOrRaise(graph)).toBeUndefined()
  })
})
