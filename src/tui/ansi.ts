/**
 * ANSI escape code helpers for TUI rendering.
 *
 * Provides cursor control, color, and screen manipulation utilities.
 */

// ---------------------------------------------------------------------------
// ANSI codes
// ---------------------------------------------------------------------------

export const ANSI = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',

  // Foreground colors
  BLACK: '\x1b[30m',
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  MAGENTA: '\x1b[35m',
  CYAN: '\x1b[36m',
  WHITE: '\x1b[37m',
  BRIGHT_BLACK: '\x1b[90m',
  BRIGHT_RED: '\x1b[91m',
  BRIGHT_GREEN: '\x1b[92m',
  BRIGHT_YELLOW: '\x1b[93m',
  BRIGHT_BLUE: '\x1b[94m',
  BRIGHT_MAGENTA: '\x1b[95m',
  BRIGHT_CYAN: '\x1b[96m',
  BRIGHT_WHITE: '\x1b[97m',

  // Background colors
  BG_BLACK: '\x1b[40m',
  BG_WHITE: '\x1b[47m',
  BG_BLUE: '\x1b[44m',
  BG_BRIGHT_BLACK: '\x1b[100m',

  // Cursor control
  HIDE_CURSOR: '\x1b[?25l',
  SHOW_CURSOR: '\x1b[?25h',
  CLEAR_SCREEN: '\x1b[2J',
  HOME: '\x1b[H',
  CLEAR_LINE: '\x1b[2K',
  ERASE_DOWN: '\x1b[J',

  // Alternate screen buffer
  ALT_SCREEN_ENTER: '\x1b[?1049h',
  ALT_SCREEN_EXIT: '\x1b[?1049l',
} as const

// ---------------------------------------------------------------------------
// Cursor movement
// ---------------------------------------------------------------------------

/** Move cursor to absolute position (1-indexed). */
export function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`
}

/** Move cursor up N lines. */
export function cursorUp(n: number): string {
  return n > 0 ? `\x1b[${n}A` : ''
}

/** Move cursor down N lines. */
export function cursorDown(n: number): string {
  return n > 0 ? `\x1b[${n}B` : ''
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

/** Check if color output is supported. */
export function supportsColor(isTTY: boolean): boolean {
  if (process.env.NO_COLOR !== undefined) return false
  return isTTY
}

/** Wrap text with an ANSI color code (only if color is enabled). */
export function colorize(text: string, code: string, useColor: boolean): string {
  if (!useColor) return text
  return `${code}${text}${ANSI.RESET}`
}

/** Bold text. */
export function bold(text: string, useColor: boolean): string {
  if (!useColor) return text
  return `${ANSI.BOLD}${text}${ANSI.RESET}`
}

/** Dim text. */
export function dim(text: string, useColor: boolean): string {
  if (!useColor) return text
  return `${ANSI.DIM}${text}${ANSI.RESET}`
}

// ---------------------------------------------------------------------------
// Terminal size
// ---------------------------------------------------------------------------

/**
 * Get current terminal dimensions.
 * Returns { cols, rows } with fallback defaults if unavailable.
 */
export function getTerminalSize(): { cols: number; rows: number } {
  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows ?? 24
  return { cols, rows }
}

/**
 * Truncate a string to fit within maxWidth characters.
 * Adds ellipsis if truncated.
 */
export function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (text.length <= maxWidth) return text
  if (maxWidth <= 3) return text.slice(0, maxWidth)
  return text.slice(0, maxWidth - 3) + '...'
}

/**
 * Pad or truncate a string to exactly `width` characters.
 */
export function padOrTruncate(text: string, width: number, padChar = ' '): string {
  if (text.length > width) return truncate(text, width)
  return text.padEnd(width, padChar)
}
