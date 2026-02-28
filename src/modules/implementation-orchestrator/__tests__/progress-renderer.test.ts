/**
 * Unit tests for createProgressRenderer().
 *
 * Covers:
 *   - TTY mode: in-place line rewrites with ANSI escape sequences
 *   - Non-TTY mode: plain-text line appending (no cursor manipulation)
 *   - All event types: pipeline:start, story:phase, story:done,
 *     story:escalation, story:warn, pipeline:complete
 *   - Color support (NO_COLOR env var)
 *   - Terminal-state display (SHIP_IT, ESCALATED, FAILED)
 *   - Unknown / silently-ignored events (story:log)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Writable } from 'node:stream'
import { createProgressRenderer } from '../progress-renderer.js'
import type {
  PipelineStartEvent,
  PipelineCompleteEvent,
  StoryPhaseEvent,
  StoryDoneEvent,
  StoryEscalationEvent,
  StoryWarnEvent,
  StoryLogEvent,
} from '../event-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a Writable stream that captures all writes as a single string. */
function makeCapture(): { stream: Writable; output(): string; chunks: string[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })
  return {
    stream,
    output: () => chunks.join(''),
    chunks,
  }
}

/** Builds a minimal PipelineStartEvent. */
function startEvent(stories: string[], concurrency = 3): PipelineStartEvent {
  return {
    type: 'pipeline:start',
    ts: new Date().toISOString(),
    run_id: 'run-1',
    stories,
    concurrency,
  }
}

/** Builds a StoryPhaseEvent. */
function phaseEvent(
  key: string,
  phase: StoryPhaseEvent['phase'],
  status: StoryPhaseEvent['status'],
  verdict?: string,
): StoryPhaseEvent {
  return { type: 'story:phase', ts: new Date().toISOString(), key, phase, status, verdict }
}

/** Builds a StoryDoneEvent. */
function doneEvent(key: string, result: 'success' | 'failed', review_cycles = 1): StoryDoneEvent {
  return { type: 'story:done', ts: new Date().toISOString(), key, result, review_cycles }
}

/** Builds a StoryEscalationEvent. */
function escalationEvent(key: string, reason: string, cycles = 3): StoryEscalationEvent {
  return {
    type: 'story:escalation',
    ts: new Date().toISOString(),
    key,
    reason,
    cycles,
    issues: [],
  }
}

/** Builds a StoryWarnEvent. */
function warnEvent(key: string, msg: string): StoryWarnEvent {
  return { type: 'story:warn', ts: new Date().toISOString(), key, msg }
}

/** Builds a PipelineCompleteEvent. */
function completeEvent(
  succeeded: string[],
  failed: string[] = [],
  escalated: string[] = [],
): PipelineCompleteEvent {
  return { type: 'pipeline:complete', ts: new Date().toISOString(), succeeded, failed, escalated }
}

/** Builds a StoryLogEvent (should be silently ignored). */
function logEvent(key: string, msg: string): StoryLogEvent {
  return { type: 'story:log', ts: new Date().toISOString(), key, msg }
}

// ---------------------------------------------------------------------------
// Non-TTY mode tests
// ---------------------------------------------------------------------------

describe('createProgressRenderer — non-TTY mode', () => {
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

  it('writes the header line on pipeline:start', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1', '10-2'], 3))

    const out = output()
    expect(out).toContain('substrate auto run — 2 stories, concurrency 3')
  })

  it('writes a blank line after the header in non-TTY mode', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))

    const out = output()
    expect(out).toContain('substrate auto run — 1 stories, concurrency 3\n\n')
  })

  it('writes a phase line for story:phase in_progress', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(phaseEvent('10-1', 'create-story', 'in_progress'))

    const out = output()
    expect(out).toContain('[create] 10-1 creating story...')
  })

  it('writes correct label for dev-story in_progress', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(phaseEvent('10-1', 'dev-story', 'in_progress'))

    expect(output()).toContain('[dev   ] 10-1 implementing...')
  })

  it('writes correct label for code-review in_progress', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(phaseEvent('10-1', 'code-review', 'in_progress'))

    expect(output()).toContain('[review] 10-1 reviewing...')
  })

  it('writes correct label for fix in_progress', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(phaseEvent('10-1', 'fix', 'in_progress'))

    expect(output()).toContain('[fix   ] 10-1 fixing issues...')
  })

  it('writes correct label for story:phase complete (code-review with verdict)', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(phaseEvent('10-1', 'code-review', 'complete', 'SHIP_IT'))

    expect(output()).toContain('[review] 10-1 reviewed (SHIP_IT)')
  })

  it('writes correct label for story:phase complete (code-review without verdict)', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(phaseEvent('10-1', 'code-review', 'complete'))

    expect(output()).toContain('[review] 10-1 reviewed')
  })

  it('writes correct label for create-story complete', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(phaseEvent('10-1', 'create-story', 'complete'))

    expect(output()).toContain('[create] 10-1 story created')
  })

  it('writes correct label for dev-story complete', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(phaseEvent('10-1', 'dev-story', 'complete'))

    expect(output()).toContain('[dev   ] 10-1 implemented')
  })

  it('writes correct label for fix complete', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(phaseEvent('10-1', 'fix', 'complete'))

    expect(output()).toContain('[fix   ] 10-1 fixes applied')
  })

  it('writes correct label for story:phase failed', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(phaseEvent('10-1', 'dev-story', 'failed'))

    expect(output()).toContain('[dev   ] 10-1 failed')
  })

  it('writes SHIP_IT line on story:done success (singular cycle)', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(doneEvent('10-1', 'success', 1))

    expect(output()).toContain('[done  ] 10-1 SHIP_IT (1 cycle)')
  })

  it('writes SHIP_IT line on story:done success (plural cycles)', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(doneEvent('10-1', 'success', 3))

    expect(output()).toContain('[done  ] 10-1 SHIP_IT (3 cycles)')
  })

  it('writes FAILED line on story:done failed', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(doneEvent('10-1', 'failed', 0))

    expect(output()).toContain('[failed] 10-1 FAILED')
  })

  it('writes escalation line on story:escalation', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(escalationEvent('10-1', 'Max cycles exceeded'))

    expect(output()).toContain('[escalated] 10-1 — Max cycles exceeded')
  })

  it('writes warning line on story:warn', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(warnEvent('10-1', 'token ceiling hit'))

    expect(output()).toContain('warning [10-1]: token ceiling hit')
  })

  it('writes summary line on pipeline:complete with only succeeded', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(completeEvent(['10-1']))

    expect(output()).toContain('Pipeline complete: 1 succeeded, 0 failed, 0 escalated')
  })

  it('writes failed keys in summary on pipeline:complete', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1', '10-2']))
    renderer.render(completeEvent(['10-1'], ['10-2']))

    const out = output()
    expect(out).toContain('Pipeline complete: 1 succeeded, 1 failed, 0 escalated')
    expect(out).toContain('  failed: 10-2')
  })

  it('writes escalated keys in summary on pipeline:complete', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1', '10-2']))
    renderer.render(escalationEvent('10-2', 'Too many issues'))
    renderer.render(completeEvent(['10-1'], [], ['10-2']))

    const out = output()
    expect(out).toContain('Pipeline complete: 1 succeeded, 0 failed, 1 escalated')
    expect(out).toContain('  escalated: 10-2 — Too many issues')
  })

  it('silently ignores story:log events', () => {
    const { stream, chunks } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    const before = chunks.length
    renderer.render(logEvent('10-1', 'some log message'))
    // No new chunks should have been added by the log event (no non-TTY line for it)
    const out = chunks.slice(before).join('')
    expect(out).toBe('')
  })

  it('handles story:phase for a story not in pipeline:start', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    // No pipeline:start — just a phase event for an unknown story
    renderer.render(phaseEvent('10-99', 'create-story', 'in_progress'))

    expect(output()).toContain('[create] 10-99 creating story...')
  })

  it('handles story:done for a story not in pipeline:start', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(doneEvent('10-99', 'success', 2))

    expect(output()).toContain('[done  ] 10-99 SHIP_IT (2 cycles)')
  })

  it('handles story:escalation for a story not in pipeline:start', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(escalationEvent('10-99', 'Unknown error'))

    expect(output()).toContain('[escalated] 10-99 — Unknown error')
  })

  it('does not write more output after pipeline:complete', () => {
    const { stream, chunks } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(completeEvent(['10-1']))

    const beforeLen = chunks.join('').length

    // Feed another phase event — should be ignored
    renderer.render(phaseEvent('10-1', 'dev-story', 'in_progress'))

    const afterLen = chunks.join('').length
    expect(afterLen).toBe(beforeLen)
  })
})

// ---------------------------------------------------------------------------
// TTY mode tests
// ---------------------------------------------------------------------------

describe('createProgressRenderer — TTY mode', () => {
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

  it('writes the header block on pipeline:start', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, true)

    renderer.render(startEvent(['10-1', '10-2'], 2))

    expect(output()).toContain('substrate auto run — 2 stories, concurrency 2')
  })

  it('includes story key in TTY render after pipeline:start', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, true)

    renderer.render(startEvent(['10-1'], 1))

    expect(output()).toContain('10-1')
  })

  it('uses ANSI cursor-up escape to overwrite previous render on second event', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, true)

    renderer.render(startEvent(['10-1']))
    renderer.render(phaseEvent('10-1', 'create-story', 'in_progress'))

    // Should contain cursor-up ANSI code (\x1b[{n}A)
    expect(output()).toMatch(/\x1b\[\d+A/)
  })

  it('clears screen portion with \\x1b[J on redraw', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, true)

    renderer.render(startEvent(['10-1']))
    renderer.render(phaseEvent('10-1', 'create-story', 'in_progress'))

    expect(output()).toContain('\x1b[J')
  })

  it('writes SHIP_IT with green color on story:done success in TTY mode', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, true)

    renderer.render(startEvent(['10-1']))
    renderer.render(doneEvent('10-1', 'success', 1))
    renderer.render(completeEvent(['10-1']))

    // ANSI green escape code
    expect(output()).toContain('\x1b[32m')
    expect(output()).toContain('SHIP_IT')
  })

  it('writes ESCALATED with red color in TTY mode', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, true)

    renderer.render(startEvent(['10-1']))
    renderer.render(escalationEvent('10-1', 'Too many blockers'))
    renderer.render(completeEvent([], [], ['10-1']))

    expect(output()).toContain('\x1b[31m')
    expect(output()).toContain('ESCALATED')
  })

  it('writes FAILED with red color on story:done failed in TTY mode', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, true)

    renderer.render(startEvent(['10-1']))
    renderer.render(doneEvent('10-1', 'failed', 0))
    renderer.render(completeEvent([], ['10-1']))

    expect(output()).toContain('\x1b[31m')
    expect(output()).toContain('FAILED')
  })

  it('writes warning line in yellow in TTY mode with color', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, true)

    renderer.render(startEvent(['10-1']))
    renderer.render(warnEvent('10-1', 'token ceiling hit'))

    expect(output()).toContain('\x1b[33m')
    expect(output()).toContain('warning [10-1]: token ceiling hit')
  })

  it('renders final complete summary after pipeline:complete', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, true)

    renderer.render(startEvent(['10-1']))
    renderer.render(doneEvent('10-1', 'success', 1))
    renderer.render(completeEvent(['10-1']))

    expect(output()).toContain('Pipeline complete: 1 succeeded, 0 failed, 0 escalated')
  })

  it('re-renders header in final complete display in TTY mode', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, true)

    renderer.render(startEvent(['10-1'], 2))
    renderer.render(completeEvent(['10-1']))

    const out = output()
    // Header should appear at least twice (once on start, once on complete)
    const occurrences = out.split('substrate auto run — 1 stories, concurrency 2').length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })

  it('does not manipulate cursor if no lines were previously rendered', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, true)

    // Directly call complete without any prior events
    renderer.render(completeEvent(['10-1']))

    // Should not contain cursor-up since lastRenderedLines is 0
    const cursorUpMatches = output().match(/\x1b\[\d+A/)
    expect(cursorUpMatches).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// NO_COLOR env var tests
// ---------------------------------------------------------------------------

describe('createProgressRenderer — NO_COLOR', () => {
  beforeEach(() => {
    process.env.NO_COLOR = '1'
  })

  afterEach(() => {
    delete process.env.NO_COLOR
  })

  it('does not emit color codes when NO_COLOR is set (TTY mode)', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, true)

    renderer.render(startEvent(['10-1']))
    renderer.render(doneEvent('10-1', 'success', 1))
    renderer.render(completeEvent(['10-1']))

    // No ANSI color codes (cursor-up is still used but no color)
    const out = output()
    expect(out).not.toContain('\x1b[32m') // no green
    expect(out).not.toContain('\x1b[31m') // no red
    expect(out).not.toContain('\x1b[33m') // no yellow
    expect(out).toContain('SHIP_IT')
  })

  it('does not emit color codes in non-TTY mode with NO_COLOR set', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['10-1']))
    renderer.render(warnEvent('10-1', 'a warning'))

    const out = output()
    expect(out).not.toContain('\x1b[33m')
    expect(out).toContain('warning [10-1]: a warning')
  })
})

// ---------------------------------------------------------------------------
// isTTY override tests
// ---------------------------------------------------------------------------

describe('createProgressRenderer — isTTY override', () => {
  it('uses stream.isTTY when isTTY parameter is not provided', () => {
    const { stream, output } = makeCapture()
    // Simulate a TTY stream by setting isTTY property
    ;(stream as NodeJS.WriteStream).isTTY = true

    const renderer = createProgressRenderer(stream)
    renderer.render(startEvent(['10-1']))

    // In TTY mode, header is written without extra blank line (redraw handles it)
    expect(output()).toContain('substrate auto run — 1 stories, concurrency 3')
  })

  it('defaults to non-TTY when stream.isTTY is undefined', () => {
    const { stream, output } = makeCapture()
    // Ensure isTTY is not set
    ;(stream as NodeJS.WriteStream).isTTY = undefined as unknown as true

    const renderer = createProgressRenderer(stream)
    renderer.render(startEvent(['10-1']))

    // Non-TTY mode: header + blank line
    expect(output()).toContain('substrate auto run — 1 stories, concurrency 3\n\n')
  })
})
