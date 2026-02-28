/**
 * Unit tests for HelpOverlay component (help-overlay.ts).
 *
 * Covers:
 *   - renderHelpOverlay returns array of strings
 *   - Contains all keyboard shortcuts
 *   - Box drawing characters
 *   - "Press ? to close" footer
 *   - Color / no-color modes
 *   - Width adaptation
 */

import { describe, it, expect } from 'vitest'
import { renderHelpOverlay } from '../help-overlay.js'

// ---------------------------------------------------------------------------
// renderHelpOverlay
// ---------------------------------------------------------------------------

describe('renderHelpOverlay', () => {
  const defaultOpts = { useColor: false, width: 80 }

  it('returns an array of strings', () => {
    const lines = renderHelpOverlay(defaultOpts)
    expect(Array.isArray(lines)).toBe(true)
    expect(lines.length).toBeGreaterThan(0)
  })

  it('contains Keyboard Shortcuts header', () => {
    const output = renderHelpOverlay(defaultOpts).join('\n')
    expect(output).toContain('Keyboard Shortcuts')
  })

  it('contains arrow key navigation shortcut', () => {
    const output = renderHelpOverlay(defaultOpts).join('\n')
    expect(output).toContain('Navigate between stories')
  })

  it('contains Enter shortcut description', () => {
    // Use a wide terminal so the description is not truncated
    const output = renderHelpOverlay({ useColor: false, width: 200 }).join('\n')
    expect(output).toContain('Drill into selected story detail view')
  })

  it('contains Esc shortcut description', () => {
    // Use a wide terminal so the description is not truncated
    const output = renderHelpOverlay({ useColor: false, width: 200 }).join('\n')
    expect(output).toContain('Return to overview from detail view')
  })

  it('contains q shortcut description', () => {
    const output = renderHelpOverlay(defaultOpts).join('\n')
    expect(output).toContain('Quit TUI')
  })

  it('contains ? shortcut description', () => {
    const output = renderHelpOverlay(defaultOpts).join('\n')
    expect(output).toContain('Show/hide this help overlay')
  })

  it('contains box drawing characters (border)', () => {
    const output = renderHelpOverlay(defaultOpts).join('\n')
    // Should include box drawing characters
    expect(output).toMatch(/[┌┐└┘├┤─│]/)
  })

  it('includes "Press ? to close" footer', () => {
    const output = renderHelpOverlay(defaultOpts).join('\n')
    expect(output).toContain('Press ? to close')
  })

  it('includes ANSI codes when useColor is true', () => {
    const output = renderHelpOverlay({ useColor: true, width: 80 }).join('\n')
    expect(output).toContain('\x1b[')
  })

  it('includes cyan ANSI code for the border when useColor is true', () => {
    const output = renderHelpOverlay({ useColor: true, width: 80 }).join('\n')
    expect(output).toContain('\x1b[36m') // CYAN
  })

  it('does not include ANSI codes when useColor is false', () => {
    const output = renderHelpOverlay({ useColor: false, width: 80 }).join('\n')
    expect(output).not.toContain('\x1b[')
  })

  it('adapts to narrow width', () => {
    // Width 40 should still render without error
    const lines = renderHelpOverlay({ useColor: false, width: 40 })
    expect(Array.isArray(lines)).toBe(true)
    expect(lines.length).toBeGreaterThan(0)
  })

  it('adapts to wide width without exceeding 56 character box', () => {
    // Width 200 should cap box at 56
    const lines = renderHelpOverlay({ useColor: false, width: 200 })
    expect(Array.isArray(lines)).toBe(true)
    // Box line should not be excessively long
    const borderLine = lines.find((l) => l.includes('┌'))
    if (borderLine !== undefined) {
      // Strip any leading spaces
      expect(borderLine.trim().length).toBeLessThanOrEqual(58)
    }
  })

  it('renders the correct number of key binding rows', () => {
    // There are 5 key bindings: ↑/↓, Enter, Esc, q, ?
    // Plus 1 header row ("Keyboard Shortcuts") = 6 content rows total
    const lines = renderHelpOverlay(defaultOpts)
    // Each binding is one line; count lines containing │ (box content lines, excluding border lines)
    const contentLines = lines.filter(
      (l) => l.includes('│') && !l.includes('┌') && !l.includes('└') && !l.includes('├'),
    )
    // 1 header row + 5 binding rows = 6
    expect(contentLines.length).toBe(6)
  })
})
