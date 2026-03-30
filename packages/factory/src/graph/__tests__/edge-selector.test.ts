/**
 * Unit tests for edge-selector.ts (story 42-12).
 * Covers all 7 acceptance criteria.
 */

import { describe, it, expect, vi } from 'vitest'
import { selectEdge, normalizeLabel, bestByWeightThenLexical } from '../edge-selector.js'
import { GraphContext } from '../context.js'
import type { GraphEdge, GraphNode, Graph, Outcome } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string): GraphNode {
  return {
    id,
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
    startNode: () => {
      throw new Error('not implemented')
    },
    exitNode: () => {
      throw new Error('not implemented')
    },
  }
}

const emptyOutcome: Outcome = { status: 'SUCCESS' }

// ---------------------------------------------------------------------------
// AC6: normalizeLabel
// ---------------------------------------------------------------------------

describe('normalizeLabel (AC6)', () => {
  it('strips bracket accelerator prefix [Y] Yes → "yes"', () => {
    expect(normalizeLabel('[Y] Yes')).toBe('yes')
  })

  it('strips bracket accelerator prefix [y] yes (already lowercase)', () => {
    expect(normalizeLabel('[y] yes')).toBe('yes')
  })

  it('strips paren accelerator prefix y) No → "no"', () => {
    expect(normalizeLabel('y) No')).toBe('no')
  })

  it('strips dash accelerator prefix y - Maybe → "maybe"', () => {
    expect(normalizeLabel('y - Maybe')).toBe('maybe')
  })

  it('handles no accelerator prefix — lowercases and trims', () => {
    expect(normalizeLabel('Continue')).toBe('continue')
  })

  it('handles empty string → empty string', () => {
    expect(normalizeLabel('')).toBe('')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeLabel('  Continue  ')).toBe('continue')
  })

  it('strips dash accelerator without spaces (y-maybe)', () => {
    expect(normalizeLabel('y-Maybe')).toBe('maybe')
  })
})

// ---------------------------------------------------------------------------
// bestByWeightThenLexical helper
// ---------------------------------------------------------------------------

describe('bestByWeightThenLexical', () => {
  it('returns the single edge when given one', () => {
    const edge = makeEdge('a', 'b', { weight: 5 })
    expect(bestByWeightThenLexical([edge])).toBe(edge)
  })

  it('returns higher-weight edge', () => {
    const low = makeEdge('a', 'b', { weight: 2 })
    const high = makeEdge('a', 'c', { weight: 5 })
    expect(bestByWeightThenLexical([low, high])).toBe(high)
  })

  it('breaks ties by lexically-first target node ID', () => {
    const toZ = makeEdge('a', 'node_z', { weight: 3 })
    const toA = makeEdge('a', 'node_a', { weight: 3 })
    expect(bestByWeightThenLexical([toZ, toA])).toBe(toA)
  })

  it('does not mutate the input array', () => {
    const edges = [makeEdge('a', 'c', { weight: 1 }), makeEdge('a', 'b', { weight: 5 })]
    const original = [...edges]
    bestByWeightThenLexical(edges)
    expect(edges).toEqual(original)
  })

  it('treats missing weight as 0', () => {
    const noWeight = makeEdge('a', 'x')
    const weighted = makeEdge('a', 'y', { weight: 1 })
    expect(bestByWeightThenLexical([noWeight, weighted])).toBe(weighted)
  })
})

// ---------------------------------------------------------------------------
// AC5: No outgoing edges → null
// ---------------------------------------------------------------------------

describe('selectEdge AC5 — no outgoing edges', () => {
  it('returns null when node has no outgoing edges', async () => {
    const node = makeNode('a')
    const graph = makeGraph([makeEdge('other', 'a')]) // edge FROM another node
    const ctx = new GraphContext()
    expect(await selectEdge(node, emptyOutcome, ctx, graph)).toBeNull()
  })

  it('returns null when edge list is empty', async () => {
    const node = makeNode('a')
    const graph = makeGraph([])
    const ctx = new GraphContext()
    expect(await selectEdge(node, emptyOutcome, ctx, graph)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AC1: Step 1 — Condition-matched edges
// ---------------------------------------------------------------------------

describe('selectEdge AC1 — condition-matched edges', () => {
  it('returns a condition-matched edge (ignoring unconditional)', async () => {
    const node = makeNode('start')
    const conditional = makeEdge('start', 'conditional_target', {
      condition: 'status=success',
      weight: 0,
    })
    const unconditional = makeEdge('start', 'unconditional_target', {
      condition: '',
      weight: 10, // higher weight but should be ignored
    })
    const graph = makeGraph([conditional, unconditional])
    const ctx = new GraphContext({ status: 'success' })

    const result = await selectEdge(node, emptyOutcome, ctx, graph)
    expect(result).toBe(conditional)
  })

  it('returns the higher-weight match when two conditions both match', async () => {
    const node = makeNode('start')
    const low = makeEdge('start', 'b', { condition: 'status=success', weight: 1 })
    const high = makeEdge('start', 'c', { condition: 'status=success', weight: 5 })
    const graph = makeGraph([low, high])
    const ctx = new GraphContext({ status: 'success' })

    expect(await selectEdge(node, emptyOutcome, ctx, graph)).toBe(high)
  })

  it('uses lexically-first target as tiebreak on equal weights', async () => {
    const node = makeNode('start')
    const toZ = makeEdge('start', 'node_z', { condition: 'x=y', weight: 3 })
    const toA = makeEdge('start', 'node_a', { condition: 'x=y', weight: 3 })
    const graph = makeGraph([toZ, toA])
    const ctx = new GraphContext({ x: 'y' })

    expect(await selectEdge(node, emptyOutcome, ctx, graph)).toBe(toA)
  })

  it('ignores condition-bearing edge when condition does not match', async () => {
    const node = makeNode('start')
    const nonMatching = makeEdge('start', 'b', { condition: 'status=failure', weight: 10 })
    const unconditional = makeEdge('start', 'c', { condition: '', weight: 0 })
    const graph = makeGraph([nonMatching, unconditional])
    const ctx = new GraphContext({ status: 'success' })

    // Falls through to Step 4
    const result = await selectEdge(node, emptyOutcome, ctx, graph)
    expect(result).toBe(unconditional)
  })

  it('treats invalid condition syntax as non-matching (no throw)', async () => {
    const node = makeNode('start')
    const badCondition = makeEdge('start', 'b', { condition: 'invalid==syntax', weight: 10 })
    const fallback = makeEdge('start', 'c', { condition: '', weight: 0 })
    const graph = makeGraph([badCondition, fallback])
    const ctx = new GraphContext()

    // Should not throw; falls through to Step 4
    const result = await selectEdge(node, emptyOutcome, ctx, graph)
    expect(result).toBe(fallback)
  })
})

// ---------------------------------------------------------------------------
// AC7: Condition match supersedes preferredLabel and suggestedNextIds
// ---------------------------------------------------------------------------

describe('selectEdge AC7 — condition supersedes preferredLabel and suggestedNextIds', () => {
  it('returns conditional edge even when preferredLabel and suggestedNextIds point elsewhere', async () => {
    const node = makeNode('start')
    const conditional = makeEdge('start', 'cond_target', {
      condition: 'go=yes',
      label: 'Conditional Path',
      weight: 0,
    })
    const preferredTarget = makeEdge('start', 'preferred_target', {
      condition: '',
      label: 'preferred',
      weight: 5,
    })
    const suggestedTarget = makeEdge('start', 'suggested_target', {
      condition: '',
      label: 'suggested',
      weight: 0,
    })
    const graph = makeGraph([conditional, preferredTarget, suggestedTarget])
    const ctx = new GraphContext({ go: 'yes' })
    const outcome: Outcome = {
      status: 'SUCCESS',
      preferredLabel: 'preferred',
      suggestedNextIds: ['suggested_target'],
    }

    expect(await selectEdge(node, outcome, ctx, graph)).toBe(conditional)
  })
})

// ---------------------------------------------------------------------------
// AC2: Step 2 — Preferred label match
// ---------------------------------------------------------------------------

describe('selectEdge AC2 — preferred label match', () => {
  it('matches unconditional edge by preferred label (exact after normalization)', async () => {
    const node = makeNode('start')
    const edgeYes = makeEdge('start', 'yes_node', { label: 'Yes', condition: '' })
    const edgeNo = makeEdge('start', 'no_node', { label: 'No', condition: '' })
    const graph = makeGraph([edgeYes, edgeNo])
    const ctx = new GraphContext()
    const outcome: Outcome = { status: 'SUCCESS', preferredLabel: 'Yes' }

    expect(await selectEdge(node, outcome, ctx, graph)).toBe(edgeYes)
  })

  it('matches with accelerator-prefix normalization', async () => {
    const node = makeNode('start')
    const edgeYes = makeEdge('start', 'yes_node', { label: '[Y] Yes', condition: '' })
    const graph = makeGraph([edgeYes])
    const ctx = new GraphContext()
    const outcome: Outcome = { status: 'SUCCESS', preferredLabel: 'Yes' }

    expect(await selectEdge(node, outcome, ctx, graph)).toBe(edgeYes)
  })

  it('falls through to Step 3/4 when preferred label does not match any edge', async () => {
    const node = makeNode('start')
    const edgeA = makeEdge('start', 'node_a', { label: 'Alpha', condition: '', weight: 5 })
    const edgeB = makeEdge('start', 'node_b', { label: 'Beta', condition: '', weight: 1 })
    const graph = makeGraph([edgeA, edgeB])
    const ctx = new GraphContext()
    const outcome: Outcome = { status: 'SUCCESS', preferredLabel: 'Gamma' } // no match

    // Falls to Step 4: highest weight is node_a
    expect(await selectEdge(node, outcome, ctx, graph)).toBe(edgeA)
  })

  it('does not match conditional edge via preferred label', async () => {
    const node = makeNode('start')
    const conditional = makeEdge('start', 'cond_node', {
      label: 'yes',
      condition: 'x=y', // conditional — will not match because condition fails
    })
    const unconditional = makeEdge('start', 'uncond_node', {
      label: 'yes',
      condition: '',
    })
    const graph = makeGraph([conditional, unconditional])
    const ctx = new GraphContext({ x: 'z' }) // condition does NOT match
    const outcome: Outcome = { status: 'SUCCESS', preferredLabel: 'yes' }

    // Step 1: conditional edge's condition fails → no match
    // Step 2: unconditional edge label matches preferredLabel → returns it
    expect(await selectEdge(node, outcome, ctx, graph)).toBe(unconditional)
  })
})

// ---------------------------------------------------------------------------
// AC3: Step 3 — Suggested next IDs
// ---------------------------------------------------------------------------

describe('selectEdge AC3 — suggested next IDs', () => {
  it('returns edge to first matching suggested ID', async () => {
    const node = makeNode('start')
    const edgeB = makeEdge('start', 'b', { condition: '', label: 'B' })
    const edgeC = makeEdge('start', 'c', { condition: '', label: 'C' })
    const graph = makeGraph([edgeC, edgeB]) // C listed first in edges, but order of suggestedNextIds wins
    const ctx = new GraphContext()
    const outcome: Outcome = { status: 'SUCCESS', suggestedNextIds: ['b', 'c'] }

    // b is first in suggestedNextIds → should return edge to b
    expect(await selectEdge(node, outcome, ctx, graph)).toBe(edgeB)
  })

  it('skips first suggested ID if not in edges, returns second match', async () => {
    const node = makeNode('start')
    const edgeC = makeEdge('start', 'c', { condition: '', label: 'C' })
    const graph = makeGraph([edgeC])
    const ctx = new GraphContext()
    const outcome: Outcome = { status: 'SUCCESS', suggestedNextIds: ['missing', 'c'] }

    expect(await selectEdge(node, outcome, ctx, graph)).toBe(edgeC)
  })

  it('falls through to Step 4 when no suggested ID matches any edge', async () => {
    const node = makeNode('start')
    const edgeA = makeEdge('start', 'a', { condition: '', weight: 3 })
    const edgeB = makeEdge('start', 'b', { condition: '', weight: 1 })
    const graph = makeGraph([edgeA, edgeB])
    const ctx = new GraphContext()
    const outcome: Outcome = { status: 'SUCCESS', suggestedNextIds: ['nonexistent'] }

    // Falls to Step 4: highest weight is 'a'
    expect(await selectEdge(node, outcome, ctx, graph)).toBe(edgeA)
  })

  it('does not match conditional edge via suggestedNextIds', async () => {
    const node = makeNode('start')
    const conditional = makeEdge('start', 'x', { condition: 'a=b', weight: 0 })
    const unconditional = makeEdge('start', 'y', { condition: '', weight: 0 })
    const graph = makeGraph([conditional, unconditional])
    const ctx = new GraphContext({ a: 'z' }) // condition fails
    const outcome: Outcome = { status: 'SUCCESS', suggestedNextIds: ['x'] }

    // Step 1: conditional edge condition fails → no match
    // Step 3: 'x' is in suggestedNextIds BUT edge to 'x' has a condition → skip
    // Step 4: unconditional edge to 'y'
    expect(await selectEdge(node, outcome, ctx, graph)).toBe(unconditional)
  })
})

// ---------------------------------------------------------------------------
// AC4: Steps 4 & 5 — Highest weight with lexical tiebreak
// ---------------------------------------------------------------------------

describe('selectEdge AC4 — highest weight with lexical tiebreak', () => {
  it('returns the edge with the highest weight', async () => {
    const node = makeNode('start')
    const low = makeEdge('start', 'x', { condition: '', weight: 2 })
    const high = makeEdge('start', 'y', { condition: '', weight: 5 })
    const graph = makeGraph([low, high])
    const ctx = new GraphContext()

    expect(await selectEdge(node, emptyOutcome, ctx, graph)).toBe(high)
  })

  it('returns lexically-first target when weights are equal', async () => {
    const node = makeNode('start')
    const toB = makeEdge('start', 'node_b', { condition: '', weight: 3 })
    const toA = makeEdge('start', 'node_a', { condition: '', weight: 3 })
    const graph = makeGraph([toB, toA])
    const ctx = new GraphContext()

    expect(await selectEdge(node, emptyOutcome, ctx, graph)).toBe(toA)
  })

  it('returns null when all outgoing edges are conditional and none match', async () => {
    const node = makeNode('start')
    const cond = makeEdge('start', 'x', { condition: 'a=b', weight: 5 })
    const graph = makeGraph([cond])
    const ctx = new GraphContext({ a: 'z' }) // condition fails

    // Step 1: no match, Step 2: no preferredLabel, Step 3: no suggestedNextIds
    // Steps 4&5: no unconditional edges → null
    expect(await selectEdge(node, emptyOutcome, ctx, graph)).toBeNull()
  })

  it('treats default weight (0) correctly in comparison', async () => {
    const node = makeNode('start')
    const defaultW = makeEdge('start', 'a', { condition: '' }) // weight: 0
    const posW = makeEdge('start', 'b', { condition: '', weight: 1 })
    const graph = makeGraph([defaultW, posW])
    const ctx = new GraphContext()

    expect(await selectEdge(node, emptyOutcome, ctx, graph)).toBe(posW)
  })
})

// ---------------------------------------------------------------------------
// LLM condition tests (story 50-4)
// ---------------------------------------------------------------------------

describe('selectEdge — LLM conditions', () => {
  it('selects LLM-conditioned edge when llmCall returns "yes"', async () => {
    const node = makeNode('start')
    const llmEdge = makeEdge('start', 'llm_target', {
      condition: 'llm:Is this ready?',
      weight: 0,
    })
    const unconditional = makeEdge('start', 'fallback', { condition: '', weight: 0 })
    const graph = makeGraph([llmEdge, unconditional])
    const ctx = new GraphContext()
    const mockLlmCall = vi.fn(async (_prompt: string) => 'yes')

    const result = await selectEdge(node, emptyOutcome, ctx, graph, { llmCall: mockLlmCall })
    expect(result).toBe(llmEdge)
    expect(mockLlmCall).toHaveBeenCalledOnce()
  })

  it('does not select LLM-conditioned edge when llmCall returns "no"; falls through to unconditional', async () => {
    const node = makeNode('start')
    const llmEdge = makeEdge('start', 'llm_target', {
      condition: 'llm:Is this ready?',
      weight: 0,
    })
    const unconditional = makeEdge('start', 'fallback', { condition: '', weight: 0 })
    const graph = makeGraph([llmEdge, unconditional])
    const ctx = new GraphContext()
    const mockLlmCall = vi.fn(async (_prompt: string) => 'no')

    const result = await selectEdge(node, emptyOutcome, ctx, graph, { llmCall: mockLlmCall })
    expect(result).toBe(unconditional)
  })

  it('treats llmCall error as non-match; falls through to unconditional; populates llm.edge_eval_errors', async () => {
    const node = makeNode('start')
    const llmEdge = makeEdge('start', 'llm_target', {
      condition: 'llm:Is this ready?',
      weight: 0,
    })
    const unconditional = makeEdge('start', 'fallback', { condition: '', weight: 0 })
    const graph = makeGraph([llmEdge, unconditional])
    const ctx = new GraphContext()
    const mockLlmCall = vi.fn(async (_prompt: string): Promise<string> => {
      throw new Error('LLM network failure')
    })

    const result = await selectEdge(node, emptyOutcome, ctx, graph, { llmCall: mockLlmCall })
    expect(result).toBe(unconditional)
    const errors = ctx.get('llm.edge_eval_errors')
    expect(Array.isArray(errors)).toBe(true)
    expect((errors as string[]).length).toBe(1)
  })

  it('selects regular condition edge when both regular and llm: conditions are present; llm: returns no', async () => {
    const node = makeNode('start')
    // Regular condition listed first — matches (outcome=success is in context)
    const regularEdge = makeEdge('start', 'regular_target', {
      condition: 'outcome=success',
      weight: 5,
    })
    // LLM condition listed second — returns "no" so does not match
    const llmEdge = makeEdge('start', 'llm_target', {
      condition: 'llm:Is this ready?',
      weight: 10, // higher weight, but won't match
    })
    const graph = makeGraph([regularEdge, llmEdge])
    const ctx = new GraphContext({ outcome: 'success' })
    // LLM returns "no" → only regular condition matches → regular edge selected
    const mockLlmCall = vi.fn(async (_prompt: string) => 'no')

    const result = await selectEdge(node, emptyOutcome, ctx, graph, { llmCall: mockLlmCall })
    expect(result).toBe(regularEdge)
  })

  it('increments llm.edge_eval_count by 1 for each LLM evaluation (AC6)', async () => {
    const node = makeNode('start')
    const llmEdge1 = makeEdge('start', 'target1', {
      condition: 'llm:Is step 1 ready?',
      weight: 0,
    })
    const llmEdge2 = makeEdge('start', 'target2', {
      condition: 'llm:Is step 2 ready?',
      weight: 0,
    })
    const graph = makeGraph([llmEdge1, llmEdge2])
    const ctx = new GraphContext()
    // Both return "no" so neither matches — both are evaluated, counting to 2
    const mockLlmCall = vi.fn(async (_prompt: string) => 'no')

    await selectEdge(node, emptyOutcome, ctx, graph, { llmCall: mockLlmCall })
    expect(ctx.get('llm.edge_eval_count')).toBe(2)
    expect(mockLlmCall).toHaveBeenCalledTimes(2)
  })
})
