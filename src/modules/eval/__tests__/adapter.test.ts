// src/modules/eval/__tests__/adapter.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PromptfooAdapter } from '../adapter.js'
import type { EvalAssertion } from '../types.js'

// Mock promptfoo to avoid real LLM calls
vi.mock('promptfoo', () => ({
  default: {
    evaluate: vi.fn(),
  },
}))

describe('PromptfooAdapter', () => {
  it('translates EvalAssertions to promptfoo format and returns LayerResult', async () => {
    const { default: promptfoo } = await import('promptfoo')
    const mockEvaluate = vi.mocked(promptfoo.evaluate)

    // New promptfoo shape: Eval.results is EvalResult[], each with a
    // gradingResult whose componentResults array holds per-assertion scores.
    mockEvaluate.mockResolvedValueOnce({
      results: [
        {
          gradingResult: {
            pass: true,
            score: 0.85,
            reason: 'Aggregated pass',
            componentResults: [
              {
                pass: true,
                score: 0.9,
                reason: 'Output follows instructions well',
                assertion: { type: 'llm-rubric', value: 'test rubric' },
              },
              {
                pass: true,
                score: 0.8,
                reason: 'Good coverage of required sections',
                assertion: { type: 'llm-rubric', value: 'section check' },
              },
            ],
          },
        },
      ],
      stats: { successes: 2, failures: 0 },
    } as any)

    const adapter = new PromptfooAdapter()
    const assertions: EvalAssertion[] = [
      { type: 'llm-rubric', value: 'test rubric', label: 'instruction-compliance' },
      { type: 'llm-rubric', value: 'section check', label: 'section-coverage' },
    ]

    const result = await adapter.runAssertions('some LLM output', assertions, 'prompt-compliance')

    expect(result.layer).toBe('prompt-compliance')
    expect(result.score).toBeCloseTo(0.85, 1)
    expect(result.pass).toBe(true)
    expect(result.assertions).toHaveLength(2)
    expect(result.assertions[0].name).toBe('instruction-compliance')
    expect(result.assertions[0].score).toBe(0.9)
  })

  it('marks layer as failed when score below threshold', async () => {
    const { default: promptfoo } = await import('promptfoo')
    const mockEvaluate = vi.mocked(promptfoo.evaluate)

    // Single-assertion case: no componentResults — the gradingResult itself
    // is the one result. Adapter should fall back to treating it as a
    // single-element array.
    mockEvaluate.mockResolvedValueOnce({
      results: [
        {
          gradingResult: {
            pass: false,
            score: 0.4,
            reason: 'Output ignores key instructions',
            assertion: { type: 'llm-rubric', value: 'rubric' },
          },
        },
      ],
      stats: { successes: 0, failures: 1 },
    } as any)

    const adapter = new PromptfooAdapter()
    const assertions: EvalAssertion[] = [
      { type: 'llm-rubric', value: 'rubric', label: 'check' },
    ]

    const result = await adapter.runAssertions('bad output', assertions, 'test-layer')

    expect(result.pass).toBe(false)
    expect(result.score).toBe(0.4)
  })

  it('handles promptfoo errors gracefully', async () => {
    const { default: promptfoo } = await import('promptfoo')
    const mockEvaluate = vi.mocked(promptfoo.evaluate)
    mockEvaluate.mockRejectedValueOnce(new Error('API key expired'))

    const adapter = new PromptfooAdapter()
    const assertions: EvalAssertion[] = [
      { type: 'llm-rubric', value: 'rubric', label: 'check' },
    ]

    const result = await adapter.runAssertions('output', assertions, 'test-layer')

    expect(result.pass).toBe(false)
    expect(result.score).toBe(0)
    expect(result.assertions[0].reason).toContain('API key expired')
  })
})
