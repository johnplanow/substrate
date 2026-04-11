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

export class RubricScorer {
  buildAssertions(rubric: Rubric): EvalAssertion[] {
    if (rubric.dimensions.length === 0) return []

    return rubric.dimensions.map((dim) => ({
      type: 'llm-rubric' as const,
      value: [
        `Evaluate this output on a single dimension: **${dim.name}**`,
        '',
        dim.prompt,
        '',
        'Score on a 0-1 scale:',
        '- 1.0: Excellent on this dimension',
        '- 0.7: Good with minor issues',
        '- 0.4: Below expectations',
        '- 0.0: This dimension is not addressed at all',
      ].join('\n'),
      label: `rubric:${dim.name}`,
    }))
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
