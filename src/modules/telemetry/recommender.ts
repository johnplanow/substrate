/**
 * Recommender — analyzes telemetry context and generates actionable recommendations.
 *
 * Implements 8 rules across three categories:
 *   - Consumer rules: biggest_consumers, large_file_reads, expensive_bash, repeated_tool_calls
 *   - Context/trend rules: context_growth_spike, growing_categories
 *   - Efficiency rules: cache_efficiency, per_model_comparison
 *
 * Architecture constraints:
 *   - Pure analysis service — no DB access; caller assembles RecommenderContext
 *   - Constructor injection: accepts pino.Logger only
 *   - No Math.random() or Date.now() — all timestamps injected via context.generatedAt
 *   - ID generation: sha256(ruleId:storyKey:actionTarget:index) via node:crypto
 */

import { createHash } from 'node:crypto'

import type pino from 'pino'

import type {
  Recommendation,
  RecommenderContext,
  IRecommender,
  RuleId,
  RecommendationSeverity,
  NormalizedSpan,
  TurnAnalysis,
} from './types.js'

// ---------------------------------------------------------------------------
// Recommender
// ---------------------------------------------------------------------------

export class Recommender implements IRecommender {
  private readonly _logger: pino.Logger

  constructor(logger: pino.Logger) {
    this._logger = logger
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run all 8 rules against the given context and return sorted recommendations.
   * Output is sorted: critical → warning → info, then by potentialSavingsTokens descending.
   * No Date.now() or Math.random() is called — generatedAt comes from context.
   */
  analyze(context: RecommenderContext): Recommendation[] {
    const allRecs: Recommendation[] = [
      ...this._runBiggestConsumers(context),
      ...this._runExpensiveBash(context),
      ...this._runLargeFileReads(context),
      ...this._runRepeatedToolCalls(context),
      ...this._runContextGrowthSpikes(context),
      ...this._runGrowingCategories(context),
      ...this._runCacheEfficiency(context),
      ...this._runModelComparison(context),
      ...this._runCacheDeltaRegression(context),
    ]

    // Sort: critical first, then warning, then info; within tier by potentialSavingsTokens desc
    const severityOrder: Record<RecommendationSeverity, number> = {
      critical: 0,
      warning: 1,
      info: 2,
    }

    return allRecs.sort((a, b) => {
      const sA = severityOrder[a.severity]
      const sB = severityOrder[b.severity]
      if (sA !== sB) return sA - sB
      const savA = a.potentialSavingsTokens ?? 0
      const savB = b.potentialSavingsTokens ?? 0
      return savB - savA
    })
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Generate a 16-char hex ID from the sha256 of `ruleId:storyKey:actionTarget:index`.
   */
  private _makeId(ruleId: RuleId, storyKey: string, actionTarget: string, index: number): string {
    return createHash('sha256')
      .update(`${ruleId}:${storyKey}:${actionTarget}:${index}`)
      .digest('hex')
      .slice(0, 16)
  }

  /**
   * Map a token percentage to a severity level.
   * >25% → critical, >10% → warning, ≤10% → info.
   */
  private _assignSeverity(tokenPercent: number): RecommendationSeverity {
    if (tokenPercent > 25) return 'critical'
    if (tokenPercent > 10) return 'warning'
    return 'info'
  }

  /**
   * Compute total tokens across all spans. Guards against empty arrays.
   */
  private _totalSpanTokens(spans: NormalizedSpan[]): number {
    return spans.reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0)
  }

  // ---------------------------------------------------------------------------
  // Rule: biggest_consumers
  // ---------------------------------------------------------------------------

  /**
   * Minimum absolute token count for a consumer to be flagged.
   * Below this, the consumer is too small to be actionable regardless of percentage.
   */
  private static readonly MIN_SIGNIFICANT_TOKENS = 10_000

  /**
   * Identify top 3 token consumers (by inputTokens + outputTokens) where pct >5%
   * AND absolute tokens exceed MIN_SIGNIFICANT_TOKENS.
   *
   * Filters out model-only consumers (empty toolName, format "model|") since those
   * just indicate which model ran — not an actionable optimization target.
   *
   * Severity factors both percentage share and absolute magnitude:
   *   - percentage-based tier via _assignSeverity()
   *   - capped at 'warning' when absolute tokens < 50,000
   *   - capped at 'info' when absolute tokens < 20,000
   */
  private _runBiggestConsumers(ctx: RecommenderContext): Recommendation[] {
    const { consumers, storyKey, sprintId, generatedAt } = ctx

    if (consumers.length === 0) return []

    const grandTotal = consumers.reduce((sum, c) => sum + c.totalTokens, 0)
    if (grandTotal === 0) return []

    const sorted = [...consumers].sort((a, b) => b.totalTokens - a.totalTokens)
    const top3 = sorted.slice(0, 3).filter((c) => {
      // Must exceed both percentage and absolute thresholds
      if (c.percentage <= 5) return false
      if (c.totalTokens < Recommender.MIN_SIGNIFICANT_TOKENS) return false
      // Filter out model-only consumers (format: "operationName|" with empty toolName)
      // These just identify which model ran, not an actionable operation
      if (c.consumerKey.endsWith('|') && !c.consumerKey.includes('|', 0)) return false
      const parts = c.consumerKey.split('|')
      if (parts.length === 2 && parts[1] === '') return false
      return true
    })

    return top3.map((consumer, index) => {
      const pct = consumer.percentage
      let severity = this._assignSeverity(pct)
      // Cap severity based on absolute token magnitude
      if (consumer.totalTokens < 20_000 && severity !== 'info') severity = 'info'
      else if (consumer.totalTokens < 50_000 && severity === 'critical') severity = 'warning'
      const actionTarget = consumer.consumerKey
      const id = this._makeId('biggest_consumers', storyKey, actionTarget, index)

      return {
        id,
        storyKey,
        sprintId,
        ruleId: 'biggest_consumers' as RuleId,
        severity,
        title: `High token consumer: ${consumer.consumerKey}`,
        description: `"${consumer.consumerKey}" consumed ${consumer.totalTokens.toLocaleString()} tokens (${pct.toFixed(1)}% of total). Consider reducing the frequency or size of this operation.`,
        potentialSavingsTokens: Math.round(consumer.totalTokens * 0.3),
        actionTarget,
        generatedAt,
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Rule: large_file_reads
  // ---------------------------------------------------------------------------

  /**
   * Flag file-read spans with inputTokens > 3000.
   * Suggest using line ranges to reduce token count.
   */
  private _runLargeFileReads(ctx: RecommenderContext): Recommendation[] {
    const { allSpans, storyKey, sprintId, generatedAt } = ctx
    if (allSpans.length === 0) return []

    const grandTotal = this._totalSpanTokens(allSpans)
    const largReads = allSpans.filter(
      (s) => s.operationName === 'file_read' && s.inputTokens > 3000,
    )

    return largReads.map((span, index) => {
      const pct = grandTotal > 0 ? ((span.inputTokens + span.outputTokens) / grandTotal) * 100 : 0
      const severity = this._assignSeverity(pct)
      const actionTarget = span.attributes?.['file.path'] as string | undefined ?? span.name
      const id = this._makeId('large_file_reads', storyKey, actionTarget, index)

      return {
        id,
        storyKey,
        sprintId,
        ruleId: 'large_file_reads' as RuleId,
        severity,
        title: `Large file read: ${actionTarget}`,
        description: `File read of "${actionTarget}" consumed ${span.inputTokens.toLocaleString()} input tokens. Consider specifying line ranges (e.g., offset/limit) to reduce context size.`,
        potentialSavingsTokens: Math.round(span.inputTokens * 0.5),
        actionTarget,
        generatedAt,
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Rule: expensive_bash
  // ---------------------------------------------------------------------------

  /**
   * Flag bash/execute_command spans with outputTokens > 3000.
   * Suggest filtering or truncating command output.
   */
  private _runExpensiveBash(ctx: RecommenderContext): Recommendation[] {
    const { allSpans, storyKey, sprintId, generatedAt } = ctx
    if (allSpans.length === 0) return []

    const grandTotal = this._totalSpanTokens(allSpans)
    const expensiveBash = allSpans.filter(
      (s) =>
        (s.attributes?.['tool.name'] === 'bash' ||
          s.attributes?.['tool.name'] === 'execute_command' ||
          s.name === 'bash' ||
          s.name === 'execute_command' ||
          (s.operationName !== undefined &&
            (s.operationName === 'bash' || s.operationName === 'execute_command'))) &&
        s.outputTokens > 3000,
    )

    return expensiveBash.map((span, index) => {
      const pct = grandTotal > 0 ? ((span.inputTokens + span.outputTokens) / grandTotal) * 100 : 0
      const severity = this._assignSeverity(pct)
      const actionTarget = (span.attributes?.['bash.command'] as string | undefined)
        ?? span.name
        ?? 'bash'
      const id = this._makeId('expensive_bash', storyKey, actionTarget, index)

      return {
        id,
        storyKey,
        sprintId,
        ruleId: 'expensive_bash' as RuleId,
        severity,
        title: `Expensive bash output: ${actionTarget}`,
        description: `Bash command "${actionTarget}" produced ${span.outputTokens.toLocaleString()} output tokens. Consider filtering output (e.g., piping to head/grep) to reduce token consumption.`,
        potentialSavingsTokens: Math.round(span.outputTokens * 0.5),
        actionTarget,
        generatedAt,
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Rule: repeated_tool_calls
  // ---------------------------------------------------------------------------

  /**
   * Detect tool calls with the same actionTarget appearing more than once.
   * Suggests caching the result to avoid redundant token consumption.
   */
  private _runRepeatedToolCalls(ctx: RecommenderContext): Recommendation[] {
    const { turns, storyKey, sprintId, generatedAt, allSpans } = ctx

    // Collect all child spans from turns plus allSpans as fallback
    const allChildSpans: Array<{ toolName?: string; name: string; actionTarget?: string }> = []

    for (const turn of turns) {
      for (const child of turn.childSpans) {
        allChildSpans.push({
          toolName: child.toolName,
          name: child.name,
        })
      }
    }

    // Also include allSpans if turns childSpans are empty
    if (allChildSpans.length === 0 && allSpans.length > 0) {
      for (const span of allSpans) {
        allChildSpans.push({
          toolName: span.attributes?.['tool.name'] as string | undefined,
          name: span.name,
          actionTarget: span.attributes?.['file.path'] as string | undefined,
        })
      }
    }

    // Group by toolName:actionTarget
    const groups = new Map<string, number>()
    for (const span of allChildSpans) {
      const key = `${span.toolName ?? ''}:${span.actionTarget ?? span.name}`
      groups.set(key, (groups.get(key) ?? 0) + 1)
    }

    const recommendations: Recommendation[] = []
    let index = 0
    for (const [key, count] of groups) {
      if (count > 1) {
        const id = this._makeId('repeated_tool_calls', storyKey, key, index)
        recommendations.push({
          id,
          storyKey,
          sprintId,
          ruleId: 'repeated_tool_calls' as RuleId,
          severity: 'warning',
          title: `Repeated tool call: ${key}`,
          description: `"${key}" was invoked ${count} times. Consider caching the result after the first call to avoid redundant token consumption.`,
          actionTarget: key,
          generatedAt,
        })
        index++
      }
    }

    return recommendations
  }

  // ---------------------------------------------------------------------------
  // Rule: context_growth_spike
  // ---------------------------------------------------------------------------

  /**
   * Flag turns where isContextSpike is true.
   * Severity is always at least 'warning'.
   */
  private _runContextGrowthSpikes(ctx: RecommenderContext): Recommendation[] {
    const { turns, storyKey, sprintId, generatedAt, allSpans } = ctx
    if (turns.length === 0) return []

    const grandTotal = this._totalSpanTokens(allSpans)
    const spiketurns = turns.filter((t) => t.isContextSpike)

    return spiketurns.map((turn, index) => {
      const pct = grandTotal > 0 ? ((turn.inputTokens + turn.outputTokens) / grandTotal) * 100 : 0
      // context_growth_spike is always at least 'warning'
      const baseSeverity = this._assignSeverity(pct)
      const severity: RecommendationSeverity =
        baseSeverity === 'info' ? 'warning' : baseSeverity

      // Sort child spans by token consumption, take top 3
      const topContributors = [...turn.childSpans]
        .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
        .slice(0, 3)
        .map((c) => c.name)

      const actionTarget = `turn:${turn.turnNumber}`
      const id = this._makeId('context_growth_spike', storyKey, actionTarget, index)

      return {
        id,
        storyKey,
        sprintId,
        ruleId: 'context_growth_spike' as RuleId,
        severity,
        title: `Context spike at turn ${turn.turnNumber}`,
        description: `Turn ${turn.turnNumber} had a context spike with ${turn.inputTokens.toLocaleString()} input tokens. Top contributors: ${topContributors.length > 0 ? topContributors.join(', ') : 'none identified'}. Consider compressing or evicting context before this turn.`,
        potentialSavingsTokens: Math.round(turn.contextDelta * 0.3),
        actionTarget,
        generatedAt,
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Rule: growing_categories
  // ---------------------------------------------------------------------------

  /**
   * Flag semantic categories with trend === 'growing'.
   * Severity is 'info' by default; 'warning' if percentage > 25%.
   */
  private _runGrowingCategories(ctx: RecommenderContext): Recommendation[] {
    const { categories, storyKey, sprintId, generatedAt } = ctx
    if (categories.length === 0) return []

    const growing = categories.filter((c) => c.trend === 'growing')

    return growing.map((cat, index) => {
      // growing_categories: floor is 'info'; only 'warning' if pct > 25
      const severity: RecommendationSeverity = cat.percentage > 25 ? 'warning' : 'info'
      const actionTarget = cat.category
      const id = this._makeId('growing_categories', storyKey, actionTarget, index)

      return {
        id,
        storyKey,
        sprintId,
        ruleId: 'growing_categories' as RuleId,
        severity,
        title: `Growing category: ${cat.category}`,
        description: `The "${cat.category}" category is growing across turns, currently at ${cat.percentage.toFixed(1)}% of total tokens (${cat.totalTokens.toLocaleString()} tokens). This trend suggests increasing context pressure from this source.`,
        potentialSavingsTokens: Math.round(cat.totalTokens * 0.2),
        actionTarget,
        generatedAt,
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Rule: cache_efficiency
  // ---------------------------------------------------------------------------

  /**
   * If cache hit rate < 30%, flag the worst-performing operations and compute
   * potential savings as totalCacheMissTokens * 0.5.
   */
  private _runCacheEfficiency(ctx: RecommenderContext): Recommendation[] {
    const { efficiencyScore, allSpans, storyKey, sprintId, generatedAt } = ctx

    // Guard against NaN cache hit rate — treat as 0
    const cacheHitRate = isNaN(efficiencyScore.avgCacheHitRate)
      ? 0
      : efficiencyScore.avgCacheHitRate

    if (cacheHitRate >= 0.3) return []
    if (allSpans.length === 0) return []

    // Compute total cache-miss tokens across all spans
    const totalCacheMissTokens = allSpans.reduce((sum, s) => {
      const missTokens = s.inputTokens - s.cacheReadTokens
      return sum + Math.max(0, missTokens)
    }, 0)

    if (totalCacheMissTokens === 0) return []

    const potentialSavingsTokens = Math.round(totalCacheMissTokens * 0.5)

    // Find top 3 worst spans by individual cache hit rate
    const spansWithRate = allSpans
      .filter((s) => s.inputTokens > 0)
      .map((s) => ({
        span: s,
        hitRate: s.cacheReadTokens / s.inputTokens,
      }))
      .sort((a, b) => a.hitRate - b.hitRate)
      .slice(0, 3)

    const worstOps = spansWithRate.map((e) => e.span.name).join(', ')
    const actionTarget = worstOps || 'unknown'

    const id = this._makeId('cache_efficiency', storyKey, actionTarget, 0)

    this._logger.debug(
      { storyKey, cacheHitRate, potentialSavingsTokens },
      'cache_efficiency recommendation generated',
    )

    return [
      {
        id,
        storyKey,
        sprintId,
        ruleId: 'cache_efficiency' as RuleId,
        severity: 'warning',
        title: 'Low cache hit rate',
        description: `Overall cache hit rate is ${(cacheHitRate * 100).toFixed(1)}% (below 30% threshold). Worst performing operations: ${worstOps || 'none identified'}. Potential savings if hit rate reached 50%: ${potentialSavingsTokens.toLocaleString()} tokens.`,
        potentialSavingsTokens,
        actionTarget,
        generatedAt,
      },
    ]
  }

  // ---------------------------------------------------------------------------
  // Rule: per_model_comparison
  // ---------------------------------------------------------------------------

  /**
   * If more than one model is present, flag the underperforming model.
   * Severity is 'info' by default; 'warning' if cache efficiency gap > 20pp.
   */
  private _runModelComparison(ctx: RecommenderContext): Recommendation[] {
    const { efficiencyScore, storyKey, sprintId, generatedAt } = ctx

    const models = efficiencyScore.perModelBreakdown
    if (models.length <= 1) return []

    // Find best and worst by cache hit rate
    const sorted = [...models].sort((a, b) => b.cacheHitRate - a.cacheHitRate)
    const best = sorted[0]!
    const worst = sorted[sorted.length - 1]!

    // Don't compare a model to itself
    if (best.model === worst.model) return []

    const gapPP = (best.cacheHitRate - worst.cacheHitRate) * 100
    const severity: RecommendationSeverity = gapPP > 20 ? 'warning' : 'info'

    const actionTarget = worst.model
    const id = this._makeId('per_model_comparison', storyKey, actionTarget, 0)

    return [
      {
        id,
        storyKey,
        sprintId,
        ruleId: 'per_model_comparison' as RuleId,
        severity,
        title: `Underperforming model: ${worst.model}`,
        description: `Model "${worst.model}" has a cache hit rate of ${(worst.cacheHitRate * 100).toFixed(1)}% vs. "${best.model}" at ${(best.cacheHitRate * 100).toFixed(1)}% (gap: ${gapPP.toFixed(1)} percentage points). Consider routing tasks to the higher-performing model.`,
        actionTarget,
        generatedAt,
      },
    ]
  }

  // ---------------------------------------------------------------------------
  // Rule: cache_delta_regression
  // ---------------------------------------------------------------------------

  /**
   * Detect significant cache hit rate drops between consecutive dispatches.
   * >30pp drop → warning; >50pp drop → critical.
   * Requires dispatchScores with at least 2 entries; otherwise returns [].
   */
  private _runCacheDeltaRegression(ctx: RecommenderContext): Recommendation[] {
    const { dispatchScores, storyKey, sprintId, generatedAt } = ctx
    if (dispatchScores === undefined || dispatchScores.length < 2) return []

    // Sort chronologically — dispatch timestamps are set sequentially in pipeline
    const sorted = [...dispatchScores].sort((a, b) => a.timestamp - b.timestamp)

    const recs: Recommendation[] = []
    for (let i = 0; i < sorted.length - 1; i++) {
      const prev = sorted[i]!
      const curr = sorted[i + 1]!
      const deltaPP = (prev.avgCacheHitRate - curr.avgCacheHitRate) * 100
      if (deltaPP <= 30) continue

      const severity: RecommendationSeverity = deltaPP > 50 ? 'critical' : 'warning'
      const prevId = prev.dispatchId ?? `dispatch-${i}`
      const currId = curr.dispatchId ?? `dispatch-${i + 1}`
      const pairKey = `${prevId}→${currId}`
      const id = this._makeId('cache_delta_regression', storyKey, pairKey, i)

      recs.push({
        id,
        storyKey,
        sprintId,
        ruleId: 'cache_delta_regression' as RuleId,
        severity,
        title: `Cache regression between dispatches: ${pairKey}`,
        description: `Cache hit rate dropped ${deltaPP.toFixed(1)} percentage points between dispatch "${prevId}" (${(prev.avgCacheHitRate * 100).toFixed(1)}%) and "${currId}" (${(curr.avgCacheHitRate * 100).toFixed(1)}%). This likely indicates a prompt prefix change broke cache alignment. Investigate whether the system prompt or context prefix was restructured between these dispatches.`,
        actionTarget: pairKey,
        generatedAt,
      })
    }
    return recs
  }

  // ---------------------------------------------------------------------------
  // Internal rule helpers (type narrowing)
  // ---------------------------------------------------------------------------

  private _isToolNameMatch(span: NormalizedSpan): boolean {
    const toolName = span.attributes?.['tool.name'] as string | undefined
    return (
      toolName === 'bash' ||
      toolName === 'execute_command' ||
      span.name === 'bash' ||
      span.name === 'execute_command' ||
      span.operationName === 'bash' ||
      span.operationName === 'execute_command'
    )
  }
}

// Re-expose _isToolNameMatch inline to keep _runExpensiveBash self-contained
// (the method above is still accessible as a private helper if needed)
void ((_: TurnAnalysis) => _) // prevent unused-import lint
