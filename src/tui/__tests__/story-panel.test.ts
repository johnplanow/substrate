/**
 * Unit tests for StoryPanel component (story-panel.ts).
 *
 * Covers:
 *   - renderStoryPanelHeader (with/without color)
 *   - renderStoryRow for each status (pending, in_progress, succeeded, failed, escalated)
 *   - renderStoryRow selection highlighting (color and no-color)
 *   - renderStoryPanel with empty stories
 *   - renderStoryPanel with multiple stories
 *   - renderStoryPanel selection propagation
 */

import { describe, it, expect } from 'vitest'
import {
  renderStoryPanelHeader,
  renderStoryRow,
  renderStoryPanel,
} from '../story-panel.js'
import type { TuiStoryState } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(overrides: Partial<TuiStoryState> = {}): TuiStoryState {
  return {
    key: '10-1',
    phase: 'wait',
    status: 'pending',
    statusLabel: 'queued',
    reviewCycles: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// renderStoryPanelHeader
// ---------------------------------------------------------------------------

describe('renderStoryPanelHeader', () => {
  it('contains column headers', () => {
    const header = renderStoryPanelHeader(false)
    expect(header).toContain('STORY')
    expect(header).toContain('PHASE')
    expect(header).toContain('STATUS')
  })

  it('returns a non-empty string', () => {
    expect(renderStoryPanelHeader(false)).toBeTruthy()
    expect(renderStoryPanelHeader(true)).toBeTruthy()
  })

  it('includes ANSI codes when useColor is true', () => {
    const header = renderStoryPanelHeader(true)
    expect(header).toContain('\x1b[')
  })

  it('does not include ANSI codes when useColor is false', () => {
    const header = renderStoryPanelHeader(false)
    expect(header).not.toContain('\x1b[')
  })
})

// ---------------------------------------------------------------------------
// renderStoryRow — status colors
// ---------------------------------------------------------------------------

describe('renderStoryRow', () => {
  it('includes the story key', () => {
    const story = makeStory({ key: '10-1' })
    const row = renderStoryRow(story, false, false, 80)
    expect(row).toContain('10-1')
  })

  it('includes the phase', () => {
    const story = makeStory({ phase: 'dev' })
    const row = renderStoryRow(story, false, false, 80)
    expect(row).toContain('dev')
  })

  it('includes the status label', () => {
    const story = makeStory({ statusLabel: 'implementing...' })
    const row = renderStoryRow(story, false, false, 80)
    expect(row).toContain('implementing...')
  })

  it('shows pending symbol ○ for pending status', () => {
    const story = makeStory({ status: 'pending' })
    const row = renderStoryRow(story, false, false, 80)
    expect(row).toContain('○')
  })

  it('shows in_progress symbol ◉ for in_progress status', () => {
    const story = makeStory({ status: 'in_progress' })
    const row = renderStoryRow(story, false, false, 80)
    expect(row).toContain('◉')
  })

  it('shows succeeded symbol ✓ for succeeded status', () => {
    const story = makeStory({ status: 'succeeded' })
    const row = renderStoryRow(story, false, false, 80)
    expect(row).toContain('✓')
  })

  it('shows failed symbol ✗ for failed status', () => {
    const story = makeStory({ status: 'failed' })
    const row = renderStoryRow(story, false, false, 80)
    expect(row).toContain('✗')
  })

  it('shows escalated symbol ✗ for escalated status', () => {
    const story = makeStory({ status: 'escalated' })
    const row = renderStoryRow(story, false, false, 80)
    expect(row).toContain('✗')
  })

  it('applies yellow ANSI code for in_progress status with color', () => {
    const story = makeStory({ status: 'in_progress' })
    const row = renderStoryRow(story, false, true, 80)
    expect(row).toContain('\x1b[33m') // YELLOW
  })

  it('applies green ANSI code for succeeded status with color', () => {
    const story = makeStory({ status: 'succeeded' })
    const row = renderStoryRow(story, false, true, 80)
    expect(row).toContain('\x1b[32m') // GREEN
  })

  it('applies red ANSI code for failed status with color', () => {
    const story = makeStory({ status: 'failed' })
    const row = renderStoryRow(story, false, true, 80)
    expect(row).toContain('\x1b[31m') // RED
  })

  it('applies red ANSI code for escalated status with color', () => {
    const story = makeStory({ status: 'escalated' })
    const row = renderStoryRow(story, false, true, 80)
    expect(row).toContain('\x1b[31m') // RED
  })

  it('applies bright black ANSI code for pending status with color', () => {
    const story = makeStory({ status: 'pending' })
    const row = renderStoryRow(story, false, true, 80)
    expect(row).toContain('\x1b[90m') // BRIGHT_BLACK
  })

  it('does not include ANSI codes when useColor is false', () => {
    const story = makeStory({ status: 'succeeded' })
    const row = renderStoryRow(story, false, false, 80)
    expect(row).not.toContain('\x1b[')
  })
})

// ---------------------------------------------------------------------------
// renderStoryRow — selection highlighting
// ---------------------------------------------------------------------------

describe('renderStoryRow — selection', () => {
  it('prefixes with > when selected and no color', () => {
    const story = makeStory()
    const row = renderStoryRow(story, true, false, 80)
    expect(row).toMatch(/^>/)
  })

  it('does not prefix with > when not selected and no color', () => {
    const story = makeStory()
    const row = renderStoryRow(story, false, false, 80)
    expect(row).not.toMatch(/^>/)
  })

  it('includes BG_BRIGHT_BLACK ANSI code when selected and useColor is true', () => {
    const story = makeStory()
    const row = renderStoryRow(story, true, true, 80)
    expect(row).toContain('\x1b[100m') // BG_BRIGHT_BLACK
  })

  it('does not include BG_BRIGHT_BLACK when not selected', () => {
    const story = makeStory()
    const row = renderStoryRow(story, false, true, 80)
    expect(row).not.toContain('\x1b[100m')
  })
})

// ---------------------------------------------------------------------------
// renderStoryPanel
// ---------------------------------------------------------------------------

describe('renderStoryPanel', () => {
  it('returns an array of strings', () => {
    const lines = renderStoryPanel({ stories: [], selectedIndex: 0, useColor: false, width: 80 })
    expect(Array.isArray(lines)).toBe(true)
  })

  it('shows (no stories) when stories is empty', () => {
    const lines = renderStoryPanel({ stories: [], selectedIndex: 0, useColor: false, width: 80 })
    expect(lines.join('\n')).toContain('(no stories)')
  })

  it('includes the title Story Status', () => {
    const lines = renderStoryPanel({ stories: [], selectedIndex: 0, useColor: false, width: 80 })
    expect(lines.join('\n')).toContain('Story Status')
  })

  it('includes column headers in the panel', () => {
    const lines = renderStoryPanel({ stories: [], selectedIndex: 0, useColor: false, width: 80 })
    const output = lines.join('\n')
    expect(output).toContain('STORY')
    expect(output).toContain('PHASE')
    expect(output).toContain('STATUS')
  })

  it('renders a row for each story', () => {
    const stories = [
      makeStory({ key: '10-1' }),
      makeStory({ key: '10-2' }),
      makeStory({ key: '10-3' }),
    ]
    const lines = renderStoryPanel({ stories, selectedIndex: 0, useColor: false, width: 80 })
    const output = lines.join('\n')
    expect(output).toContain('10-1')
    expect(output).toContain('10-2')
    expect(output).toContain('10-3')
  })

  it('marks the correct row as selected', () => {
    const stories = [
      makeStory({ key: '10-1' }),
      makeStory({ key: '10-2' }),
    ]
    const lines = renderStoryPanel({ stories, selectedIndex: 1, useColor: false, width: 80 })
    // The second row should have selection marker
    // With no color, selected row starts with >
    const selectedLine = lines.find((l) => l.startsWith('>'))
    expect(selectedLine).toBeDefined()
    expect(selectedLine).toContain('10-2')
  })

  it('renders a separator line', () => {
    const lines = renderStoryPanel({ stories: [], selectedIndex: 0, useColor: false, width: 80 })
    const output = lines.join('\n')
    expect(output).toContain('─')
  })

  it('handles a single story', () => {
    const stories = [makeStory({ key: '5-1', status: 'succeeded', statusLabel: 'SHIP_IT', phase: 'done' })]
    const lines = renderStoryPanel({ stories, selectedIndex: 0, useColor: false, width: 80 })
    const output = lines.join('\n')
    expect(output).toContain('5-1')
    expect(output).toContain('SHIP_IT')
    expect(output).toContain('done')
  })

  it('does not include ANSI codes when useColor is false', () => {
    const stories = [makeStory()]
    const lines = renderStoryPanel({ stories, selectedIndex: 0, useColor: false, width: 80 })
    const output = lines.join('\n')
    expect(output).not.toContain('\x1b[')
  })

  it('includes ANSI codes when useColor is true', () => {
    const stories = [makeStory()]
    const lines = renderStoryPanel({ stories, selectedIndex: 0, useColor: true, width: 80 })
    const output = lines.join('\n')
    expect(output).toContain('\x1b[')
  })
})
