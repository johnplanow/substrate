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

export interface PhaseData {
  phase: EvalPhase
  output: string
  promptTemplate: string
  context: Record<string, string>
  /** Only for implementation phase */
  storySpec?: StorySpec
}

export class EvalEngine {
  private adapter: EvalAdapter
  private promptCompliance = new PromptComplianceLayer()
  private implVerifier = new ImplVerifier()

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

    // Deep tier layers will be added in Task 11

    // Aggregate
    const avgScore =
      layers.length > 0
        ? layers.reduce((sum, l) => sum + l.score, 0) / layers.length
        : 0
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
