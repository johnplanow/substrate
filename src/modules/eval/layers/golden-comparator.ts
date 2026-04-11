// src/modules/eval/layers/golden-comparator.ts
import type { EvalAssertion, EvalPhase } from '../types.js'

interface GoldenDimension {
  name: 'completeness' | 'depth' | 'accuracy'
  question: string
  rubric: string[]
}

const DIMENSIONS: GoldenDimension[] = [
  {
    name: 'completeness',
    question:
      'Does the output cover the same breadth of topics and requirements as the reference?',
    rubric: [
      '- 1.0: Covers every topic the reference covers, no meaningful gaps',
      '- 0.7: Covers the main topics with minor omissions',
      '- 0.4: Missing several topics the reference includes',
      '- 0.0: Substantially narrower scope than the reference',
    ],
  },
  {
    name: 'depth',
    question:
      'Is each section as detailed and specific as the reference, or is the output more shallow?',
    rubric: [
      '- 1.0: Matches the reference in specificity and detail on every section',
      '- 0.7: Slightly less detailed than the reference in a few places',
      '- 0.4: Noticeably more shallow than the reference across most sections',
      '- 0.0: Surface-level where the reference is substantive',
    ],
  },
  {
    name: 'accuracy',
    question:
      'Are the claims, reasoning, and facts in the output as sound as those in the reference?',
    rubric: [
      '- 1.0: Claims and reasoning are as sound as the reference',
      '- 0.7: Minor inaccuracies or weaker reasoning in a few places',
      '- 0.4: Several unsound claims or weak reasoning',
      '- 0.0: Fundamental inaccuracies or broken reasoning',
    ],
  },
]

export class GoldenComparator {
  buildAssertions(goldenExample: string, phase: EvalPhase | string): EvalAssertion[] {
    if (!goldenExample.trim()) return []

    return DIMENSIONS.map((dim) => ({
      type: 'llm-rubric' as const,
      value: [
        `Evaluate the ${phase} output against the reference example on a single dimension: **${dim.name}**`,
        'The reference represents a high-quality example — the output does NOT need to match it exactly,',
        'but should demonstrate equivalent quality on this one dimension.',
        '',
        '**Reference output:**',
        goldenExample.trim(),
        '',
        dim.question,
        '',
        'Score on a 0-1 scale:',
        ...dim.rubric,
      ].join('\n'),
      label: `golden:${dim.name}`,
    }))
  }
}
