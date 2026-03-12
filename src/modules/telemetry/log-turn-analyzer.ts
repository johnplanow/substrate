/**
 * LogTurnAnalyzer — computes per-turn token breakdowns from normalized log records.
 *
 * Takes a list of NormalizedLog records and produces TurnAnalysis[], where
 * each entry represents an LLM turn derived from log data with:
 *   - Chronological ordering (by timestamp)
 *   - Sequential turnNumber assignment (1-N)
 *   - freshTokens, cacheHitRate, contextSize, contextDelta metrics
 *   - isContextSpike detection (inputTokens > 2× average)
 *   - Deduplication by traceId+spanId combination
 *
 * Architecture constraints:
 *   - Constructor injection: accepts pino.Logger via constructor
 *   - No external dependencies beyond types from this module
 *   - Zero LLM calls — pure statistical computation
 *   - Never throws from public methods
 */

import type pino from 'pino'

import type { NormalizedLog, TurnAnalysis } from './types.js'

// ---------------------------------------------------------------------------
// Merged entry type (internal)
// ---------------------------------------------------------------------------

interface MergedLogEntry {
  representative: NormalizedLog
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
}

// ---------------------------------------------------------------------------
// LogTurnAnalyzer
// ---------------------------------------------------------------------------

export class LogTurnAnalyzer {
  private readonly _logger: pino.Logger

  constructor(logger: pino.Logger) {
    this._logger = logger
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Analyze a list of NormalizedLog records and produce TurnAnalysis[].
   *
   * Returns an empty array immediately when logs is empty or on any error.
   *
   * @param logs - All log records for a story
   */
  analyze(logs: NormalizedLog[]): TurnAnalysis[] {
    try {
      if (!Array.isArray(logs) || logs.length === 0) {
        return []
      }

      // Filter out invalid/malformed entries and non-LLM logs (zero tokens = noise)
      const validLogs = logs.filter(
        (log) =>
          log != null &&
          typeof log === 'object' &&
          ((log.inputTokens ?? 0) > 0 || (log.outputTokens ?? 0) > 0),
      )
      if (validLogs.length === 0) {
        this._logger.debug('LogTurnAnalyzer: no LLM logs with tokens to analyze')
        return []
      }

      // Group by traceId+spanId for deduplication.
      // Key: `${traceId}:${spanId}` when both present; otherwise fallback to logId.
      const grouped = new Map<string, NormalizedLog[]>()
      for (const log of validLogs) {
        const key =
          log.traceId != null && log.spanId != null
            ? `${log.traceId}:${log.spanId}`
            : log.logId
        const group = grouped.get(key) ?? []
        group.push(log)
        grouped.set(key, group)
      }

      // Merge each group: sum token counts, use earliest log as representative
      const merged: MergedLogEntry[] = []
      for (const group of grouped.values()) {
        const sorted = [...group].sort((a, b) => a.timestamp - b.timestamp)
        const representative = sorted[0]

        let inputTokens = 0
        let outputTokens = 0
        let cacheReadTokens = 0
        let costUsd = 0
        for (const log of group) {
          inputTokens += log.inputTokens ?? 0
          outputTokens += log.outputTokens ?? 0
          cacheReadTokens += log.cacheReadTokens ?? 0
          costUsd += log.costUsd ?? 0
        }

        merged.push({ representative, inputTokens, outputTokens, cacheReadTokens, costUsd })
      }

      // Sort merged entries chronologically by representative timestamp
      merged.sort((a, b) => a.representative.timestamp - b.representative.timestamp)

      // First pass: build turns with context accumulation metrics
      let runningContext = 0
      const turns: TurnAnalysis[] = merged.map(
        ({ representative: log, inputTokens, outputTokens, cacheReadTokens, costUsd }, idx) => {
          const prevContext = runningContext
          // contextSize tracks total input (fresh + cached) to reflect actual context window usage
          runningContext += inputTokens + cacheReadTokens

          const freshTokens = inputTokens - cacheReadTokens
          // cacheHitRate = fraction of total input that came from cache (0-1).
          // Claude API reports input_tokens as fresh (non-cached) only, so
          // total input = inputTokens + cacheReadTokens.
          const totalInput = inputTokens + cacheReadTokens
          const cacheHitRate = totalInput > 0 ? cacheReadTokens / totalInput : 0

          return {
            spanId: log.spanId ?? log.logId,
            turnNumber: idx + 1,
            name: log.eventName ?? 'log_turn',
            timestamp: log.timestamp,
            source: 'claude-code',
            model: log.model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            freshTokens,
            cacheHitRate,
            costUsd,
            durationMs: 0,
            contextSize: runningContext,
            contextDelta: runningContext - prevContext,
            toolName: log.toolName,
            isContextSpike: false, // will be set in second pass
            childSpans: [],
          }
        },
      )

      // Second pass: spike detection (inputTokens > 2 × average)
      const avg = turns.reduce((sum, t) => sum + t.inputTokens, 0) / turns.length
      for (const turn of turns) {
        turn.isContextSpike = avg > 0 && turn.inputTokens > 2 * avg
      }

      this._logger.debug({ turnCount: turns.length, avg }, 'LogTurnAnalyzer.analyze complete')

      return turns
    } catch (err) {
      this._logger.warn({ err }, 'LogTurnAnalyzer.analyze failed — returning empty array')
      return []
    }
  }
}
