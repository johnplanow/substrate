/**
 * HelpOverlay component for the TUI dashboard.
 *
 * Renders a keyboard shortcut reference overlay.
 */

import { ANSI, colorize, bold, padOrTruncate } from './ansi.js'

// ---------------------------------------------------------------------------
// HelpOverlay
// ---------------------------------------------------------------------------

/**
 * Keyboard shortcut definition.
 */
interface KeyBinding {
  key: string
  description: string
}

/** All keyboard bindings shown in the help overlay. */
const KEY_BINDINGS: KeyBinding[] = [
  { key: '↑ / ↓', description: 'Navigate between stories' },
  { key: 'Enter', description: 'Drill into selected story detail view' },
  { key: 'Esc', description: 'Return to overview from detail view' },
  { key: 'q', description: 'Quit TUI (pipeline completes in background)' },
  { key: '?', description: 'Show/hide this help overlay' },
]

/**
 * Render options for the help overlay.
 */
export interface HelpOverlayOptions {
  /** Whether to use color output */
  useColor: boolean
  /** Available width in columns */
  width: number
}

/**
 * Render the help overlay.
 *
 * Returns an array of lines to be written to the terminal.
 */
export function renderHelpOverlay(options: HelpOverlayOptions): string[] {
  const { useColor, width } = options
  const lines: string[] = []

  const boxWidth = Math.min(56, Math.max(width - 4, 30))
  const horizontalBorder = '─'.repeat(boxWidth - 2)

  lines.push(colorize(`  ┌${horizontalBorder}┐`, ANSI.CYAN, useColor))
  lines.push(colorize(`  │${padOrTruncate(' Keyboard Shortcuts', boxWidth - 2)}│`, ANSI.CYAN, useColor))
  lines.push(colorize(`  ├${horizontalBorder}┤`, ANSI.CYAN, useColor))

  for (const binding of KEY_BINDINGS) {
    const keyPart = bold(padOrTruncate(binding.key, 12), useColor)
    const descPart = padOrTruncate(binding.description, boxWidth - 16)
    lines.push(
      useColor
        ? `${ANSI.CYAN}  │${ANSI.RESET}  ${keyPart}  ${descPart}${ANSI.CYAN}│${ANSI.RESET}`
        : `  │  ${keyPart}  ${descPart}│`,
    )
  }

  lines.push(colorize(`  └${horizontalBorder}┘`, ANSI.CYAN, useColor))
  lines.push(colorize('  Press ? to close', ANSI.BRIGHT_BLACK, useColor))

  return lines
}
