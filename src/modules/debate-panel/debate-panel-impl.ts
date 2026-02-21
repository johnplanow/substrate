/**
 * DebatePanelImpl — concrete implementation of the DebatePanel interface.
 *
 * Orchestrates perspective generation via the dispatcher and aggregates results
 * using weighted confidence voting.
 *
 * Tiers:
 * - Routine: single perspective, auto-approved
 * - Significant: N perspectives (default 3), confidence-weighted vote, tie-break < 10%
 * - Architectural: 5 specialized perspectives, >60% supermajority required
 *
 * AC7: Persists finalized decisions to the decision store.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { Dispatcher } from '../agent-dispatch/types.js'
import { createDecision } from '../../persistence/queries/decisions.js'
import type { DebatePanel } from './debate-panel.js'
import type { DecisionRequest, DebateResult, Perspective, VotingRecord } from './types.js'

// ---------------------------------------------------------------------------
// Viewpoints for each tier
// ---------------------------------------------------------------------------

const SIGNIFICANT_VIEWPOINTS = ['simplicity', 'performance', 'maintainability']

const ARCHITECTURAL_VIEWPOINTS = [
  'security',
  'scalability',
  'developer-experience',
  'cost',
  'maintainability',
]

// Supermajority threshold (60%) for architectural decisions
const ARCHITECTURAL_SUPERMAJORITY = 0.6

// Tie-break threshold (10% margin) for significant decisions
const TIEBREAK_MARGIN_THRESHOLD = 0.1

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DebatePanelOptions {
  /** Dispatcher for spawning perspective-generation sub-agents */
  dispatcher: Dispatcher
  /** Optional database for decision persistence (AC7) */
  db?: BetterSqlite3Database
  /**
   * Optional function to generate a perspective from a viewpoint prompt.
   * Defaults to using the dispatcher with agent 'claude-code'.
   * Override in tests to inject mock perspectives.
   */
  perspectiveGenerator?: PerspectiveGeneratorFn
}

/**
 * Function that generates a Perspective given viewpoint and context.
 */
export type PerspectiveGeneratorFn = (
  viewpoint: string,
  question: string,
  context: string,
) => Promise<Perspective>

// ---------------------------------------------------------------------------
// Default perspective generator (uses dispatcher)
// ---------------------------------------------------------------------------

function buildPerspectivePrompt(viewpoint: string, question: string, context: string): string {
  return [
    `You are evaluating a decision from the perspective of ${viewpoint}.`,
    `Question: ${question}`,
    `Context: ${context}`,
    'Provide your analysis as YAML with fields: recommendation (string), confidence (number 0-1), risks (string[]).',
    '```yaml',
    'recommendation: <your recommendation>',
    'confidence: 0.8',
    'risks:',
    '  - <risk 1>',
    '```',
  ].join('\n')
}

function createDefaultPerspectiveGenerator(dispatcher: Dispatcher): PerspectiveGeneratorFn {
  return async (viewpoint: string, question: string, context: string): Promise<Perspective> => {
    const prompt = buildPerspectivePrompt(viewpoint, question, context)
    const handle = dispatcher.dispatch({
      prompt,
      agent: 'claude-code',
      taskType: 'perspective-generation',
    })
    const result = await handle.result

    // Parse the perspective from the dispatch result
    const parsed = result.parsed as Record<string, unknown> | null
    return {
      viewpoint,
      recommendation: String(parsed?.recommendation ?? 'No recommendation available'),
      confidence: Number(parsed?.confidence ?? 0.5),
      risks: Array.isArray(parsed?.risks) ? (parsed.risks as string[]) : [],
    }
  }
}

// ---------------------------------------------------------------------------
// Weighted voting helpers
// ---------------------------------------------------------------------------

/**
 * Compute confidence-weighted voting across perspectives.
 * Returns the winning recommendation, margin, and per-viewpoint weights.
 */
function computeWeightedVote(perspectives: Perspective[]): {
  winner: string
  margin: number
  votes: { viewpoint: string; weight: number }[]
} {
  // Accumulate confidence scores per recommendation
  const scores = new Map<string, number>()
  const votes: { viewpoint: string; weight: number }[] = []

  let totalConfidence = 0
  for (const p of perspectives) {
    const current = scores.get(p.recommendation) ?? 0
    scores.set(p.recommendation, current + p.confidence)
    votes.push({ viewpoint: p.viewpoint, weight: p.confidence })
    totalConfidence += p.confidence
  }

  // Sort by score descending
  const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1])
  const winner = ranked[0]?.[0] ?? ''
  const winnerScore = ranked[0]?.[1] ?? 0
  const runnerUpScore = ranked[1]?.[1] ?? 0

  const margin = totalConfidence > 0 ? (winnerScore - runnerUpScore) / totalConfidence : 1.0

  return { winner, margin, votes }
}

/**
 * Compute supermajority fraction: winner's confidence / total confidence.
 */
function computeSupermajority(perspectives: Perspective[], winner: string): number {
  let winnerScore = 0
  let totalScore = 0
  for (const p of perspectives) {
    totalScore += p.confidence
    if (p.recommendation === winner) {
      winnerScore += p.confidence
    }
  }
  return totalScore > 0 ? winnerScore / totalScore : 0
}

// ---------------------------------------------------------------------------
// DebatePanelImpl
// ---------------------------------------------------------------------------

export class DebatePanelImpl implements DebatePanel {
  private readonly _dispatcher: Dispatcher
  private readonly _db: BetterSqlite3Database | undefined
  private readonly _generatePerspective: PerspectiveGeneratorFn

  constructor(options: DebatePanelOptions) {
    this._dispatcher = options.dispatcher
    this._db = options.db
    this._generatePerspective =
      options.perspectiveGenerator ?? createDefaultPerspectiveGenerator(options.dispatcher)
  }

  async decide(request: DecisionRequest): Promise<DebateResult> {
    let result: DebateResult

    switch (request.tier) {
      case 'routine':
        result = await this._routineDecision(request)
        break
      case 'significant':
        result = await this._significantDecision(request)
        break
      case 'architectural':
        result = await this._architecturalDecision(request)
        break
      default: {
        const exhaustive: never = request.tier
        throw new Error(`Unknown decision tier: ${String(exhaustive)}`)
      }
    }

    // AC7: Persist decision to decision store
    if (this._db !== undefined) {
      const key =
        request.key ??
        request.question
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 64)
      const phase = request.phase ?? request.tier
      const rationale = JSON.stringify({
        perspectives: result.perspectives,
        votingRecord: result.votingRecord,
        tier: result.tier,
        escalated: result.escalated,
      })
      createDecision(this._db, {
        phase,
        category: 'debate-panel',
        key,
        value: result.decision,
        rationale,
        pipeline_run_id: request.pipelineRunId,
      })
    }

    return result
  }

  // ---------------------------------------------------------------------------
  // Routine tier
  // ---------------------------------------------------------------------------

  private async _routineDecision(request: DecisionRequest): Promise<DebateResult> {
    const perspective = await this._generatePerspective(
      'general',
      request.question,
      request.context,
    )

    return {
      decision: perspective.recommendation,
      rationale: `Routine decision: single perspective (auto-approved). Confidence: ${String(perspective.confidence)}`,
      tier: 'routine',
      perspectives: [perspective],
    }
  }

  // ---------------------------------------------------------------------------
  // Significant tier
  // ---------------------------------------------------------------------------

  private async _significantDecision(request: DecisionRequest): Promise<DebateResult> {
    const numPerspectives = request.perspectives ?? 3
    const viewpoints = SIGNIFICANT_VIEWPOINTS.slice(0, numPerspectives)

    // Dispatch all perspectives in parallel
    const perspectives = await Promise.all(
      viewpoints.map((vp) =>
        this._generatePerspective(vp, request.question, request.context),
      ),
    )

    return this._computeSignificantResult(request, perspectives)
  }

  private async _computeSignificantResult(
    request: DecisionRequest,
    perspectives: Perspective[],
  ): Promise<DebateResult> {
    const { winner, margin, votes } = computeWeightedVote(perspectives)

    let tieBreak = false
    let finalPerspectives = perspectives

    // Tie-break if margin < 10%
    if (margin < TIEBREAK_MARGIN_THRESHOLD) {
      tieBreak = true
      const tieBreakPerspective = await this._generatePerspective(
        'tie-break',
        request.question,
        request.context,
      )
      finalPerspectives = [...perspectives, tieBreakPerspective]
    }

    // Recompute after tie-break
    const final = computeWeightedVote(finalPerspectives)

    const votingRecord: VotingRecord = {
      votes,
      winner: final.winner,
      margin: final.margin,
      tieBreak,
    }

    const winnerPerspective = finalPerspectives.find((p) => p.recommendation === final.winner)
    const rationale = [
      `Significant decision: ${String(finalPerspectives.length)} perspectives, confidence-weighted vote.`,
      `Winner: ${final.winner} (margin: ${(final.margin * 100).toFixed(1)}%)`,
      winnerPerspective?.risks.length
        ? `Risks: ${winnerPerspective.risks.join('; ')}`
        : '',
    ]
      .filter(Boolean)
      .join(' ')

    return {
      decision: final.winner,
      rationale,
      tier: 'significant',
      perspectives: finalPerspectives,
      votingRecord,
    }
  }

  // ---------------------------------------------------------------------------
  // Architectural tier
  // ---------------------------------------------------------------------------

  private async _architecturalDecision(request: DecisionRequest): Promise<DebateResult> {
    const viewpoints = ARCHITECTURAL_VIEWPOINTS

    // Dispatch all 5 perspectives in parallel
    const perspectives = await Promise.all(
      viewpoints.map((vp) =>
        this._generatePerspective(vp, request.question, request.context),
      ),
    )

    const { winner, margin, votes } = computeWeightedVote(perspectives)
    const supermajority = computeSupermajority(perspectives, winner)

    const votingRecord: VotingRecord = {
      votes,
      winner,
      margin,
      tieBreak: false,
    }

    // Check supermajority
    if (supermajority <= ARCHITECTURAL_SUPERMAJORITY) {
      // Escalate to user — no supermajority achieved
      return {
        decision: winner,
        rationale: [
          `Architectural decision: 5 specialized perspectives. No supermajority achieved.`,
          `Highest vote: ${winner} (${(supermajority * 100).toFixed(1)}% of confidence, required >60%).`,
          'Escalated to user for final decision.',
        ].join(' '),
        tier: 'architectural',
        perspectives,
        votingRecord,
        escalated: true,
      }
    }

    const winnerPerspective = perspectives.find((p) => p.recommendation === winner)
    const rationale = [
      `Architectural decision: 5 specialized perspectives. Supermajority achieved (${(supermajority * 100).toFixed(1)}%).`,
      `Winner: ${winner}`,
      winnerPerspective?.risks.length
        ? `Risks: ${winnerPerspective.risks.join('; ')}`
        : '',
    ]
      .filter(Boolean)
      .join(' ')

    return {
      decision: winner,
      rationale,
      tier: 'architectural',
      perspectives,
      votingRecord,
      escalated: false,
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a new DebatePanel instance.
 */
export function createDebatePanel(options: DebatePanelOptions): DebatePanel {
  return new DebatePanelImpl(options)
}
