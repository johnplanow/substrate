// packages/factory/src/agent/truncation.ts
// Output truncation utilities for the agentic loop.
// Story 48-7: Coding Agent Loop — Core Agentic Loop
// Story 48-9: Output Truncation — Two-Phase Algorithm

import type { SessionConfig } from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default per-tool character output limits.
 * Tools not listed here fall back to DEFAULT_FALLBACK_CHAR_LIMIT (10,000).
 *
 * Note: shell is 30K (not 10K as in the AC) — shell output often contains build logs,
 * test results, and compiler errors that need more context for effective debugging.
 * The 10K AC value was based on interactive shell use; 30K reflects agentic workloads.
 */
export const DEFAULT_TOOL_LIMITS = {
  read_file: 50_000,
  shell: 30_000,
  grep: 20_000,
  glob: 20_000,
} as const

/** Fallback character limit for tools not in DEFAULT_TOOL_LIMITS */
export const DEFAULT_FALLBACK_CHAR_LIMIT = 10_000

/** Maximum lines before Phase 2 line-based truncation is applied */
export const DEFAULT_LINE_LIMIT = 500

// ---------------------------------------------------------------------------
// Phase 1: Character-based truncation
// ---------------------------------------------------------------------------

function truncateByChars(output: string, limit: number, mode: 'head_tail' | 'tail'): string {
  if (output.length <= limit) return output
  if (mode === 'tail') return output.slice(-limit)
  const half = Math.floor(limit / 2)
  const removed = output.length - limit
  return (
    output.slice(0, half) +
    `\n\n[... ${removed} characters truncated from middle. Full output available in event stream.]\n\n` +
    output.slice(-half)
  )
}

// ---------------------------------------------------------------------------
// Phase 2: Line-based truncation
// ---------------------------------------------------------------------------

function truncateByLines(output: string, maxLines: number, mode: 'head_tail' | 'tail'): string {
  const lines = output.split('\n')
  if (lines.length <= maxLines) return output
  if (mode === 'tail') return lines.slice(-maxLines).join('\n')
  const headCount = Math.ceil(maxLines / 2)
  const tailCount = Math.floor(maxLines / 2)
  const removed = lines.length - maxLines
  return (
    lines.slice(0, headCount).join('\n') +
    `\n[... ${removed} lines truncated from middle ...]\n` +
    lines.slice(-tailCount).join('\n')
  )
}

// ---------------------------------------------------------------------------
// Composed two-phase pipeline
// ---------------------------------------------------------------------------

/**
 * Truncates tool output to fit within LLM context windows using a two-phase pipeline.
 *
 * Phase 1 (character-based): Applies per-tool character limits in head_tail or tail mode.
 * Phase 2 (line-based): Applies max_output_lines limit in head_tail or tail mode.
 *
 * If output is within both limits, returns the original string unchanged.
 */
export function truncateToolOutput(
  output: string,
  toolName: string,
  config: SessionConfig
): string {
  const charLimit =
    config.tool_output_limits.get(toolName) ??
    DEFAULT_TOOL_LIMITS[toolName as keyof typeof DEFAULT_TOOL_LIMITS] ??
    DEFAULT_FALLBACK_CHAR_LIMIT

  const mode = config.truncation_mode ?? 'head_tail'
  const maxLines = config.max_output_lines ?? DEFAULT_LINE_LIMIT

  const afterPhase1 = truncateByChars(output, charLimit, mode)
  return truncateByLines(afterPhase1, maxLines, mode)
}
