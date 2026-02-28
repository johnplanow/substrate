/**
 * LogPanel component for the TUI dashboard.
 *
 * Renders a scrollable log display showing story:log and story:warn events.
 * Logs are prefixed with story key and timestamp, auto-scrolled to latest.
 */

import type { TuiLogEntry } from './types.js'
import { ANSI, colorize, truncate, bold } from './ansi.js'

// ---------------------------------------------------------------------------
// LogPanel
// ---------------------------------------------------------------------------

/**
 * Render options for the log panel.
 */
export interface LogPanelOptions {
  /** Log entries to display */
  entries: TuiLogEntry[]
  /** Maximum number of visible lines in the panel */
  maxLines: number
  /** Whether to use color output */
  useColor: boolean
  /** Available width in columns */
  width: number
  /** Optional filtered story key (for detail view) */
  filterKey?: string
}

/**
 * Format a log entry timestamp to a short HH:MM:SS format.
 */
function formatTimestamp(ts: string): string {
  try {
    const date = new Date(ts)
    const hh = date.getHours().toString().padStart(2, '0')
    const mm = date.getMinutes().toString().padStart(2, '0')
    const ss = date.getSeconds().toString().padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  } catch {
    return ts.slice(11, 19)
  }
}

/**
 * Render a single log entry line.
 */
export function renderLogEntry(entry: TuiLogEntry, useColor: boolean, width: number): string {
  const ts = formatTimestamp(entry.ts)
  const prefix = `[${ts}] [${entry.key}] `
  const maxMsgWidth = Math.max(width - prefix.length - 2, 10)
  const msg = truncate(entry.msg, maxMsgWidth)
  const line = `${prefix}${msg}`

  if (useColor) {
    if (entry.level === 'warn') {
      return colorize(line, ANSI.YELLOW, useColor)
    }
    // Key in cyan, message in default
    const coloredPrefix = colorize(`[${ts}] `, ANSI.BRIGHT_BLACK, useColor) +
                          colorize(`[${entry.key}] `, ANSI.CYAN, useColor)
    return `${coloredPrefix}${msg}`
  }

  return line
}

/**
 * Render the complete log panel.
 *
 * Auto-scrolls to show the most recent entries (last `maxLines` entries).
 * Returns an array of lines to be written to the terminal.
 */
export function renderLogPanel(options: LogPanelOptions): string[] {
  const { entries, maxLines, useColor, width, filterKey } = options
  const lines: string[] = []

  // Title bar
  const title = filterKey !== undefined
    ? `  Logs for ${filterKey}`
    : '  Live Logs'
  lines.push(bold(colorize(title, ANSI.CYAN, useColor), useColor))
  lines.push('  ' + '─'.repeat(Math.max(width - 4, 20)))

  // Filter entries if detail view
  const filtered = filterKey !== undefined
    ? entries.filter((e) => e.key === filterKey)
    : entries

  if (filtered.length === 0) {
    lines.push(colorize('  (no log entries)', ANSI.BRIGHT_BLACK, useColor))
    return lines
  }

  // Auto-scroll: show last maxLines entries
  const visibleEntries = filtered.slice(-maxLines)

  for (const entry of visibleEntries) {
    lines.push('  ' + renderLogEntry(entry, useColor, width - 2))
  }

  return lines
}
