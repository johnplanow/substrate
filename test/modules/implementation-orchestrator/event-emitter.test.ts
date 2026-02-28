/**
 * Tests for event-emitter.ts
 *
 * Covers:
 *  - NDJSON output format (one JSON object per line, ends with newline)
 *  - Timestamp override at emit time (AC7)
 *  - Fire-and-forget: write errors are swallowed (AC1)
 *  - Each emitted line is valid JSON parseable by JSON.parse()
 *  - Emitter returns correct interface shape
 */

import { describe, it, expect, vi } from 'vitest'
import { PassThrough, Writable } from 'node:stream'
import {
  createEventEmitter,
} from '../../../src/modules/implementation-orchestrator/event-emitter.js'
import type {
  PipelineEvent,
  PipelineStartEvent,
  StoryDoneEvent,
  StoryPhaseEvent,
  StoryEscalationEvent,
  StoryWarnEvent,
} from '../../../src/modules/implementation-orchestrator/event-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a PassThrough stream and return it with a line-collector */
function makeCapture(): { stream: PassThrough; getOutput: () => string[] } {
  const stream = new PassThrough()
  const rawChunks: string[] = []
  stream.on('data', (chunk: Buffer | string) => {
    rawChunks.push(chunk.toString())
  })
  return {
    stream,
    getOutput: () => rawChunks.join('').split('\n').filter(Boolean),
  }
}

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// ---------------------------------------------------------------------------
// createEventEmitter — basic shape
// ---------------------------------------------------------------------------

describe('createEventEmitter', () => {
  it('returns an object with an emit function', () => {
    const stream = new PassThrough()
    const emitter = createEventEmitter(stream)
    expect(typeof emitter.emit).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// NDJSON output format
// ---------------------------------------------------------------------------

describe('NDJSON output format', () => {
  it('writes one line per event', () => {
    const { stream, getOutput } = makeCapture()
    const emitter = createEventEmitter(stream)

    const start: PipelineStartEvent = {
      type: 'pipeline:start',
      ts: '2020-01-01T00:00:00.000Z',
      run_id: 'r1',
      stories: ['10-1'],
      concurrency: 1,
    }
    const done: StoryDoneEvent = {
      type: 'story:done',
      ts: '2020-01-01T00:01:00.000Z',
      key: '10-1',
      result: 'success',
      review_cycles: 1,
    }

    emitter.emit(start)
    emitter.emit(done)

    const lines = getOutput()
    expect(lines).toHaveLength(2)
  })

  it('each emitted line is valid JSON', () => {
    const { stream, getOutput } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit({
      type: 'pipeline:start',
      ts: '2026-01-01T00:00:00.000Z',
      run_id: 'run-1',
      stories: ['5-1', '5-2'],
      concurrency: 2,
    })

    const lines = getOutput()
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0]!)).not.toThrow()
  })

  it('output is terminated with a newline (NDJSON convention)', () => {
    const stream = new PassThrough()
    const chunks: string[] = []
    stream.on('data', (chunk: Buffer | string) => chunks.push(chunk.toString()))

    const emitter = createEventEmitter(stream)
    emitter.emit({
      type: 'story:warn',
      ts: new Date().toISOString(),
      key: '10-1',
      msg: 'test warning',
    })

    const raw = chunks.join('')
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('each line contains exactly the event fields (no extra wrapping)', () => {
    const { stream, getOutput } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit({
      type: 'story:done',
      ts: '2026-01-01T00:00:00.000Z',
      key: '10-2',
      result: 'success',
      review_cycles: 0,
    })

    const parsed = JSON.parse(getOutput()[0]!) as Record<string, unknown>
    expect(parsed['type']).toBe('story:done')
    expect(parsed['key']).toBe('10-2')
    expect(parsed['result']).toBe('success')
    expect(parsed['review_cycles']).toBe(0)
    // Should not have extra envelope fields
    expect(parsed['success']).toBeUndefined()
    expect(parsed['data']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Timestamp override (AC7)
// ---------------------------------------------------------------------------

describe('timestamp override (AC7)', () => {
  it('overwrites the ts field with the current time at emit', () => {
    const { stream, getOutput } = makeCapture()
    const emitter = createEventEmitter(stream)

    const staleTs = '2000-01-01T00:00:00.000Z'
    emitter.emit({
      type: 'story:log',
      ts: staleTs,
      key: '10-1',
      msg: 'hello',
    } as PipelineEvent)

    const parsed = JSON.parse(getOutput()[0]!) as { ts: string }
    // ts should NOT be the stale timestamp
    expect(parsed.ts).not.toBe(staleTs)
    // ts should look like a real ISO-8601 timestamp
    expect(ISO_8601_RE.test(parsed.ts)).toBe(true)
  })

  it('generates ts at emit time (different from creation time)', async () => {
    const { stream, getOutput } = makeCapture()
    const emitter = createEventEmitter(stream)

    const before = Date.now()
    // Small delay to ensure time difference
    await new Promise((resolve) => setTimeout(resolve, 5))

    emitter.emit({
      type: 'story:warn',
      ts: '1970-01-01T00:00:00.000Z', // old timestamp will be overwritten
      key: '10-1',
      msg: 'warn',
    })

    const parsed = JSON.parse(getOutput()[0]!) as { ts: string }
    const emittedTime = new Date(parsed.ts).getTime()
    expect(emittedTime).toBeGreaterThanOrEqual(before)
  })
})

// ---------------------------------------------------------------------------
// Event type correctness
// ---------------------------------------------------------------------------

describe('event type correctness', () => {
  it('emits pipeline:start with all required fields', () => {
    const { stream, getOutput } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit({
      type: 'pipeline:start',
      ts: new Date().toISOString(),
      run_id: 'uuid-1234',
      stories: ['10-1', '10-2'],
      concurrency: 3,
    })

    const parsed = JSON.parse(getOutput()[0]!) as Record<string, unknown>
    expect(parsed['type']).toBe('pipeline:start')
    expect(parsed['run_id']).toBe('uuid-1234')
    expect(parsed['stories']).toEqual(['10-1', '10-2'])
    expect(parsed['concurrency']).toBe(3)
  })

  it('emits pipeline:complete with succeeded/failed/escalated arrays', () => {
    const { stream, getOutput } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit({
      type: 'pipeline:complete',
      ts: new Date().toISOString(),
      succeeded: ['10-1'],
      failed: ['10-3'],
      escalated: ['10-2'],
    })

    const parsed = JSON.parse(getOutput()[0]!) as Record<string, unknown>
    expect(parsed['type']).toBe('pipeline:complete')
    expect(parsed['succeeded']).toEqual(['10-1'])
    expect(parsed['failed']).toEqual(['10-3'])
    expect(parsed['escalated']).toEqual(['10-2'])
  })

  it('emits story:phase with optional verdict for code-review', () => {
    const { stream, getOutput } = makeCapture()
    const emitter = createEventEmitter(stream)

    const phaseEvent: StoryPhaseEvent = {
      type: 'story:phase',
      ts: new Date().toISOString(),
      key: '10-1',
      phase: 'code-review',
      status: 'complete',
      verdict: 'approved',
    }
    emitter.emit(phaseEvent)

    const parsed = JSON.parse(getOutput()[0]!) as Record<string, unknown>
    expect(parsed['phase']).toBe('code-review')
    expect(parsed['status']).toBe('complete')
    expect(parsed['verdict']).toBe('approved')
  })

  it('emits story:phase with optional file for create-story', () => {
    const { stream, getOutput } = makeCapture()
    const emitter = createEventEmitter(stream)

    const phaseEvent: StoryPhaseEvent = {
      type: 'story:phase',
      ts: new Date().toISOString(),
      key: '10-1',
      phase: 'create-story',
      status: 'complete',
      file: '/output/stories/10-1.md',
    }
    emitter.emit(phaseEvent)

    const parsed = JSON.parse(getOutput()[0]!) as Record<string, unknown>
    expect(parsed['file']).toBe('/output/stories/10-1.md')
    expect(parsed['verdict']).toBeUndefined()
  })

  it('emits story:escalation with issues array', () => {
    const { stream, getOutput } = makeCapture()
    const emitter = createEventEmitter(stream)

    const escalationEvent: StoryEscalationEvent = {
      type: 'story:escalation',
      ts: new Date().toISOString(),
      key: '10-2',
      reason: 'Max review cycles exceeded',
      cycles: 3,
      issues: [
        { severity: 'blocker', file: 'src/main.ts', desc: 'Null pointer' },
      ],
    }
    emitter.emit(escalationEvent)

    const parsed = JSON.parse(getOutput()[0]!) as Record<string, unknown>
    expect(parsed['type']).toBe('story:escalation')
    expect(parsed['cycles']).toBe(3)
    expect(Array.isArray(parsed['issues'])).toBe(true)
    const issues = parsed['issues'] as Array<Record<string, unknown>>
    expect(issues[0]?.['severity']).toBe('blocker')
    expect(issues[0]?.['file']).toBe('src/main.ts')
    expect(issues[0]?.['desc']).toBe('Null pointer')
  })

  it('emits story:warn with key and msg', () => {
    const { stream, getOutput } = makeCapture()
    const emitter = createEventEmitter(stream)

    const warnEvent: StoryWarnEvent = {
      type: 'story:warn',
      ts: new Date().toISOString(),
      key: '10-1',
      msg: 'Token ceiling reached',
    }
    emitter.emit(warnEvent)

    const parsed = JSON.parse(getOutput()[0]!) as Record<string, unknown>
    expect(parsed['type']).toBe('story:warn')
    expect(parsed['key']).toBe('10-1')
    expect(parsed['msg']).toBe('Token ceiling reached')
  })
})

// ---------------------------------------------------------------------------
// Fire-and-forget: write errors swallowed
// ---------------------------------------------------------------------------

describe('fire-and-forget error swallowing', () => {
  it('does not throw when stream.write throws synchronously', () => {
    const throwingStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('broken pipe'))
      },
    })

    // Override write to throw synchronously instead
    const originalWrite = throwingStream.write.bind(throwingStream)
    throwingStream.write = () => {
      throw new Error('broken pipe')
    }

    const emitter = createEventEmitter(throwingStream)

    expect(() => {
      emitter.emit({
        type: 'story:log',
        ts: new Date().toISOString(),
        key: '10-1',
        msg: 'hello',
      })
    }).not.toThrow()

    // Restore original write
    throwingStream.write = originalWrite
  })

  it('continues emitting after a write error', () => {
    let callCount = 0
    const flakyStream = {
      write: (_data: unknown) => {
        callCount++
        if (callCount === 1) throw new Error('first call fails')
        return true
      },
    } as unknown as Writable

    const emitter = createEventEmitter(flakyStream)

    expect(() => {
      emitter.emit({
        type: 'story:warn',
        ts: new Date().toISOString(),
        key: '10-1',
        msg: 'first',
      })
    }).not.toThrow()

    expect(() => {
      emitter.emit({
        type: 'story:warn',
        ts: new Date().toISOString(),
        key: '10-1',
        msg: 'second',
      })
    }).not.toThrow()

    expect(callCount).toBe(2)
  })

  it('does not block pipeline when write returns false (backpressure)', () => {
    const backpressureStream = {
      write: vi.fn().mockReturnValue(false),
    } as unknown as Writable

    const emitter = createEventEmitter(backpressureStream)

    // Should not throw or await drain
    emitter.emit({
      type: 'story:log',
      ts: new Date().toISOString(),
      key: '10-1',
      msg: 'test',
    })

    expect(backpressureStream.write).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Multiple events in sequence
// ---------------------------------------------------------------------------

describe('event sequence', () => {
  it('emits multiple events in order', () => {
    const { stream, getOutput } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit({
      type: 'pipeline:start',
      ts: new Date().toISOString(),
      run_id: 'r1',
      stories: ['10-1'],
      concurrency: 1,
    })
    emitter.emit({
      type: 'story:phase',
      ts: new Date().toISOString(),
      key: '10-1',
      phase: 'create-story',
      status: 'in_progress',
    })
    emitter.emit({
      type: 'story:phase',
      ts: new Date().toISOString(),
      key: '10-1',
      phase: 'create-story',
      status: 'complete',
      file: '/stories/10-1.md',
    })
    emitter.emit({
      type: 'story:done',
      ts: new Date().toISOString(),
      key: '10-1',
      result: 'success',
      review_cycles: 1,
    })
    emitter.emit({
      type: 'pipeline:complete',
      ts: new Date().toISOString(),
      succeeded: ['10-1'],
      failed: [],
      escalated: [],
    })

    const lines = getOutput()
    expect(lines).toHaveLength(5)

    const types = lines.map((line) => {
      const parsed = JSON.parse(line) as { type: string }
      return parsed.type
    })
    expect(types[0]).toBe('pipeline:start')
    expect(types[4]).toBe('pipeline:complete')
  })
})

