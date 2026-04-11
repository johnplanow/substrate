// src/modules/eval/eval-engine.ts
import type { EvalAdapter } from './adapter.js'
import type {
  EvalDepth,
  EvalPhase,
  EvalReport,
  PhaseEvalResult,
  LayerResult,
} from './types.js'
import { DEFAULT_PASS_THRESHOLD } from './types.js'
import { PromptComplianceLayer } from './layers/prompt-compliance.js'
import { ImplVerifier } from './layers/impl-verifier.js'
import type { StorySpec } from './layers/impl-verifier.js'
import { GoldenComparator } from './layers/golden-comparator.js'
import { CrossPhaseAnalyzer } from './layers/cross-phase-analyzer.js'
import { RubricScorer } from './layers/rubric-scorer.js'
import type { Rubric } from './layers/rubric-scorer.js'

/**
 * Per-layer weights for phase-score aggregation (G5).
 *
 * Rationale: before G5 the phase score was an unweighted mean across layers,
 * which meant a deterministic file-existence check counted the same as a
 * subjective LLM rubric, so the phase score was dragged toward whichever
 * layer was noisiest. Weights prioritize layers whose signal we trust more.
 *
 * - `rubric` (0.4): highest weight — scores per-dimension against a
 *   hand-authored rubric; most direct quality signal for the phase contract.
 * - `prompt-compliance` / `impl-verifier` (0.3): structural/deterministic
 *   checks that should pull the score toward concrete contract adherence.
 * - `golden-comparison` (0.2): useful but degrades with fixture drift.
 * - `cross-phase-coherence` (0.1): noisiest; lowest weight.
 *
 * Aggregation is `sum(weight·score) / sum(weight)` over layers that
 * actually ran for the phase, so weights do not need to sum to 1.
 */
const LAYER_WEIGHTS: Record<string, number> = {
  rubric: 0.4,
  'prompt-compliance': 0.3,
  'impl-verifier': 0.3,
  'golden-comparison': 0.2,
  'cross-phase-coherence': 0.1,
}

/** Weight applied to any layer whose name is not in LAYER_WEIGHTS. */
const DEFAULT_LAYER_WEIGHT = 0.2

export interface PhaseData {
  phase: EvalPhase
  output: string
  promptTemplate: string
  context: Record<string, string>
  /** Only for implementation phase */
  storySpec?: StorySpec
  /** Deep tier: golden example for this phase */
  goldenExample?: string
  /** Deep tier: scoring rubric for this phase */
  rubric?: Rubric
  /** Deep tier: upstream phase output for coherence check */
  upstreamOutput?: string
  /** Deep tier: upstream phase name */
  upstreamPhase?: EvalPhase | string
}

export class EvalEngine {
  private adapter: EvalAdapter
  private promptCompliance = new PromptComplianceLayer()
  private implVerifier = new ImplVerifier()
  private goldenComparator = new GoldenComparator()
  private crossPhaseAnalyzer = new CrossPhaseAnalyzer()
  private rubricScorer = new RubricScorer()

  constructor(adapter: EvalAdapter) {
    this.adapter = adapter
  }

  async evaluatePhase(
    phaseData: PhaseData,
    depth: EvalDepth,
  ): Promise<PhaseEvalResult> {
    const layers: LayerResult[] = []

    // Standard tier: prompt compliance
    const complianceAssertions = this.promptCompliance.buildAssertions(
      phaseData.promptTemplate,
      phaseData.output,
      phaseData.context,
    )
    if (complianceAssertions.length > 0) {
      const result = await this.adapter.runAssertions(
        phaseData.output,
        complianceAssertions,
        'prompt-compliance',
      )
      layers.push(result)
    }

    // Standard tier: implementation verifier (impl phase only)
    if (phaseData.phase === 'implementation' && phaseData.storySpec) {
      const implAssertions = this.implVerifier.buildAssertions(phaseData.storySpec)
      if (implAssertions.length > 0) {
        const result = await this.adapter.runAssertions(
          phaseData.output,
          implAssertions,
          'impl-verifier',
        )
        layers.push(result)
      }
    }

    // Deep tier: golden example comparison
    if (depth === 'deep' && phaseData.goldenExample) {
      const goldenAssertions = this.goldenComparator.buildAssertions(
        phaseData.goldenExample,
        phaseData.phase,
      )
      if (goldenAssertions.length > 0) {
        const result = await this.adapter.runAssertions(
          phaseData.output,
          goldenAssertions,
          'golden-comparison',
        )
        layers.push(result)
      }
    }

    // Deep tier: cross-phase coherence
    if (depth === 'deep' && phaseData.upstreamOutput && phaseData.upstreamPhase) {
      const coherenceAssertions = this.crossPhaseAnalyzer.buildAssertions(
        phaseData.upstreamOutput,
        phaseData.output,
        phaseData.upstreamPhase,
        phaseData.phase,
      )
      if (coherenceAssertions.length > 0) {
        const result = await this.adapter.runAssertions(
          phaseData.output,
          coherenceAssertions,
          'cross-phase-coherence',
        )
        layers.push(result)
      }
    }

    // Deep tier: rubric scoring (with weighted aggregation)
    if (depth === 'deep' && phaseData.rubric) {
      const rubricAssertions = this.rubricScorer.buildAssertions(phaseData.rubric)
      if (rubricAssertions.length > 0) {
        const result = await this.adapter.runAssertions(
          phaseData.output,
          rubricAssertions,
          'rubric',
        )

        // Build per-dimension scores map from assertion results
        // (assertion labels are `rubric:<dimension-name>`)
        const dimensionScores: Record<string, number> = {}
        for (const a of result.assertions) {
          if (a.name.startsWith('rubric:')) {
            const dimName = a.name.slice('rubric:'.length)
            dimensionScores[dimName] = a.score
          }
        }

        // Apply dimension weights from the rubric
        const weightedScore = this.rubricScorer.weightedScore(
          phaseData.rubric,
          dimensionScores,
        )

        // Overwrite the layer score with the weighted version
        layers.push({
          ...result,
          score: weightedScore,
          pass: weightedScore >= DEFAULT_PASS_THRESHOLD,
        })
      }
    }

    // Aggregate: weighted mean across the layers that actually ran
    // (G5 — see LAYER_WEIGHTS above for rationale).
    let avgScore = 0
    if (layers.length > 0) {
      let weightedSum = 0
      let weightTotal = 0
      for (const l of layers) {
        const w = LAYER_WEIGHTS[l.layer] ?? DEFAULT_LAYER_WEIGHT
        weightedSum += w * l.score
        weightTotal += w
      }
      avgScore = weightTotal > 0 ? weightedSum / weightTotal : 0
    }
    const pass = avgScore >= DEFAULT_PASS_THRESHOLD
    const issues = layers
      .flatMap((l) => l.assertions.filter((a) => !a.pass))
      .map((a) => a.reason)
    const feedback = this.buildFeedback(layers)

    return {
      phase: phaseData.phase,
      score: avgScore,
      pass,
      layers,
      issues,
      feedback,
    }
  }

  async evaluate(
    phases: PhaseData[],
    depth: EvalDepth,
    runId: string,
  ): Promise<EvalReport> {
    const phaseResults: PhaseEvalResult[] = []

    for (const phaseData of phases) {
      const result = await this.evaluatePhase(phaseData, depth)
      phaseResults.push(result)
    }

    const overallScore =
      phaseResults.length > 0
        ? phaseResults.reduce((sum, p) => sum + p.score, 0) / phaseResults.length
        : 0
    const pass = phaseResults.every((p) => p.pass)

    return {
      runId,
      depth,
      timestamp: new Date().toISOString(),
      phases: phaseResults,
      overallScore,
      pass,
    }
  }

  private buildFeedback(layers: LayerResult[]): string {
    const failedAssertions = layers
      .flatMap((l) =>
        l.assertions
          .filter((a) => !a.pass)
          .map((a) => `${l.layer}/${a.name}: ${a.reason} (score: ${a.score})`),
      )

    if (failedAssertions.length === 0) return ''

    return [
      'The following checks scored below threshold:',
      ...failedAssertions.map((f) => `- ${f}`),
      '',
      'Address these issues to improve the output quality.',
    ].join('\n')
  }
}
