/**
 * Unit tests for task-validator.ts (AC: #4, #5, #6, #7)
 */

import { describe, it, expect, vi } from 'vitest'
import { validateGraph, ValidationError, VersionError } from '../task-validator.js'
import type { AdapterRegistry } from '../../../adapters/adapter-registry.js'

// ---------------------------------------------------------------------------
// Minimal valid graph for reuse
// ---------------------------------------------------------------------------

const validGraphInput = {
  version: '1',
  session: { name: 'test-session', budget_usd: 5.0 },
  tasks: {
    'task-1': {
      name: 'Task One',
      prompt: 'Do task one',
      type: 'coding',
      depends_on: [],
    },
    'task-2': {
      name: 'Task Two',
      prompt: 'Do task two',
      type: 'testing',
      depends_on: ['task-1'],
    },
  },
}

// ---------------------------------------------------------------------------
// AC7: Version compatibility
// ---------------------------------------------------------------------------

describe('validateGraph — version compatibility (AC #7)', () => {
  it('accepts version "1"', () => {
    const result = validateGraph(validGraphInput)
    expect(result.valid).toBe(true)
  })

  it('accepts version "1.0"', () => {
    const result = validateGraph({ ...validGraphInput, version: '1.0' })
    expect(result.valid).toBe(true)
  })

  it('rejects unsupported version with clear error', () => {
    const result = validateGraph({ ...validGraphInput, version: '2' })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("'2'"))).toBe(true)
    expect(result.errors.some((e) => e.includes('not supported'))).toBe(true)
  })

  it('rejects missing version', () => {
    const { version: _, ...withoutVersion } = validGraphInput
    const result = validateGraph(withoutVersion)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.toLowerCase().includes('version'))).toBe(true)
  })

  it('version error message includes supported versions list', () => {
    const result = validateGraph({ ...validGraphInput, version: '99' })
    expect(result.valid).toBe(false)
    const errorText = result.errors.join(' ')
    expect(errorText).toContain('1')
  })
})

// ---------------------------------------------------------------------------
// AC1/AC2: Schema validation
// ---------------------------------------------------------------------------

describe('validateGraph — schema validation (AC #1, #2)', () => {
  it('returns valid=true for a correct graph', () => {
    const result = validateGraph(validGraphInput)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns the parsed graph when valid', () => {
    const result = validateGraph(validGraphInput)
    expect(result.graph).toBeDefined()
    expect(result.graph?.version).toBe('1')
    expect(result.graph?.session.name).toBe('test-session')
  })

  it('returns valid=false when tasks field is missing', () => {
    const { tasks: _, ...withoutTasks } = validGraphInput
    const result = validateGraph(withoutTasks)
    expect(result.valid).toBe(false)
  })

  it('returns valid=false when a task has an invalid type', () => {
    const result = validateGraph({
      ...validGraphInput,
      tasks: {
        't1': { name: 'T1', prompt: 'Do it', type: 'unknown-type', depends_on: [] },
      },
    })
    expect(result.valid).toBe(false)
  })

  it('returns valid=false for non-object input', () => {
    const result = validateGraph('not an object')
    expect(result.valid).toBe(false)
  })

  it('returns valid=false for null input', () => {
    const result = validateGraph(null)
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC4: Cycle detection
// ---------------------------------------------------------------------------

describe('validateGraph — cycle detection (AC #4)', () => {
  it('returns valid=false for a direct cycle (A→B→A)', () => {
    const result = validateGraph({
      ...validGraphInput,
      tasks: {
        'a': { name: 'A', prompt: 'Do A', type: 'coding', depends_on: ['b'] },
        'b': { name: 'B', prompt: 'Do B', type: 'coding', depends_on: ['a'] },
      },
    })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.toLowerCase().includes('circular'))).toBe(true)
  })

  it('error message contains the cycle path with arrow notation', () => {
    const result = validateGraph({
      ...validGraphInput,
      tasks: {
        'a': { name: 'A', prompt: 'Do A', type: 'coding', depends_on: ['b'] },
        'b': { name: 'B', prompt: 'Do B', type: 'coding', depends_on: ['a'] },
      },
    })
    const errorText = result.errors.join(' ')
    expect(errorText).toContain('→')
  })

  it('returns valid=false for transitive cycle (A→B→C→A)', () => {
    const result = validateGraph({
      ...validGraphInput,
      tasks: {
        'a': { name: 'A', prompt: 'Do A', type: 'coding', depends_on: ['b'] },
        'b': { name: 'B', prompt: 'Do B', type: 'coding', depends_on: ['c'] },
        'c': { name: 'C', prompt: 'Do C', type: 'coding', depends_on: ['a'] },
      },
    })
    expect(result.valid).toBe(false)
  })

  it('returns valid=true for acyclic graph', () => {
    const result = validateGraph(validGraphInput)
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC5: Dangling reference detection
// ---------------------------------------------------------------------------

describe('validateGraph — dangling reference detection (AC #5)', () => {
  it('returns valid=false when a task references a non-existent dep', () => {
    const result = validateGraph({
      ...validGraphInput,
      tasks: {
        'task-x': {
          name: 'Task X',
          prompt: 'Do X',
          type: 'coding',
          depends_on: ['nonexistent'],
        },
      },
    })
    expect(result.valid).toBe(false)
  })

  it('error message identifies which task references the missing dep', () => {
    const result = validateGraph({
      ...validGraphInput,
      tasks: {
        'task-x': {
          name: 'Task X',
          prompt: 'Do X',
          type: 'coding',
          depends_on: ['ghost-task'],
        },
      },
    })
    const errorText = result.errors.join(' ')
    expect(errorText).toContain('task-x')
    expect(errorText).toContain('ghost-task')
  })
})

// ---------------------------------------------------------------------------
// AC6: Agent availability check
// ---------------------------------------------------------------------------

describe('validateGraph — agent availability (AC #6)', () => {
  function makeRegistry(agentIds: string[]): AdapterRegistry {
    const adapters = agentIds.map((id) => ({
      id,
      displayName: id,
      getCapabilities: () => ({ supportsPlanGeneration: false }),
      healthCheck: async () => ({ healthy: true, supportsHeadless: true }),
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }))

    return {
      getAll: () => adapters,
      get: (id: string) => adapters.find((a) => a.id === id),
      register: vi.fn(),
      getPlanningCapable: () => [],
      discoverAndRegister: vi.fn(),
    } as unknown as AdapterRegistry
  }

  it('passes validation when all agents are registered', () => {
    const registry = makeRegistry(['claude-code'])
    const result = validateGraph(
      {
        ...validGraphInput,
        tasks: {
          't1': {
            name: 'T1',
            prompt: 'Do it',
            type: 'coding',
            depends_on: [],
            agent: 'claude-code',
          },
        },
      },
      registry,
    )
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('adds warning (not error) for unavailable agent', () => {
    const registry = makeRegistry(['claude-code'])
    const result = validateGraph(
      {
        ...validGraphInput,
        tasks: {
          't1': {
            name: 'T1',
            prompt: 'Do it',
            type: 'coding',
            depends_on: [],
            agent: 'unknown-agent',
          },
        },
      },
      registry,
    )
    // valid=true because unavailable agent is a warning not an error
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('unknown-agent')
  })

  it('warning message includes task ID and agent name', () => {
    const registry = makeRegistry([])
    const result = validateGraph(
      {
        ...validGraphInput,
        tasks: {
          'my-task': {
            name: 'My Task',
            prompt: 'Do it',
            type: 'coding',
            depends_on: [],
            agent: 'some-agent',
          },
        },
      },
      registry,
    )
    expect(result.warnings.some((w) => w.includes('my-task') && w.includes('some-agent'))).toBe(true)
  })

  it('skips agent check when no adapterRegistry provided', () => {
    const result = validateGraph({
      ...validGraphInput,
      tasks: {
        't1': {
          name: 'T1',
          prompt: 'Do it',
          type: 'coding',
          depends_on: [],
          agent: 'any-agent',
        },
      },
    })
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// ValidationError class
// ---------------------------------------------------------------------------

describe('ValidationError', () => {
  it('is an instance of Error', () => {
    const err = new ValidationError(['error 1'], ['warning 1'])
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ValidationError)
  })

  it('stores errors and warnings', () => {
    const err = new ValidationError(['e1', 'e2'], ['w1'])
    expect(err.errors).toEqual(['e1', 'e2'])
    expect(err.warnings).toEqual(['w1'])
  })

  it('has name ValidationError', () => {
    const err = new ValidationError(['error'])
    expect(err.name).toBe('ValidationError')
  })

  it('message includes the error strings', () => {
    const err = new ValidationError(['cycle detected'])
    expect(err.message).toContain('cycle detected')
  })
})
