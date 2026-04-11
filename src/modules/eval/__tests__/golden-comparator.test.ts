// src/modules/eval/__tests__/golden-comparator.test.ts
import { describe, it, expect } from 'vitest'
import { GoldenComparator } from '../layers/golden-comparator.js'

describe('GoldenComparator', () => {
  const goldenExample = `
problem_statement: "Users need a lightweight CLI tool to manage daily tasks without leaving the terminal"
target_users:
  - "Developers who live in the terminal"
  - "DevOps engineers managing server tasks"
core_features:
  - "Add, complete, and delete tasks"
  - "Priority levels and due dates"
  - "Filter and search across tasks"
`

  it('emits one assertion per dimension (completeness, depth, accuracy)', () => {
    const comparator = new GoldenComparator()
    const assertions = comparator.buildAssertions(goldenExample, 'analysis')

    expect(assertions).toHaveLength(3)
    const labels = assertions.map((a) => a.label)
    expect(labels).toEqual([
      'golden:completeness',
      'golden:depth',
      'golden:accuracy',
    ])
  })

  it('each dimension assertion is an llm-rubric that includes the reference output', () => {
    const comparator = new GoldenComparator()
    const assertions = comparator.buildAssertions(goldenExample, 'analysis')

    for (const a of assertions) {
      expect(a.type).toBe('llm-rubric')
      expect(a.value).toContain(goldenExample.trim())
    }
  })

  it('scopes each assertion to a single dimension so the judge cannot average across them', () => {
    const comparator = new GoldenComparator()
    const assertions = comparator.buildAssertions(goldenExample, 'analysis')

    const byLabel = Object.fromEntries(assertions.map((a) => [a.label, a.value]))

    // completeness asks only about breadth
    expect(byLabel['golden:completeness']).toContain('completeness')
    expect(byLabel['golden:completeness']).not.toContain('average')
    expect(byLabel['golden:completeness']).not.toContain('accuracy')

    // depth asks only about section detail
    expect(byLabel['golden:depth']).toContain('depth')
    expect(byLabel['golden:depth']).not.toContain('average')

    // accuracy asks only about soundness of claims
    expect(byLabel['golden:accuracy']).toContain('accuracy')
    expect(byLabel['golden:accuracy']).not.toContain('average')
  })

  it('mentions the phase name in each assertion so the judge knows the context', () => {
    const comparator = new GoldenComparator()
    const assertions = comparator.buildAssertions(goldenExample, 'planning')

    for (const a of assertions) {
      expect(a.value).toContain('planning')
    }
  })

  it('returns empty for empty golden example', () => {
    const comparator = new GoldenComparator()
    expect(comparator.buildAssertions('', 'analysis')).toEqual([])
    expect(comparator.buildAssertions('   \n  ', 'analysis')).toEqual([])
  })
})
