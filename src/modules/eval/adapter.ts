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

export interface PromptfooAdapterOptions {
  /** When true, write results to promptfoo's output cache for `npx promptfoo view`. */
  persistToUi?: boolean
}

export class PromptfooAdapter implements EvalAdapter {
  private persistToUi: boolean

  constructor(options?: PromptfooAdapterOptions) {
    this.persistToUi = options?.persistToUi ?? false
  }

  async runAssertions(
    output: string,
    assertions: EvalAssertion[],
    layerName: string,
  ): Promise<LayerResult> {
    // G14: reject empty / whitespace-only output early with a clear
    // message. Grading an empty string fools the default grader into
    // refusing the call and surfaces as a confusing "no results" error
    // deep inside promptfoo's response parsing. Surface the real cause.
    if (output.trim() === '') {
      return {
        layer: layerName,
        score: 0,
        pass: false,
        assertions: [
          {
            name: 'eval-error',
            score: 0,
            pass: false,
            reason:
              'Eval adapter error: output is empty or whitespace-only — cannot grade against an empty response. This usually means the phase_outputs capture for this phase/step was empty or got trimmed upstream; investigate step-runner.ts and phase_outputs fallback logic.',
          },
        ],
      }
    }

    try {
      // promptfoo is intentionally NOT listed in package.json dependencies
      // because its ~800-package transitive tree balloons CI install time
      // and pushes timing-sensitive tests over their timeouts. Users who
      // run `substrate eval` install promptfoo separately via
      // `npm install promptfoo`. The dynamic import below catches the
      // missing-module case and surfaces an actionable error.
      let promptfoo: any
      try {
        // @ts-expect-error — not in deps, resolved at runtime only
        promptfoo = (await import('promptfoo')).default
      } catch (importErr) {
        const msg = importErr instanceof Error ? importErr.message : String(importErr)
        if (
          msg.includes('promptfoo') &&
          (msg.includes('Cannot find') || msg.includes('ERR_MODULE_NOT_FOUND'))
        ) {
          throw new Error(
            'promptfoo is not installed. Run `npm install promptfoo` to enable `substrate eval`.',
          )
        }
        throw importErr
      }

      // G14: capture the output in a provider closure so it NEVER flows
      // through promptfoo's nunjucks renderer. Pre-G14 we used
      // `prompts: ['{{output}}']` with `vars: { output }`, which had
      // three known hazards:
      //
      //   1. Output starting with `file://` → nunjucks attempted a disk
      //      read, either leaking file content into the grader or
      //      tanking the eval into a confusing I/O error.
      //   2. Output containing `{{ var }}` or `{% tag %}` → nunjucks
      //      tried to expand them (sometimes recursively against other
      //      known vars), silently mutating grader input.
      //   3. Whitespace-trimming by the renderer could produce an empty
      //      prompt, which the default grader refuses.
      //
      // The closure pattern eliminates all three: the prompt template is
      // a literal string with no variable references, promptfoo renders
      // it to a constant, the provider ignores whatever promptfoo passes
      // and returns our captured output verbatim. No nunjucks sees the
      // phase output.
      //
      // promptfoo's `loadApiProviders` accepts a bare function and
      // auto-wraps it into `{ id: () => 'custom-function-<idx>', callApi
      // }`. We use that branch (2) — string-ID providerPath branches
      // trip the `.startsWith is not a function` TypeError inside
      // promptfoo's dispatcher.
      const capturedOutput = output
      const echoCallApi = async () => ({ output: capturedOutput })

      const testSuite = {
        // Literal, non-templated prompt. Never references `output`.
        // The provider closure doesn't even look at what promptfoo
        // passes here — it returns `capturedOutput` directly.
        prompts: ['eval-stub'],
        providers: [echoCallApi],
        tests: [
          {
            // No `vars.output` — pre-G14 this was how the output flowed
            // into nunjucks. Intentionally omitted.
            assert: assertions.map((a) => ({
              type: a.type,
              value: a.value,
              threshold: a.threshold ?? DEFAULT_PASS_THRESHOLD,
            })),
          },
        ],
      }

      const evalResult = await promptfoo.evaluate(testSuite as any)

      // Persist to promptfoo's output cache for `npx promptfoo view`.
      // Fire-and-forget — UI persistence failure should never fail the eval.
      if (this.persistToUi) {
        try {
          if (typeof promptfoo.writeResultsToDatabase === 'function') {
            await promptfoo.writeResultsToDatabase(evalResult.results, testSuite as any)
          } else if (typeof promptfoo.writeOutput === 'function') {
            await promptfoo.writeOutput(
              // promptfoo expects { evalId, results, config, ... }
              { results: evalResult.results, config: testSuite },
              null, // outputPath — null uses default ~/.promptfoo/
            )
          }
        } catch {
          // Silently skip — UI persistence is best-effort
        }
      }

      // promptfoo's Eval.results is EvalResult[] — one entry per test case.
      // We submit a single test with N assertions, so there's one row whose
      // gradingResult.componentResults holds per-assertion grading. When there
      // is only one assertion, promptfoo may skip componentResults and put the
      // single result at the top level — fall back to that.
      const testResult = (evalResult as { results?: Array<{ gradingResult?: any }> })
        .results?.[0]
      const grading = testResult?.gradingResult
      const componentResults: Array<{ pass?: boolean; score?: number; reason?: string }> =
        Array.isArray(grading?.componentResults) && grading.componentResults.length > 0
          ? grading.componentResults
          : grading
            ? [grading]
            : []

      const assertionResults: AssertionResult[] = componentResults.map((r, i) => ({
        name: assertions[i]?.label ?? `assertion-${i}`,
        score: r.score ?? (r.pass ? 1.0 : 0.0),
        pass: r.pass ?? false,
        reason: r.reason ?? '',
      }))

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
