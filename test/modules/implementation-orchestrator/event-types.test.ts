/**
 * Tests for event-types.ts
 *
 * Verifies type definitions, PipelineEvent discriminated union completeness,
 * and structural validation of each event type.
 */

import { describe, it, expect } from 'vitest'
import type {
  PipelineEvent,
  PipelineStartEvent,
  PipelineCompleteEvent,
  StoryPhaseEvent,
  StoryDoneEvent,
  StoryEscalationEvent,
  StoryWarnEvent,
  StoryLogEvent,
  EscalationIssue,
  PipelinePhase,
} from '../../../src/modules/implementation-orchestrator/event-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function isIso8601(ts: string): boolean {
  return ISO_8601_RE.test(ts)
}

// ---------------------------------------------------------------------------
// PipelineStartEvent
// ---------------------------------------------------------------------------

describe('PipelineStartEvent', () => {
  it('accepts a valid pipeline:start event', () => {
    const event: PipelineStartEvent = {
      type: 'pipeline:start',
      ts: new Date().toISOString(),
      run_id: 'run-abc-123',
      stories: ['10-1', '10-2'],
      concurrency: 3,
    }

    expect(event.type).toBe('pipeline:start')
    expect(event.run_id).toBe('run-abc-123')
    expect(event.stories).toEqual(['10-1', '10-2'])
    expect(event.concurrency).toBe(3)
    expect(isIso8601(event.ts)).toBe(true)
  })

  it('can represent empty stories array', () => {
    const event: PipelineStartEvent = {
      type: 'pipeline:start',
      ts: new Date().toISOString(),
      run_id: 'run-xyz',
      stories: [],
      concurrency: 1,
    }
    expect(event.stories).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// PipelineCompleteEvent
// ---------------------------------------------------------------------------

describe('PipelineCompleteEvent', () => {
  it('accepts a valid pipeline:complete event with all arrays populated', () => {
    const event: PipelineCompleteEvent = {
      type: 'pipeline:complete',
      ts: new Date().toISOString(),
      succeeded: ['10-1'],
      failed: ['10-3'],
      escalated: ['10-2'],
    }

    expect(event.type).toBe('pipeline:complete')
    expect(event.succeeded).toEqual(['10-1'])
    expect(event.failed).toEqual(['10-3'])
    expect(event.escalated).toEqual(['10-2'])
  })

  it('allows all arrays to be empty', () => {
    const event: PipelineCompleteEvent = {
      type: 'pipeline:complete',
      ts: new Date().toISOString(),
      succeeded: [],
      failed: [],
      escalated: [],
    }
    expect(event.succeeded).toHaveLength(0)
    expect(event.failed).toHaveLength(0)
    expect(event.escalated).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// StoryPhaseEvent
// ---------------------------------------------------------------------------

describe('StoryPhaseEvent', () => {
  it('accepts a valid story:phase in_progress event', () => {
    const event: StoryPhaseEvent = {
      type: 'story:phase',
      ts: new Date().toISOString(),
      key: '10-1',
      phase: 'dev-story',
      status: 'in_progress',
    }
    expect(event.type).toBe('story:phase')
    expect(event.key).toBe('10-1')
    expect(event.phase).toBe('dev-story')
    expect(event.status).toBe('in_progress')
  })

  it('accepts a code-review complete event with verdict', () => {
    const event: StoryPhaseEvent = {
      type: 'story:phase',
      ts: new Date().toISOString(),
      key: '10-2',
      phase: 'code-review',
      status: 'complete',
      verdict: 'approved',
    }
    expect(event.verdict).toBe('approved')
    expect(event.file).toBeUndefined()
  })

  it('accepts a create-story complete event with file path', () => {
    const event: StoryPhaseEvent = {
      type: 'story:phase',
      ts: new Date().toISOString(),
      key: '10-1',
      phase: 'create-story',
      status: 'complete',
      file: '/path/to/story/10-1.md',
    }
    expect(event.file).toBe('/path/to/story/10-1.md')
    expect(event.verdict).toBeUndefined()
  })

  it('accepts a failed status event', () => {
    const event: StoryPhaseEvent = {
      type: 'story:phase',
      ts: new Date().toISOString(),
      key: '10-3',
      phase: 'fix',
      status: 'failed',
    }
    expect(event.status).toBe('failed')
  })

  it('covers all PipelinePhase values', () => {
    const phases: PipelinePhase[] = ['create-story', 'dev-story', 'code-review', 'fix']
    for (const phase of phases) {
      const event: StoryPhaseEvent = {
        type: 'story:phase',
        ts: new Date().toISOString(),
        key: '10-1',
        phase,
        status: 'complete',
      }
      expect(event.phase).toBe(phase)
    }
  })
})

// ---------------------------------------------------------------------------
// StoryDoneEvent
// ---------------------------------------------------------------------------

describe('StoryDoneEvent', () => {
  it('accepts a successful story:done event', () => {
    const event: StoryDoneEvent = {
      type: 'story:done',
      ts: new Date().toISOString(),
      key: '10-1',
      result: 'success',
      review_cycles: 2,
    }
    expect(event.type).toBe('story:done')
    expect(event.result).toBe('success')
    expect(event.review_cycles).toBe(2)
  })

  it('accepts a failed story:done event', () => {
    const event: StoryDoneEvent = {
      type: 'story:done',
      ts: new Date().toISOString(),
      key: '10-2',
      result: 'failed',
      review_cycles: 0,
    }
    expect(event.result).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// EscalationIssue
// ---------------------------------------------------------------------------

describe('EscalationIssue', () => {
  it('accepts a valid escalation issue', () => {
    const issue: EscalationIssue = {
      severity: 'blocker',
      file: 'src/main.ts',
      desc: 'Missing null check',
    }
    expect(issue.severity).toBe('blocker')
    expect(issue.file).toBe('src/main.ts')
    expect(issue.desc).toBe('Missing null check')
  })
})

// ---------------------------------------------------------------------------
// StoryEscalationEvent
// ---------------------------------------------------------------------------

describe('StoryEscalationEvent', () => {
  it('accepts a valid story:escalation event', () => {
    const event: StoryEscalationEvent = {
      type: 'story:escalation',
      ts: new Date().toISOString(),
      key: '10-1',
      reason: 'Max review cycles exceeded',
      cycles: 3,
      issues: [
        { severity: 'blocker', file: 'src/foo.ts', desc: 'Unhandled error' },
        { severity: 'major', file: 'src/bar.ts', desc: 'Memory leak' },
      ],
    }
    expect(event.type).toBe('story:escalation')
    expect(event.key).toBe('10-1')
    expect(event.cycles).toBe(3)
    expect(event.issues).toHaveLength(2)
    expect(event.issues[0]?.severity).toBe('blocker')
    expect(event.issues[1]?.file).toBe('src/bar.ts')
  })

  it('accepts an escalation with empty issues array', () => {
    const event: StoryEscalationEvent = {
      type: 'story:escalation',
      ts: new Date().toISOString(),
      key: '10-2',
      reason: 'timeout',
      cycles: 1,
      issues: [],
    }
    expect(event.issues).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// StoryWarnEvent
// ---------------------------------------------------------------------------

describe('StoryWarnEvent', () => {
  it('accepts a valid story:warn event', () => {
    const event: StoryWarnEvent = {
      type: 'story:warn',
      ts: new Date().toISOString(),
      key: '10-1',
      msg: 'Token ceiling reached, truncating context',
    }
    expect(event.type).toBe('story:warn')
    expect(event.key).toBe('10-1')
    expect(event.msg).toBe('Token ceiling reached, truncating context')
  })
})

// ---------------------------------------------------------------------------
// StoryLogEvent
// ---------------------------------------------------------------------------

describe('StoryLogEvent', () => {
  it('accepts a valid story:log event', () => {
    const event: StoryLogEvent = {
      type: 'story:log',
      ts: new Date().toISOString(),
      key: '10-1',
      msg: 'Starting dev phase',
    }
    expect(event.type).toBe('story:log')
    expect(event.msg).toBe('Starting dev phase')
  })
})

// ---------------------------------------------------------------------------
// PipelineEvent discriminated union
// ---------------------------------------------------------------------------

describe('PipelineEvent discriminated union', () => {
  it('covers all 7 event types via type narrowing', () => {
    const events: PipelineEvent[] = [
      {
        type: 'pipeline:start',
        ts: new Date().toISOString(),
        run_id: 'r1',
        stories: ['10-1'],
        concurrency: 1,
      },
      {
        type: 'pipeline:complete',
        ts: new Date().toISOString(),
        succeeded: ['10-1'],
        failed: [],
        escalated: [],
      },
      {
        type: 'story:phase',
        ts: new Date().toISOString(),
        key: '10-1',
        phase: 'dev-story',
        status: 'in_progress',
      },
      {
        type: 'story:done',
        ts: new Date().toISOString(),
        key: '10-1',
        result: 'success',
        review_cycles: 1,
      },
      {
        type: 'story:escalation',
        ts: new Date().toISOString(),
        key: '10-1',
        reason: 'max cycles',
        cycles: 2,
        issues: [],
      },
      {
        type: 'story:warn',
        ts: new Date().toISOString(),
        key: '10-1',
        msg: 'warning',
      },
      {
        type: 'story:log',
        ts: new Date().toISOString(),
        key: '10-1',
        msg: 'log message',
      },
    ]

    const typesSeen = new Set<string>()
    for (const event of events) {
      typesSeen.add(event.type)
      switch (event.type) {
        case 'pipeline:start':
          expect(event.run_id).toBeDefined()
          expect(event.stories).toBeDefined()
          expect(event.concurrency).toBeDefined()
          break
        case 'pipeline:complete':
          expect(event.succeeded).toBeDefined()
          expect(event.failed).toBeDefined()
          expect(event.escalated).toBeDefined()
          break
        case 'story:phase':
          expect(event.key).toBeDefined()
          expect(event.phase).toBeDefined()
          expect(event.status).toBeDefined()
          break
        case 'story:done':
          expect(event.key).toBeDefined()
          expect(event.result).toBeDefined()
          expect(event.review_cycles).toBeDefined()
          break
        case 'story:escalation':
          expect(event.key).toBeDefined()
          expect(event.reason).toBeDefined()
          expect(event.cycles).toBeDefined()
          expect(event.issues).toBeDefined()
          break
        case 'story:warn':
          expect(event.key).toBeDefined()
          expect(event.msg).toBeDefined()
          break
        case 'story:log':
          expect(event.key).toBeDefined()
          expect(event.msg).toBeDefined()
          break
      }
    }

    expect(typesSeen.size).toBe(7)
  })

  it('all events carry ts field', () => {
    const events: PipelineEvent[] = [
      {
        type: 'pipeline:start',
        ts: '2026-01-01T00:00:00.000Z',
        run_id: 'r1',
        stories: [],
        concurrency: 1,
      },
      {
        type: 'pipeline:complete',
        ts: '2026-01-01T00:00:01.000Z',
        succeeded: [],
        failed: [],
        escalated: [],
      },
    ]

    for (const event of events) {
      expect(event.ts).toBeDefined()
      expect(typeof event.ts).toBe('string')
    }
  })
})
