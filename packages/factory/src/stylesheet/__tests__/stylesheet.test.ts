/**
 * Unit tests for `parseStylesheet` (parser.ts) and `resolveNodeStyles` (resolver.ts).
 *
 * Covers:
 *  AC1 — universal selector applies to all nodes
 *  AC2 — shape selector matches by shape
 *  AC3 — class selector matches nodes with a matching class token
 *  AC4 — ID selector matches exactly one node by id
 *  AC5 — higher-specificity rule wins; equal-specificity later rule wins
 *  AC6 — resolver returns stylesheet values only (caller must prefer explicit attrs)
 *  AC7 — parseStylesheet throws StylesheetParseError on invalid syntax
 *  AC8 — stylesheet_syntax validator rule uses real parser
 *
 * Story 42-7.
 */

import { describe, it, expect } from 'vitest'
import { parseStylesheet, StylesheetParseError } from '../parser.js'
import { resolveNodeStyles } from '../resolver.js'
import type { GraphNode, ParsedStylesheet } from '../../graph/types.js'
import { createValidator } from '../../graph/validator.js'
import type { Graph, GraphEdge } from '../../graph/types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal GraphNode with defaults for all required fields. */
function makeNode(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: 'test_node',
    label: 'Test Node',
    shape: 'box',
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
    ...overrides,
  }
}

/** Build a minimal Graph for the stylesheet_syntax validator tests. */
function makeGraph(modelStylesheet: string): Graph {
  const nodeMap = new Map<string, GraphNode>()
  nodeMap.set('start', makeNode({ id: 'start', shape: 'Mdiamond' }))
  nodeMap.set('exit', makeNode({ id: 'exit', shape: 'Msquare' }))
  const edges: GraphEdge[] = [
    {
      fromNode: 'start',
      toNode: 'exit',
      label: '',
      condition: '',
      weight: 1,
      fidelity: '',
      threadId: '',
      loopRestart: false,
    },
  ]
  return {
    id: 'test',
    goal: '',
    label: '',
    modelStylesheet,
    defaultMaxRetries: 0,
    retryTarget: '',
    fallbackRetryTarget: '',
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
// parseStylesheet tests
// ---------------------------------------------------------------------------

describe('parseStylesheet', () => {
  // AC1 — universal selector
  it('single universal rule with two properties → correct ParsedStylesheet', () => {
    const result = parseStylesheet('* { llm_model: claude-sonnet-4-5; llm_provider: anthropic; }')
    expect(result).toHaveLength(1)
    const rule = result[0]!
    expect(rule.selector.type).toBe('universal')
    expect(rule.selector.value).toBe('*')
    expect(rule.selector.specificity).toBe(0)
    expect(rule.declarations).toHaveLength(2)
    expect(rule.declarations[0]).toEqual({ property: 'llm_model', value: 'claude-sonnet-4-5' })
    expect(rule.declarations[1]).toEqual({ property: 'llm_provider', value: 'anthropic' })
  })

  // AC2 — shape selector
  it('shape selector → type: shape, specificity: 1', () => {
    const result = parseStylesheet('box { llm_model: gpt-4o; }')
    expect(result).toHaveLength(1)
    const rule = result[0]!
    expect(rule.selector.type).toBe('shape')
    expect(rule.selector.value).toBe('box')
    expect(rule.selector.specificity).toBe(1)
    expect(rule.declarations[0]).toEqual({ property: 'llm_model', value: 'gpt-4o' })
  })

  // AC3 — class selector
  it('class selector → type: class, specificity: 2', () => {
    const result = parseStylesheet('.code { llm_model: claude-opus-4; }')
    expect(result).toHaveLength(1)
    const rule = result[0]!
    expect(rule.selector.type).toBe('class')
    expect(rule.selector.value).toBe('code')
    expect(rule.selector.specificity).toBe(2)
    expect(rule.declarations[0]).toEqual({ property: 'llm_model', value: 'claude-opus-4' })
  })

  // AC4 — ID selector
  it('ID selector → type: id, specificity: 3', () => {
    const result = parseStylesheet('#review_node { reasoning_effort: high; }')
    expect(result).toHaveLength(1)
    const rule = result[0]!
    expect(rule.selector.type).toBe('id')
    expect(rule.selector.value).toBe('review_node')
    expect(rule.selector.specificity).toBe(3)
    expect(rule.declarations[0]).toEqual({ property: 'reasoning_effort', value: 'high' })
  })

  it('multiple rules → all returned in source order', () => {
    const stylesheet = `
      * { llm_model: base; }
      .code { llm_model: class-model; }
      #target { llm_model: id-model; }
    `
    const result = parseStylesheet(stylesheet)
    expect(result).toHaveLength(3)
    expect(result[0]!.selector.type).toBe('universal')
    expect(result[1]!.selector.type).toBe('class')
    expect(result[2]!.selector.type).toBe('id')
  })

  it('unquoted values parsed correctly', () => {
    const result = parseStylesheet('box { llm_model: gpt-4o; }')
    expect(result[0]!.declarations[0]!.value).toBe('gpt-4o')
  })

  it('double-quoted values parsed correctly (quotes stripped)', () => {
    const result = parseStylesheet('box { llm_model: "claude-sonnet-4-5"; }')
    expect(result[0]!.declarations[0]!.value).toBe('claude-sonnet-4-5')
  })

  it('single-quoted values parsed correctly (quotes stripped)', () => {
    const result = parseStylesheet("box { llm_model: 'claude-opus-4'; }")
    expect(result[0]!.declarations[0]!.value).toBe('claude-opus-4')
  })

  it('multiple declarations in one rule parsed correctly', () => {
    const result = parseStylesheet(
      '* { llm_model: claude-sonnet-4-5; llm_provider: anthropic; reasoning_effort: high; }',
    )
    expect(result[0]!.declarations).toHaveLength(3)
  })

  it('trailing semicolon is accepted', () => {
    const result = parseStylesheet('box { llm_model: gpt-4o; }')
    expect(result).toHaveLength(1)
  })

  // AC7 — error cases
  it('missing closing brace → StylesheetParseError thrown', () => {
    expect(() => parseStylesheet('box { llm_model: gpt-4o;')).toThrow(StylesheetParseError)
  })

  it('missing closing brace → error message mentions missing brace', () => {
    expect(() => parseStylesheet('box { llm_model: gpt-4o;')).toThrow(/Missing closing brace/)
  })

  it('unknown property (font-size) → StylesheetParseError thrown', () => {
    expect(() => parseStylesheet('box { font-size: 12px; }')).toThrow(StylesheetParseError)
  })

  it('unknown property → error message mentions the property name', () => {
    expect(() => parseStylesheet('box { font-size: 12px; }')).toThrow(/font-size/)
  })

  it('content without opening brace → StylesheetParseError thrown', () => {
    expect(() => parseStylesheet('box llm_model: gpt-4o;')).toThrow(StylesheetParseError)
  })

  it('empty stylesheet → returns empty array (no error)', () => {
    expect(parseStylesheet('')).toEqual([])
  })

  it('whitespace-only stylesheet → returns empty array (no error)', () => {
    expect(parseStylesheet('   \n  ')).toEqual([])
  })

  it('block comments stripped before parsing', () => {
    const result = parseStylesheet('/* global defaults */ * { llm_model: base; }')
    expect(result).toHaveLength(1)
    expect(result[0]!.selector.type).toBe('universal')
  })

  it('line comments stripped before parsing', () => {
    const result = parseStylesheet('// shape rule\nbox { llm_model: gpt-4o; }')
    expect(result).toHaveLength(1)
    expect(result[0]!.selector.type).toBe('shape')
  })
})

// ---------------------------------------------------------------------------
// resolveNodeStyles tests
// ---------------------------------------------------------------------------

describe('resolveNodeStyles', () => {
  // AC1 — universal rule
  it('universal rule → all three properties resolved from the rule', () => {
    const stylesheet: ParsedStylesheet = parseStylesheet(
      '* { llm_model: claude-sonnet-4-5; llm_provider: anthropic; reasoning_effort: high; }',
    )
    const node = makeNode({ id: 'any_node', shape: 'box' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.llmModel).toBe('claude-sonnet-4-5')
    expect(resolved.llmProvider).toBe('anthropic')
    expect(resolved.reasoningEffort).toBe('high')
  })

  it('universal rule applies to every node regardless of shape', () => {
    const stylesheet = parseStylesheet('* { llm_model: claude-sonnet-4-5; }')
    const nodeA = makeNode({ id: 'a', shape: 'box' })
    const nodeB = makeNode({ id: 'b', shape: 'diamond' })
    expect(resolveNodeStyles(nodeA, stylesheet).llmModel).toBe('claude-sonnet-4-5')
    expect(resolveNodeStyles(nodeB, stylesheet).llmModel).toBe('claude-sonnet-4-5')
  })

  // AC2 — shape rule
  it('shape rule: matching node gets property', () => {
    const stylesheet = parseStylesheet('box { llm_model: gpt-4o; }')
    const node = makeNode({ id: 'n1', shape: 'box' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.llmModel).toBe('gpt-4o')
  })

  it('shape rule: non-matching node gets empty ResolvedNodeStyles', () => {
    const stylesheet = parseStylesheet('box { llm_model: gpt-4o; }')
    const node = makeNode({ id: 'n2', shape: 'diamond' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.llmModel).toBeUndefined()
    expect(resolved.llmProvider).toBeUndefined()
    expect(resolved.reasoningEffort).toBeUndefined()
  })

  // AC3 — class rule
  it('class rule: node with matching class token gets properties', () => {
    const stylesheet = parseStylesheet('.code { llm_model: claude-opus-4; }')
    const node = makeNode({ id: 'n1', class: 'code,critical' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.llmModel).toBe('claude-opus-4')
  })

  it('class rule: node without the class token gets nothing', () => {
    const stylesheet = parseStylesheet('.code { llm_model: claude-opus-4; }')
    const node = makeNode({ id: 'n2', class: 'critical' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.llmModel).toBeUndefined()
  })

  it('class rule: node with empty class field does not match', () => {
    const stylesheet = parseStylesheet('.code { llm_model: claude-opus-4; }')
    const node = makeNode({ id: 'n3', class: '' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.llmModel).toBeUndefined()
  })

  it('class rule: class="a,b,c" and rule .b → matches (space-trimmed token)', () => {
    const stylesheet = parseStylesheet('.b { llm_model: matched; }')
    const node = makeNode({ id: 'n4', class: 'a,b,c' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.llmModel).toBe('matched')
  })

  it('class rule: class=" a , b , c " with spaces → trimmed tokens match', () => {
    const stylesheet = parseStylesheet('.b { llm_model: matched; }')
    const node = makeNode({ id: 'n5', class: ' a , b , c ' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.llmModel).toBe('matched')
  })

  // AC4 — ID rule
  it('ID rule: node with matching id gets properties', () => {
    const stylesheet = parseStylesheet('#review_node { reasoning_effort: high; }')
    const node = makeNode({ id: 'review_node', shape: 'box' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.reasoningEffort).toBe('high')
  })

  it('ID rule: all other nodes do not get properties', () => {
    const stylesheet = parseStylesheet('#review_node { reasoning_effort: high; }')
    const otherNode = makeNode({ id: 'other_node', shape: 'box' })
    const resolved = resolveNodeStyles(otherNode, stylesheet)
    expect(resolved.reasoningEffort).toBeUndefined()
  })

  // AC5 — specificity
  it('ID rule + class rule on same node → ID property value wins (specificity 3 > 2)', () => {
    const stylesheet = parseStylesheet(
      '.code { llm_model: class-model; }\n#target { llm_model: id-model; }',
    )
    const node = makeNode({ id: 'target', class: 'code' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.llmModel).toBe('id-model')
  })

  it('universal + class + ID → ID wins for all three specificity levels', () => {
    const stylesheet = parseStylesheet(`
      * { llm_model: base; }
      .code { llm_model: class-model; }
      #target { llm_model: id-model; }
    `)
    const node = makeNode({ id: 'target', class: 'code' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.llmModel).toBe('id-model')
  })

  it('two universal rules → later rule property value wins for overlapping properties', () => {
    const stylesheet = parseStylesheet(
      '* { llm_model: first; }\n* { llm_model: second; }',
    )
    const node = makeNode({ id: 'any' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.llmModel).toBe('second')
  })

  it('two equal-specificity shape rules → later rule wins for same property', () => {
    const stylesheet = parseStylesheet(
      'box { llm_model: first; }\nbox { llm_model: second; }',
    )
    const node = makeNode({ id: 'n', shape: 'box' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.llmModel).toBe('second')
  })

  it('non-overlapping rules accumulate all properties', () => {
    const stylesheet = parseStylesheet(
      '* { llm_model: base-model; }\n.code { llm_provider: anthropic; }',
    )
    const node = makeNode({ id: 'n', class: 'code' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved.llmModel).toBe('base-model')
    expect(resolved.llmProvider).toBe('anthropic')
  })

  // AC6 — resolver does not enforce explicit node attribute priority
  it('resolver returns stylesheet value regardless of node.llmModel being set', () => {
    const stylesheet = parseStylesheet('* { llm_model: from-stylesheet; }')
    // Node has its own llmModel — but resolver ignores it
    const node = makeNode({ id: 'n', llmModel: 'from-node' })
    const resolved = resolveNodeStyles(node, stylesheet)
    // Resolver simply returns what the stylesheet says
    expect(resolved.llmModel).toBe('from-stylesheet')
  })

  it('empty stylesheet → empty ResolvedNodeStyles returned', () => {
    const stylesheet = parseStylesheet('')
    const node = makeNode({ id: 'n' })
    const resolved = resolveNodeStyles(node, stylesheet)
    expect(resolved).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// AC8: stylesheet_syntax validator rule uses real parser
// ---------------------------------------------------------------------------

describe('stylesheet_syntax validator rule (uses real parser)', () => {
  it('explicitly invalid stylesheet → emits ruleId: stylesheet_syntax error diagnostic', () => {
    const graph = makeGraph('box { font-color: red; }') // unknown property
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'stylesheet_syntax')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.ruleId).toBe('stylesheet_syntax')
  })

  it('valid stylesheet with known properties → no stylesheet_syntax diagnostic', () => {
    const graph = makeGraph('box { llm_model: claude-sonnet-4-5; }')
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'stylesheet_syntax')
    expect(diags).toHaveLength(0)
  })

  it('stylesheet with missing closing brace → emits stylesheet_syntax error', () => {
    const graph = makeGraph('box { llm_model: gpt-4o;') // no closing brace
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'stylesheet_syntax')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
  })

  it('stylesheet with class and ID selectors → no stylesheet_syntax diagnostic', () => {
    const graph = makeGraph(
      '.code { llm_model: claude-opus-4; }\n#review { reasoning_effort: high; }',
    )
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'stylesheet_syntax')
    expect(diags).toHaveLength(0)
  })

  it('universal selector stylesheet → no stylesheet_syntax diagnostic', () => {
    const graph = makeGraph('* { llm_model: claude-sonnet-4-5; llm_provider: anthropic; }')
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'stylesheet_syntax')
    expect(diags).toHaveLength(0)
  })
})
