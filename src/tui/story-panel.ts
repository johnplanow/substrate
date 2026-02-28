/**
 * StoryPanel component for the TUI dashboard.
 *
 * Renders a table of story rows with color-coded status indicators.
 * Each row shows: story key, current phase, and status.
 *
 * Color coding:
 *   - pending   → gray/dim
 *   - in_progress → yellow
 *   - succeeded → green
 *   - failed    → red
 *   - escalated → red
 */

import type { TuiStoryState } from './types.js'
import { ANSI, colorize, padOrTruncate, bold } from './ansi.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COL_KEY_WIDTH = 12
const COL_PHASE_WIDTH = 8
const COL_STATUS_WIDTH = 30

// ---------------------------------------------------------------------------
// StoryPanel
// ---------------------------------------------------------------------------

/**
 * Render options for the story panel.
 */
export interface StoryPanelOptions {
  /** Stories to display (in order) */
  stories: TuiStoryState[]
  /** Currently selected index (for highlight) */
  selectedIndex: number
  /** Whether to use color output */
  useColor: boolean
  /** Available width in columns */
  width: number
}

/**
 * Get ANSI color code for a story status.
 */
function statusColor(status: TuiStoryState['status']): string {
  switch (status) {
    case 'pending':
      return ANSI.BRIGHT_BLACK
    case 'in_progress':
      return ANSI.YELLOW
    case 'succeeded':
      return ANSI.GREEN
    case 'failed':
    case 'escalated':
      return ANSI.RED
    default:
      return ANSI.RESET
  }
}

/**
 * Get status indicator symbol for a story status.
 */
function statusSymbol(status: TuiStoryState['status']): string {
  switch (status) {
    case 'pending':
      return '○'
    case 'in_progress':
      return '◉'
    case 'succeeded':
      return '✓'
    case 'failed':
    case 'escalated':
      return '✗'
    default:
      return '·'
  }
}

/**
 * Render the story panel header row.
 */
export function renderStoryPanelHeader(useColor: boolean): string {
  const key = padOrTruncate('STORY', COL_KEY_WIDTH)
  const phase = padOrTruncate('PHASE', COL_PHASE_WIDTH)
  const status = 'STATUS'
  const header = `  ${key}  ${phase}  ${status}`
  return bold(colorize(header, ANSI.BRIGHT_WHITE, useColor), useColor)
}

/**
 * Render a single story row.
 */
export function renderStoryRow(
  story: TuiStoryState,
  isSelected: boolean,
  useColor: boolean,
  width: number,
): string {
  const symbol = statusSymbol(story.status)
  const color = statusColor(story.status)

  const keyCol = padOrTruncate(story.key, COL_KEY_WIDTH)
  const phaseCol = padOrTruncate(story.phase, COL_PHASE_WIDTH)
  const statusCol = padOrTruncate(story.statusLabel, COL_STATUS_WIDTH)

  // Available width for the row
  const maxWidth = Math.max(width - 2, 10)

  let row = `${symbol} ${keyCol}  ${phaseCol}  ${statusCol}`
  row = row.slice(0, maxWidth)

  if (useColor) {
    row = `${color}${row}${ANSI.RESET}`
  }

  // Highlight selected row with inverse colors
  if (isSelected && useColor) {
    row = `${ANSI.BG_BRIGHT_BLACK}${row}${ANSI.RESET}`
  } else if (isSelected) {
    row = `> ${row.slice(2)}`
  }

  return row
}

/**
 * Render the complete story panel.
 *
 * Returns an array of lines to be written to the terminal.
 */
export function renderStoryPanel(options: StoryPanelOptions): string[] {
  const { stories, selectedIndex, useColor, width } = options
  const lines: string[] = []

  // Title bar
  lines.push(bold(colorize('  Story Status', ANSI.CYAN, useColor), useColor))
  lines.push(renderStoryPanelHeader(useColor))
  lines.push('  ' + '─'.repeat(Math.max(width - 4, 20)))

  // Story rows
  if (stories.length === 0) {
    lines.push(colorize('  (no stories)', ANSI.BRIGHT_BLACK, useColor))
  } else {
    for (let i = 0; i < stories.length; i++) {
      const story = stories[i]
      if (story !== undefined) {
        lines.push(renderStoryRow(story, i === selectedIndex, useColor, width))
      }
    }
  }

  return lines
}
