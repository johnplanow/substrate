/**
 * Unit tests for src/modules/plan-generator/plan-validator.ts
 *
 * Tests all validation logic:
 *   - Schema validation (AC1)
 *   - Cycle detection (AC2)
 *   - Dangling dependency reference detection (AC3)
 *   - Agent availability checks (AC4)
 *   - Structured error formats (AC6)
 *   - Agent name normalization (AC7)
 *   - Empty-graph check, budget warnings (AC9)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  validatePlan,
  normalizeAgentName,
  AGENT_NAME_ALIASES,
  type PlanValidationResult,
} from '../plan-validator.js'
import type { AdapterRegistry } from '../../../adapters/adapter-registry.js'

// ---------------------------------------------------------------------------
// Helper: build a minimal valid raw plan object
// ---------------------------------------------------------------------------

function minimalPlan(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: '1',
    session: { name: 'test-session' },
    tasks: {
      'task-a': {
        name: 'Task A',
        prompt: 'Do task A',
        type: 'coding',
      },
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper: build a mock AdapterRegistry
// ---------------------------------------------------------------------------

function mockRegistry(agentIds: string[]): AdapterRegistry {
  return {
    getAll: vi.fn(() => agentIds.map((id) => ({ id }))),
    getPlanningCapable: vi.fn(() => []),
    get: vi.fn(),
    register: vi.fn(),
    discoverAndRegister: vi.fn(),
  } as unknown as AdapterRegistry
}

// ---------------------------------------------------------------------------
// normalizeAgentName tests
// ---------------------------------------------------------------------------

describe('normalizeAgentName', () => {
  it('returns canonical for known aliases', () => {
    expect(normalizeAgentName('claude')).toEqual({ normalized: 'claude-code', changed: true })
    expect(normalizeAgentName('claude-cli')).toEqual({ normalized: 'claude-code', changed: true })
    expect(normalizeAgentName('codex-cli')).toEqual({ normalized: 'codex', changed: true })
    expect(normalizeAgentName('gemini-cli')).toEqual({ normalized: 'gemini', changed: true })
    expect(normalizeAgentName('gemini-code')).toEqual({ normalized: 'gemini', changed: true })
  })

  it('returns original for unknown names', () => {
    expect(normalizeAgentName('claude-code')).toEqual({ normalized: 'claude-code', changed: false })
    expect(normalizeAgentName('some-unknown')).toEqual({ normalized: 'some-unknown', changed: false })
  })
})

// ---------------------------------------------------------------------------
// AGENT_NAME_ALIASES
// ---------------------------------------------------------------------------

describe('AGENT_NAME_ALIASES', () => {
  it('contains all expected mappings', () => {
    expect(AGENT_NAME_ALIASES['claude']).toBe('claude-code')
    expect(AGENT_NAME_ALIASES['claude-cli']).toBe('claude-code')
    expect(AGENT_NAME_ALIASES['codex-cli']).toBe('codex')
    expect(AGENT_NAME_ALIASES['gemini-cli']).toBe('gemini')
    expect(AGENT_NAME_ALIASES['gemini-code']).toBe('gemini')
  })
})

// ---------------------------------------------------------------------------
// validatePlan — happy path
// ---------------------------------------------------------------------------

describe('validatePlan — valid plan', () => {
  it('returns valid=true for a minimal valid plan', () => {
    const result = validatePlan(minimalPlan())
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('includes the graph when valid', () => {
    const result = validatePlan(minimalPlan())
    expect(result.graph).toBeDefined()
    expect(result.graph?.session.name).toBe('test-session')
  })

  it('returns no agent warnings when no agent field', () => {
    const registry = mockRegistry(['claude-code'])
    const result = validatePlan(minimalPlan(), registry)
    const agentWarnings = result.warnings.filter((w) => w.code === 'agent_unavailable')
    expect(agentWarnings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// validatePlan — schema errors (AC1)
// ---------------------------------------------------------------------------

describe('validatePlan — schema errors', () => {
  it('returns error when session.name is missing', () => {
    const raw = {
      version: '1',
      session: { name: '' },
      tasks: {
        'task-a': { name: 'Task A', prompt: 'Do task A', type: 'coding' },
      },
    }
    const result = validatePlan(raw)
    expect(result.valid).toBe(false)
    const schemaErrors = result.errors.filter((e) => e.code === 'schema')
    expect(schemaErrors.length).toBeGreaterThan(0)
    const sessionError = schemaErrors.find((e) => e.field?.includes('session'))
    expect(sessionError).toBeDefined()
    expect(sessionError?.message).toMatch(/required/i)
  })

  it('returns error for invalid task type', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-a': { name: 'Task A', prompt: 'Do task A', type: 'scripting' },
      },
    }
    const result = validatePlan(raw)
    expect(result.valid).toBe(false)
    const typeError = result.errors.find((e) => e.code === 'schema' && e.field?.includes('type'))
    expect(typeError).toBeDefined()
    expect(typeError?.suggestion).toContain('coding, testing, docs, debugging, refactoring')
  })

  it('returns error when task prompt is missing', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-a': { name: 'Task A', prompt: '', type: 'coding' },
      },
    }
    const result = validatePlan(raw)
    expect(result.valid).toBe(false)
    const promptError = result.errors.find((e) => e.code === 'schema' && e.field?.includes('prompt'))
    expect(promptError).toBeDefined()
    expect(promptError?.message).toMatch(/required/i)
  })

  it('returns no graph when schema fails', () => {
    const result = validatePlan({ version: '1' })
    expect(result.valid).toBe(false)
    expect(result.graph).toBeUndefined()
  })

  it('collects multiple errors without short-circuiting', () => {
    const raw = {
      version: '1',
      session: { name: '' },
      tasks: {
        'task-a': { name: '', prompt: '', type: 'coding' },
      },
    }
    const result = validatePlan(raw)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// validatePlan — empty graph check (AC9)
// ---------------------------------------------------------------------------

describe('validatePlan — empty graph', () => {
  it('returns empty_graph error when tasks is empty', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {},
    }
    const result = validatePlan(raw)
    expect(result.valid).toBe(false)
    const emptyError = result.errors.find((e) => e.code === 'empty_graph')
    expect(emptyError).toBeDefined()
    expect(emptyError?.message).toMatch(/empty/i)
    expect(emptyError?.suggestion).toMatch(/at least one task/i)
  })
})

// ---------------------------------------------------------------------------
// validatePlan — cycle detection (AC2)
// ---------------------------------------------------------------------------

describe('validatePlan — cycle detection', () => {
  it('detects a simple A->B->A cycle', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-a': { name: 'A', prompt: 'Do A', type: 'coding', depends_on: ['task-b'] },
        'task-b': { name: 'B', prompt: 'Do B', type: 'coding', depends_on: ['task-a'] },
      },
    }
    const result = validatePlan(raw)
    expect(result.valid).toBe(false)
    const cycleError = result.errors.find((e) => e.code === 'cycle')
    expect(cycleError).toBeDefined()
    expect(cycleError?.message).toContain('->')
    expect(cycleError?.suggestion).toMatch(/remove/i)
  })

  it('cycle error includes the closing edge in suggestion', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-a': { name: 'A', prompt: 'Do A', type: 'coding', depends_on: ['task-b'] },
        'task-b': { name: 'B', prompt: 'Do B', type: 'coding', depends_on: ['task-a'] },
      },
    }
    const result = validatePlan(raw)
    const cycleError = result.errors.find((e) => e.code === 'cycle')
    expect(cycleError?.suggestion).toBeDefined()
    // suggestion should mention "-> task-a" or "-> task-b" (closing edge)
    expect(cycleError?.suggestion).toMatch(/->/)
  })
})

// ---------------------------------------------------------------------------
// validatePlan — dangling references (AC3)
// ---------------------------------------------------------------------------

describe('validatePlan — dangling references', () => {
  it('returns dangling_ref error for missing dependency', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-b': {
          name: 'B',
          prompt: 'Do B',
          type: 'coding',
          depends_on: ['task-x'],
        },
      },
    }
    const result = validatePlan(raw)
    expect(result.valid).toBe(false)
    const refError = result.errors.find((e) => e.code === 'dangling_ref')
    expect(refError).toBeDefined()
    expect(refError?.field).toContain('task-b')
    expect(refError?.field).toContain('depends_on')
    expect(refError?.message).toContain('task-x')
    expect(refError?.suggestion).toContain('task-x')
  })
})

// ---------------------------------------------------------------------------
// validatePlan — agent availability (AC4)
// ---------------------------------------------------------------------------

describe('validatePlan — agent availability', () => {
  it('produces no agent warning when agent is registered', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-a': { name: 'A', prompt: 'Do A', type: 'coding', agent: 'claude-code' },
      },
    }
    const registry = mockRegistry(['claude-code', 'gemini'])
    const result = validatePlan(raw, registry)
    expect(result.valid).toBe(true)
    const agentWarnings = result.warnings.filter((w) => w.code === 'agent_unavailable')
    expect(agentWarnings).toHaveLength(0)
  })

  it('produces warning when agent is not in registry', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-a': { name: 'A', prompt: 'Do A', type: 'coding', agent: 'codex' },
      },
    }
    const registry = mockRegistry([])
    const result = validatePlan(raw, registry)
    expect(result.valid).toBe(true) // warnings don't block
    const agentWarn = result.warnings.find((w) => w.code === 'agent_unavailable')
    expect(agentWarn).toBeDefined()
    expect(agentWarn?.message).toContain('codex')
    expect(agentWarn?.message).toContain('not registered')
  })

  it('warning message includes available agents list', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-a': { name: 'A', prompt: 'Do A', type: 'coding', agent: 'unknown-agent' },
      },
    }
    const registry = mockRegistry(['claude-code', 'gemini'])
    const result = validatePlan(raw, registry)
    const agentWarn = result.warnings.find((w) => w.code === 'agent_unavailable')
    expect(agentWarn?.message).toContain('claude-code')
    expect(agentWarn?.message).toContain('gemini')
  })

  it('produces no warning when no adapterRegistry provided', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-a': { name: 'A', prompt: 'Do A', type: 'coding', agent: 'unknown-agent' },
      },
    }
    const result = validatePlan(raw)
    const agentWarnings = result.warnings.filter((w) => w.code === 'agent_unavailable')
    expect(agentWarnings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// validatePlan — budget warnings (AC9)
// ---------------------------------------------------------------------------

describe('validatePlan — budget warnings', () => {
  it('produces no_budget warning for task missing budget_usd', () => {
    const result = validatePlan(minimalPlan())
    const budgetWarnings = result.warnings.filter((w) => w.code === 'no_budget')
    expect(budgetWarnings).toHaveLength(1)
    expect(budgetWarnings[0]?.field).toContain('task-a')
  })

  it('produces no no_budget warning when budget_usd is set', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-a': { name: 'A', prompt: 'Do A', type: 'coding', budget_usd: 1.0 },
      },
    }
    const result = validatePlan(raw)
    const budgetWarnings = result.warnings.filter((w) => w.code === 'no_budget')
    expect(budgetWarnings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// validatePlan — agent normalization (AC7)
// ---------------------------------------------------------------------------

describe('validatePlan — agent normalization', () => {
  it('normalizes claude alias to claude-code when normalize=true', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'build-api': { name: 'Build API', prompt: 'Do it', type: 'coding', agent: 'claude' },
      },
    }
    const result = validatePlan(raw, undefined, { normalize: true })
    expect(result.valid).toBe(true)
    expect(result.autoFixed).toHaveLength(1)
    expect(result.autoFixed[0]).toContain("'claude'")
    expect(result.autoFixed[0]).toContain("'claude-code'")
    // The graph should contain the normalized agent name
    expect(result.graph?.tasks['build-api']?.agent).toBe('claude-code')
  })

  it('normalizes gemini-cli alias to gemini when normalize=true', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-a': { name: 'Task A', prompt: 'Do it', type: 'coding', agent: 'gemini-cli' },
      },
    }
    const result = validatePlan(raw, undefined, { normalize: true })
    expect(result.autoFixed).toHaveLength(1)
    expect(result.autoFixed[0]).toContain("'gemini'")
    expect(result.graph?.tasks['task-a']?.agent).toBe('gemini')
  })

  it('does NOT normalize when normalize=false (default)', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-a': { name: 'Task A', prompt: 'Do it', type: 'coding', agent: 'claude' },
      },
    }
    // 'claude' is not a valid agent in schema but we just check normalization doesn't happen
    // agent field is a free string in schema, so 'claude' is valid schema-wise
    const result = validatePlan(raw, undefined, { normalize: false })
    expect(result.autoFixed).toHaveLength(0)
    // The raw object should NOT be mutated
    const rawObj = raw as Record<string, unknown>
    const tasks = rawObj['tasks'] as Record<string, unknown>
    const taskA = tasks['task-a'] as Record<string, unknown>
    expect(taskA['agent']).toBe('claude')
  })

  it('multiple aliases across tasks are all normalized', () => {
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-a': { name: 'Task A', prompt: 'Do it', type: 'coding', agent: 'claude' },
        'task-b': { name: 'Task B', prompt: 'Do it', type: 'testing', agent: 'gemini-cli' },
      },
    }
    const result = validatePlan(raw, undefined, { normalize: true })
    expect(result.autoFixed).toHaveLength(2)
    expect(result.graph?.tasks['task-a']?.agent).toBe('claude-code')
    expect(result.graph?.tasks['task-b']?.agent).toBe('gemini')
  })
})

// ---------------------------------------------------------------------------
// validatePlan — multiple errors collected (not short-circuited)
// ---------------------------------------------------------------------------

describe('validatePlan — multiple errors', () => {
  it('collects all post-schema errors in a single run', () => {
    // This plan has a dangling ref AND an empty tasks (after removing task-a)
    // We use a plan with both dangling refs possible
    const raw = {
      version: '1',
      session: { name: 'test' },
      tasks: {
        'task-a': {
          name: 'A',
          prompt: 'Do A',
          type: 'coding',
          depends_on: ['task-x', 'task-y'], // two dangling refs
        },
      },
    }
    const result = validatePlan(raw)
    expect(result.valid).toBe(false)
    const danglingErrors = result.errors.filter((e) => e.code === 'dangling_ref')
    expect(danglingErrors.length).toBeGreaterThanOrEqual(2)
  })
})
