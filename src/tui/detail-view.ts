/**
 * DetailView component for the TUI dashboard.
 *
 * Renders a per-story drill-down view showing all log entries for a
 * specific story, along with its current phase and status details.
 */

import type { TuiStoryState, TuiLogEntry } from './types.js'
import { ANSI, colorize, bold, padOrTruncate } from './ansi.js'
import { renderLogPanel } from './log-panel.js'

// ---------------------------------------------------------------------------
// DetailView
// ---------------------------------------------------------------------------

/**
 * Render options for the detail view.
 */
export interface DetailViewOptions {
  /** Story to display details for */
  story: TuiStoryState
  /** All log entries (will be filtered to this story) */
  allLogs: TuiLogEntry[]
  /** Maximum log lines to show */
  maxLogLines: number
  /** Whether to use color output */
  useColor: boolean
  /** Available width in columns */
  width: number
  /** Available height in rows */
  height: number
}

/**
 * Render the full detail view for a story.
 *
 * Returns an array of lines to be written to the terminal.
 */
export function renderDetailView(options: DetailViewOptions): string[] {
  const { story, allLogs, maxLogLines, useColor, width, height } = options
  const lines: string[] = []

  // Header
  const titleBar = `  Story Detail: ${story.key}`
  lines.push(bold(colorize(titleBar, ANSI.BRIGHT_WHITE, useColor), useColor))
  lines.push('  ' + '═'.repeat(Math.max(width - 4, 20)))
  lines.push('')

  // Story info
  const phaseLabel = padOrTruncate('Phase:', 12)
  const statusLabel = padOrTruncate('Status:', 12)
  const cyclesLabel = padOrTruncate('Review Cycles:', 12)

  lines.push(`  ${bold(phaseLabel, useColor)} ${colorize(story.phase, ANSI.CYAN, useColor)}`)
  lines.push(`  ${bold(statusLabel, useColor)} ${colorize(story.statusLabel, ANSI.WHITE, useColor)}`)
  lines.push(`  ${bold(cyclesLabel, useColor)} ${story.reviewCycles}`)

  if (story.escalationReason !== undefined) {
    lines.push(`  ${bold(padOrTruncate('Escalated:', 12), useColor)} ${colorize(story.escalationReason, ANSI.RED, useColor)}`)
  }

  lines.push('')
  lines.push('  ' + '─'.repeat(Math.max(width - 4, 20)))

  // Log panel (filtered to this story)
  const availableLogLines = Math.max(height - lines.length - 4, 3)
  const logLines = renderLogPanel({
    entries: allLogs,
    maxLines: Math.min(maxLogLines, availableLogLines),
    useColor,
    width,
    filterKey: story.key,
  })

  lines.push(...logLines)
  lines.push('')
  lines.push(colorize('  [Esc] Back to overview', ANSI.BRIGHT_BLACK, useColor))

  return lines
}
