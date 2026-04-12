// src/modules/eval/__tests__/cross-phase-analyzer.test.ts
import { describe, it, expect } from 'vitest'
import { CrossPhaseAnalyzer } from '../layers/cross-phase-analyzer.js'

describe('CrossPhaseAnalyzer', () => {
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

  it('emits one assertion per dimension (reference-coverage, contradiction, information-loss)', () => {
    const analyzer = new CrossPhaseAnalyzer()
    const assertions = analyzer.buildAssertions(
      upstreamOutput,
      downstreamOutput,
      'analysis',
      'planning',
    )

    expect(assertions).toHaveLength(3)
    const labels = assertions.map((a) => a.label)
    expect(labels).toEqual([
      'cross-phase:reference-coverage',
      'cross-phase:contradiction-detection',
      'cross-phase:information-loss',
    ])
  })

  it('each dimension assertion includes both upstream and downstream output', () => {
    const analyzer = new CrossPhaseAnalyzer()
    const assertions = analyzer.buildAssertions(
      upstreamOutput,
      downstreamOutput,
      'analysis',
      'planning',
    )

    for (const a of assertions) {
      expect(a.type).toBe('llm-rubric')
      expect(a.value).toContain(upstreamOutput.trim())
      expect(a.value).toContain(downstreamOutput.trim())
    }
  })

  it('scopes each assertion to a single dimension so the judge cannot average across them', () => {
    const analyzer = new CrossPhaseAnalyzer()
    const assertions = analyzer.buildAssertions(
      upstreamOutput,
      downstreamOutput,
      'analysis',
      'planning',
    )

    const byLabel = Object.fromEntries(assertions.map((a) => [a.label, a.value]))

    // reference-coverage asks whether downstream builds on upstream
    expect(byLabel['cross-phase:reference-coverage']).toContain('reference')
    expect(byLabel['cross-phase:reference-coverage']).not.toContain('average')
    expect(byLabel['cross-phase:reference-coverage']).not.toContain('contradict')

    // contradiction-detection asks only about conflicts
    expect(byLabel['cross-phase:contradiction-detection']).toContain('contradict')
    expect(byLabel['cross-phase:contradiction-detection']).not.toContain('average')

    // information-loss asks only about dropped upstream details
    expect(byLabel['cross-phase:information-loss']).toContain('lost')
    expect(byLabel['cross-phase:information-loss']).not.toContain('average')
  })

  it('mentions both phase names so the judge knows the transition direction', () => {
    const analyzer = new CrossPhaseAnalyzer()
    const assertions = analyzer.buildAssertions(
      upstreamOutput,
      downstreamOutput,
      'solutioning',
      'implementation',
    )

    for (const a of assertions) {
      expect(a.value).toContain('solutioning')
      expect(a.value).toContain('implementation')
    }
  })

  it('returns empty when upstream output is empty', () => {
    const analyzer = new CrossPhaseAnalyzer()
    expect(analyzer.buildAssertions('', 'x', 'analysis', 'planning')).toEqual([])
    expect(analyzer.buildAssertions('  \n ', 'x', 'analysis', 'planning')).toEqual([])
  })

  it('filters to reference-coverage only when dimensionFilter provided (V1b-4)', () => {
    const analyzer = new CrossPhaseAnalyzer()
    const assertions = analyzer.buildAssertions(
      upstreamOutput,
      downstreamOutput,
      'analysis',
      'planning',
      ['reference-coverage'],
    )

    expect(assertions).toHaveLength(1)
    expect(assertions[0].label).toBe('cross-phase:reference-coverage')
  })

  it('returns all dimensions when dimensionFilter is undefined (backward compat, V1b-4)', () => {
    const analyzer = new CrossPhaseAnalyzer()
    const assertions = analyzer.buildAssertions(
      upstreamOutput,
      downstreamOutput,
      'analysis',
      'planning',
      undefined,
    )

    expect(assertions).toHaveLength(3)
  })

  it('filters to multiple dimensions (V1b-4)', () => {
    const analyzer = new CrossPhaseAnalyzer()
    const assertions = analyzer.buildAssertions(
      upstreamOutput,
      downstreamOutput,
      'analysis',
      'planning',
      ['reference-coverage', 'information-loss'],
    )

    expect(assertions).toHaveLength(2)
    expect(assertions.map((a) => a.label)).toEqual([
      'cross-phase:reference-coverage',
      'cross-phase:information-loss',
    ])
  })
})
