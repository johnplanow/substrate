/**
 * Unit tests for condition-parser.ts (story 42-6)
 *
 * Covers:
 *  AC1 — equality condition evaluates true
 *  AC2 — inequality condition evaluates true
 *  AC3 — conjunction (&&) evaluates all clauses
 *  AC4 — missing context key resolves to empty string
 *  AC5 — invalid condition syntax throws ConditionParseError
 *  AC6 — comparison is case-sensitive
 *  AC7 — condition_syntax validator rule uses real parser
 */

import { describe, it, expect } from 'vitest'
import { parseCondition, evaluateCondition, ConditionParseError } from '../condition-parser.js'
import { createValidator } from '../validator.js'
import type { Graph, GraphEdge, GraphNode } from '../types.js'

// ---------------------------------------------------------------------------
// Test helper — build a minimal Graph for validator tests
// ---------------------------------------------------------------------------

function makeGraph(edges: { fromNode: string; toNode: string; condition?: string }[]): Graph {
  const nodeMap = new Map<string, GraphNode>()
  const nodeIds = new Set<string>()
  for (const e of edges) {
    nodeIds.add(e.fromNode)
    nodeIds.add(e.toNode)
  }
  // Ensure start and exit nodes
  nodeIds.add('start')
  nodeIds.add('exit')
  for (const id of nodeIds) {
    nodeMap.set(id, {
      id,
      label: id,
      shape: id === 'start' ? 'Mdiamond' : id === 'exit' ? 'Msquare' : 'box',
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
    modelStylesheet: '',
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
      return nodeMap.get('start')!
    },
    exitNode(): GraphNode {
      return nodeMap.get('exit')!
    },
  }
}

// ---------------------------------------------------------------------------
// parseCondition — happy path
// ---------------------------------------------------------------------------

describe('parseCondition — happy path', () => {
  it('AC1: parses equality clause correctly', () => {
    const result = parseCondition('outcome=success')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ key: 'outcome', op: '=', value: 'success' })
  })

  it('AC2: parses inequality clause correctly', () => {
    const result = parseCondition('outcome!=fail')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ key: 'outcome', op: '!=', value: 'fail' })
  })

  it('AC3: parses conjunction of two clauses', () => {
    const result = parseCondition('outcome=success && iteration!=0')
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ key: 'outcome', op: '=', value: 'success' })
    expect(result[1]).toEqual({ key: 'iteration', op: '!=', value: '0' })
  })

  it('parses a single-clause condition with no whitespace around operator', () => {
    const result = parseCondition('status=done')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ key: 'status', op: '=', value: 'done' })
  })

  it('parses whitespace around && separator', () => {
    const result = parseCondition('a=1&&b!=2')
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ key: 'a', op: '=', value: '1' })
    expect(result[1]).toEqual({ key: 'b', op: '!=', value: '2' })
  })

  it('strips double-quoted value', () => {
    const result = parseCondition('outcome="success"')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ key: 'outcome', op: '=', value: 'success' })
  })

  it('strips single-quoted value', () => {
    const result = parseCondition("outcome='success'")
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ key: 'outcome', op: '=', value: 'success' })
  })

  it('handles numeric-string value (no coercion in parser)', () => {
    const result = parseCondition('count=42')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ key: 'count', op: '=', value: '42' })
  })

  it('handles underscore in key', () => {
    const result = parseCondition('my_key=val')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ key: 'my_key', op: '=', value: 'val' })
  })

  it('handles key starting with underscore', () => {
    const result = parseCondition('_key=val')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ key: '_key', op: '=', value: 'val' })
  })

  it('parses three-clause conjunction', () => {
    const result = parseCondition('a=1 && b=2 && c!=3')
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ key: 'a', op: '=', value: '1' })
    expect(result[1]).toEqual({ key: 'b', op: '=', value: '2' })
    expect(result[2]).toEqual({ key: 'c', op: '!=', value: '3' })
  })
})

// ---------------------------------------------------------------------------
// parseCondition — error cases (AC5)
// ---------------------------------------------------------------------------

describe('parseCondition — error cases (AC5)', () => {
  it('throws ConditionParseError for empty string', () => {
    expect(() => parseCondition('')).toThrow(ConditionParseError)
  })

  it('throws ConditionParseError for whitespace-only string', () => {
    expect(() => parseCondition('   ')).toThrow(ConditionParseError)
  })

  it('throws ConditionParseError for double-equals operator', () => {
    expect(() => parseCondition('outcome==success')).toThrow(ConditionParseError)
  })

  it('error for double-equals has descriptive message', () => {
    expect(() => parseCondition('outcome==success')).toThrow(/==/)
  })

  it('throws ConditionParseError for empty clause after &&', () => {
    expect(() => parseCondition('outcome=success && ')).toThrow(ConditionParseError)
  })

  it('throws ConditionParseError for empty clause before &&', () => {
    expect(() => parseCondition(' && outcome=success')).toThrow(ConditionParseError)
  })

  it('throws ConditionParseError for whitespace-only clause', () => {
    expect(() => parseCondition('  &&  ')).toThrow(ConditionParseError)
  })

  it('throws ConditionParseError for clause with no operator', () => {
    expect(() => parseCondition('outcome')).toThrow(ConditionParseError)
  })

  it('throws ConditionParseError for clause with invalid key (starts with digit)', () => {
    expect(() => parseCondition('1key=val')).toThrow(ConditionParseError)
  })

  it('throws ConditionParseError for clause with empty value after =', () => {
    expect(() => parseCondition('outcome=')).toThrow(ConditionParseError)
  })

  it('throws ConditionParseError for clause with empty value after !=', () => {
    expect(() => parseCondition('outcome!=')).toThrow(ConditionParseError)
  })

  it('thrown error is an instance of ConditionParseError (extends Error)', () => {
    let caught: unknown
    try {
      parseCondition('outcome==success')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConditionParseError)
    expect(caught).toBeInstanceOf(Error)
    expect((caught as ConditionParseError).name).toBe('ConditionParseError')
  })
})

// ---------------------------------------------------------------------------
// evaluateCondition — happy path
// ---------------------------------------------------------------------------

describe('evaluateCondition — happy path', () => {
  it('AC1: equality condition with matching context → true', () => {
    expect(evaluateCondition('outcome=success', { outcome: 'success' })).toBe(true)
  })

  it('AC2: inequality condition with non-matching value → true', () => {
    expect(evaluateCondition('outcome!=fail', { outcome: 'success' })).toBe(true)
  })

  it('AC3: conjunction — both clauses pass → true', () => {
    expect(
      evaluateCondition('outcome=success && iteration!=0', {
        outcome: 'success',
        iteration: '1',
      })
    ).toBe(true)
  })

  it('AC3: conjunction — first clause fails → false', () => {
    expect(
      evaluateCondition('outcome=success && iteration!=0', {
        outcome: 'failure',
        iteration: '1',
      })
    ).toBe(false)
  })

  it('AC3: conjunction — second clause fails → false', () => {
    expect(
      evaluateCondition('outcome=success && iteration!=0', {
        outcome: 'success',
        iteration: '0',
      })
    ).toBe(false)
  })

  it('AC4: missing context key resolves to "" → equality with non-empty value fails', () => {
    expect(evaluateCondition('missing_key=value', {})).toBe(false)
  })

  it('AC4: missing context key resolves to "" — absent key != non-empty value is true', () => {
    // missing_key is absent from context → resolves to "" → "" !== "present" → true
    expect(evaluateCondition('missing_key!=present', {})).toBe(true)
  })

  it('AC4: missing context key → resolves to "" correctly', () => {
    // evaluates missing_key="" (via empty string default) — comparing with "value" → false
    const result = evaluateCondition('outcome!=empty', {})
    // outcome is undefined → "" → "empty" !== "" → !="empty" is true
    expect(result).toBe(true)
  })

  it('AC6: comparison is case-sensitive — uppercase S fails lowercase match', () => {
    expect(evaluateCondition('outcome=success', { outcome: 'Success' })).toBe(false)
  })

  it('AC6: exact case match → true', () => {
    expect(evaluateCondition('outcome=Success', { outcome: 'Success' })).toBe(true)
  })

  it('inequality condition with matching value → false', () => {
    expect(evaluateCondition('outcome!=success', { outcome: 'success' })).toBe(false)
  })

  it('coerces numeric context values to string', () => {
    expect(evaluateCondition('count=42', { count: 42 })).toBe(true)
  })

  it('coerces boolean context values to string', () => {
    expect(evaluateCondition('flag=true', { flag: true })).toBe(true)
  })

  it('quoted value in condition matches correctly', () => {
    expect(evaluateCondition('outcome="success"', { outcome: 'success' })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// evaluateCondition — error propagation
// ---------------------------------------------------------------------------

describe('evaluateCondition — error propagation', () => {
  it('propagates ConditionParseError for invalid condition', () => {
    expect(() => evaluateCondition('outcome==success', {})).toThrow(ConditionParseError)
  })

  it('propagates ConditionParseError for empty condition string', () => {
    expect(() => evaluateCondition('', {})).toThrow(ConditionParseError)
  })
})

// ---------------------------------------------------------------------------
// AC7: condition_syntax validator rule uses real parser
// ---------------------------------------------------------------------------

describe('AC7: condition_syntax rule uses parseCondition', () => {
  it('valid condition outcome=success → no diagnostics', () => {
    const graph = makeGraph([{ fromNode: 'start', toNode: 'exit', condition: 'outcome=success' }])
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'condition_syntax')
    expect(diags).toHaveLength(0)
  })

  it('valid condition outcome!=fail → no diagnostics', () => {
    const graph = makeGraph([{ fromNode: 'start', toNode: 'exit', condition: 'outcome!=fail' }])
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'condition_syntax')
    expect(diags).toHaveLength(0)
  })

  it('valid conjunction condition → no diagnostics', () => {
    const graph = makeGraph([
      {
        fromNode: 'start',
        toNode: 'exit',
        condition: 'outcome=success && iteration!=0',
      },
    ])
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'condition_syntax')
    expect(diags).toHaveLength(0)
  })

  it('AC5 via validator: outcome==success (double-equals) → error diagnostic', () => {
    const graph = makeGraph([{ fromNode: 'start', toNode: 'exit', condition: 'outcome==success' }])
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'condition_syntax')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.ruleId).toBe('condition_syntax')
    expect(diags[0]!.message).toMatch(/outcome==success/)
  })

  it('empty condition string → no diagnostics (edge has no condition)', () => {
    const graph = makeGraph([{ fromNode: 'start', toNode: 'exit', condition: '' }])
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'condition_syntax')
    expect(diags).toHaveLength(0)
  })

  it('invalid condition at specific edge index → edgeIndex set correctly', () => {
    const graph = makeGraph([
      { fromNode: 'start', toNode: 'exit', condition: '' }, // index 0 — valid (no condition)
      { fromNode: 'exit', toNode: 'start', condition: 'outcome==fail' }, // index 1 — bad
    ])
    const validator = createValidator()
    const diags = validator.validate(graph).filter((d) => d.ruleId === 'condition_syntax')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.edgeIndex).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Numeric comparison operators (story 44-5, AC5, AC6)
// ---------------------------------------------------------------------------

describe('parseCondition — numeric operators (story 44-5)', () => {
  it('parses >= operator correctly', () => {
    const result = parseCondition('satisfaction_score>=0.8')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ key: 'satisfaction_score', op: '>=', value: '0.8' })
  })

  it('parses <= operator correctly', () => {
    const result = parseCondition('score<=0.5')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ key: 'score', op: '<=', value: '0.5' })
  })

  it('parses > operator correctly', () => {
    const result = parseCondition('iteration>3')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ key: 'iteration', op: '>', value: '3' })
  })

  it('parses < operator correctly', () => {
    const result = parseCondition('error_count<10')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ key: 'error_count', op: '<', value: '10' })
  })

  it('parses >= without spaces around operator', () => {
    const result = parseCondition('satisfaction_score>=0.8')
    expect(result[0]?.op).toBe('>=')
    expect(result[0]?.value).toBe('0.8')
  })

  it('parses >= with spaces around operator', () => {
    const result = parseCondition('satisfaction_score >= 0.8')
    expect(result[0]?.op).toBe('>=')
    expect(result[0]?.value).toBe('0.8')
  })
})

describe('evaluateCondition — numeric operators (story 44-5)', () => {
  it('AC5: >= evaluates true when context value exceeds threshold', () => {
    expect(evaluateCondition('satisfaction_score>=0.8', { satisfaction_score: 0.9 })).toBe(true)
  })

  it('AC5: >= evaluates true when context value equals threshold exactly', () => {
    expect(evaluateCondition('satisfaction_score>=0.8', { satisfaction_score: 0.8 })).toBe(true)
  })

  it('AC5: >= evaluates false when context value is below threshold', () => {
    expect(evaluateCondition('satisfaction_score>=0.8', { satisfaction_score: 0.75 })).toBe(false)
  })

  it('AC6: >= false → unlabelled (retry) edge is chosen instead', () => {
    // The condition itself returns false — router picks the unlabelled edge
    expect(evaluateCondition('satisfaction_score>=0.8', { satisfaction_score: 0.6 })).toBe(false)
  })

  it('<= evaluates true when context value is at or below threshold', () => {
    expect(evaluateCondition('score<=0.5', { score: 0.4 })).toBe(true)
    expect(evaluateCondition('score<=0.5', { score: 0.5 })).toBe(true)
    expect(evaluateCondition('score<=0.5', { score: 0.6 })).toBe(false)
  })

  it('> evaluates correctly', () => {
    expect(evaluateCondition('iteration>3', { iteration: 4 })).toBe(true)
    expect(evaluateCondition('iteration>3', { iteration: 3 })).toBe(false)
    expect(evaluateCondition('iteration>3', { iteration: 2 })).toBe(false)
  })

  it('< evaluates correctly', () => {
    expect(evaluateCondition('error_count<10', { error_count: 5 })).toBe(true)
    expect(evaluateCondition('error_count<10', { error_count: 10 })).toBe(false)
    expect(evaluateCondition('error_count<10', { error_count: 15 })).toBe(false)
  })

  it('absent context key → NaN → numeric comparison returns false', () => {
    expect(evaluateCondition('satisfaction_score>=0.8', {})).toBe(false)
  })

  it('numeric context value stored as a number (not string) evaluates correctly', () => {
    // satisfaction_score stored as 0.9 (Number) — AC5 scenario
    expect(evaluateCondition('satisfaction_score>=0.8', { satisfaction_score: 0.9 })).toBe(true)
  })

  it('string operators (= and !=) are unaffected by numeric operator extension', () => {
    expect(evaluateCondition('outcome=success', { outcome: 'success' })).toBe(true)
    expect(evaluateCondition('outcome!=fail', { outcome: 'success' })).toBe(true)
  })
})
