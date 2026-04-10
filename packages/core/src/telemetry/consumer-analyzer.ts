/**
 * ConsumerAnalyzer — groups telemetry spans by consumer key and ranks by token
 * consumption, producing ConsumerStats for each unique operation+tool combination.
 *
 * A "consumer key" is `operationName|toolName`, stable across runs and safe to
 * store as a VARCHAR(300) primary-key component in Dolt.
 *
 * Architecture constraints:
 *   - Constructor injection: accepts Categorizer and ILogger (logger defaults to console)
 *   - Delegates classification to the injected Categorizer
 *   - Zero external dependencies beyond types and Categorizer from this module
 *
 * Migrated to @substrate-ai/core in story 41-6b.
 */

import type { ILogger } from '../dispatch/types.js'
import type { NormalizedSpan, ConsumerStats, TopInvocation, TurnAnalysis } from './types.js'
import type { IConsumerAnalyzer } from './telemetry-pipeline.js'
import type { Categorizer } from './categorizer.js'

// ---------------------------------------------------------------------------
// ConsumerAnalyzer
// ---------------------------------------------------------------------------

export class ConsumerAnalyzer implements IConsumerAnalyzer {
  private readonly _categorizer: Categorizer
  private readonly _logger: ILogger

  constructor(categorizer: Categorizer, logger?: ILogger) {
    this._categorizer = categorizer
    this._logger = logger ?? console
  }

  // ---------------------------------------------------------------------------
  // analyze
  // ---------------------------------------------------------------------------

  /**
   * Group spans by consumer key, rank by totalTokens descending, and return
   * ConsumerStats for each non-zero-token group.
   *
   * @param spans - All NormalizedSpans for the story
   */
  analyze(spans: NormalizedSpan[]): ConsumerStats[] {
    if (spans.length === 0) return []

    const grandTotal = spans.reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0)

    // Group spans by consumerKey
    const groups = new Map<string, NormalizedSpan[]>()
    for (const span of spans) {
      const key = this._buildConsumerKey(span)
      const existing = groups.get(key)
      if (existing !== undefined) {
        existing.push(span)
      } else {
        groups.set(key, [span])
      }
    }

    const results: ConsumerStats[] = []

    for (const [consumerKey, groupSpans] of groups) {
      const totalTokens = groupSpans.reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0)

      // Exclude zero-token groups
      if (totalTokens === 0) continue

      const percentage =
        grandTotal > 0 ? Math.round((totalTokens / grandTotal) * 100 * 1000) / 1000 : 0
      const eventCount = groupSpans.length

      // Determine category using the first span's operation + tool name
      const firstSpan = groupSpans[0]!
      const toolName = this._extractToolName(firstSpan)
      const operationName = firstSpan.operationName ?? firstSpan.name ?? 'unknown'
      const category = this._categorizer.classify(operationName, toolName)

      // Top 20 invocations sorted by totalTokens descending
      const sorted = groupSpans
        .slice()
        .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))

      const topInvocations: TopInvocation[] = sorted.slice(0, 20).map((s) => ({
        spanId: s.spanId,
        name: s.name,
        toolName: this._extractToolName(s),
        totalTokens: s.inputTokens + s.outputTokens,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
      }))

      results.push({
        consumerKey,
        category,
        totalTokens,
        percentage,
        eventCount,
        topInvocations,
      })
    }

    this._logger.debug({ consumers: results.length, grandTotal }, 'Computed consumer stats')

    return results.sort((a, b) => b.totalTokens - a.totalTokens)
  }

  // ---------------------------------------------------------------------------
  // analyzeFromTurns
  // ---------------------------------------------------------------------------

  /**
   * Group turns by consumer key (model|toolName), rank by totalTokens descending,
   * and return ConsumerStats for each non-zero-token group.
   *
   * @param turns - All TurnAnalysis records for the story
   */
  analyzeFromTurns(turns: TurnAnalysis[]): ConsumerStats[] {
    if (turns.length === 0) return []

    const grandTotal = turns.reduce((sum, t) => sum + t.inputTokens + t.outputTokens, 0)

    // Group turns by consumerKey (model|toolName)
    const groups = new Map<string, TurnAnalysis[]>()
    for (const turn of turns) {
      const key = this._buildConsumerKeyFromTurn(turn)
      const existing = groups.get(key)
      if (existing !== undefined) {
        existing.push(turn)
      } else {
        groups.set(key, [turn])
      }
    }

    const results: ConsumerStats[] = []

    for (const [consumerKey, groupTurns] of groups) {
      const totalTokens = groupTurns.reduce((sum, t) => sum + t.inputTokens + t.outputTokens, 0)

      // Exclude zero-token groups
      if (totalTokens === 0) continue

      const percentage =
        grandTotal > 0 ? Math.round((totalTokens / grandTotal) * 100 * 1000) / 1000 : 0
      const eventCount = groupTurns.length

      // Determine category using the first turn's name + toolName
      const firstTurn = groupTurns[0]!
      const category = this._categorizer.classify(firstTurn.name, firstTurn.toolName)

      // Top 20 invocations sorted by totalTokens descending
      const sorted = groupTurns
        .slice()
        .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))

      const topInvocations: TopInvocation[] = sorted.slice(0, 20).map((t) => ({
        spanId: t.spanId,
        name: t.name,
        toolName: t.toolName,
        totalTokens: t.inputTokens + t.outputTokens,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
      }))

      results.push({
        consumerKey,
        category,
        totalTokens,
        percentage,
        eventCount,
        topInvocations,
      })
    }

    this._logger.debug(
      { consumers: results.length, grandTotal },
      'Computed consumer stats from turns'
    )

    return results.sort((a, b) => b.totalTokens - a.totalTokens)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a stable, collision-resistant consumer key from a span.
   * Format: `operationName|toolName` (tool part is empty string if absent).
   */
  private _buildConsumerKey(span: NormalizedSpan): string {
    const operationPart = (span.operationName ?? span.name ?? 'unknown').slice(0, 200)
    const toolPart = (this._extractToolName(span) ?? '').slice(0, 100)
    return `${operationPart}|${toolPart}`
  }

  /**
   * Build a stable consumer key from a turn.
   * Format: `model|toolName` (tool part is empty string if absent).
   */
  private _buildConsumerKeyFromTurn(turn: TurnAnalysis): string {
    const modelPart = (turn.model ?? 'unknown').slice(0, 200)
    const toolPart = (turn.toolName ?? '').slice(0, 100)
    return `${modelPart}|${toolPart}`
  }

  /**
   * Extract a tool name from span attributes, checking three known attribute keys
   * in priority order.
   */
  private _extractToolName(span: NormalizedSpan): string | undefined {
    if (!span.attributes) return undefined
    const attrs = span.attributes
    const name =
      (attrs['tool.name'] as string | undefined) ||
      (attrs['llm.tool.name'] as string | undefined) ||
      (attrs['claude.tool_name'] as string | undefined)
    return name || undefined
  }
}
