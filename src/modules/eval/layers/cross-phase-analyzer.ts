// src/modules/eval/layers/cross-phase-analyzer.ts
import type { EvalAssertion, EvalPhase } from '../types.js'

export class CrossPhaseAnalyzer {
  buildAssertions(
    upstreamOutput: string,
    downstreamOutput: string,
    upstreamPhase: EvalPhase | string,
    downstreamPhase: EvalPhase | string,
  ): EvalAssertion[] {
    if (!upstreamOutput.trim()) return []

    return [
      {
        type: 'llm-rubric',
        value: [
          `Evaluate whether the ${downstreamPhase} output demonstrates awareness of the ${upstreamPhase} output.`,
          '',
          `**${upstreamPhase} output (upstream):**`,
          upstreamOutput,
          '',
          `**${downstreamPhase} output (downstream):**`,
          downstreamOutput,
          '',
          'Score on three dimensions (equal weight):',
          '',
          '**reference coverage** — Does the downstream output reference or build on key elements from the upstream?',
          `Specifically: does the ${downstreamPhase} output use the ${upstreamPhase} output's main conclusions, decisions, and data points?`,
          '',
          '**contradiction detection** — Does the downstream output contradict any upstream decisions?',
          'Score 1.0 if no contradictions, lower if contradictions exist.',
          '',
          '**information loss** — Are there key details in the upstream that the downstream should have incorporated but dropped?',
          'Score 1.0 if nothing important was lost, lower for significant omissions.',
          '',
          'Return the average of the three dimension scores (0-1 scale).',
        ].join('\n'),
        label: 'cross-phase-coherence',
      },
    ]
  }
}
