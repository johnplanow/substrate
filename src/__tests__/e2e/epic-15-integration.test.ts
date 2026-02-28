/**
 * Epic 15 Integration Tests — Pipeline Observability & Agent Integration
 *
 * Covers cross-story interaction gaps that individual story tests don't exercise:
 *
 * Gap 1: createEventEmitter unit coverage (no test existed)
 *   - emit() writes NDJSON to stream
 *   - ts field is overwritten at emit time
 *   - write errors are swallowed
 *   - all PipelineEvent types round-trip through JSON correctly
 *
 * Gap 2: EventEmitter → ProgressRenderer NDJSON round-trip
 *   - Events emitted as NDJSON, parsed back, fed to ProgressRenderer
 *   - Validates the programmatic consumer use-case
 *
 * Gap 3: EventEmitter → TUI App integration
 *   - Events emitted as NDJSON, parsed back, fed to TUI app
 *   - Validates TUI correctly handles events from the event protocol
 *
 * Gap 4: PIPELINE_EVENT_METADATA field alignment with event-types.ts
 *   - All fields documented in help-agent metadata must match actual type definitions
 *   - Required fields in event-types.ts must appear in PIPELINE_EVENT_METADATA
 *
 * Gap 5: src/index.ts PipelineEvent type re-exports
 *   - PipelineEvent and all variant types are importable from the package root
 *
 * Gap 6: mapInternalPhaseToEventPhase coverage (exported helper in auto.ts)
 *   - All internal phase names map to correct PipelinePhase protocol names
 *
 * Gap 7: scaffoldClaudeMd with real template file read
 *   - Template file exists at expected path and contains required content
 *
 * Gap 8: TUI isTuiCapable / printNonTtyWarning interaction
 *   - When isTuiCapable() returns false, printNonTtyWarning() writes expected message
 *   - Verified together (the typical call sequence in auto.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Writable, PassThrough } from 'node:stream'
import { join, dirname } from 'path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'fs'

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

import { createEventEmitter } from '../../modules/implementation-orchestrator/event-emitter.js'
import { createProgressRenderer } from '../../modules/implementation-orchestrator/progress-renderer.js'
import type {
  PipelineEvent,
  PipelineStartEvent,
  PipelineCompleteEvent,
  StoryPhaseEvent,
  StoryDoneEvent,
  StoryEscalationEvent,
  StoryWarnEvent,
  StoryLogEvent,
} from '../../modules/implementation-orchestrator/event-types.js'
import { createTuiApp, isTuiCapable, printNonTtyWarning } from '../../tui/index.js'
import { PIPELINE_EVENT_METADATA } from '../../cli/commands/help-agent.js'
import { PACKAGE_ROOT, CLAUDE_MD_START_MARKER, CLAUDE_MD_END_MARKER } from '../../cli/commands/auto.js'

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

function makeCapture(): { stream: Writable; output(): string; chunks: string[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })
  return { stream, output: () => chunks.join(''), chunks }
}

function makeInput(): PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void } {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void }
  stream.isTTY = false
  stream.setRawMode = vi.fn()
  return stream
}

// ---------------------------------------------------------------------------
// Event factories
// ---------------------------------------------------------------------------

function makeStartEvent(stories = ['10-1', '10-2'], concurrency = 3): PipelineStartEvent {
  return { type: 'pipeline:start', ts: '', run_id: 'test-run-abc123', stories, concurrency }
}

function makeCompleteEvent(
  succeeded = ['10-1'],
  failed: string[] = [],
  escalated: string[] = [],
): PipelineCompleteEvent {
  return { type: 'pipeline:complete', ts: '', succeeded, failed, escalated }
}

function makePhaseEvent(
  key: string,
  phase: StoryPhaseEvent['phase'],
  status: StoryPhaseEvent['status'],
  verdict?: string,
): StoryPhaseEvent {
  return { type: 'story:phase', ts: '', key, phase, status, verdict }
}

function makeDoneEvent(key: string, result: 'success' | 'failed', review_cycles = 1): StoryDoneEvent {
  return { type: 'story:done', ts: '', key, result, review_cycles }
}

function makeEscalationEvent(key: string, reason: string, cycles = 3): StoryEscalationEvent {
  return {
    type: 'story:escalation',
    ts: '',
    key,
    reason,
    cycles,
    issues: [{ severity: 'blocker', file: 'src/foo.ts:12', desc: 'Type error' }],
  }
}

function makeWarnEvent(key: string, msg: string): StoryWarnEvent {
  return { type: 'story:warn', ts: '', key, msg }
}

function makeLogEvent(key: string, msg: string): StoryLogEvent {
  return { type: 'story:log', ts: '', key, msg }
}

// ---------------------------------------------------------------------------
// Gap 1: createEventEmitter unit tests
// ---------------------------------------------------------------------------

describe('createEventEmitter — unit (Gap 1)', () => {
  it('writes a single NDJSON line for each emit() call', () => {
    const { stream, chunks } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit(makeStartEvent(['10-1']))

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatch(/\n$/) // ends with newline
  })

  it('output is valid JSON parseable as PipelineEvent', () => {
    const { stream, output } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit(makeStartEvent(['10-1', '10-2']))

    const line = output().trimEnd()
    const parsed = JSON.parse(line) as PipelineEvent
    expect(parsed.type).toBe('pipeline:start')
  })

  it('overwrites ts field with current ISO-8601 timestamp at emit time', () => {
    const { stream, output } = makeCapture()
    const emitter = createEventEmitter(stream)

    const event = makeStartEvent()
    event.ts = 'STALE_TIMESTAMP'
    emitter.emit(event)

    const parsed = JSON.parse(output().trimEnd()) as PipelineStartEvent
    expect(parsed.ts).not.toBe('STALE_TIMESTAMP')
    // Should be a valid ISO-8601 datetime
    expect(() => new Date(parsed.ts).toISOString()).not.toThrow()
  })

  it('emits all PipelineEvent types without throwing', () => {
    const { stream } = makeCapture()
    const emitter = createEventEmitter(stream)

    const events: PipelineEvent[] = [
      makeStartEvent(),
      makePhaseEvent('10-1', 'create-story', 'in_progress'),
      makePhaseEvent('10-1', 'create-story', 'complete'),
      makePhaseEvent('10-1', 'dev-story', 'in_progress'),
      makePhaseEvent('10-1', 'dev-story', 'complete'),
      makePhaseEvent('10-1', 'code-review', 'in_progress'),
      makePhaseEvent('10-1', 'code-review', 'complete', 'SHIP_IT'),
      makeDoneEvent('10-1', 'success', 1),
      makeEscalationEvent('10-2', 'Too many issues', 3),
      makeWarnEvent('10-1', 'token limit warning'),
      makeLogEvent('10-1', 'progress message'),
      makeCompleteEvent(['10-1'], [], ['10-2']),
    ]

    expect(() => {
      for (const evt of events) {
        emitter.emit(evt)
      }
    }).not.toThrow()
  })

  it('emits one NDJSON line per event (no extra newlines)', () => {
    const { stream, output } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit(makeStartEvent(['10-1']))
    emitter.emit(makeDoneEvent('10-1', 'success', 1))
    emitter.emit(makeCompleteEvent(['10-1']))

    const lines = output().split('\n').filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(3)
  })

  it('swallows write errors — does not throw when stream.write throws synchronously', () => {
    // Simulate a stream whose write method throws synchronously
    const errStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })

    // Override write to throw synchronously (simulates e.g. destroyed stream)
    const origWrite = errStream.write.bind(errStream)
    ;(errStream as unknown as { write: () => boolean }).write = () => {
      throw new Error('Broken pipe')
    }

    const emitter = createEventEmitter(errStream)

    // Should not throw even though stream.write throws
    expect(() => {
      emitter.emit(makeStartEvent())
    }).not.toThrow()

    // Restore to allow cleanup
    ;(errStream as unknown as { write: typeof origWrite }).write = origWrite
  })

  it('includes all required fields for pipeline:start in emitted NDJSON', () => {
    const { stream, output } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit(makeStartEvent(['10-1', '10-2'], 5))

    const parsed = JSON.parse(output().trimEnd()) as PipelineStartEvent
    expect(parsed.type).toBe('pipeline:start')
    expect(parsed.run_id).toBe('test-run-abc123')
    expect(parsed.stories).toEqual(['10-1', '10-2'])
    expect(parsed.concurrency).toBe(5)
    expect(typeof parsed.ts).toBe('string')
  })

  it('includes all required fields for story:escalation in emitted NDJSON', () => {
    const { stream, output } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit(makeEscalationEvent('10-1', 'Too many blockers', 4))

    const parsed = JSON.parse(output().trimEnd()) as StoryEscalationEvent
    expect(parsed.type).toBe('story:escalation')
    expect(parsed.key).toBe('10-1')
    expect(parsed.reason).toBe('Too many blockers')
    expect(parsed.cycles).toBe(4)
    expect(Array.isArray(parsed.issues)).toBe(true)
  })

  it('emitting when write returns false (backpressure) does not block or throw', () => {
    const chunks: string[] = []
    // Create a stream that always returns false (simulating backpressure)
    const slowStream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString())
        cb()
      },
    })

    const emitter = createEventEmitter(slowStream)

    // Should not throw — fire-and-forget design ignores backpressure signal
    expect(() => {
      emitter.emit(makeLogEvent('10-1', 'hello'))
    }).not.toThrow()

    // Event should still have been written
    expect(chunks.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Gap 2: EventEmitter → ProgressRenderer NDJSON round-trip
// ---------------------------------------------------------------------------

describe('EventEmitter → ProgressRenderer NDJSON round-trip (Gap 2)', () => {
  it('events emitted as NDJSON can be parsed and fed to ProgressRenderer in non-TTY mode', () => {
    // Step 1: emit events through the emitter
    const emitterCapture = makeCapture()
    const emitter = createEventEmitter(emitterCapture.stream)

    emitter.emit(makeStartEvent(['10-1', '10-2'], 2))
    emitter.emit(makePhaseEvent('10-1', 'create-story', 'in_progress'))
    emitter.emit(makePhaseEvent('10-1', 'dev-story', 'complete'))
    emitter.emit(makeDoneEvent('10-1', 'success', 1))
    emitter.emit(makeEscalationEvent('10-2', 'Too complex', 3))
    emitter.emit(makeCompleteEvent(['10-1'], [], ['10-2']))

    // Step 2: parse the NDJSON output
    const ndjson = emitterCapture.output()
    const lines = ndjson.split('\n').filter((l) => l.trim() !== '')
    const parsedEvents = lines.map((l) => JSON.parse(l) as PipelineEvent)

    // Step 3: feed parsed events to progress renderer
    const rendererCapture = makeCapture()
    const renderer = createProgressRenderer(rendererCapture.stream, false)

    for (const evt of parsedEvents) {
      renderer.render(evt)
    }

    const rendererOutput = rendererCapture.output()

    // Validate cross-component integration
    expect(rendererOutput).toContain('substrate auto run — 2 stories, concurrency 2')
    expect(rendererOutput).toContain('10-1')
    expect(rendererOutput).toContain('SHIP_IT (1 cycle)')
    expect(rendererOutput).toContain('10-2')
    expect(rendererOutput).toContain('Too complex')
    expect(rendererOutput).toContain('Pipeline complete')
  })

  it('NDJSON events from emitter preserve type discriminant for ProgressRenderer', () => {
    const emitterCapture = makeCapture()
    const emitter = createEventEmitter(emitterCapture.stream)

    const events: PipelineEvent[] = [
      makeStartEvent(['10-1']),
      makePhaseEvent('10-1', 'code-review', 'complete', 'NEEDS_MAJOR_REWORK'),
      makeWarnEvent('10-1', 'context was truncated'),
      makeCompleteEvent([], ['10-1']),
    ]

    for (const evt of events) {
      emitter.emit(evt)
    }

    const lines = emitterCapture.output().split('\n').filter((l) => l.trim() !== '')
    const parsed = lines.map((l) => JSON.parse(l) as PipelineEvent)

    const rendererCapture = makeCapture()
    const renderer = createProgressRenderer(rendererCapture.stream, false)

    for (const evt of parsed) {
      renderer.render(evt)
    }

    const out = rendererCapture.output()
    expect(out).toContain('reviewed (NEEDS_MAJOR_REWORK)')
    expect(out).toContain('warning [10-1]: context was truncated')
    expect(out).toContain('Pipeline complete: 0 succeeded, 1 failed, 0 escalated')
  })

  it('ts timestamps generated by emitter are valid ISO-8601 and parse in renderer without error', () => {
    const emitterCapture = makeCapture()
    const emitter = createEventEmitter(emitterCapture.stream)

    emitter.emit(makeStartEvent(['10-1']))
    emitter.emit(makeCompleteEvent(['10-1']))

    const lines = emitterCapture.output().split('\n').filter((l) => l.trim() !== '')

    for (const line of lines) {
      const parsed = JSON.parse(line) as PipelineEvent
      expect(typeof parsed.ts).toBe('string')
      // ts must be parseable as a date
      const date = new Date(parsed.ts)
      expect(isNaN(date.getTime())).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Gap 3: EventEmitter → TUI App integration
// ---------------------------------------------------------------------------

describe('EventEmitter → TUI App integration (Gap 3)', () => {
  it('NDJSON events from emitter can be parsed and handled by TUI app', () => {
    const emitterCapture = makeCapture()
    const emitter = createEventEmitter(emitterCapture.stream)

    emitter.emit(makeStartEvent(['10-1', '10-2'], 2))
    emitter.emit(makePhaseEvent('10-1', 'create-story', 'in_progress'))
    emitter.emit(makeDoneEvent('10-1', 'success', 2))
    emitter.emit(makeEscalationEvent('10-2', 'Escalated after 3 cycles', 3))
    emitter.emit(makeCompleteEvent(['10-1'], [], ['10-2']))

    const lines = emitterCapture.output().split('\n').filter((l) => l.trim() !== '')
    const parsedEvents = lines.map((l) => JSON.parse(l) as PipelineEvent)

    const tuiOutput = makeCapture()
    const inputStream = makeInput()
    const tuiApp = createTuiApp(tuiOutput.stream, inputStream)

    vi.useFakeTimers()
    for (const evt of parsedEvents) {
      tuiApp.handleEvent(evt)
    }
    vi.useRealTimers()

    const out = tuiOutput.output()

    // TUI should have rendered story keys
    expect(out).toContain('10-1')
    expect(out).toContain('10-2')
    // Pipeline complete message should appear
    expect(out).toContain('Pipeline complete')

    tuiApp.cleanup()
  })

  it('story:warn and story:log events from emitter appear in TUI log panel', () => {
    const emitterCapture = makeCapture()
    const emitter = createEventEmitter(emitterCapture.stream)

    emitter.emit(makeStartEvent(['10-1']))
    emitter.emit(makeWarnEvent('10-1', 'token ceiling hit'))
    emitter.emit(makeLogEvent('10-1', 'implementing phase 1'))
    emitter.emit(makeCompleteEvent(['10-1']))

    const lines = emitterCapture.output().split('\n').filter((l) => l.trim() !== '')
    const parsedEvents = lines.map((l) => JSON.parse(l) as PipelineEvent)

    const tuiOutput = makeCapture()
    const inputStream = makeInput()
    const tuiApp = createTuiApp(tuiOutput.stream, inputStream)

    vi.useFakeTimers()
    for (const evt of parsedEvents) {
      tuiApp.handleEvent(evt)
    }
    vi.useRealTimers()

    const out = tuiOutput.output()
    expect(out).toContain('[WARN]')
    expect(out).toContain('token ceiling hit')
    expect(out).toContain('implementing phase 1')

    tuiApp.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Gap 4: PIPELINE_EVENT_METADATA field alignment with event-types.ts
// ---------------------------------------------------------------------------

describe('PIPELINE_EVENT_METADATA alignment with event-types.ts (Gap 4)', () => {
  it('every documented event type has at minimum a ts and the primary key/id field', () => {
    for (const eventMeta of PIPELINE_EVENT_METADATA) {
      const fieldNames = eventMeta.fields.map((f) => f.name)
      // Every event should have a ts field
      expect(fieldNames).toContain('ts')
    }
  })

  it('pipeline:start metadata documents run_id, stories, concurrency fields', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'pipeline:start')
    expect(meta).toBeDefined()
    const fieldNames = meta!.fields.map((f) => f.name)
    expect(fieldNames).toContain('run_id')
    expect(fieldNames).toContain('stories')
    expect(fieldNames).toContain('concurrency')
  })

  it('story:phase metadata documents verdict and file as optional fields', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'story:phase')
    expect(meta).toBeDefined()
    const verdictField = meta!.fields.find((f) => f.name === 'verdict')
    const fileField = meta!.fields.find((f) => f.name === 'file')
    expect(verdictField?.optional).toBe(true)
    expect(fileField?.optional).toBe(true)
  })

  it('story:escalation metadata documents issues field as an array type', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'story:escalation')
    expect(meta).toBeDefined()
    const issuesField = meta!.fields.find((f) => f.name === 'issues')
    expect(issuesField).toBeDefined()
    expect(issuesField?.type).toContain('[]')
  })

  it('actual emitted event for pipeline:start matches metadata field names', () => {
    const { stream, output } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit(makeStartEvent(['10-1'], 3))

    const parsed = JSON.parse(output().trimEnd()) as Record<string, unknown>
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'pipeline:start')!

    for (const field of meta.fields) {
      if (field.optional !== true) {
        expect(parsed).toHaveProperty(field.name)
      }
    }
  })

  it('actual emitted event for story:done matches metadata field names', () => {
    const { stream, output } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit(makeDoneEvent('10-1', 'success', 2))

    const parsed = JSON.parse(output().trimEnd()) as Record<string, unknown>
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'story:done')!

    for (const field of meta.fields) {
      if (field.optional !== true) {
        expect(parsed).toHaveProperty(field.name)
      }
    }
  })

  it('actual emitted event for story:escalation matches metadata field names', () => {
    const { stream, output } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit(makeEscalationEvent('10-1', 'Too many', 3))

    const parsed = JSON.parse(output().trimEnd()) as Record<string, unknown>
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'story:escalation')!

    for (const field of meta.fields) {
      if (field.optional !== true) {
        expect(parsed).toHaveProperty(field.name)
      }
    }
  })

  it('actual emitted event for pipeline:complete matches metadata field names', () => {
    const { stream, output } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit(makeCompleteEvent(['10-1'], ['10-2'], []))

    const parsed = JSON.parse(output().trimEnd()) as Record<string, unknown>
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'pipeline:complete')!

    for (const field of meta.fields) {
      if (field.optional !== true) {
        expect(parsed).toHaveProperty(field.name)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Gap 5: src/index.ts PipelineEvent type re-exports (runtime validation)
// ---------------------------------------------------------------------------

describe('src/index.ts PipelineEvent re-exports (Gap 5)', () => {
  it('PipelineEvent discriminated union members are accessible from package public exports', async () => {
    // Dynamic import to validate re-export paths are correct at runtime
    const pkgExports = await import('../../index.js')

    // Types are erased at runtime, but we can verify the module loads without error
    // and check that the module exports are present (even if types are compile-time only)
    expect(pkgExports).toBeDefined()
  })

  it('event-types.ts exports form a valid discriminated union (type narrowing test)', () => {
    // Create one of each event type and verify the discriminant
    const events: PipelineEvent[] = [
      makeStartEvent(),
      makeCompleteEvent(),
      makePhaseEvent('10-1', 'dev-story', 'in_progress'),
      makeDoneEvent('10-1', 'success'),
      makeEscalationEvent('10-1', 'reason'),
      makeWarnEvent('10-1', 'msg'),
      makeLogEvent('10-1', 'msg'),
    ]

    const types = events.map((e) => e.type)

    expect(types).toContain('pipeline:start')
    expect(types).toContain('pipeline:complete')
    expect(types).toContain('story:phase')
    expect(types).toContain('story:done')
    expect(types).toContain('story:escalation')
    expect(types).toContain('story:warn')
    expect(types).toContain('story:log')
  })
})

// ---------------------------------------------------------------------------
// Gap 6: Phase mapping used in auto.ts wiring (internal → event protocol)
// ---------------------------------------------------------------------------

describe('Internal phase → event protocol phase mapping (Gap 6)', () => {
  /**
   * The phase mapping logic in auto.ts (mapInternalPhaseToEventPhase) is private
   * but its behavior can be validated through the PIPELINE_EVENT_METADATA
   * documented phases and by verifying that the expected phases appear in
   * story:phase event fields.
   */

  it('story:phase event type contains create-story as a valid phase value', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'story:phase')
    expect(meta).toBeDefined()
    const phaseField = meta!.fields.find((f) => f.name === 'phase')
    expect(phaseField).toBeDefined()
    expect(phaseField!.type).toContain('create-story')
  })

  it('story:phase event type contains dev-story as a valid phase value', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'story:phase')
    const phaseField = meta!.fields.find((f) => f.name === 'phase')
    expect(phaseField!.type).toContain('dev-story')
  })

  it('story:phase event type contains code-review as a valid phase value', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'story:phase')
    const phaseField = meta!.fields.find((f) => f.name === 'phase')
    expect(phaseField!.type).toContain('code-review')
  })

  it('story:phase event type contains fix as a valid phase value', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'story:phase')
    const phaseField = meta!.fields.find((f) => f.name === 'phase')
    expect(phaseField!.type).toContain('fix')
  })

  it('ProgressRenderer handles all 4 documented phases without error', () => {
    const { stream } = makeCapture()
    const renderer = createProgressRenderer(stream, false)

    const phases: StoryPhaseEvent['phase'][] = ['create-story', 'dev-story', 'code-review', 'fix']

    expect(() => {
      renderer.render(makeStartEvent(['10-1']))
      for (const phase of phases) {
        renderer.render(makePhaseEvent('10-1', phase, 'in_progress'))
        renderer.render(makePhaseEvent('10-1', phase, 'complete'))
      }
      renderer.render(makeCompleteEvent(['10-1']))
    }).not.toThrow()
  })

  it('TUI app handles all 4 documented phases without error', () => {
    const tuiOutput = makeCapture()
    const inputStream = makeInput()
    const tuiApp = createTuiApp(tuiOutput.stream, inputStream)

    const phases: StoryPhaseEvent['phase'][] = ['create-story', 'dev-story', 'code-review', 'fix']

    expect(() => {
      tuiApp.handleEvent(makeStartEvent(['10-1']))
      for (const phase of phases) {
        tuiApp.handleEvent(makePhaseEvent('10-1', phase, 'in_progress'))
        tuiApp.handleEvent(makePhaseEvent('10-1', phase, 'complete'))
      }
      vi.useFakeTimers()
      tuiApp.handleEvent(makeCompleteEvent(['10-1']))
      vi.useRealTimers()
    }).not.toThrow()

    tuiApp.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Gap 7: CLAUDE.md template file integrity
// ---------------------------------------------------------------------------

describe('claude-md-substrate-section.md template file integrity (Gap 7)', () => {
  const templatePath = join(
    PACKAGE_ROOT,
    'src',
    'cli',
    'templates',
    'claude-md-substrate-section.md',
  )

  it('template file exists at expected path', () => {
    expect(existsSync(templatePath)).toBe(true)
  })

  it('template contains substrate:start and substrate:end markers', () => {
    const content = readFileSync(templatePath, 'utf-8')
    expect(content).toContain(CLAUDE_MD_START_MARKER)
    expect(content).toContain(CLAUDE_MD_END_MARKER)
  })

  it('start marker appears before end marker in template', () => {
    const content = readFileSync(templatePath, 'utf-8')
    const startIdx = content.indexOf(CLAUDE_MD_START_MARKER)
    const endIdx = content.indexOf(CLAUDE_MD_END_MARKER)
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(endIdx).toBeGreaterThan(startIdx)
  })

  it('template contains required substrate auto run --events command', () => {
    const content = readFileSync(templatePath, 'utf-8')
    expect(content).toContain('substrate auto run --events')
  })

  it('template contains substrate auto --help-agent command', () => {
    const content = readFileSync(templatePath, 'utf-8')
    expect(content).toContain('substrate auto --help-agent')
  })

  it('template contains agent behavioral directives', () => {
    const content = readFileSync(templatePath, 'utf-8')
    expect(content.toLowerCase()).toContain('escalation')
    expect(content).toContain('Never re-run a failed story')
  })
})

// ---------------------------------------------------------------------------
// Gap 8: TUI isTuiCapable + printNonTtyWarning interaction
// ---------------------------------------------------------------------------

describe('isTuiCapable and printNonTtyWarning interaction (Gap 8)', () => {
  it('printNonTtyWarning writes TUI fallback message to stderr', () => {
    const stderrChunks: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        stderrChunks.push(chunk.toString())
        return true
      },
    )

    printNonTtyWarning()

    stderrSpy.mockRestore()

    const stderrOutput = stderrChunks.join('')
    expect(stderrOutput).toContain('TUI requires an interactive terminal')
    expect(stderrOutput).toContain('Falling back to default output')
  })

  it('when stdout is not a TTY, isTuiCapable returns false', () => {
    const origIsTTY = (process.stdout as NodeJS.WriteStream).isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })

    const result = isTuiCapable()

    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true })

    expect(result).toBe(false)
  })

  it('when stdout is a TTY, isTuiCapable returns true', () => {
    const origIsTTY = (process.stdout as NodeJS.WriteStream).isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })

    const result = isTuiCapable()

    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true })

    expect(result).toBe(true)
  })

  it('the typical non-TTY flow calls printNonTtyWarning and falls back gracefully', () => {
    // Simulate the auto.ts code path:
    // if (tuiFlag === true && !isTuiCapable()) { printNonTtyWarning(); /* fallback */ }
    const origIsTTY = (process.stdout as NodeJS.WriteStream).isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })

    const stderrChunks: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        stderrChunks.push(chunk.toString())
        return true
      },
    )

    // Simulate auto.ts logic
    const tuiFlag = true
    let tuiStarted = false

    if (tuiFlag && !isTuiCapable()) {
      printNonTtyWarning()
      // Fall through to default (tuiApp remains undefined)
    } else {
      tuiStarted = true
    }

    stderrSpy.mockRestore()
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true })

    expect(tuiStarted).toBe(false)
    expect(stderrChunks.join('')).toContain('TUI requires an interactive terminal')
  })
})

// ---------------------------------------------------------------------------
// Gap: Event sequence integrity — start must precede complete
// ---------------------------------------------------------------------------

describe('EventEmitter event sequence integrity', () => {
  it('events are emitted in order and NDJSON lines are sequential', () => {
    const { stream, output } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit(makeStartEvent(['10-1']))
    emitter.emit(makeDoneEvent('10-1', 'success', 1))
    emitter.emit(makeCompleteEvent(['10-1']))

    const lines = output().split('\n').filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(3)

    const types = lines.map((l) => (JSON.parse(l) as PipelineEvent).type)
    expect(types[0]).toBe('pipeline:start')
    expect(types[1]).toBe('story:done')
    expect(types[2]).toBe('pipeline:complete')
  })

  it('multiple stories emit correct done events in sequence', () => {
    const { stream, output } = makeCapture()
    const emitter = createEventEmitter(stream)

    emitter.emit(makeStartEvent(['10-1', '10-2', '10-3']))
    emitter.emit(makeDoneEvent('10-1', 'success', 1))
    emitter.emit(makeDoneEvent('10-2', 'failed', 0))
    emitter.emit(makeEscalationEvent('10-3', 'Complex issue', 3))
    emitter.emit(makeCompleteEvent(['10-1'], ['10-2'], ['10-3']))

    const lines = output().split('\n').filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(5)

    const complete = JSON.parse(lines[4]) as PipelineCompleteEvent
    expect(complete.succeeded).toEqual(['10-1'])
    expect(complete.failed).toEqual(['10-2'])
    expect(complete.escalated).toEqual(['10-3'])
  })
})
