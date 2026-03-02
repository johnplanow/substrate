/**
 * Unit tests for supervisor event type definitions (Story 17.5).
 *
 * Verifies:
 *   AC1: Analysis event type definitions in event-types.ts
 *   AC2: Experiment event type definitions in event-types.ts
 *   AC5: Supervisor interaction patterns in help-agent.ts
 *   AC6: CLAUDE.md supervisor section content
 */

import { describe, it, expect } from 'vitest'
import {
  EVENT_TYPE_NAMES,
} from '../event-types.js'
import {
  PIPELINE_EVENT_METADATA,
  generateInteractionPatternsSection,
  generateCommandReferenceSection,
} from '../../../cli/commands/help-agent.js'

// ---------------------------------------------------------------------------
// AC1: Analysis Event Type Definitions
// ---------------------------------------------------------------------------

describe('AC1: SupervisorAnalysisCompleteEvent and SupervisorAnalysisErrorEvent', () => {
  it('supervisor:analysis:complete is in EVENT_TYPE_NAMES', () => {
    expect(EVENT_TYPE_NAMES).toContain('supervisor:analysis:complete')
  })

  it('supervisor:analysis:error is in EVENT_TYPE_NAMES', () => {
    expect(EVENT_TYPE_NAMES).toContain('supervisor:analysis:error')
  })

  it('supervisor:analysis:complete metadata has ts and run_id fields', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'supervisor:analysis:complete')
    expect(meta).toBeDefined()
    const fieldNames = meta!.fields.map((f) => f.name)
    expect(fieldNames).toContain('ts')
    expect(fieldNames).toContain('run_id')
  })

  it('supervisor:analysis:error metadata has ts, run_id, and error fields', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'supervisor:analysis:error')
    expect(meta).toBeDefined()
    const fieldNames = meta!.fields.map((f) => f.name)
    expect(fieldNames).toContain('ts')
    expect(fieldNames).toContain('run_id')
    expect(fieldNames).toContain('error')
  })

  it('supervisor:analysis:complete has exactly 2 fields', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'supervisor:analysis:complete')
    expect(meta!.fields).toHaveLength(2)
  })

  it('supervisor:analysis:error has exactly 3 fields', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'supervisor:analysis:error')
    expect(meta!.fields).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// AC2: Experiment Event Type Definitions
// ---------------------------------------------------------------------------

describe('AC2: Experiment event types in EVENT_TYPE_NAMES', () => {
  const experimentTypes = [
    'supervisor:experiment:start',
    'supervisor:experiment:skip',
    'supervisor:experiment:recommendations',
    'supervisor:experiment:complete',
    'supervisor:experiment:error',
  ]

  for (const typeName of experimentTypes) {
    it(`${typeName} is in EVENT_TYPE_NAMES`, () => {
      expect(EVENT_TYPE_NAMES).toContain(typeName)
    })
  }

  it('supervisor:experiment:start has ts and run_id fields', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'supervisor:experiment:start')
    expect(meta).toBeDefined()
    const fieldNames = meta!.fields.map((f) => f.name)
    expect(fieldNames).toContain('ts')
    expect(fieldNames).toContain('run_id')
    expect(meta!.fields).toHaveLength(2)
  })

  it('supervisor:experiment:skip has ts, run_id, and reason fields', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'supervisor:experiment:skip')
    expect(meta).toBeDefined()
    const fieldNames = meta!.fields.map((f) => f.name)
    expect(fieldNames).toContain('ts')
    expect(fieldNames).toContain('run_id')
    expect(fieldNames).toContain('reason')
    expect(meta!.fields).toHaveLength(3)
  })

  it('supervisor:experiment:recommendations has ts, run_id, and count fields', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'supervisor:experiment:recommendations')
    expect(meta).toBeDefined()
    const fieldNames = meta!.fields.map((f) => f.name)
    expect(fieldNames).toContain('ts')
    expect(fieldNames).toContain('run_id')
    expect(fieldNames).toContain('count')
    expect(meta!.fields).toHaveLength(3)
  })

  it('supervisor:experiment:complete has ts, run_id, improved, mixed, regressed fields', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'supervisor:experiment:complete')
    expect(meta).toBeDefined()
    const fieldNames = meta!.fields.map((f) => f.name)
    expect(fieldNames).toContain('ts')
    expect(fieldNames).toContain('run_id')
    expect(fieldNames).toContain('improved')
    expect(fieldNames).toContain('mixed')
    expect(fieldNames).toContain('regressed')
    expect(meta!.fields).toHaveLength(5)
  })

  it('supervisor:experiment:error has ts, run_id, and error fields', () => {
    const meta = PIPELINE_EVENT_METADATA.find((e) => e.type === 'supervisor:experiment:error')
    expect(meta).toBeDefined()
    const fieldNames = meta!.fields.map((f) => f.name)
    expect(fieldNames).toContain('ts')
    expect(fieldNames).toContain('run_id')
    expect(fieldNames).toContain('error')
    expect(meta!.fields).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// AC5: Supervisor Interaction Patterns
// ---------------------------------------------------------------------------

describe('AC5: generateInteractionPatternsSection — supervisor patterns', () => {
  let output: string

  beforeAll(() => {
    output = generateInteractionPatternsSection()
  })

  it('contains Supervisor Interaction Patterns header', () => {
    expect(output).toContain('Supervisor Interaction Patterns')
  })

  it('documents supervisor:summary pattern', () => {
    expect(output).toContain('supervisor:summary')
    expect(output.toLowerCase()).toContain('summar')
  })

  it('documents supervisor:kill pattern with restart context', () => {
    expect(output).toContain('supervisor:kill')
    expect(output.toLowerCase()).toMatch(/stall|restart/)
  })

  it('documents supervisor:abort pattern with user escalation', () => {
    expect(output).toContain('supervisor:abort')
    expect(output).toMatch(/max-restarts|stall-threshold/i)
  })

  it('documents supervisor:analysis:complete pattern with report path', () => {
    expect(output).toContain('supervisor:analysis:complete')
    expect(output).toContain('_bmad-output/supervisor-reports')
  })

  it('documents supervisor:experiment:complete pattern with verdicts', () => {
    expect(output).toContain('supervisor:experiment:complete')
    expect(output).toMatch(/improved|regressed/i)
  })

  it('documents supervisor:experiment:error pattern with recovery suggestion', () => {
    expect(output).toContain('supervisor:experiment:error')
    expect(output).toContain('--experiment')
  })
})

// ---------------------------------------------------------------------------
// AC4: Command Documentation Updates (metrics --analysis flag)
// ---------------------------------------------------------------------------

describe('AC4: generateCommandReferenceSection — metrics --analysis flag', () => {
  it('documents --analysis <run-id> flag for substrate metrics', () => {
    const output = generateCommandReferenceSection()
    expect(output).toContain('--analysis')
    expect(output).toContain('substrate metrics')
  })

  it('documents --experiment flag for substrate supervisor', () => {
    const output = generateCommandReferenceSection()
    expect(output).toContain('--experiment')
    expect(output).toContain('substrate supervisor')
  })

  it('documents --max-experiments flag for substrate supervisor', () => {
    const output = generateCommandReferenceSection()
    expect(output).toContain('--max-experiments')
  })
})

// ---------------------------------------------------------------------------
// Helper import for beforeAll
// ---------------------------------------------------------------------------

import { beforeAll } from 'vitest'
