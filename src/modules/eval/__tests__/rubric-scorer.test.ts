// src/modules/eval/__tests__/rubric-scorer.test.ts
import { describe, it, expect } from 'vitest'
import { RubricScorer } from '../layers/rubric-scorer.js'

describe('RubricScorer', () => {
  it('builds one assertion per rubric dimension', () => {
    const scorer = new RubricScorer()

    const rubric = {
      dimensions: [
        {
          name: 'problem_clarity',
          weight: 0.3,
          prompt: 'Is the problem statement specific, falsifiable, and grounded in real user pain?',
        },
        {
          name: 'user_specificity',
          weight: 0.3,
          prompt: 'Are target users described as concrete segments, not generic personas?',
        },
        {
          name: 'feature_justification',
          weight: 0.2,
          prompt: 'Does each feature trace back to a stated user need?',
        },
        {
          name: 'scope_discipline',
          weight: 0.2,
          prompt: 'Is the scope tight, or does it include kitchen-sink features?',
        },
      ],
    }

    const assertions = scorer.buildAssertions(rubric)

    expect(assertions).toHaveLength(4)
    expect(assertions[0].label).toBe('rubric:problem_clarity')
    expect(assertions[0].type).toBe('llm-rubric')
    expect(assertions[0].value).toContain('specific, falsifiable')
    expect(assertions[1].label).toBe('rubric:user_specificity')
  })

  it('returns empty for empty rubric', () => {
    const scorer = new RubricScorer()
    const assertions = scorer.buildAssertions({ dimensions: [] })
    expect(assertions).toEqual([])
  })

  it('calculates weighted score from dimension results', () => {
    const scorer = new RubricScorer()

    const rubric = {
      dimensions: [
        { name: 'a', weight: 0.6, prompt: 'test' },
        { name: 'b', weight: 0.4, prompt: 'test' },
      ],
    }

    const scores = { a: 0.9, b: 0.5 }
    const weighted = scorer.weightedScore(rubric, scores)

    // 0.6 * 0.9 + 0.4 * 0.5 = 0.54 + 0.20 = 0.74
    expect(weighted).toBeCloseTo(0.74, 2)
  })
})
