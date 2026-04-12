// src/modules/eval/layers/cross-phase-analyzer.ts
import type { EvalAssertion, EvalPhase } from '../types.js'

interface CrossPhaseDimension {
  name: 'reference-coverage' | 'contradiction-detection' | 'information-loss'
  /** Question the judge is being asked — must use the dimension's keyword in plain prose */
  question: (upstreamPhase: string, downstreamPhase: string) => string
  rubric: string[]
}

const DIMENSIONS: CrossPhaseDimension[] = [
  {
    name: 'reference-coverage',
    question: (up, down) =>
      `Does the ${down} output reference and build on key elements of the ${up} output — its main conclusions, decisions, and data points?`,
    rubric: [
      '- 1.0: Downstream clearly uses the upstream conclusions and data',
      '- 0.7: Most upstream elements are referenced; minor gaps',
      '- 0.4: Downstream only loosely connects to the upstream',
      '- 0.0: Downstream appears to ignore the upstream entirely',
    ],
  },
  {
    name: 'contradiction-detection',
    question: (up, down) =>
      `Does the ${down} output contradict any decisions, claims, or constraints made in the ${up} output? Score the absence of contradictions: 1.0 means no contradictions, lower means contradictions exist.`,
    rubric: [
      '- 1.0: No contradictions with upstream',
      '- 0.7: One minor inconsistency that does not change intent',
      '- 0.4: Multiple inconsistencies or one significant contradiction',
      '- 0.0: Downstream directly contradicts core upstream decisions',
    ],
  },
  {
    name: 'information-loss',
    question: (up, down) =>
      `Are there important details in the ${up} output that the ${down} output should have carried forward but lost? Score the absence of loss: 1.0 means nothing important was lost, lower for significant omissions.`,
    rubric: [
      '- 1.0: No important upstream details were lost',
      '- 0.7: Minor details were dropped without consequence',
      '- 0.4: Several important upstream details are missing downstream',
      '- 0.0: Critical upstream information was lost',
    ],
  },
]

export type CoherenceDimension = 'reference-coverage' | 'contradiction-detection' | 'information-loss'

export class CrossPhaseAnalyzer {
  buildAssertions(
    upstreamOutput: string,
    downstreamOutput: string,
    upstreamPhase: EvalPhase | string,
    downstreamPhase: EvalPhase | string,
    dimensionFilter?: CoherenceDimension[],
  ): EvalAssertion[] {
    if (!upstreamOutput.trim()) return []

    const dims = dimensionFilter
      ? DIMENSIONS.filter((d) => dimensionFilter.includes(d.name))
      : DIMENSIONS

    return dims.map((dim) => ({
      type: 'llm-rubric' as const,
      value: [
        `Evaluate the coherence of the ${downstreamPhase} output against the ${upstreamPhase} output on a single dimension: **${dim.name}**`,
        '',
        `**${upstreamPhase} output (upstream):**`,
        upstreamOutput.trim(),
        '',
        `**${downstreamPhase} output (downstream):**`,
        downstreamOutput.trim(),
        '',
        dim.question(String(upstreamPhase), String(downstreamPhase)),
        '',
        'Score on a 0-1 scale:',
        ...dim.rubric,
      ].join('\n'),
      label: `cross-phase:${dim.name}`,
    }))
  }
}
