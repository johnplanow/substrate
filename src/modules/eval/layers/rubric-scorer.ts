// src/modules/eval/layers/rubric-scorer.ts
import type { EvalAssertion } from '../types.js'

export interface RubricDimension {
  name: string
  weight: number
  prompt: string
}

export interface Rubric {
  dimensions: RubricDimension[]
}

/**
 * Optional knobs for building rubric assertions.
 *
 * - `referenceContext` (G9): a pre-formatted markdown/text block with the
 *   story spec, acceptance criteria, and any supporting architecture
 *   context that the judge should evaluate the output AGAINST. Injected
 *   into every assertion prompt so the judge has the reference material
 *   in the same call as the rubric question. Used for the implementation
 *   phase where grading requires knowing which story is being implemented.
 */
export interface BuildAssertionsOptions {
  referenceContext?: string
}

export class RubricScorer {
  buildAssertions(rubric: Rubric, options: BuildAssertionsOptions = {}): EvalAssertion[] {
    if (rubric.dimensions.length === 0) return []

    const { referenceContext } = options

    return rubric.dimensions.map((dim) => {
      const lines: string[] = [
        `Evaluate this output on a single dimension: **${dim.name}**`,
        '',
        dim.prompt,
      ]

      if (referenceContext && referenceContext.trim().length > 0) {
        lines.push(
          '',
          'Reference context (the material the output is being evaluated AGAINST):',
          '',
          referenceContext,
        )
      }

      lines.push(
        '',
        'Score on a 0-1 scale:',
        '- 1.0: Excellent on this dimension',
        '- 0.7: Good with minor issues',
        '- 0.4: Below expectations',
        '- 0.0: This dimension is not addressed at all',
      )

      return {
        type: 'llm-rubric' as const,
        value: lines.join('\n'),
        label: `rubric:${dim.name}`,
      }
    })
  }

  weightedScore(rubric: Rubric, scores: Record<string, number>): number {
    let totalWeight = 0
    let weightedSum = 0

    for (const dim of rubric.dimensions) {
      const score = scores[dim.name] ?? 0
      weightedSum += dim.weight * score
      totalWeight += dim.weight
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0
  }
}
