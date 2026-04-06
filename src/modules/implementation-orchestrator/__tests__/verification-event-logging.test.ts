/**
 * Unit tests for Story 51-6: Verification Events and Logging
 *
 * Covers:
 *   - EVENT_TYPE_NAMES includes both new verification event type strings
 *   - Progress renderer handles verification:check-complete events
 *   - Progress renderer handles verification:story-complete events (pass, warn, fail)
 *   - Progress renderer handles unknown story keys gracefully
 *   - Progress renderer does not un-terminal a story after story:done
 *   - wireNdjsonEmitter forwards verification events to the NDJSON stream
 */

import { describe, it, expect, vi } from 'vitest'
import { Writable } from 'node:stream'
import { EVENT_TYPE_NAMES } from '../event-types.js'
import { createProgressRenderer } from '../progress-renderer.js'
import { wireNdjsonEmitter } from '../../../cli/commands/run.js'
import type {
  PipelineStartEvent,
  StoryDoneEvent,
  VerificationCheckCompleteEvent,
  VerificationStoryCompleteEvent,
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

function startEvent(stories: string[], concurrency = 3): PipelineStartEvent {
  return {
    type: 'pipeline:start',
    ts: new Date().toISOString(),
    run_id: 'run-1',
    stories,
    concurrency,
  }
}

function doneEvent(key: string, review_cycles = 1): StoryDoneEvent {
  return {
    type: 'story:done',
    ts: new Date().toISOString(),
    key,
    result: 'success',
    review_cycles,
  }
}

function checkCompleteEvent(
  storyKey: string,
  checkName: string,
  status: 'pass' | 'warn' | 'fail' = 'pass',
): VerificationCheckCompleteEvent {
  return {
    type: 'verification:check-complete',
    ts: new Date().toISOString(),
    storyKey,
    checkName,
    status,
    details: `${checkName} result: ${status}`,
    duration_ms: 100,
  }
}

function storyCompleteEvent(
  storyKey: string,
  status: 'pass' | 'warn' | 'fail',
  checkCount = 3,
): VerificationStoryCompleteEvent {
  const checks = Array.from({ length: checkCount }, (_, i) => ({
    checkName: `check-${i}`,
    status: 'pass' as const,
    details: `check-${i} passed`,
    duration_ms: 50,
  }))
  return {
    type: 'verification:story-complete',
    ts: new Date().toISOString(),
    storyKey,
    checks,
    status,
    duration_ms: checkCount * 50,
  }
}

// ---------------------------------------------------------------------------
// AC1: EVENT_TYPE_NAMES tests
// ---------------------------------------------------------------------------

describe('EVENT_TYPE_NAMES — verification event type strings', () => {
  it('includes verification:check-complete', () => {
    expect(EVENT_TYPE_NAMES).toContain('verification:check-complete')
  })

  it('includes verification:story-complete', () => {
    expect(EVENT_TYPE_NAMES).toContain('verification:story-complete')
  })
})

// ---------------------------------------------------------------------------
// Progress renderer: verification:check-complete
// ---------------------------------------------------------------------------

describe('createProgressRenderer — verification:check-complete', () => {
  it('updates status label to show verifying... on check-complete (non-TTY)', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['51-5']))
    renderer.render(checkCompleteEvent('51-5', 'phantom-review', 'pass'))

    const out = output()
    expect(out).toContain('verifying')
  })

  it('adds unknown story key to storyOrder without crashing (non-TTY)', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    // Intentionally no pipeline:start — story is unknown
    expect(() => {
      renderer.render(checkCompleteEvent('99-9', 'build', 'pass'))
    }).not.toThrow()

    // The renderer should have emitted a line about the unknown story
    const out = output()
    expect(out).toContain('99-9')
  })
})

// ---------------------------------------------------------------------------
// Progress renderer: verification:story-complete
// ---------------------------------------------------------------------------

describe('createProgressRenderer — verification:story-complete', () => {
  it('shows "verified ✓" when status is pass (non-TTY)', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['51-5']))
    renderer.render(storyCompleteEvent('51-5', 'pass', 3))

    const out = output()
    expect(out).toContain('verified ✓')
  })

  it('shows "verified (warn)" when status is warn (non-TTY)', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['51-5']))
    renderer.render(storyCompleteEvent('51-5', 'warn', 2))

    const out = output()
    expect(out).toContain('verified (warn)')
  })

  it('marks story terminal and shows VERIFICATION FAILED when status is fail (non-TTY)', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['51-5']))
    renderer.render(storyCompleteEvent('51-5', 'fail', 1))

    const out = output()
    expect(out).toContain('VERIFICATION FAILED')
  })

  it('does not un-terminal a story that already received story:done (non-TTY)', () => {
    const { stream, output } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    renderer.render(startEvent(['51-5']))
    renderer.render(doneEvent('51-5', 2))

    // Now a late verification:story-complete arrives (should be ignored since already terminal)
    renderer.render(storyCompleteEvent('51-5', 'fail', 3))

    // The output should show SHIP_IT, not VERIFICATION FAILED
    const out = output()
    expect(out).toContain('SHIP_IT')
    expect(out).not.toContain('VERIFICATION FAILED')
  })
})

// ---------------------------------------------------------------------------
// wireNdjsonEmitter: NDJSON forwarding
// ---------------------------------------------------------------------------

describe('wireNdjsonEmitter — verification event forwarding', () => {
  it('forwards verification:check-complete bus event to ndjsonEmitter', () => {
    // Capture handlers registered via eventBus.on
    const registeredHandlers = new Map<string, (payload: unknown) => void>()
    const mockEventBus = {
      on: vi.fn((event: string, handler: (payload: unknown) => void) => {
        registeredHandlers.set(event, handler)
      }),
    }

    const emittedEvents: unknown[] = []
    const mockNdjsonEmitter = {
      emit: vi.fn((event: unknown) => {
        emittedEvents.push(event)
      }),
    }

    wireNdjsonEmitter(
      mockEventBus as unknown as Parameters<typeof wireNdjsonEmitter>[0],
      mockNdjsonEmitter as unknown as Parameters<typeof wireNdjsonEmitter>[1],
    )

    // Confirm the handler was registered for verification:check-complete
    const handler = registeredHandlers.get('verification:check-complete')
    expect(handler).toBeDefined()

    // Invoke the handler with a sample payload
    const payload = {
      storyKey: '51-5',
      checkName: 'phantom-review',
      status: 'pass' as const,
      details: 'No phantom review detected.',
      duration_ms: 42,
    }
    handler!(payload)

    // Assert ndjsonEmitter.emit was called with the correct forwarded shape
    expect(mockNdjsonEmitter.emit).toHaveBeenCalledOnce()
    const emitted = emittedEvents[0] as Record<string, unknown>
    expect(emitted.type).toBe('verification:check-complete')
    expect(emitted.storyKey).toBe('51-5')
    expect(emitted.checkName).toBe('phantom-review')
    expect(emitted.status).toBe('pass')
    expect(emitted.details).toBe('No phantom review detected.')
    expect(emitted.duration_ms).toBe(42)
    expect(typeof emitted.ts).toBe('string')
  })

  it('forwards verification:story-complete bus event to ndjsonEmitter', () => {
    // Capture handlers registered via eventBus.on
    const registeredHandlers = new Map<string, (payload: unknown) => void>()
    const mockEventBus = {
      on: vi.fn((event: string, handler: (payload: unknown) => void) => {
        registeredHandlers.set(event, handler)
      }),
    }

    const emittedEvents: unknown[] = []
    const mockNdjsonEmitter = {
      emit: vi.fn((event: unknown) => {
        emittedEvents.push(event)
      }),
    }

    wireNdjsonEmitter(
      mockEventBus as unknown as Parameters<typeof wireNdjsonEmitter>[0],
      mockNdjsonEmitter as unknown as Parameters<typeof wireNdjsonEmitter>[1],
    )

    // Confirm the handler was registered for verification:story-complete
    const handler = registeredHandlers.get('verification:story-complete')
    expect(handler).toBeDefined()

    // Invoke the handler with a sample payload
    const checks = [
      { checkName: 'phantom-review', status: 'pass' as const, details: 'ok', duration_ms: 10 },
      { checkName: 'trivial-output', status: 'warn' as const, details: 'low tokens', duration_ms: 5 },
      { checkName: 'build', status: 'pass' as const, details: 'build passed', duration_ms: 300 },
    ]
    const payload = {
      storyKey: '51-5',
      checks,
      status: 'warn' as const,
      duration_ms: 315,
    }
    handler!(payload)

    // Assert ndjsonEmitter.emit was called with the correct forwarded shape
    expect(mockNdjsonEmitter.emit).toHaveBeenCalledOnce()
    const emitted = emittedEvents[0] as Record<string, unknown>
    expect(emitted.type).toBe('verification:story-complete')
    expect(emitted.storyKey).toBe('51-5')
    expect(emitted.checks).toEqual(checks)
    expect(emitted.status).toBe('warn')
    expect(emitted.duration_ms).toBe(315)
    expect(typeof emitted.ts).toBe('string')
  })
})
