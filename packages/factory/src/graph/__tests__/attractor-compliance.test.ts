/**
 * Spec compliance tests for the Attractor graph engine.
 *
 * Replays pseudocode examples from the Attractor spec through
 * selectEdge(), evaluateGates(), and checkpoint resume APIs.
 *
 * Story 42-17.
 */

// AttractorBench structural conformance parity — Phase A mandatory
// See: https://github.com/strongdm/attractorbench
// Behavioral conformance tests are advisory in Phase A; required by Phase B exit.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import crypto from 'node:crypto'

import { selectEdge, normalizeLabel } from '../edge-selector.js'
import { createConvergenceController } from '../../convergence/controller.js'
import { CheckpointManager } from '../checkpoint.js'
import { createGraphExecutor } from '../executor.js'
import { createValidator } from '../validator.js'
import { parseGraph } from '../parser.js'
import { GraphContext } from '../context.js'
import type { Graph, GraphNode, GraphEdge, Outcome, IGraphContext } from '../types.js'
import type { IHandlerRegistry } from '../../handlers/types.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'
import type { GraphExecutorConfig } from '../executor.js'

// ---------------------------------------------------------------------------
// DOT fixture for resume/fidelity tests (spec Section 5.3)
// ---------------------------------------------------------------------------

const COMPLIANCE_RESUME_DOT = `
digraph compliance_resume {
  graph [goal="Resume compliance test"]
  start [shape=Mdiamond]
  node1 [type=codergen, prompt="Step 1"]
  node2 [type=codergen, prompt="Step 2"]
  exit [shape=Msquare]

  start -> node1
  node1 -> node2
  node2 -> exit
}
`

const COMPLIANCE_FIDELITY_RESUME_DOT = `
digraph compliance_fidelity_resume {
  graph [goal="Fidelity degradation test"]
  start [shape=Mdiamond]
  node1 [type=codergen, prompt="Step 1", fidelity=full]
  node2 [type=codergen, prompt="Step 2"]
  exit [shape=Msquare]

  start -> node1
  node1 -> node2
  node2 -> exit
}
`

// ---------------------------------------------------------------------------
// Shared helper factories
// ---------------------------------------------------------------------------

/** A node with all required fields at sensible defaults. */
const MINIMAL_NODE: GraphNode = {
  id: '',
  label: '',
  shape: 'box',
  type: 'codergen',
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

function makeNode(id: string, overrides?: Partial<GraphNode>): GraphNode {
  return { ...MINIMAL_NODE, id, ...overrides }
}

function makeEdge(fromNode: string, toNode: string, overrides?: Partial<GraphEdge>): GraphEdge {
  return {
    fromNode,
    toNode,
    label: '',
    condition: '',
    weight: 0,
    fidelity: '',
    threadId: '',
    loopRestart: false,
    ...overrides,
  }
}

/**
 * Build a minimal Graph conforming to the Graph interface.
 * startNodeId / exitNodeId control which nodes serve as start/exit.
 */
function makeGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  startNodeId?: string,
  exitNodeId?: string,
): Graph {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const resolveStart = (): GraphNode => {
    if (startNodeId) return nodeMap.get(startNodeId)!
    for (const n of nodeMap.values()) {
      if (n.shape === 'Mdiamond') return n
    }
    throw new Error('No start node')
  }
  const resolveExit = (): GraphNode => {
    if (exitNodeId) return nodeMap.get(exitNodeId)!
    for (const n of nodeMap.values()) {
      if (n.shape === 'Msquare') return n
    }
    throw new Error('No exit node')
  }
  return {
    id: '',
    goal: '',
    label: '',
    modelStylesheet: '',
    defaultMaxRetries: 0,
    retryTarget: '',
    fallbackRetryTarget: '',
    defaultFidelity: '',
    nodes: nodeMap,
    edges,
    outgoingEdges: (nodeId: string) => edges.filter((e) => e.fromNode === nodeId),
    startNode: resolveStart,
    exitNode: resolveExit,
  }
}

/** Build a Graph with only the minimal start/exit structure for lint-rule tests. */
function makeLintGraph(
  extraNodes: Array<Partial<GraphNode> & { id: string }>,
  extraEdges: Array<{
    fromNode: string
    toNode: string
    condition?: string
    loopRestart?: boolean
  }>,
  overrides?: Partial<{
    modelStylesheet: string
    retryTarget: string
    fallbackRetryTarget: string
  }>,
): Graph {
  const baseNodes: GraphNode[] = [
    makeNode('start', { shape: 'Mdiamond', type: '' }),
    makeNode('exit', { shape: 'Msquare', type: '' }),
    ...extraNodes.map((n) => makeNode(n.id, n)),
  ]
  const baseEdges: GraphEdge[] = extraEdges.map((e) =>
    makeEdge(e.fromNode, e.toNode, {
      condition: e.condition ?? '',
      loopRestart: e.loopRestart ?? false,
    }),
  )
  const nodeMap = new Map(baseNodes.map((n) => [n.id, n]))
  return {
    id: 'test',
    goal: '',
    label: '',
    modelStylesheet: overrides?.modelStylesheet ?? '',
    defaultMaxRetries: 0,
    retryTarget: overrides?.retryTarget ?? '',
    fallbackRetryTarget: overrides?.fallbackRetryTarget ?? '',
    defaultFidelity: '',
    nodes: nodeMap,
    edges: baseEdges,
    outgoingEdges: (nodeId: string) => baseEdges.filter((e) => e.fromNode === nodeId),
    startNode: () => nodeMap.get('start')!,
    exitNode: () => nodeMap.get('exit')!,
  }
}

/** Build a mock IHandlerRegistry that resolves every node via the given handler factory. */
function makeRegistry(
  handlerFactory: (node: GraphNode, ctx: IGraphContext) => void,
  statusOverride?: 'SUCCESS' | 'FAILURE',
): IHandlerRegistry {
  return {
    register: vi.fn(),
    registerShape: vi.fn(),
    setDefault: vi.fn(),
    resolve: vi.fn().mockImplementation(
      () => async (node: GraphNode, ctx: IGraphContext): Promise<Outcome> => {
        handlerFactory(node, ctx)
        return { status: statusOverride ?? ('SUCCESS' as const) }
      },
    ),
  }
}

/** Build a mock TypedEventBus that captures all emitted events. */
function makeEventBus(): {
  bus: TypedEventBus<FactoryEvents>
  nodeStartedIds: () => string[]
} {
  const nodeStartedIds: string[] = []
  const bus: TypedEventBus<FactoryEvents> = {
    emit: vi.fn().mockImplementation((event: string, payload: unknown) => {
      if (event === 'graph:node-started') {
        nodeStartedIds.push((payload as { nodeId: string }).nodeId)
      }
    }),
    on: vi.fn(),
    off: vi.fn(),
  }
  return { bus, nodeStartedIds: () => [...nodeStartedIds] }
}

// ---------------------------------------------------------------------------
// Task 2: Edge selection compliance — spec Section 3.3
// ---------------------------------------------------------------------------

describe('selectEdge compliance — spec Section 3.3', () => {
  // Step 1: Condition-matched edges beat weight
  it('AC1 — Step 1: condition match returns conditional edge over high-weight unconditional', async () => {
    const node = makeNode('origin')
    const condEdge = makeEdge('origin', 'dest-conditional', { condition: 'outcome=success', weight: 0 })
    const unconEdge = makeEdge('origin', 'dest-unconditional', { weight: 10 })
    const graph = makeGraph([node], [condEdge, unconEdge])
    const ctx = new GraphContext({ outcome: 'success' })
    const outcome: Outcome = { status: 'SUCCESS' }

    const selected = await selectEdge(node, outcome, ctx, graph)
    expect(selected).toBe(condEdge)
  })

  it('AC1 variant — Step 1: no condition match falls through to Step 4 (weight)', async () => {
    const node = makeNode('origin')
    const condEdge = makeEdge('origin', 'dest-conditional', { condition: 'outcome=success', weight: 0 })
    const unconEdge = makeEdge('origin', 'dest-unconditional', { weight: 10 })
    const graph = makeGraph([node], [condEdge, unconEdge])
    const ctx = new GraphContext({ outcome: 'failure' })
    const outcome: Outcome = { status: 'SUCCESS' }

    const selected = await selectEdge(node, outcome, ctx, graph)
    expect(selected).toBe(unconEdge)
  })

  // Step 2: Preferred label with accelerator prefix stripping
  it('AC2 — Step 2: [Y] prefix stripped, label matches preferredLabel "yes"', async () => {
    const node = makeNode('origin')
    const yesEdge = makeEdge('origin', 'yes-target', { label: '[Y] Yes' })
    const noEdge = makeEdge('origin', 'no-target', { label: 'No' })
    const graph = makeGraph([node], [yesEdge, noEdge])
    const ctx = new GraphContext()
    const outcome: Outcome = { status: 'SUCCESS', preferredLabel: 'yes' }

    const selected = await selectEdge(node, outcome, ctx, graph)
    expect(selected).toBe(yesEdge)
  })

  it('AC2 variant — Step 2: Y) prefix stripped, label matches preferredLabel "confirm"', async () => {
    const node = makeNode('origin')
    const confirmEdge = makeEdge('origin', 'confirm-target', { label: 'Y) Confirm' })
    const otherEdge = makeEdge('origin', 'other-target', { label: 'Cancel' })
    const graph = makeGraph([node], [confirmEdge, otherEdge])
    const ctx = new GraphContext()
    const outcome: Outcome = { status: 'SUCCESS', preferredLabel: 'confirm' }

    const selected = await selectEdge(node, outcome, ctx, graph)
    expect(selected).toBe(confirmEdge)
  })

  // Step 3: Suggested next IDs
  it('Step 3: suggestedNextIds matches edge target', async () => {
    const node = makeNode('origin')
    const edgeA = makeEdge('origin', 'a')
    const edgeB = makeEdge('origin', 'b')
    const edgeC = makeEdge('origin', 'c')
    const graph = makeGraph([node], [edgeA, edgeB, edgeC])
    const ctx = new GraphContext()
    const outcome: Outcome = { status: 'SUCCESS', suggestedNextIds: ['b'] }

    const selected = await selectEdge(node, outcome, ctx, graph)
    expect(selected).toBe(edgeB)
  })

  // Steps 4 & 5: Weight with lexical tiebreak
  it('AC3 — Steps 4&5: weight 5 tie between charlie and alpha → lexically-first alpha wins', async () => {
    const node = makeNode('origin')
    const charlieEdge = makeEdge('origin', 'charlie', { weight: 5 })
    const alphaEdge = makeEdge('origin', 'alpha', { weight: 5 })
    const bravoEdge = makeEdge('origin', 'bravo', { weight: 3 })
    const graph = makeGraph([node], [charlieEdge, alphaEdge, bravoEdge])
    const ctx = new GraphContext()
    const outcome: Outcome = { status: 'SUCCESS' }

    const selected = await selectEdge(node, outcome, ctx, graph)
    expect(selected).toBe(alphaEdge)
    expect(selected?.toNode).toBe('alpha')
  })

  // Empty edges
  it('empty edges: no outgoing edges → returns null', async () => {
    const node = makeNode('origin')
    const graph = makeGraph([node], [])
    const ctx = new GraphContext()
    const outcome: Outcome = { status: 'SUCCESS' }

    const selected = await selectEdge(node, outcome, ctx, graph)
    expect(selected).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Task 3: Goal gate compliance — spec Section 3.4
// ---------------------------------------------------------------------------

describe('evaluateGates compliance — spec Section 3.4', () => {
  it('SUCCESS satisfies a goalGate=true node', () => {
    const controller = createConvergenceController()
    controller.recordOutcome('nodeA', 'SUCCESS')
    const graph = makeGraph([makeNode('nodeA', { goalGate: true })], [])
    const result = controller.evaluateGates(graph)
    expect(result).toEqual({ satisfied: true, failingNodes: [] })
  })

  it('AC4 — PARTIAL_SUCCESS satisfies a goalGate=true node (spec Section 3.4)', () => {
    const controller = createConvergenceController()
    controller.recordOutcome('nodeA', 'PARTIAL_SUCCESS')
    const graph = makeGraph([makeNode('nodeA', { goalGate: true })], [])
    const result = controller.evaluateGates(graph)
    expect(result).toEqual({ satisfied: true, failingNodes: [] })
  })

  it('AC4 — FAILURE does not satisfy goalGate=true node, appears in failingNodes', () => {
    const controller = createConvergenceController()
    controller.recordOutcome('nodeA', 'FAILURE')
    const graph = makeGraph([makeNode('nodeA', { goalGate: true })], [])
    const result = controller.evaluateGates(graph)
    expect(result.satisfied).toBe(false)
    expect(result.failingNodes).toContain('nodeA')
  })

  it('AC4 — Unrecorded outcome (never executed) fails gate', () => {
    const controller = createConvergenceController()
    // nodeA has no recorded outcome
    const graph = makeGraph([makeNode('nodeA', { goalGate: true })], [])
    const result = controller.evaluateGates(graph)
    expect(result.satisfied).toBe(false)
    expect(result.failingNodes).toContain('nodeA')
  })

  it('AC4 — PARTIAL_SUCCESS satisfies; FAILURE and unrecorded both fail', () => {
    const controller = createConvergenceController()
    controller.recordOutcome('partial', 'PARTIAL_SUCCESS')
    controller.recordOutcome('failing', 'FAILURE')
    // 'unrecorded' has no recorded outcome
    const graph = makeGraph(
      [
        makeNode('partial', { goalGate: true }),
        makeNode('failing', { goalGate: true }),
        makeNode('unrecorded', { goalGate: true }),
      ],
      [],
    )
    const result = controller.evaluateGates(graph)
    expect(result.satisfied).toBe(false)
    expect(result.failingNodes).toContain('failing')
    expect(result.failingNodes).toContain('unrecorded')
    expect(result.failingNodes).not.toContain('partial')
  })

  it('mixed SUCCESS + PARTIAL_SUCCESS: both satisfied → { satisfied: true, failingNodes: [] }', () => {
    const controller = createConvergenceController()
    controller.recordOutcome('nodeA', 'SUCCESS')
    controller.recordOutcome('nodeB', 'PARTIAL_SUCCESS')
    const graph = makeGraph(
      [makeNode('nodeA', { goalGate: true }), makeNode('nodeB', { goalGate: true })],
      [],
    )
    const result = controller.evaluateGates(graph)
    expect(result).toEqual({ satisfied: true, failingNodes: [] })
  })

  it('mixed SUCCESS + FAILURE: only failing node in failingNodes', () => {
    const controller = createConvergenceController()
    controller.recordOutcome('nodeA', 'SUCCESS')
    controller.recordOutcome('nodeB', 'FAILURE')
    const graph = makeGraph(
      [makeNode('nodeA', { goalGate: true }), makeNode('nodeB', { goalGate: true })],
      [],
    )
    const result = controller.evaluateGates(graph)
    expect(result.satisfied).toBe(false)
    expect(result.failingNodes).toEqual(['nodeB'])
    expect(result.failingNodes).not.toContain('nodeA')
  })

  it('no goalGate=true nodes: vacuously satisfied', () => {
    const controller = createConvergenceController()
    const graph = makeGraph(
      [makeNode('nodeA', { goalGate: false }), makeNode('nodeB', { goalGate: false })],
      [],
    )
    const result = controller.evaluateGates(graph)
    expect(result).toEqual({ satisfied: true, failingNodes: [] })
  })
})

// ---------------------------------------------------------------------------
// Task 4: Checkpoint resume compliance — spec Section 5.3
// ---------------------------------------------------------------------------

describe('checkpoint resume compliance — spec Section 5.3', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `attractor-compliance-${crypto.randomUUID()}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('AC5 — completed nodes are skipped and context is restored on resume', async () => {
    // Write seed checkpoint using CheckpointManager.save()
    const checkpointManager = new CheckpointManager()
    const seedContext = new GraphContext({ result: 'ok', attempt: '3' })
    await checkpointManager.save(tmpDir, {
      currentNode: 'node1',
      completedNodes: ['start', 'node1'],
      nodeRetries: {},
      context: seedContext,
    })

    // Parse and validate the compliance resume graph
    const graph = parseGraph(COMPLIANCE_RESUME_DOT)
    const validator = createValidator()
    const validationErrors = validator.validate(graph).filter((d) => d.severity === 'error')
    expect(validationErrors).toHaveLength(0)

    // Track graph:node-started events and captured contexts per node
    const { bus, nodeStartedIds } = makeEventBus()
    const capturedContextByNode: Record<string, IGraphContext> = {}

    const registry = makeRegistry((node, ctx) => {
      capturedContextByNode[node.id] = ctx
    })

    const executor = createGraphExecutor()
    const config: GraphExecutorConfig = {
      runId: 'compliance-resume-test',
      logsRoot: tmpDir,
      handlerRegistry: registry,
      eventBus: bus,
      checkpointPath: path.join(tmpDir, 'checkpoint.json'),
    }

    const finalOutcome = await executor.run(graph, config)

    // graph:node-started must NOT include 'start' or 'node1' (skipped)
    expect(nodeStartedIds()).not.toContain('start')
    expect(nodeStartedIds()).not.toContain('node1')

    // graph:node-started MUST include 'node2' and 'exit' is never dispatched (exit check)
    expect(nodeStartedIds()).toContain('node2')

    // Context is restored: node2 handler receives context seeded from checkpoint
    expect(capturedContextByNode['node2']).toBeDefined()
    expect(capturedContextByNode['node2']!.getString('result')).toBe('ok')
    expect(capturedContextByNode['node2']!.getString('attempt')).toBe('3')

    // Final outcome is SUCCESS
    expect(finalOutcome.status).toBe('SUCCESS')
  })
})

// ---------------------------------------------------------------------------
// Task 5: Fidelity degradation on resume — spec Section 5.3 step 6
// ---------------------------------------------------------------------------

describe('fidelity degradation on resume — spec Section 5.3 step 6', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `attractor-fidelity-${crypto.randomUUID()}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('first resumed node gets fidelity="summary:high" when last completed node had fidelity="full"', async () => {
    // Write seed checkpoint: node1 (which has fidelity=full in the DOT) is the last completed node
    const checkpointManager = new CheckpointManager()
    const seedContext = new GraphContext({ result: 'ok' })
    await checkpointManager.save(tmpDir, {
      currentNode: 'node1',
      completedNodes: ['start', 'node1'],
      nodeRetries: {},
      context: seedContext,
    })

    // Parse graph where node1 has fidelity=full
    const graph = parseGraph(COMPLIANCE_FIDELITY_RESUME_DOT)

    // Capture the node argument passed to each handler dispatch
    const capturedNodeByNodeId: Record<string, GraphNode> = {}
    const registry = makeRegistry((node) => {
      capturedNodeByNodeId[node.id] = node
    })

    const { bus } = makeEventBus()
    const config: GraphExecutorConfig = {
      runId: 'compliance-fidelity-test',
      logsRoot: tmpDir,
      handlerRegistry: registry,
      eventBus: bus,
      checkpointPath: path.join(tmpDir, 'checkpoint.json'),
    }

    await createGraphExecutor().run(graph, config)

    // node2 is the first resumed node; its fidelity should be degraded to 'summary:high'
    expect(capturedNodeByNodeId['node2']).toBeDefined()
    expect(capturedNodeByNodeId['node2']!.fidelity).toBe('summary:high')
  })

  it('subsequent resumed nodes use their configured fidelity (not the degraded value)', async () => {
    // Extend the graph by adding node3 after node2
    const EXTENDED_DOT = `
digraph compliance_fidelity_extended {
  graph [goal="Extended fidelity test"]
  start [shape=Mdiamond]
  node1 [type=codergen, prompt="Step 1", fidelity=full]
  node2 [type=codergen, prompt="Step 2", fidelity=medium]
  node3 [type=codergen, prompt="Step 3", fidelity=high]
  exit [shape=Msquare]

  start -> node1
  node1 -> node2
  node2 -> node3
  node3 -> exit
}
`
    const checkpointManager = new CheckpointManager()
    const seedCtx = new GraphContext()
    await checkpointManager.save(tmpDir, {
      currentNode: 'node1',
      completedNodes: ['start', 'node1'],
      nodeRetries: {},
      context: seedCtx,
    })

    const graph = parseGraph(EXTENDED_DOT)

    const capturedNodeByNodeId: Record<string, GraphNode> = {}
    const registry = makeRegistry((node) => {
      capturedNodeByNodeId[node.id] = node
    })

    const { bus } = makeEventBus()
    const config: GraphExecutorConfig = {
      runId: 'compliance-fidelity-extended-test',
      logsRoot: tmpDir,
      handlerRegistry: registry,
      eventBus: bus,
      checkpointPath: path.join(tmpDir, 'checkpoint.json'),
    }

    await createGraphExecutor().run(graph, config)

    // node2 is first resumed → degraded to 'summary:high'
    expect(capturedNodeByNodeId['node2']!.fidelity).toBe('summary:high')
    // node3 is subsequent → uses its configured fidelity='high'
    expect(capturedNodeByNodeId['node3']!.fidelity).toBe('high')
  })
})

// ---------------------------------------------------------------------------
// Task 6: Structural conformance — AttractorBench parity
// ---------------------------------------------------------------------------

describe('structural conformance — AttractorBench parity', () => {
  // AttractorBench structural conformance parity — Phase A mandatory
  // See: https://github.com/strongdm/attractorbench
  // Behavioral conformance tests are advisory in Phase A; required by Phase B exit.

  // -------------------------------------------------------------------------
  // Attribute coverage — nodes (all 17 spec-defined + toolCommand from 42-11 + backend from 48-10)
  // -------------------------------------------------------------------------

  it('AC6 — all node attributes extracted with correct values from DOT', () => {
    const dot = `
digraph compliance_node_attrs {
  graph [goal="Attribute coverage"]
  start [shape=Mdiamond]
  target [
    shape=box,
    type=codergen,
    label="Target Label",
    prompt="Target prompt",
    max_retries=3,
    goal_gate=true,
    retry_target="start",
    fallback_retry_target="start",
    fidelity=high,
    thread_id="thread-1",
    class="myclass",
    timeout=30,
    llm_model="gpt-4o",
    llm_provider=openai,
    reasoning_effort=high,
    auto_status=false,
    allow_partial=true,
    tool_command="echo hello",
    backend=direct
  ]
  exit [shape=Msquare]
  start -> target
  target -> exit
}
`
    const graph = parseGraph(dot)
    const node = graph.nodes.get('target')
    expect(node).toBeDefined()
    expect(node!.id).toBe('target')
    expect(node!.label).toBe('Target Label')
    expect(node!.shape).toBe('box')
    expect(node!.type).toBe('codergen')
    expect(node!.prompt).toBe('Target prompt')
    expect(node!.maxRetries).toBe(3)
    expect(node!.goalGate).toBe(true)
    expect(node!.retryTarget).toBe('start')
    expect(node!.fallbackRetryTarget).toBe('start')
    expect(node!.fidelity).toBe('high')
    expect(node!.threadId).toBe('thread-1')
    expect(node!.class).toBe('myclass')
    expect(node!.timeout).toBe(30)
    expect(node!.llmModel).toBe('gpt-4o')
    expect(node!.llmProvider).toBe('openai')
    expect(node!.reasoningEffort).toBe('high')
    expect(node!.autoStatus).toBe(false)
    expect(node!.allowPartial).toBe(true)
    expect(node!.toolCommand).toBe('echo hello')
    expect(node!.backend).toBe('direct')
  })

  // -------------------------------------------------------------------------
  // Attribute coverage — edges (all 6 edge attributes)
  // -------------------------------------------------------------------------

  it('AC6 — all 6 edge attributes extracted with correct values from DOT', () => {
    const dot = `
digraph compliance_edge_attrs {
  graph [goal="Edge attribute coverage"]
  start [shape=Mdiamond]
  nodeA [type=codergen, prompt="a"]
  exit [shape=Msquare]
  start -> nodeA [
    label="go",
    condition="outcome=success",
    weight=5,
    fidelity=high,
    thread_id="t2",
    loop_restart=true
  ]
  nodeA -> exit
}
`
    const graph = parseGraph(dot)
    const edge = graph.edges.find((e) => e.fromNode === 'start' && e.toNode === 'nodeA')
    expect(edge).toBeDefined()
    expect(edge!.label).toBe('go')
    expect(edge!.condition).toBe('outcome=success')
    expect(edge!.weight).toBe(5)
    expect(edge!.fidelity).toBe('high')
    expect(edge!.threadId).toBe('t2')
    expect(edge!.loopRestart).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Lint rule coverage — 8 error-level rules (stories 42-4)
  // -------------------------------------------------------------------------

  it('AC6 — lint rule "start_node" fires (severity=error) when no start node exists', () => {
    // Graph with no Mdiamond node and no id=start/Start
    const graph = makeLintGraph(
      [{ id: 'work', type: 'codergen', prompt: 'work' }],
      [{ fromNode: 'work', toNode: 'exit' }],
    )
    // Override the nodes map to remove start (the makeLintGraph adds start by default — use manual build)
    const nodeMap = new Map<string, GraphNode>()
    nodeMap.set('work', makeNode('work', { type: 'codergen', prompt: 'work' }))
    nodeMap.set('exit', makeNode('exit', { shape: 'Msquare', type: '' }))
    const edges: GraphEdge[] = [makeEdge('work', 'exit')]
    const g: Graph = {
      id: 'test', goal: '', label: '', modelStylesheet: '',
      defaultMaxRetries: 0, retryTarget: '', fallbackRetryTarget: '', defaultFidelity: '',
      nodes: nodeMap,
      edges,
      outgoingEdges: (id) => edges.filter((e) => e.fromNode === id),
      startNode: () => { throw new Error('no start') },
      exitNode: () => nodeMap.get('exit')!,
    }
    const diags = createValidator().validate(g)
    const rule = diags.find((d) => d.ruleId === 'start_node')
    expect(rule).toBeDefined()
    expect(rule!.severity).toBe('error')
  })

  it('AC6 — lint rule "terminal_node" fires (severity=error) when no exit node exists', () => {
    const nodeMap = new Map<string, GraphNode>()
    nodeMap.set('start', makeNode('start', { shape: 'Mdiamond', type: '' }))
    nodeMap.set('work', makeNode('work', { type: 'codergen', prompt: 'work' }))
    const edges: GraphEdge[] = [makeEdge('start', 'work')]
    const g: Graph = {
      id: 'test', goal: '', label: '', modelStylesheet: '',
      defaultMaxRetries: 0, retryTarget: '', fallbackRetryTarget: '', defaultFidelity: '',
      nodes: nodeMap,
      edges,
      outgoingEdges: (id) => edges.filter((e) => e.fromNode === id),
      startNode: () => nodeMap.get('start')!,
      exitNode: () => { throw new Error('no exit') },
    }
    const diags = createValidator().validate(g)
    const rule = diags.find((d) => d.ruleId === 'terminal_node')
    expect(rule).toBeDefined()
    expect(rule!.severity).toBe('error')
  })

  it('AC6 — lint rule "start_no_incoming" fires (severity=error) when edge targets the start node', () => {
    const graph = makeLintGraph(
      [{ id: 'work', type: 'codergen', prompt: 'work' }],
      [
        { fromNode: 'start', toNode: 'work' },
        { fromNode: 'work', toNode: 'exit' },
        { fromNode: 'work', toNode: 'start' }, // incoming edge to start
      ],
    )
    const diags = createValidator().validate(graph)
    const rule = diags.find((d) => d.ruleId === 'start_no_incoming')
    expect(rule).toBeDefined()
    expect(rule!.severity).toBe('error')
  })

  it('AC6 — lint rule "exit_no_outgoing" fires (severity=error) when exit node has an outgoing edge', () => {
    const graph = makeLintGraph(
      [{ id: 'work', type: 'codergen', prompt: 'work' }],
      [
        { fromNode: 'start', toNode: 'work' },
        { fromNode: 'work', toNode: 'exit' },
        { fromNode: 'exit', toNode: 'work' }, // outgoing edge from exit
      ],
    )
    const diags = createValidator().validate(graph)
    const rule = diags.find((d) => d.ruleId === 'exit_no_outgoing')
    expect(rule).toBeDefined()
    expect(rule!.severity).toBe('error')
  })

  it('AC6 — lint rule "edge_target_exists" fires (severity=error) when edge targets non-existent node', () => {
    // Build graph directly — DOT auto-creates referenced nodes, so we use in-memory construction
    const nodeMap = new Map<string, GraphNode>()
    nodeMap.set('start', makeNode('start', { shape: 'Mdiamond', type: '' }))
    nodeMap.set('work', makeNode('work', { type: 'codergen', prompt: 'work' }))
    nodeMap.set('exit', makeNode('exit', { shape: 'Msquare', type: '' }))
    const edges: GraphEdge[] = [
      makeEdge('start', 'work'),
      makeEdge('work', 'exit'),
      makeEdge('work', 'ghost_node'), // ghost_node does NOT exist in nodeMap
    ]
    const g: Graph = {
      id: 'test', goal: '', label: '', modelStylesheet: '',
      defaultMaxRetries: 0, retryTarget: '', fallbackRetryTarget: '', defaultFidelity: '',
      nodes: nodeMap,
      edges,
      outgoingEdges: (id) => edges.filter((e) => e.fromNode === id),
      startNode: () => nodeMap.get('start')!,
      exitNode: () => nodeMap.get('exit')!,
    }
    const diags = createValidator().validate(g)
    const rule = diags.find((d) => d.ruleId === 'edge_target_exists')
    expect(rule).toBeDefined()
    expect(rule!.severity).toBe('error')
  })

  it('AC6 — lint rule "reachability" fires (severity=error) when a node is unreachable', () => {
    const graph = makeLintGraph(
      [
        { id: 'work', type: 'codergen', prompt: 'work' },
        { id: 'unreachable', type: 'codergen', prompt: 'unreachable' },
      ],
      [
        { fromNode: 'start', toNode: 'work' },
        { fromNode: 'work', toNode: 'exit' },
        // 'unreachable' has no incoming edges from start
      ],
    )
    const diags = createValidator().validate(graph)
    const rule = diags.find((d) => d.ruleId === 'reachability')
    expect(rule).toBeDefined()
    expect(rule!.severity).toBe('error')
  })

  it('AC6 — lint rule "condition_syntax" fires (severity=error) for invalid condition expression', () => {
    const graph = makeLintGraph(
      [{ id: 'work', type: 'codergen', prompt: 'work' }],
      [
        { fromNode: 'start', toNode: 'work' },
        { fromNode: 'work', toNode: 'exit', condition: 'a==b' }, // double-equals is invalid
      ],
    )
    const diags = createValidator().validate(graph)
    const rule = diags.find((d) => d.ruleId === 'condition_syntax')
    expect(rule).toBeDefined()
    expect(rule!.severity).toBe('error')
  })

  it('AC6 — lint rule "stylesheet_syntax" fires (severity=error) for invalid stylesheet content', () => {
    // Build graph with invalid inline stylesheet
    const graph = makeLintGraph(
      [{ id: 'work', type: 'codergen', prompt: 'work' }],
      [{ fromNode: 'start', toNode: 'work' }, { fromNode: 'work', toNode: 'exit' }],
      { modelStylesheet: '!!! invalid stylesheet content !!!' },
    )
    const diags = createValidator().validate(graph)
    const rule = diags.find((d) => d.ruleId === 'stylesheet_syntax')
    expect(rule).toBeDefined()
    expect(rule!.severity).toBe('error')
  })

  // -------------------------------------------------------------------------
  // Lint rule coverage — 5 warning-level rules (stories 42-5)
  // -------------------------------------------------------------------------

  it('AC6 — lint rule "type_known" fires (severity=warning) for unknown node type', () => {
    const graph = makeLintGraph(
      [{ id: 'work', type: 'wizard_type', prompt: 'work' }], // wizard_type is unknown
      [{ fromNode: 'start', toNode: 'work' }, { fromNode: 'work', toNode: 'exit' }],
    )
    const diags = createValidator().validate(graph)
    const rule = diags.find((d) => d.ruleId === 'type_known')
    expect(rule).toBeDefined()
    expect(rule!.severity).toBe('warning')
  })

  it('AC6 — lint rule "fidelity_valid" fires (severity=warning) for invalid fidelity value', () => {
    const graph = makeLintGraph(
      [{ id: 'work', type: 'codergen', prompt: 'work', fidelity: 'ultra_high' }], // invalid fidelity
      [{ fromNode: 'start', toNode: 'work' }, { fromNode: 'work', toNode: 'exit' }],
    )
    const diags = createValidator().validate(graph)
    const rule = diags.find((d) => d.ruleId === 'fidelity_valid')
    expect(rule).toBeDefined()
    expect(rule!.severity).toBe('warning')
  })

  it('AC6 — lint rule "retry_target_exists" fires (severity=warning) for missing retryTarget node', () => {
    const graph = makeLintGraph(
      [{ id: 'work', type: 'codergen', prompt: 'work', retryTarget: 'nonexistent' }],
      [{ fromNode: 'start', toNode: 'work' }, { fromNode: 'work', toNode: 'exit' }],
    )
    const diags = createValidator().validate(graph)
    const rule = diags.find((d) => d.ruleId === 'retry_target_exists')
    expect(rule).toBeDefined()
    expect(rule!.severity).toBe('warning')
  })

  it('AC6 — lint rule "goal_gate_has_retry" fires (severity=warning) when goalGate=true node has no retryTarget', () => {
    const graph = makeLintGraph(
      [{ id: 'work', type: 'codergen', prompt: 'work', goalGate: true, retryTarget: '' }],
      [{ fromNode: 'start', toNode: 'work' }, { fromNode: 'work', toNode: 'exit' }],
      // no graph-level retryTarget either (default '')
    )
    const diags = createValidator().validate(graph)
    const rule = diags.find((d) => d.ruleId === 'goal_gate_has_retry')
    expect(rule).toBeDefined()
    expect(rule!.severity).toBe('warning')
  })

  it('AC6 — lint rule "prompt_on_llm_nodes" fires (severity=warning) for codergen node with no prompt or label', () => {
    const graph = makeLintGraph(
      [{ id: 'work', type: 'codergen', prompt: '', label: '' }], // no prompt AND no label
      [{ fromNode: 'start', toNode: 'work' }, { fromNode: 'work', toNode: 'exit' }],
    )
    const diags = createValidator().validate(graph)
    const rule = diags.find((d) => d.ruleId === 'prompt_on_llm_nodes')
    expect(rule).toBeDefined()
    expect(rule!.severity).toBe('warning')
  })

  // -------------------------------------------------------------------------
  // Edge selection determinism — identical inputs always produce same output
  // -------------------------------------------------------------------------

  it('AC6 — selectEdge is deterministic: identical inputs always produce same edge', async () => {
    const node = makeNode('origin')
    const edgeA = makeEdge('origin', 'alpha', { weight: 5 })
    const edgeB = makeEdge('origin', 'bravo', { weight: 5 })
    const edgeC = makeEdge('origin', 'charlie', { weight: 3 })
    const graph = makeGraph([node], [edgeA, edgeB, edgeC])
    const ctx = new GraphContext({ x: '1' })
    const outcome: Outcome = { status: 'SUCCESS' }

    const first = await selectEdge(node, outcome, ctx, graph)
    const second = await selectEdge(node, outcome, ctx, graph)
    const third = await selectEdge(node, outcome, ctx, graph)

    expect(first?.toNode).toBe(second?.toNode)
    expect(second?.toNode).toBe(third?.toNode)
    expect(first?.toNode).toBe('alpha') // lexically first among weight-5 ties
  })
})
