// src/modules/eval/__tests__/meta-eval.test.ts
//
// META-EVAL: Does the LLM judge actually discriminate good output from bad?
//
// Every other test in this module mocks promptfoo. This file does not — it
// runs the real adapter against hand-built good/bad fixture pairs and asserts
// that the judge scores the good variant higher than the bad variant by a
// non-trivial margin.
//
// Gated two ways:
//   1. Filename pattern `*meta-eval*` is excluded from `npm test` and `test:fast`
//      via --exclude in package.json. vitest never picks this file up in those runs.
//   2. If someone runs vitest directly with --include, the describe block checks
//      `process.env.META_EVAL === '1'` and skips all tests unless it is set.
//
// Invoke via `npm run test:meta-eval` (which sets META_EVAL=1). Requires an API
// key in env (OPENAI_API_KEY or ANTHROPIC_API_KEY) for promptfoo's default grader.
//
// G2 STATUS: The output-fidelity fix has landed. The eval CLI now reads raw
// LLM text from the `phase_outputs` table (captured per dispatch step in
// src/modules/phase-orchestrator/step-runner.ts) and falls back to the
// legacy `key: value\n` synthesis only for runs predating the capture.
// The fixtures in this suite are still hand-authored to match the legacy
// synthesized shape and should be regenerated against real raw output
// when there is a captured run available. That regeneration is tracked as
// deferred work G8.

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { PromptfooAdapter } from '../adapter.js'
import { RubricScorer } from '../layers/rubric-scorer.js'
import type { Rubric } from '../layers/rubric-scorer.js'
import type { EvalPhase, LayerResult } from '../types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FIXTURES_DIR = join(__dirname, '..', 'fixtures')

/** Minimum `score(good) - score(bad)` delta required per phase. */
const MARGIN_THRESHOLD = 0.15

/** Per-test timeout — real LLM calls can take a while. */
const META_EVAL_TIMEOUT_MS = 180_000

/** Single source of truth for phases covered by meta-eval fixtures. */
const META_EVAL_PHASES = [
  'analysis',
  'planning',
  'solutioning',
  'implementation',
] as const satisfies readonly EvalPhase[]

// Compile-time exhaustiveness check: if `EvalPhase` gains a new variant and
// this array is not updated, the following assignment will fail to type-check.
// (Uses a never-pinning pattern; resolves to `true` when exhaustive.)
type _ExhaustiveEvalPhases =
  Exclude<EvalPhase, typeof META_EVAL_PHASES[number]> extends never ? true : never
const _exhaustive: _ExhaustiveEvalPhases = true
void _exhaustive

interface MetaEvalFixture {
  name: string
  description: string
  phase: EvalPhase
  output: string
  notes?: string
  /**
   * G9: pre-formatted reference material (story spec, acceptance criteria,
   * architecture decisions) that the judge should evaluate the output
   * AGAINST. Injected into every rubric assertion prompt via
   * `RubricScorer.buildAssertions({ referenceContext })` so the grader has
   * the reference in the same call as the rubric question.
   *
   * Used for the implementation phase where grading requires knowing which
   * story is being implemented. Optional — analysis/planning/solutioning
   * phases evaluate outputs on self-contained quality rubrics and do not
   * need external reference material.
   *
   * Good and bad variants for the same phase should carry the SAME
   * reference_context (they are evaluating the same simulated story from
   * two different implementation quality levels), so the judge is asked
   * to distinguish implementation quality, not reference fidelity.
   */
  reference_context?: string
}

function loadFixture(phase: EvalPhase, variant: 'good' | 'bad'): MetaEvalFixture {
  const path = join(FIXTURES_DIR, 'meta-eval', phase, `${variant}.yaml`)
  let parsed: unknown
  try {
    parsed = yaml.load(readFileSync(path, 'utf-8'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`meta-eval fixture missing or malformed: ${path} (${msg})`)
  }
  // yaml.load returns `undefined` for an empty file and `null` for `~` — both
  // would bypass the try/catch and cause a confusing downstream TypeError.
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`meta-eval fixture empty or not an object: ${path}`)
  }
  return parsed as MetaEvalFixture
}

function loadRubric(phase: EvalPhase): Rubric {
  const path = join(FIXTURES_DIR, 'rubrics', `${phase}.yaml`)
  let parsed: unknown
  try {
    parsed = yaml.load(readFileSync(path, 'utf-8'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`meta-eval rubric missing or malformed: ${path} (${msg})`)
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { dimensions?: unknown }).dimensions)
  ) {
    throw new Error(`meta-eval rubric missing dimensions array: ${path}`)
  }
  return parsed as Rubric
}

/**
 * Extract per-dimension scores from a LayerResult. Mirrors the extraction
 * pattern in src/modules/eval/eval-engine.ts:128-134 so these must stay in sync.
 * RubricScorer labels each assertion `rubric:<dimension-name>`.
 */
function extractDimensionScores(result: LayerResult): Record<string, number> {
  const scores: Record<string, number> = {}
  for (const a of result.assertions) {
    if (a.name.startsWith('rubric:')) {
      scores[a.name.slice('rubric:'.length)] = a.score
    }
  }
  return scores
}

const describeMetaEval = process.env.META_EVAL === '1' ? describe : describe.skip

describeMetaEval('Meta-eval: LLM judge discrimination', () => {
  const adapter = new PromptfooAdapter()
  const scorer = new RubricScorer()

  // Fail fast with a clear message if the env gate is on but no API key is
  // available for promptfoo's default grader. Runs inside beforeAll so the
  // check only fires when the describe block is active (META_EVAL=1). Without
  // this, the adapter's catch path would silently return score 0 for both
  // variants and the test would fail on the margin assertion with a misleading
  // diagnosis.
  beforeAll(() => {
    if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'meta-eval: META_EVAL=1 is set but neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is in env. ' +
          'Set one before running `npm run test:meta-eval`.',
      )
    }
  })

  for (const phase of META_EVAL_PHASES) {
    it(
      `judge distinguishes good from bad ${phase} output with margin >= ${MARGIN_THRESHOLD}`,
      async () => {
        const good = loadFixture(phase, 'good')
        const bad = loadFixture(phase, 'bad')
        const rubric = loadRubric(phase)

        expect(good.phase).toBe(phase)
        expect(bad.phase).toBe(phase)
        expect(rubric.dimensions.length).toBeGreaterThan(0)

        // G9: Sanity-check that good and bad carry the same reference
        // context when either provides one, so the judge is asked to
        // distinguish implementation quality against a shared reference
        // rather than accidentally grading "who has a better story spec".
        if (good.reference_context || bad.reference_context) {
          expect(
            bad.reference_context,
            `meta-eval fixture mismatch: ${phase} good has reference_context but bad does not (or vice versa)`,
          ).toBe(good.reference_context)
        }

        // Use the good fixture's reference_context for both dispatches —
        // they must match per the guard above. Falls back to undefined
        // when neither fixture provides one (analysis/planning/solutioning).
        const referenceContext = good.reference_context

        const assertions = scorer.buildAssertions(rubric, { referenceContext })

        // Run sequentially rather than in parallel. Parallelism only saves ~50%
        // wall-clock but doubles peak concurrent grader calls, making rate-limit
        // and cost-spike behavior harder to reason about on a gated-off test.
        const goodResult = await adapter.runAssertions(good.output, assertions, 'rubric')
        const badResult = await adapter.runAssertions(bad.output, assertions, 'rubric')

        // Guard: if the adapter's catch path fired on either call, it emits a
        // single `eval-error` assertion with score 0. Without this check, the
        // test would fail on the margin assertion with a message that points
        // at the fixtures rather than the real adapter/API failure.
        for (const [label, res] of [
          ['good', goodResult],
          ['bad', badResult],
        ] as const) {
          const adapterErr = res.assertions.find((a) => a.name === 'eval-error')
          if (adapterErr) {
            throw new Error(
              `meta-eval adapter failed on ${phase}/${label}: ${adapterErr.reason}`,
            )
          }
        }

        const goodScores = extractDimensionScores(goodResult)
        const badScores = extractDimensionScores(badResult)

        const goodWeighted = scorer.weightedScore(rubric, goodScores)
        const badWeighted = scorer.weightedScore(rubric, badScores)
        const margin = goodWeighted - badWeighted

        // Diagnostic visibility — this is the key output developers look at when
        // calibrating the threshold or triaging a regression.
        // eslint-disable-next-line no-console
        console.log(
          `[meta-eval] ${phase}: good=${goodWeighted.toFixed(3)}, bad=${badWeighted.toFixed(3)}, margin=${margin.toFixed(3)}`,
        )

        expect(
          goodWeighted,
          `judge did not rank good above bad for ${phase} (good=${goodWeighted.toFixed(3)}, bad=${badWeighted.toFixed(3)})`,
        ).toBeGreaterThan(badWeighted)

        expect(
          margin,
          `${phase} margin ${margin.toFixed(3)} below threshold ${MARGIN_THRESHOLD} (good=${goodWeighted.toFixed(3)}, bad=${badWeighted.toFixed(3)})`,
        ).toBeGreaterThanOrEqual(MARGIN_THRESHOLD)
      },
      META_EVAL_TIMEOUT_MS,
    )
  }
})
