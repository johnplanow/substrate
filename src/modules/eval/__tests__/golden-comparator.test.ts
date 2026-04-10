// src/modules/eval/__tests__/golden-comparator.test.ts
import { describe, it, expect } from 'vitest'
import { GoldenComparator } from '../layers/golden-comparator.js'
import type { EvalAssertion } from '../types.js'

describe('GoldenComparator', () => {
  it('builds comparison assertion from golden example', () => {
    const comparator = new GoldenComparator()

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

    const assertions = comparator.buildAssertions(goldenExample, 'analysis')

    expect(assertions).toHaveLength(1)
    expect(assertions[0].type).toBe('llm-rubric')
    expect(assertions[0].label).toBe('golden-comparison')
    expect(assertions[0].value).toContain('reference output')
    expect(assertions[0].value).toContain('completeness')
  })

  it('returns empty for empty golden example', () => {
    const comparator = new GoldenComparator()
    const assertions = comparator.buildAssertions('', 'analysis')
    expect(assertions).toEqual([])
  })
})
