// src/modules/eval/__tests__/cross-phase-analyzer.test.ts
import { describe, it, expect } from 'vitest'
import { CrossPhaseAnalyzer } from '../layers/cross-phase-analyzer.js'
import type { EvalAssertion } from '../types.js'

describe('CrossPhaseAnalyzer', () => {
  it('builds coherence assertions for analysis → planning transition', () => {
    const analyzer = new CrossPhaseAnalyzer()

    const upstreamOutput = `
problem_statement: "CLI task management for developers"
target_users: ["terminal-first developers", "DevOps engineers"]
core_features: ["task CRUD", "priority levels", "search"]
`
    const downstreamOutput = `
functional_requirements:
  - description: "Create, read, update, delete tasks via CLI"
  - description: "Assign priority levels to tasks"
`

    const assertions = analyzer.buildAssertions(
      upstreamOutput,
      downstreamOutput,
      'analysis',
      'planning',
    )

    expect(assertions).toHaveLength(1)
    const assertion = assertions[0]
    expect(assertion.type).toBe('llm-rubric')
    expect(assertion.label).toBe('cross-phase-coherence')
    expect(assertion.value).toContain('reference coverage')
    expect(assertion.value).toContain('contradiction')
    expect(assertion.value).toContain('information loss')
  })

  it('returns empty when no upstream output', () => {
    const analyzer = new CrossPhaseAnalyzer()
    const assertions = analyzer.buildAssertions('', 'some output', 'analysis', 'planning')
    expect(assertions).toEqual([])
  })
})
