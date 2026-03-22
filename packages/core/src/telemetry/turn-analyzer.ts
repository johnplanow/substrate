/**
 * TurnAnalyzer — computes per-turn token breakdowns from normalized spans.
 *
 * Takes a list of NormalizedSpan records and produces TurnAnalysis[], where
 * each entry represents a root-level span (an agent "turn") with:
 *   - Chronological ordering (by startTime)
 *   - Sequential turnNumber assignment (1-N)
 *   - freshTokens, cacheHitRate, contextSize, contextDelta metrics
 *   - childSpans drill-down (tool calls within the turn)
 *   - isContextSpike detection (inputTokens > 2× average)
 *
 * Architecture constraints:
 *   - Constructor injection: accepts ILogger via constructor (defaults to console)
 *   - No external dependencies beyond types from this module
 *   - Zero LLM calls — pure statistical computation
 *
 * Migrated to @substrate-ai/core in story 41-6b.
 */

import type { ILogger } from '../dispatch/types.js'
import type { NormalizedSpan, TurnAnalysis, ChildSpanSummary } from './types.js'
import type { ITurnAnalyzer } from './telemetry-pipeline.js'

// ---------------------------------------------------------------------------
// TurnAnalyzer
// ---------------------------------------------------------------------------

export class TurnAnalyzer implements ITurnAnalyzer {
  private readonly _logger: ILogger

  constructor(logger?: ILogger) {
    this._logger = logger ?? console
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Analyze a list of NormalizedSpan records and produce TurnAnalysis[].
   *
   * Returns an empty array immediately when spans is empty.
   *
   * @param spans - All spans for a story (root and child spans mixed)
   */
  analyze(spans: NormalizedSpan[]): TurnAnalysis[] {
    if (spans.length === 0) {
      return []
    }

    // Build set of all spanIds for root-span identification
    const allSpanIds = new Set(spans.map((s) => s.spanId))

    // Separate root spans from child spans
    const rootSpans = spans.filter((s) => !s.parentSpanId || !allSpanIds.has(s.parentSpanId))

    // Sort root spans chronologically
    const ordered = [...rootSpans].sort((a, b) => a.startTime - b.startTime)

    // Build child span index: parentSpanId → child spans
    const childIndex = new Map<string, NormalizedSpan[]>()
    for (const span of spans) {
      if (span.parentSpanId && allSpanIds.has(span.parentSpanId)) {
        const children = childIndex.get(span.parentSpanId) ?? []
        children.push(span)
        childIndex.set(span.parentSpanId, children)
      }
    }

    // First pass: build turns with metrics (context accumulation)
    let runningContext = 0
    const turns: TurnAnalysis[] = ordered.map((span, idx) => {
      const prevContext = runningContext
      runningContext += span.inputTokens

      const freshTokens = span.inputTokens - span.cacheReadTokens
      const cacheHitRate = span.inputTokens > 0 ? span.cacheReadTokens / span.inputTokens : 0

      const childSpanSummaries: ChildSpanSummary[] = (childIndex.get(span.spanId) ?? []).map(
        (child): ChildSpanSummary => ({
          spanId: child.spanId,
          name: child.name,
          toolName: child.attributes?.['tool.name'] as string | undefined,
          inputTokens: child.inputTokens,
          outputTokens: child.outputTokens,
          durationMs: child.durationMs,
        }),
      )

      return {
        spanId: span.spanId,
        turnNumber: idx + 1,
        name: span.name,
        timestamp: span.startTime,
        source: span.source,
        model: span.model,
        inputTokens: span.inputTokens,
        outputTokens: span.outputTokens,
        cacheReadTokens: span.cacheReadTokens,
        freshTokens,
        cacheHitRate,
        costUsd: span.costUsd,
        durationMs: span.durationMs,
        contextSize: runningContext,
        contextDelta: runningContext - prevContext,
        toolName: span.attributes?.['tool.name'] as string | undefined,
        isContextSpike: false, // will be set in second pass
        childSpans: childSpanSummaries,
      }
    })

    // Second pass: spike detection
    const avg = turns.reduce((sum, t) => sum + t.inputTokens, 0) / turns.length
    for (const turn of turns) {
      turn.isContextSpike = avg > 0 && turn.inputTokens > 2 * avg
    }

    this._logger.debug({ turnCount: turns.length, avg }, 'TurnAnalyzer.analyze complete')

    return turns
  }
}
