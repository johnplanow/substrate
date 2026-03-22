/**
 * Categorizer — classifies telemetry spans into semantic categories and
 * computes per-category token statistics with trend detection.
 *
 * Classification proceeds through three tiers:
 *   1. Exact match against a lookup table of known operation names
 *   2. Prefix/regex pattern match
 *   3. Fuzzy case-insensitive substring match
 *   4. Fallback to 'other' (overridden to 'tool_outputs' when toolName present)
 *
 * Architecture constraints:
 *   - Constructor injection: accepts ILogger via constructor (defaults to console)
 *   - Module-scope lookup tables to avoid recreation on every classify() call
 *   - Zero external dependencies beyond types from this module
 *
 * Migrated to @substrate-ai/core in story 41-6b.
 */

import type { ILogger } from '../dispatch/types.js'
import type {
  NormalizedSpan,
  TurnAnalysis,
  SemanticCategory,
  CategoryStats,
  Trend,
} from './types.js'
import type { ICategorizer } from './telemetry-pipeline.js'

// ---------------------------------------------------------------------------
// Module-scope lookup tables (constructed once, shared across all instances)
// ---------------------------------------------------------------------------

/**
 * Tier 0: task-type to semantic category mapping.
 *
 * When a TurnAnalysis has a known taskType, the category is determined
 * directly from this map without consulting lower tiers.
 */
const TASK_TYPE_CATEGORY_MAP = new Map<string, SemanticCategory>([
  ['create-story', 'system_prompts'],
  ['dev-story',    'tool_outputs'],
  ['code-review',  'conversation_history'],
  ['test-plan',    'system_prompts'],
  ['minor-fixes',  'tool_outputs'],
])

const EXACT_CATEGORY_MAP = new Map<string, SemanticCategory>([
  ['read_file', 'file_reads'],
  ['write_file', 'tool_outputs'],
  ['bash', 'tool_outputs'],
  ['tool_use', 'tool_outputs'],
  ['tool_result', 'tool_outputs'],
  ['system_prompt', 'system_prompts'],
  ['human_turn', 'user_prompts'],
  ['user_message', 'user_prompts'],
  ['assistant_turn', 'conversation_history'],
  ['assistant_message', 'conversation_history'],
  ['search_files', 'file_reads'],
  ['list_files', 'file_reads'],
  ['run_command', 'tool_outputs'],
  ['memory_read', 'system_prompts'],
  ['web_fetch', 'tool_outputs'],
  // Claude Code OTLP log event names
  ['api_request', 'conversation_history'],
  ['tool_decision', 'tool_outputs'],
])

const PREFIX_PATTERNS: Array<{ pattern: RegExp; category: SemanticCategory }> = [
  { pattern: /^(bash|exec|run|spawn)/i, category: 'tool_outputs' },
  { pattern: /^(read|open|cat|head|tail).*file/i, category: 'file_reads' },
  { pattern: /^(list|glob|find).*file/i, category: 'file_reads' },
  { pattern: /^tool/i, category: 'tool_outputs' },
  { pattern: /^system/i, category: 'system_prompts' },
  { pattern: /^(human|user)/i, category: 'user_prompts' },
  { pattern: /^(assistant|ai|model)/i, category: 'conversation_history' },
]

/** All six semantic categories in a stable order for zero-fill initialisation. */
const ALL_CATEGORIES: readonly SemanticCategory[] = [
  'tool_outputs',
  'file_reads',
  'system_prompts',
  'conversation_history',
  'user_prompts',
  'other',
]

// ---------------------------------------------------------------------------
// Categorizer
// ---------------------------------------------------------------------------

export class Categorizer implements ICategorizer {
  private readonly _logger: ILogger

  constructor(logger?: ILogger) {
    this._logger = logger ?? console
  }

  // ---------------------------------------------------------------------------
  // classify
  // ---------------------------------------------------------------------------

  /**
   * Classify an operation into a SemanticCategory using tiered logic.
   *
   * @param operationName - Span operation name (e.g. 'read_file', 'bash')
   * @param toolName      - Optional tool name; non-empty value overrides fallback to tool_outputs
   * @param taskType      - Optional task type (e.g. 'dev-story', 'code-review'); acts as Tier 0 (highest priority)
   */
  classify(operationName: string, toolName?: string, taskType?: string): SemanticCategory {
    // Tier 0: taskType takes highest priority when defined and mapped
    if (taskType !== undefined && taskType.length > 0) {
      const taskCategory = TASK_TYPE_CATEGORY_MAP.get(taskType)
      if (taskCategory !== undefined) return taskCategory
    }

    // Tier 1: exact match
    const exact = EXACT_CATEGORY_MAP.get(operationName)
    if (exact !== undefined) return exact

    // Tier 2: prefix/regex pattern match
    for (const { pattern, category } of PREFIX_PATTERNS) {
      if (pattern.test(operationName)) return category
    }

    // Tier 3: fuzzy case-insensitive substring match
    const lower = operationName.toLowerCase()

    // file_reads: contains 'file' AND ('read' or 'open')
    if (lower.includes('file') && (lower.includes('read') || lower.includes('open'))) {
      return 'file_reads'
    }

    // system_prompts: contains 'system' or 'prompt'
    if (lower.includes('system') || lower.includes('prompt')) {
      return 'system_prompts'
    }

    // tool_outputs: contains 'bash' or 'exec' or 'tool'
    if (lower.includes('bash') || lower.includes('exec') || lower.includes('tool')) {
      return 'tool_outputs'
    }

    // conversation_history: contains 'conversation' or 'history' or 'chat'
    if (lower.includes('conversation') || lower.includes('history') || lower.includes('chat')) {
      return 'conversation_history'
    }

    // user_prompts: contains 'user' or 'human'
    if (lower.includes('user') || lower.includes('human')) {
      return 'user_prompts'
    }

    // Tier 4: fallback — toolName presence overrides to tool_outputs
    if (toolName !== undefined && toolName.length > 0) {
      return 'tool_outputs'
    }

    // Tier 5: log-derived turns without explicit operation names default to
    // conversation_history (they represent LLM turns, not unknown operations)
    if (lower === 'log_turn') {
      return 'conversation_history'
    }

    return 'other'
  }

  // ---------------------------------------------------------------------------
  // computeTrend
  // ---------------------------------------------------------------------------

  /**
   * Detect whether a category's token consumption is growing, stable, or shrinking
   * by comparing first-half vs second-half turn attribution.
   *
   * @param categorySpans - Spans already classified into this category
   * @param turns         - Full turn sequence for the story
   */
  computeTrend(categorySpans: NormalizedSpan[], turns: TurnAnalysis[]): Trend {
    if (turns.length < 2) return 'stable'

    // Build spanId → turn-index map from direct spanId and childSpans
    const spanTurnMap = new Map<string, number>()
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]
      if (turn === undefined) continue
      spanTurnMap.set(turn.spanId, i)
      for (const child of turn.childSpans) {
        spanTurnMap.set(child.spanId, i)
      }
    }

    const half = Math.floor(turns.length / 2)
    let firstHalfTokens = 0
    let secondHalfTokens = 0

    for (const span of categorySpans) {
      const turnIdx = spanTurnMap.has(span.spanId)
        ? spanTurnMap.get(span.spanId)!
        : attributeSpanToTurnIndex(span.startTime, turns)

      const tokens = span.inputTokens + span.outputTokens
      if (turnIdx < half) {
        firstHalfTokens += tokens
      } else {
        secondHalfTokens += tokens
      }
    }

    if (firstHalfTokens === 0 && secondHalfTokens === 0) return 'stable'

    // If first half is zero but second is non-zero, it is growing
    if (firstHalfTokens === 0) return 'growing'

    if (secondHalfTokens > 1.2 * firstHalfTokens) return 'growing'
    if (secondHalfTokens < 0.8 * firstHalfTokens) return 'shrinking'
    return 'stable'
  }

  // ---------------------------------------------------------------------------
  // computeCategoryStatsFromTurns
  // ---------------------------------------------------------------------------

  /**
   * Compute per-category token statistics from TurnAnalysis data (not raw spans).
   *
   * All six SemanticCategory values are always present in the result (zero-token
   * categories are included with totalTokens: 0). Results are sorted by
   * totalTokens descending.
   *
   * Trend is computed by comparing first-half vs second-half turn token attribution
   * for each category, using the same 1.2×/0.8× thresholds as computeTrend().
   *
   * @param turns - TurnAnalysis[] for the story
   */
  computeCategoryStatsFromTurns(turns: TurnAnalysis[]): CategoryStats[] {
    if (turns.length === 0) {
      return ALL_CATEGORIES.map((category) => ({
        category,
        totalTokens: 0,
        percentage: 0,
        eventCount: 0,
        avgTokensPerEvent: 0,
        trend: 'stable' as Trend,
      }))
    }

    const grandTotal = turns.reduce((sum, t) => sum + t.inputTokens + t.outputTokens, 0)

    // Track tokens by category, split by first/second half for trend
    type BucketData = { total: number; count: number; first: number; second: number }
    const buckets = new Map<SemanticCategory, BucketData>()
    for (const cat of ALL_CATEGORIES) {
      buckets.set(cat, { total: 0, count: 0, first: 0, second: 0 })
    }

    const half = Math.floor(turns.length / 2)

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]
      if (turn === undefined) continue
      const cat = this.classify(turn.name, turn.toolName, turn.taskType)
      const bucket = buckets.get(cat)!
      const tokens = turn.inputTokens + turn.outputTokens
      bucket.total += tokens
      bucket.count += 1
      if (i < half) {
        bucket.first += tokens
      } else {
        bucket.second += tokens
      }
    }

    const results: CategoryStats[] = ALL_CATEGORIES.map((category) => {
      const bucket = buckets.get(category)!
      const totalTokens = bucket.total
      const eventCount = bucket.count
      const percentage =
        grandTotal > 0 ? Math.round((totalTokens / grandTotal) * 100 * 1000) / 1000 : 0
      const avgTokensPerEvent = eventCount > 0 ? totalTokens / eventCount : 0

      // Compute trend from first vs second half turn token counts for this category
      let trend: Trend = 'stable'
      if (turns.length >= 2) {
        const { first, second } = bucket
        if (first === 0 && second === 0) {
          trend = 'stable'
        } else if (first === 0) {
          trend = 'growing'
        } else if (second > 1.2 * first) {
          trend = 'growing'
        } else if (second < 0.8 * first) {
          trend = 'shrinking'
        }
      }

      return { category, totalTokens, percentage, eventCount, avgTokensPerEvent, trend }
    })

    this._logger.debug(
      { categories: results.length, grandTotal },
      'Computed category stats from turns',
    )

    return results.sort((a, b) => b.totalTokens - a.totalTokens)
  }

  // ---------------------------------------------------------------------------
  // computeCategoryStats
  // ---------------------------------------------------------------------------

  /**
   * Compute per-category token statistics for a complete set of spans.
   *
   * All six SemanticCategory values are always present in the result (zero-token
   * categories are included with totalTokens: 0).  Results are sorted by
   * totalTokens descending.
   *
   * @param spans - All NormalizedSpans for the story
   * @param turns - TurnAnalysis sequence (may be empty)
   */
  computeCategoryStats(spans: NormalizedSpan[], turns: TurnAnalysis[]): CategoryStats[] {
    const grandTotal = spans.reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0)

    // Bucket spans by category
    const buckets = new Map<SemanticCategory, NormalizedSpan[]>()
    for (const cat of ALL_CATEGORIES) buckets.set(cat, [])

    for (const span of spans) {
      const toolName = extractToolNameFromSpan(span)
      const cat = this.classify(span.operationName ?? span.name, toolName)
      buckets.get(cat)!.push(span)
    }

    const results: CategoryStats[] = ALL_CATEGORIES.map((category) => {
      const catSpans = buckets.get(category)!
      const totalTokens = catSpans.reduce((sum, s) => sum + s.inputTokens + s.outputTokens, 0)
      const eventCount = catSpans.length
      const percentage =
        grandTotal > 0 ? Math.round((totalTokens / grandTotal) * 100 * 1000) / 1000 : 0
      const avgTokensPerEvent = eventCount > 0 ? totalTokens / eventCount : 0
      const trend = this.computeTrend(catSpans, turns)

      return { category, totalTokens, percentage, eventCount, avgTokensPerEvent, trend }
    })

    this._logger.debug(
      { categories: results.length, grandTotal },
      'Computed category stats',
    )

    return results.sort((a, b) => b.totalTokens - a.totalTokens)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Binary search: find the index of the last turn whose timestamp ≤ spanStartTime.
 * Returns 0 if no turn precedes the span.
 */
function attributeSpanToTurnIndex(spanStartTime: number, turns: TurnAnalysis[]): number {
  let lo = 0
  let hi = turns.length - 1
  let result = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((turns[mid]?.timestamp ?? 0) <= spanStartTime) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

/**
 * Extract a tool name from a span's attributes, checking known attribute keys
 * in priority order.
 */
function extractToolNameFromSpan(span: NormalizedSpan): string | undefined {
  if (!span.attributes) return undefined
  const attrs = span.attributes
  const name =
    (attrs['tool.name'] as string | undefined) ||
    (attrs['llm.tool.name'] as string | undefined) ||
    (attrs['claude.tool_name'] as string | undefined)
  return name || undefined
}
