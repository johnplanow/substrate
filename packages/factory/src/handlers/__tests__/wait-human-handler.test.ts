/**
 * Unit tests for the wait.human handler (story 42-11).
 *
 * Covers:
 *   AC4 – Accelerator key parsing from edge labels
 *   AC5 – Returns preferredLabel matching human selection
 *   AC6 – Handler registration in createDefaultRegistry()
 *   AC7 – All unit tests pass
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { GraphContext } from '../../graph/context.js'
import type { GraphNode, Graph, GraphEdge } from '../../graph/types.js'
import {
  parseAcceleratorKey,
  deriveChoices,
  createWaitHumanHandler,
} from '../wait-human.js'
import { createDefaultRegistry } from '../registry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal GraphNode factory for wait.human nodes. */
function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'gate',
    label: 'Approve this change?',
    shape: 'box',
    type: 'wait.human',
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
    ...overrides,
  }
}

/** Build a minimal GraphEdge stub. */
function makeEdge(fromNode: string, toNode: string, label: string): GraphEdge {
  return {
    fromNode,
    toNode,
    label,
    condition: '',
    weight: 0,
    fidelity: '',
    threadId: '',
    loopRestart: false,
  }
}

/** Build a minimal Graph stub with given edges. */
function makeGraph(edges: GraphEdge[]): Graph {
  return {
    id: '',
    goal: '',
    label: '',
    modelStylesheet: '',
    defaultMaxRetries: 0,
    retryTarget: '',
    fallbackRetryTarget: '',
    defaultFidelity: '',
    nodes: new Map(),
    edges,
    outgoingEdges: (nodeId: string) => edges.filter((e) => e.fromNode === nodeId),
    startNode: () => { throw new Error('not implemented') },
    exitNode: () => { throw new Error('not implemented') },
  }
}

// ---------------------------------------------------------------------------
// Test teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// AC4 – Accelerator key parsing from edge labels
// ---------------------------------------------------------------------------

describe('parseAcceleratorKey (AC4)', () => {
  it('parses [Y] Yes → { key: "Y", label: "Yes" }', () => {
    expect(parseAcceleratorKey('[Y] Yes')).toEqual({ key: 'Y', label: 'Yes' })
  })

  it('parses [N] No → { key: "N", label: "No" }', () => {
    expect(parseAcceleratorKey('[N] No')).toEqual({ key: 'N', label: 'No' })
  })

  it('parses lowercase accelerator and uppercases key: [y] yes → { key: "Y", label: "yes" }', () => {
    expect(parseAcceleratorKey('[y] yes')).toEqual({ key: 'Y', label: 'yes' })
  })

  it('falls back to first char of label when no [X] prefix: Continue → { key: "C", label: "Continue" }', () => {
    expect(parseAcceleratorKey('Continue')).toEqual({ key: 'C', label: 'Continue' })
  })

  it('falls back to first char (uppercased) for labels without prefix', () => {
    expect(parseAcceleratorKey('abort')).toEqual({ key: 'A', label: 'abort' })
  })

  it('handles numeric accelerators: [1] Option One', () => {
    expect(parseAcceleratorKey('[1] Option One')).toEqual({ key: '1', label: 'Option One' })
  })

  it('trims extra whitespace from the label portion', () => {
    expect(parseAcceleratorKey('[Y]   Yes  ')).toEqual({ key: 'Y', label: 'Yes' })
  })
})

// ---------------------------------------------------------------------------
// AC4 – deriveChoices from graph edges
// ---------------------------------------------------------------------------

describe('deriveChoices (AC4)', () => {
  it('returns choices from outgoing edges of the node', () => {
    const node = makeNode({ id: 'my_gate' })
    const edges = [
      makeEdge('my_gate', 'approve_node', '[Y] Yes'),
      makeEdge('my_gate', 'reject_node', '[N] No'),
    ]
    const graph = makeGraph(edges)
    const choices = deriveChoices(node, graph)
    expect(choices).toEqual([
      { key: 'Y', label: 'Yes' },
      { key: 'N', label: 'No' },
    ])
  })

  it('excludes edges from other nodes', () => {
    const node = makeNode({ id: 'my_gate' })
    const edges = [
      makeEdge('my_gate', 'approve_node', '[Y] Yes'),
      makeEdge('other_gate', 'some_node', '[X] Other'),
    ]
    const graph = makeGraph(edges)
    const choices = deriveChoices(node, graph)
    expect(choices).toHaveLength(1)
    expect(choices[0]).toEqual({ key: 'Y', label: 'Yes' })
  })

  it('excludes edges with empty labels', () => {
    const node = makeNode({ id: 'my_gate' })
    const edges = [
      makeEdge('my_gate', 'approve_node', '[Y] Yes'),
      makeEdge('my_gate', 'no_label_node', ''),
    ]
    const graph = makeGraph(edges)
    const choices = deriveChoices(node, graph)
    expect(choices).toHaveLength(1)
  })

  it('returns empty array when no outgoing edges exist', () => {
    const node = makeNode({ id: 'isolated' })
    const graph = makeGraph([])
    expect(deriveChoices(node, graph)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC5 – wait.human handler returns preferredLabel matching selection
// ---------------------------------------------------------------------------

describe('createWaitHumanHandler (AC5)', () => {
  it('returns SUCCESS when promptFn resolves', async () => {
    const promptFn = vi.fn().mockResolvedValue('[Y] Yes')
    const handler = createWaitHumanHandler({ promptFn })
    const node = makeNode({ id: 'my_node' })
    const edges = [
      makeEdge('my_node', 'yes_node', '[Y] Yes'),
      makeEdge('my_node', 'no_node', '[N] No'),
    ]
    const graph = makeGraph(edges)
    const ctx = new GraphContext()
    const result = await handler(node, ctx, graph)
    expect(result.status).toBe('SUCCESS')
  })

  it('sets preferredLabel to the selected edge label', async () => {
    const promptFn = vi.fn().mockResolvedValue('[Y] Yes')
    const handler = createWaitHumanHandler({ promptFn })
    const node = makeNode({ id: 'my_node' })
    const edges = [
      makeEdge('my_node', 'yes_node', '[Y] Yes'),
      makeEdge('my_node', 'no_node', '[N] No'),
    ]
    const graph = makeGraph(edges)
    const ctx = new GraphContext()
    const result = await handler(node, ctx, graph)
    expect(result.preferredLabel).toBe('[Y] Yes')
  })

  it('stores the selected label as {node.id}.choice in contextUpdates', async () => {
    const promptFn = vi.fn().mockResolvedValue('[Y] Yes')
    const handler = createWaitHumanHandler({ promptFn })
    const node = makeNode({ id: 'my_node' })
    const edges = [
      makeEdge('my_node', 'yes_node', '[Y] Yes'),
      makeEdge('my_node', 'no_node', '[N] No'),
    ]
    const graph = makeGraph(edges)
    const ctx = new GraphContext()
    const result = await handler(node, ctx, graph)
    expect(result.contextUpdates?.['my_node.choice']).toBe('[Y] Yes')
  })

  it('passes node.label and choices to promptFn', async () => {
    const promptFn = vi.fn().mockResolvedValue('[Y] Yes')
    const handler = createWaitHumanHandler({ promptFn })
    const node = makeNode({ id: 'my_node', label: 'Approve this change?' })
    const edges = [
      makeEdge('my_node', 'yes_node', '[Y] Yes'),
      makeEdge('my_node', 'no_node', '[N] No'),
    ]
    const graph = makeGraph(edges)
    const ctx = new GraphContext()
    await handler(node, ctx, graph)
    expect(promptFn).toHaveBeenCalledWith('Approve this change?', [
      { key: 'Y', label: 'Yes' },
      { key: 'N', label: 'No' },
    ])
  })

  it('handles the [N] No selection correctly', async () => {
    const promptFn = vi.fn().mockResolvedValue('[N] No')
    const handler = createWaitHumanHandler({ promptFn })
    const node = makeNode({ id: 'my_node' })
    const edges = [
      makeEdge('my_node', 'yes_node', '[Y] Yes'),
      makeEdge('my_node', 'no_node', '[N] No'),
    ]
    const graph = makeGraph(edges)
    const ctx = new GraphContext()
    const result = await handler(node, ctx, graph)
    expect(result.preferredLabel).toBe('[N] No')
    expect(result.contextUpdates?.['my_node.choice']).toBe('[N] No')
  })
})

// ---------------------------------------------------------------------------
// AC6 – Handler registration in createDefaultRegistry()
// ---------------------------------------------------------------------------

describe('createDefaultRegistry() – tool and wait.human (AC6)', () => {
  it('resolves type="tool" to a function (tool handler is registered)', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: 'tool' })
    const handler = registry.resolve(node)
    expect(typeof handler).toBe('function')
  })

  it('resolves type="wait.human" to a function (wait.human handler is registered)', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: 'wait.human' })
    const handler = registry.resolve(node)
    expect(typeof handler).toBe('function')
  })

  it('tool handler resolves via explicit type (step 1)', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: 'tool', shape: '' })
    expect(() => registry.resolve(node)).not.toThrow()
  })

  it('wait.human handler resolves via explicit type (step 1)', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: 'wait.human', shape: '' })
    expect(() => registry.resolve(node)).not.toThrow()
  })
})
