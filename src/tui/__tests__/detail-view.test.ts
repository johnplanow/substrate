/**
 * Unit tests for DetailView component (detail-view.ts).
 *
 * Covers:
 *   - renderDetailView header and title bar
 *   - Story info lines (phase, status, review cycles)
 *   - Escalation reason display
 *   - Log panel integration (filtered logs)
 *   - Back navigation hint
 *   - Color / no-color modes
 */

import { describe, it, expect } from 'vitest'
import { renderDetailView } from '../detail-view.js'
import type { TuiStoryState, TuiLogEntry } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(overrides: Partial<TuiStoryState> = {}): TuiStoryState {
  return {
    key: '10-1',
    phase: 'dev',
    status: 'in_progress',
    statusLabel: 'implementing...',
    reviewCycles: 0,
    ...overrides,
  }
}

function makeLog(overrides: Partial<TuiLogEntry> = {}): TuiLogEntry {
  return {
    ts: '2026-01-01T10:00:00.000Z',
    key: '10-1',
    msg: 'a log message',
    level: 'log',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// renderDetailView
// ---------------------------------------------------------------------------

describe('renderDetailView', () => {
  const defaultOpts = {
    story: makeStory(),
    allLogs: [],
    maxLogLines: 10,
    useColor: false,
    width: 80,
    height: 24,
  }

  it('returns an array of strings', () => {
    const lines = renderDetailView(defaultOpts)
    expect(Array.isArray(lines)).toBe(true)
    expect(lines.length).toBeGreaterThan(0)
  })

  it('includes story key in the title bar', () => {
    const lines = renderDetailView({ ...defaultOpts, story: makeStory({ key: '5-3' }) })
    const output = lines.join('\n')
    expect(output).toContain('5-3')
  })

  it('includes "Story Detail" in the title bar', () => {
    const lines = renderDetailView(defaultOpts)
    expect(lines.join('\n')).toContain('Story Detail')
  })

  it('includes a double-line separator', () => {
    const lines = renderDetailView(defaultOpts)
    const output = lines.join('\n')
    expect(output).toContain('═')
  })

  it('displays the story phase', () => {
    const lines = renderDetailView({ ...defaultOpts, story: makeStory({ phase: 'review' }) })
    expect(lines.join('\n')).toContain('review')
  })

  it('displays the story status label', () => {
    const lines = renderDetailView({
      ...defaultOpts,
      story: makeStory({ statusLabel: 'reviewing...' }),
    })
    expect(lines.join('\n')).toContain('reviewing...')
  })

  it('displays the review cycle count', () => {
    const lines = renderDetailView({
      ...defaultOpts,
      story: makeStory({ reviewCycles: 2 }),
    })
    expect(lines.join('\n')).toContain('2')
  })

  it('does not show escalation line when escalationReason is undefined', () => {
    const lines = renderDetailView({
      ...defaultOpts,
      story: makeStory({ escalationReason: undefined }),
    })
    expect(lines.join('\n')).not.toContain('Escalated:')
  })

  it('shows escalation reason when escalationReason is set', () => {
    const lines = renderDetailView({
      ...defaultOpts,
      story: makeStory({
        status: 'escalated',
        phase: 'escalated',
        escalationReason: 'Too many blockers',
      }),
    })
    expect(lines.join('\n')).toContain('Too many blockers')
  })

  it('shows escalation line label when escalationReason is set', () => {
    const lines = renderDetailView({
      ...defaultOpts,
      story: makeStory({ escalationReason: 'Blocker found' }),
    })
    expect(lines.join('\n')).toContain('Escalated:')
  })

  it('includes [Esc] Back to overview hint', () => {
    const lines = renderDetailView(defaultOpts)
    expect(lines.join('\n')).toContain('[Esc] Back to overview')
  })

  it('shows (no log entries) when allLogs is empty', () => {
    const lines = renderDetailView({ ...defaultOpts, allLogs: [] })
    expect(lines.join('\n')).toContain('(no log entries)')
  })

  it('shows logs filtered to the story key', () => {
    const allLogs = [
      makeLog({ key: '10-1', msg: 'from target story' }),
      makeLog({ key: '10-2', msg: 'from other story' }),
    ]
    const lines = renderDetailView({ ...defaultOpts, allLogs })
    const output = lines.join('\n')
    expect(output).toContain('from target story')
    expect(output).not.toContain('from other story')
  })

  it('includes Logs for <key> title in the log section', () => {
    const lines = renderDetailView({ ...defaultOpts, story: makeStory({ key: '7-2' }) })
    expect(lines.join('\n')).toContain('Logs for 7-2')
  })

  it('includes ANSI codes when useColor is true', () => {
    const lines = renderDetailView({ ...defaultOpts, useColor: true })
    expect(lines.join('\n')).toContain('\x1b[')
  })

  it('does not include ANSI codes when useColor is false', () => {
    // The "Phase:", "Status:" labels are bolded even in no-color when useColor=false
    // But no escape codes should appear
    const lines = renderDetailView({ ...defaultOpts, useColor: false })
    // Only check non-header lines for ANSI (header might have none)
    const output = lines.join('\n')
    expect(output).not.toContain('\x1b[')
  })

  it('uses Phase: label for the phase field', () => {
    const lines = renderDetailView(defaultOpts)
    expect(lines.join('\n')).toContain('Phase:')
  })

  it('uses Status: label for the status field', () => {
    const lines = renderDetailView(defaultOpts)
    expect(lines.join('\n')).toContain('Status:')
  })
})
