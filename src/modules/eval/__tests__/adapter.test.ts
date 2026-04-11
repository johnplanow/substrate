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

  describe('G14 — adapter output-rendering hazards', () => {
    // The pre-G14 adapter passed output into promptfoo's nunjucks renderer
    // via `prompts: ['{{output}}']` + `vars: { output }`. That lets an
    // adversarial output mutate the grader input silently. G14 eliminates
    // the render path by moving the captured output into a provider
    // closure, so nunjucks never sees it.

    async function invokeAdapter(
      mockSuite: (suite: any) => void,
      output: string,
    ): Promise<void> {
      const { default: promptfoo } = await import('promptfoo')
      const mockEvaluate = vi.mocked(promptfoo.evaluate)
      mockEvaluate.mockImplementationOnce(async (suite: any) => {
        mockSuite(suite)
        return {
          results: [
            {
              gradingResult: {
                pass: true,
                score: 1.0,
                reason: 'stub',
                assertion: { type: 'llm-rubric', value: 'x' },
              },
            },
          ],
          stats: { successes: 1, failures: 0 },
        } as any
      })

      const adapter = new PromptfooAdapter()
      await adapter.runAssertions(
        output,
        [{ type: 'llm-rubric', value: 'rubric', label: 'c' }],
        'test-layer',
      )
    }

    it('prompts array does not contain a templated {{output}} reference', async () => {
      let captured: any = null
      await invokeAdapter((s) => (captured = s), 'normal phase output')
      expect(captured).toBeTruthy()
      expect(Array.isArray(captured.prompts)).toBe(true)
      for (const p of captured.prompts) {
        // The pre-G14 prompt was literally '{{output}}'. Any prompt
        // string that references the `output` var is a regression —
        // it re-opens the nunjucks hazard.
        expect(String(p)).not.toMatch(/\{\{\s*output\s*\}\}/)
      }
    })

    it('provider returns captured output verbatim for file:// prefixed content', async () => {
      let captured: any = null
      const adversarial = 'file:///etc/passwd\nadditional content below'
      await invokeAdapter((s) => (captured = s), adversarial)
      const provider = captured.providers[0]
      // Invoke the provider function directly — it should return the
      // captured output unchanged, with no disk read attempted by
      // nunjucks (because nunjucks never sees this value).
      const result = await provider('ignored-prompt-from-promptfoo')
      expect(result.output).toBe(adversarial)
    })

    it('provider returns captured output verbatim for embedded template tags', async () => {
      let captured: any = null
      const adversarial =
        'analysis: {{ leaked_var }}\nthen: {% for x in secrets %}{{ x }}{% endfor %}'
      await invokeAdapter((s) => (captured = s), adversarial)
      const provider = captured.providers[0]
      const result = await provider('unused')
      // The template tags must come through unexpanded — the grader
      // sees them as literal characters, not as expanded variables.
      expect(result.output).toBe(adversarial)
      expect(result.output).toContain('{{ leaked_var }}')
      expect(result.output).toContain('{% for x in secrets %}')
    })

    it('fails fast with a clear error when output is empty', async () => {
      const adapter = new PromptfooAdapter()
      const result = await adapter.runAssertions(
        '',
        [{ type: 'llm-rubric', value: 'rubric', label: 'c' }],
        'test-layer',
      )
      expect(result.pass).toBe(false)
      expect(result.score).toBe(0)
      expect(result.assertions[0].name).toBe('eval-error')
      expect(result.assertions[0].reason.toLowerCase()).toContain('empty')
    })

    it('fails fast with a clear error when output is whitespace-only', async () => {
      const adapter = new PromptfooAdapter()
      const result = await adapter.runAssertions(
        '   \n\t\n   ',
        [{ type: 'llm-rubric', value: 'rubric', label: 'c' }],
        'test-layer',
      )
      expect(result.pass).toBe(false)
      expect(result.assertions[0].reason.toLowerCase()).toContain('empty')
    })
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
