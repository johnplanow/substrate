/**
 * Unit tests for ANSI escape code utilities (ansi.ts).
 *
 * Covers:
 *   - ANSI constant values
 *   - moveTo, cursorUp, cursorDown
 *   - supportsColor (respects NO_COLOR env, isTTY)
 *   - colorize, bold, dim (with and without color)
 *   - getTerminalSize (uses process.stdout columns/rows, fallback defaults)
 *   - truncate
 *   - padOrTruncate
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ANSI,
  moveTo,
  cursorUp,
  cursorDown,
  supportsColor,
  colorize,
  bold,
  dim,
  getTerminalSize,
  truncate,
  padOrTruncate,
} from '../ansi.js'

// ---------------------------------------------------------------------------
// ANSI constants
// ---------------------------------------------------------------------------

describe('ANSI constants', () => {
  it('RESET is the reset escape code', () => {
    expect(ANSI.RESET).toBe('\x1b[0m')
  })

  it('BOLD is the bold escape code', () => {
    expect(ANSI.BOLD).toBe('\x1b[1m')
  })

  it('DIM is the dim escape code', () => {
    expect(ANSI.DIM).toBe('\x1b[2m')
  })

  it('GREEN is the green foreground escape code', () => {
    expect(ANSI.GREEN).toBe('\x1b[32m')
  })

  it('RED is the red foreground escape code', () => {
    expect(ANSI.RED).toBe('\x1b[31m')
  })

  it('YELLOW is the yellow foreground escape code', () => {
    expect(ANSI.YELLOW).toBe('\x1b[33m')
  })

  it('CYAN is the cyan foreground escape code', () => {
    expect(ANSI.CYAN).toBe('\x1b[36m')
  })

  it('BRIGHT_BLACK is the bright black foreground escape code', () => {
    expect(ANSI.BRIGHT_BLACK).toBe('\x1b[90m')
  })

  it('HIDE_CURSOR is the hide cursor escape code', () => {
    expect(ANSI.HIDE_CURSOR).toBe('\x1b[?25l')
  })

  it('SHOW_CURSOR is the show cursor escape code', () => {
    expect(ANSI.SHOW_CURSOR).toBe('\x1b[?25h')
  })

  it('CLEAR_SCREEN is the clear screen escape code', () => {
    expect(ANSI.CLEAR_SCREEN).toBe('\x1b[2J')
  })

  it('HOME is the home position escape code', () => {
    expect(ANSI.HOME).toBe('\x1b[H')
  })

  it('ALT_SCREEN_ENTER is the alternate screen buffer enter code', () => {
    expect(ANSI.ALT_SCREEN_ENTER).toBe('\x1b[?1049h')
  })

  it('ALT_SCREEN_EXIT is the alternate screen buffer exit code', () => {
    expect(ANSI.ALT_SCREEN_EXIT).toBe('\x1b[?1049l')
  })
})

// ---------------------------------------------------------------------------
// moveTo
// ---------------------------------------------------------------------------

describe('moveTo', () => {
  it('formats a row/col move escape sequence', () => {
    expect(moveTo(1, 1)).toBe('\x1b[1;1H')
  })

  it('uses the provided row and col values', () => {
    expect(moveTo(5, 10)).toBe('\x1b[5;10H')
  })

  it('handles large row/col values', () => {
    expect(moveTo(999, 80)).toBe('\x1b[999;80H')
  })
})

// ---------------------------------------------------------------------------
// cursorUp
// ---------------------------------------------------------------------------

describe('cursorUp', () => {
  it('returns cursor up escape sequence for positive n', () => {
    expect(cursorUp(1)).toBe('\x1b[1A')
  })

  it('returns cursor up for larger n', () => {
    expect(cursorUp(5)).toBe('\x1b[5A')
  })

  it('returns empty string for n = 0', () => {
    expect(cursorUp(0)).toBe('')
  })

  it('returns empty string for negative n', () => {
    expect(cursorUp(-3)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// cursorDown
// ---------------------------------------------------------------------------

describe('cursorDown', () => {
  it('returns cursor down escape sequence for positive n', () => {
    expect(cursorDown(1)).toBe('\x1b[1B')
  })

  it('returns cursor down for larger n', () => {
    expect(cursorDown(3)).toBe('\x1b[3B')
  })

  it('returns empty string for n = 0', () => {
    expect(cursorDown(0)).toBe('')
  })

  it('returns empty string for negative n', () => {
    expect(cursorDown(-2)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// supportsColor
// ---------------------------------------------------------------------------

describe('supportsColor', () => {
  let originalNoColor: string | undefined

  beforeEach(() => {
    originalNoColor = process.env.NO_COLOR
    delete process.env.NO_COLOR
  })

  afterEach(() => {
    if (originalNoColor !== undefined) {
      process.env.NO_COLOR = originalNoColor
    } else {
      delete process.env.NO_COLOR
    }
  })

  it('returns true when isTTY is true and NO_COLOR is not set', () => {
    expect(supportsColor(true)).toBe(true)
  })

  it('returns false when isTTY is false', () => {
    expect(supportsColor(false)).toBe(false)
  })

  it('returns false when NO_COLOR is set (even if isTTY is true)', () => {
    process.env.NO_COLOR = '1'
    expect(supportsColor(true)).toBe(false)
  })

  it('returns false when NO_COLOR is empty string', () => {
    process.env.NO_COLOR = ''
    expect(supportsColor(true)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// colorize
// ---------------------------------------------------------------------------

describe('colorize', () => {
  it('wraps text with color code and reset when useColor is true', () => {
    const result = colorize('hello', ANSI.GREEN, true)
    expect(result).toBe(`${ANSI.GREEN}hello${ANSI.RESET}`)
  })

  it('returns plain text when useColor is false', () => {
    const result = colorize('hello', ANSI.GREEN, false)
    expect(result).toBe('hello')
  })

  it('works with different color codes', () => {
    const result = colorize('world', ANSI.RED, true)
    expect(result).toBe(`${ANSI.RED}world${ANSI.RESET}`)
  })

  it('handles empty string', () => {
    const result = colorize('', ANSI.CYAN, true)
    expect(result).toBe(`${ANSI.CYAN}${ANSI.RESET}`)
  })
})

// ---------------------------------------------------------------------------
// bold
// ---------------------------------------------------------------------------

describe('bold', () => {
  it('wraps text with bold code and reset when useColor is true', () => {
    const result = bold('hello', true)
    expect(result).toBe(`${ANSI.BOLD}hello${ANSI.RESET}`)
  })

  it('returns plain text when useColor is false', () => {
    const result = bold('hello', false)
    expect(result).toBe('hello')
  })

  it('handles empty string', () => {
    expect(bold('', true)).toBe(`${ANSI.BOLD}${ANSI.RESET}`)
  })
})

// ---------------------------------------------------------------------------
// dim
// ---------------------------------------------------------------------------

describe('dim', () => {
  it('wraps text with dim code and reset when useColor is true', () => {
    const result = dim('hello', true)
    expect(result).toBe(`${ANSI.DIM}hello${ANSI.RESET}`)
  })

  it('returns plain text when useColor is false', () => {
    const result = dim('hello', false)
    expect(result).toBe('hello')
  })

  it('handles empty string', () => {
    expect(dim('', true)).toBe(`${ANSI.DIM}${ANSI.RESET}`)
  })
})

// ---------------------------------------------------------------------------
// getTerminalSize
// ---------------------------------------------------------------------------

describe('getTerminalSize', () => {
  it('returns process.stdout.columns and rows when available', () => {
    const origColumns = process.stdout.columns
    const origRows = process.stdout.rows

    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true })

    const size = getTerminalSize()
    expect(size.cols).toBe(120)
    expect(size.rows).toBe(40)

    Object.defineProperty(process.stdout, 'columns', { value: origColumns, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: origRows, configurable: true })
  })

  it('returns default 80x24 when columns/rows are undefined', () => {
    const origColumns = process.stdout.columns
    const origRows = process.stdout.rows

    Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: undefined, configurable: true })

    const size = getTerminalSize()
    expect(size.cols).toBe(80)
    expect(size.rows).toBe(24)

    Object.defineProperty(process.stdout, 'columns', { value: origColumns, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: origRows, configurable: true })
  })

  it('returns object with cols and rows keys', () => {
    const size = getTerminalSize()
    expect(size).toHaveProperty('cols')
    expect(size).toHaveProperty('rows')
  })
})

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe('truncate', () => {
  it('returns text unchanged if within maxWidth', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('returns text unchanged if exactly maxWidth', () => {
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('truncates and adds ellipsis when text is longer than maxWidth', () => {
    expect(truncate('hello world', 8)).toBe('hello...')
  })

  it('returns empty string when maxWidth is 0', () => {
    expect(truncate('hello', 0)).toBe('')
  })

  it('returns empty string when maxWidth is negative', () => {
    expect(truncate('hello', -1)).toBe('')
  })

  it('truncates without ellipsis when maxWidth is 3', () => {
    expect(truncate('hello', 3)).toBe('hel')
  })

  it('truncates without ellipsis when maxWidth is 1', () => {
    expect(truncate('hello', 1)).toBe('h')
  })

  it('truncates without ellipsis when maxWidth is 2', () => {
    expect(truncate('hello', 2)).toBe('he')
  })

  it('handles empty text', () => {
    expect(truncate('', 10)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// padOrTruncate
// ---------------------------------------------------------------------------

describe('padOrTruncate', () => {
  it('pads short text to width with spaces', () => {
    expect(padOrTruncate('hi', 5)).toBe('hi   ')
  })

  it('returns text unchanged if exactly width', () => {
    expect(padOrTruncate('hello', 5)).toBe('hello')
  })

  it('truncates text that is longer than width', () => {
    const result = padOrTruncate('hello world', 8)
    expect(result.length).toBe(8)
    expect(result).toBe('hello...')
  })

  it('pads with custom character', () => {
    expect(padOrTruncate('hi', 5, '-')).toBe('hi---')
  })

  it('handles empty text', () => {
    expect(padOrTruncate('', 4)).toBe('    ')
  })
})
