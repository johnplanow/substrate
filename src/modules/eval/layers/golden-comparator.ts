// src/modules/eval/layers/golden-comparator.ts
import type { EvalAssertion, EvalPhase } from '../types.js'

export class GoldenComparator {
  buildAssertions(goldenExample: string, phase: EvalPhase | string): EvalAssertion[] {
    if (!goldenExample.trim()) return []

    return [
      {
        type: 'llm-rubric',
        value: [
          `Compare the output against this reference output for the ${phase} phase.`,
          'The reference represents a high-quality example — the output does NOT need to match it exactly,',
          'but should demonstrate equivalent quality.',
          '',
          '**Reference output:**',
          goldenExample,
          '',
          'Score on three dimensions (equal weight):',
          '- **completeness**: Does the output cover the same breadth of topics as the reference?',
          '- **depth**: Is each section as detailed and specific as the reference?',
          '- **accuracy**: Are the claims and reasoning as sound as the reference?',
          '',
          'Return the average of the three dimension scores (0-1 scale).',
          '- 1.0: Equivalent or better than the reference on all dimensions',
          '- 0.7: Close to reference quality with minor gaps',
          '- 0.4: Noticeably weaker than the reference',
          '- 0.0: Far below reference quality',
        ].join('\n'),
        label: 'golden-comparison',
      },
    ]
  }
}
