/**
 * Unit tests for LogPanel component (log-panel.ts).
 *
 * Covers:
 *   - renderLogEntry for log and warn levels (with/without color)
 *   - renderLogPanel with empty entries
 *   - renderLogPanel auto-scroll (shows last maxLines entries)
 *   - renderLogPanel filterKey for detail view
 *   - renderLogPanel title variants (Live Logs vs Logs for <key>)
 */

import { describe, it, expect } from 'vitest'
import { renderLogEntry, renderLogPanel } from '../log-panel.js'
import type { TuiLogEntry } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<TuiLogEntry> = {}): TuiLogEntry {
  return {
    ts: '2026-01-01T12:34:56.000Z',
    key: '10-1',
    msg: 'test message',
    level: 'log',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// renderLogEntry
// ---------------------------------------------------------------------------

describe('renderLogEntry', () => {
  it('includes the story key in the output', () => {
    const entry = makeEntry({ key: '10-2' })
    const line = renderLogEntry(entry, false, 80)
    expect(line).toContain('10-2')
  })

  it('includes the message in the output', () => {
    const entry = makeEntry({ msg: 'hello from story' })
    const line = renderLogEntry(entry, false, 80)
    expect(line).toContain('hello from story')
  })

  it('includes a formatted timestamp HH:MM:SS', () => {
    // ts = 2026-01-01T12:34:56.000Z
    const entry = makeEntry({ ts: '2026-01-01T12:34:56.000Z' })
    const line = renderLogEntry(entry, false, 80)
    // Should contain HH:MM:SS somewhere (exact time depends on local timezone)
    expect(line).toMatch(/\d{2}:\d{2}:\d{2}/)
  })

  it('formats line with [ts] [key] prefix', () => {
    const entry = makeEntry({ key: '5-3', ts: '2026-01-01T10:00:00.000Z' })
    const line = renderLogEntry(entry, false, 120)
    expect(line).toContain('[5-3]')
    expect(line).toContain(']')
  })

  it('applies yellow ANSI code for warn level with color', () => {
    const entry = makeEntry({ level: 'warn' })
    const line = renderLogEntry(entry, true, 80)
    expect(line).toContain('\x1b[33m') // YELLOW
  })

  it('does not apply yellow for log level with color', () => {
    const entry = makeEntry({ level: 'log' })
    const line = renderLogEntry(entry, true, 80)
    expect(line).not.toContain('\x1b[33m')
  })

  it('includes cyan ANSI code for key in log level with color', () => {
    const entry = makeEntry({ level: 'log' })
    const line = renderLogEntry(entry, true, 80)
    expect(line).toContain('\x1b[36m') // CYAN
  })

  it('returns plain text without ANSI codes when useColor is false', () => {
    const entry = makeEntry({ level: 'warn' })
    const line = renderLogEntry(entry, false, 80)
    expect(line).not.toContain('\x1b[')
  })

  it('truncates message to fit available width', () => {
    const longMsg = 'A'.repeat(200)
    const entry = makeEntry({ msg: longMsg })
    const line = renderLogEntry(entry, false, 50)
    // Line should be shorter than 200 + prefix
    expect(line.length).toBeLessThan(200)
  })
})

// ---------------------------------------------------------------------------
// renderLogPanel
// ---------------------------------------------------------------------------

describe('renderLogPanel', () => {
  it('returns an array of strings', () => {
    const lines = renderLogPanel({ entries: [], maxLines: 10, useColor: false, width: 80 })
    expect(Array.isArray(lines)).toBe(true)
  })

  it('shows (no log entries) when entries is empty', () => {
    const lines = renderLogPanel({ entries: [], maxLines: 10, useColor: false, width: 80 })
    expect(lines.join('\n')).toContain('(no log entries)')
  })

  it('shows "Live Logs" title when no filterKey', () => {
    const lines = renderLogPanel({ entries: [], maxLines: 10, useColor: false, width: 80 })
    expect(lines.join('\n')).toContain('Live Logs')
  })

  it('shows "Logs for <key>" title when filterKey is provided', () => {
    const lines = renderLogPanel({
      entries: [],
      maxLines: 10,
      useColor: false,
      width: 80,
      filterKey: '10-1',
    })
    expect(lines.join('\n')).toContain('Logs for 10-1')
  })

  it('renders all entries when count <= maxLines', () => {
    const entries = [
      makeEntry({ msg: 'first' }),
      makeEntry({ msg: 'second' }),
      makeEntry({ msg: 'third' }),
    ]
    const lines = renderLogPanel({ entries, maxLines: 10, useColor: false, width: 80 })
    const output = lines.join('\n')
    expect(output).toContain('first')
    expect(output).toContain('second')
    expect(output).toContain('third')
  })

  it('auto-scrolls to show only last maxLines entries', () => {
    // Use messages that won't be substrings of each other
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ msg: `msg-${String(i + 1).padStart(3, '0')}` }),
    )
    const lines = renderLogPanel({ entries, maxLines: 3, useColor: false, width: 80 })
    const output = lines.join('\n')
    // Should show last 3
    expect(output).toContain('msg-008')
    expect(output).toContain('msg-009')
    expect(output).toContain('msg-010')
    // Should NOT show earlier ones
    expect(output).not.toContain('msg-001')
    expect(output).not.toContain('msg-007')
  })

  it('filters entries by filterKey', () => {
    const entries = [
      makeEntry({ key: '10-1', msg: 'from 10-1' }),
      makeEntry({ key: '10-2', msg: 'from 10-2' }),
      makeEntry({ key: '10-1', msg: 'also from 10-1' }),
    ]
    const lines = renderLogPanel({
      entries,
      maxLines: 10,
      useColor: false,
      width: 80,
      filterKey: '10-1',
    })
    const output = lines.join('\n')
    expect(output).toContain('from 10-1')
    expect(output).toContain('also from 10-1')
    expect(output).not.toContain('from 10-2')
  })

  it('shows (no log entries) when filterKey has no matching entries', () => {
    const entries = [makeEntry({ key: '10-1' })]
    const lines = renderLogPanel({
      entries,
      maxLines: 10,
      useColor: false,
      width: 80,
      filterKey: '10-99',
    })
    expect(lines.join('\n')).toContain('(no log entries)')
  })

  it('includes a separator line', () => {
    const lines = renderLogPanel({ entries: [], maxLines: 10, useColor: false, width: 80 })
    const output = lines.join('\n')
    expect(output).toContain('─')
  })

  it('includes ANSI codes when useColor is true and entries exist', () => {
    const entries = [makeEntry()]
    const lines = renderLogPanel({ entries, maxLines: 10, useColor: true, width: 80 })
    const output = lines.join('\n')
    expect(output).toContain('\x1b[')
  })

  it('does not include ANSI codes in log entries when useColor is false', () => {
    const entries = [makeEntry({ level: 'warn' })]
    const lines = renderLogPanel({ entries, maxLines: 10, useColor: false, width: 80 })
    // Separator check only; log entry should be plain
    const entryLines = lines.filter((l) => l.includes('test message'))
    for (const line of entryLines) {
      expect(line).not.toContain('\x1b[')
    }
  })

  it('handles a single entry', () => {
    const entries = [makeEntry({ msg: 'single entry' })]
    const lines = renderLogPanel({ entries, maxLines: 5, useColor: false, width: 80 })
    expect(lines.join('\n')).toContain('single entry')
  })

  it('renders warn-level entries with different formatting in color mode', () => {
    const entries = [makeEntry({ level: 'warn', msg: 'a warning' })]
    const lines = renderLogPanel({ entries, maxLines: 5, useColor: true, width: 80 })
    const output = lines.join('\n')
    expect(output).toContain('\x1b[33m') // YELLOW for warn
    expect(output).toContain('a warning')
  })
})
