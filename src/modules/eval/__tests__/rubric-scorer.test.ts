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
          prompt: 'Does the problem statement name a measurable user impact (counts, percentages, frequencies, or named scenarios) rather than a vague hardship?',
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
          prompt: 'Does the output include an explicit out-of-scope section that names what is excluded, rather than only listing what is included?',
        },
      ],
    }

    const assertions = scorer.buildAssertions(rubric)

    expect(assertions).toHaveLength(4)
    expect(assertions[0].label).toBe('rubric:problem_clarity')
    expect(assertions[0].type).toBe('llm-rubric')
    expect(assertions[0].value).toContain('measurable user impact')
    expect(assertions[1].label).toBe('rubric:user_specificity')
  })

  it('returns empty for empty rubric', () => {
    const scorer = new RubricScorer()
    const assertions = scorer.buildAssertions({ dimensions: [] })
    expect(assertions).toEqual([])
  })

  it('includes referenceContext in each assertion prompt when provided (G9)', () => {
    // The implementation-phase rubric prompts reference "the story" ("every
    // module the story spec listed", "all acceptance criteria from the
    // story"). Without a reference context, the judge has to guess what
    // story is being implemented. G9 extends buildAssertions to optionally
    // inject a reference context block into every assertion so the grader
    // has the AC list and module list alongside the rubric question.
    const scorer = new RubricScorer()
    const rubric = {
      dimensions: [
        { name: 'acceptance_coverage', weight: 0.5, prompt: 'Are all acceptance criteria addressed?' },
        { name: 'code_correctness', weight: 0.5, prompt: 'Does the diff show complete function bodies?' },
      ],
    }

    const referenceContext = [
      'Story: 1-2 (Task domain model)',
      'Acceptance criteria:',
      '  - ValidateTitle rejects empty string',
      '  - ValidatePriority is case-insensitive',
      'Expected files: internal/task/task.go, internal/task/validate.go',
    ].join('\n')

    const assertions = scorer.buildAssertions(rubric, { referenceContext })

    expect(assertions).toHaveLength(2)
    for (const a of assertions) {
      // Every dimension's prompt should now include the reference context
      // so the judge sees the AC and modules alongside the rubric question.
      expect(a.value).toContain('Reference context')
      expect(a.value).toContain('ValidateTitle rejects empty string')
      expect(a.value).toContain('internal/task/task.go')
      // The dimension-specific question is still present.
      expect(a.value).toContain('Score on a 0-1 scale')
    }
    // Dimension-specific prompt text is preserved.
    expect(assertions[0].value).toContain('acceptance criteria')
    expect(assertions[1].value).toContain('function bodies')
  })

  it('omits referenceContext section when not provided (backward compat)', () => {
    const scorer = new RubricScorer()
    const rubric = {
      dimensions: [{ name: 'x', weight: 1.0, prompt: 'test question' }],
    }
    const assertions = scorer.buildAssertions(rubric)
    expect(assertions[0].value).not.toContain('Reference context')
    expect(assertions[0].value).toContain('test question')
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
