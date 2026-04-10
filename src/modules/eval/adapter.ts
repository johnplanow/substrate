// src/modules/eval/adapter.ts
import type { EvalAssertion, LayerResult, AssertionResult } from './types.js'
import { DEFAULT_PASS_THRESHOLD } from './types.js'

export interface EvalAdapter {
  runAssertions(
    output: string,
    assertions: EvalAssertion[],
    layerName: string,
  ): Promise<LayerResult>
}

export class PromptfooAdapter implements EvalAdapter {
  async runAssertions(
    output: string,
    assertions: EvalAssertion[],
    layerName: string,
  ): Promise<LayerResult> {
    try {
      const promptfoo = (await import('promptfoo')).default

      const testSuite = {
        prompts: ['{{output}}'],
        providers: [
          {
            id: () => Promise.resolve({ output }),
          },
        ],
        tests: [
          {
            vars: { output },
            assert: assertions.map((a) => ({
              type: a.type,
              value: a.value,
              threshold: a.threshold ?? DEFAULT_PASS_THRESHOLD,
            })),
          },
        ],
      }

      const evalResult = await promptfoo.evaluate(testSuite as any)

      const testResults = evalResult.results?.[0]?.results ?? []
      const assertionResults: AssertionResult[] = testResults.map(
        (r: any, i: number) => ({
          name: assertions[i]?.label ?? `assertion-${i}`,
          score: r.score ?? (r.success ? 1.0 : 0.0),
          pass: r.success ?? false,
          reason: r.reason ?? '',
        }),
      )

      const avgScore =
        assertionResults.length > 0
          ? assertionResults.reduce((sum, a) => sum + a.score, 0) / assertionResults.length
          : 0

      return {
        layer: layerName,
        score: avgScore,
        pass: avgScore >= DEFAULT_PASS_THRESHOLD,
        assertions: assertionResults,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        layer: layerName,
        score: 0,
        pass: false,
        assertions: [
          {
            name: 'eval-error',
            score: 0,
            pass: false,
            reason: `Eval adapter error: ${msg}`,
          },
        ],
      }
    }
  }
}
