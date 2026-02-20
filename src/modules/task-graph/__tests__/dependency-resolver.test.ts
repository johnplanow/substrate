/**
 * Unit tests for dependency-resolver.ts (AC: #4, #5)
 */

import { describe, it, expect } from 'vitest'
import { detectCycle, validateDependencies } from '../dependency-resolver.js'
import type { TaskDefinition } from '../schemas.js'

// ---------------------------------------------------------------------------
// Helper to build TaskDefinition records
// ---------------------------------------------------------------------------

function task(depends_on: string[]): TaskDefinition {
  return {
    name: 'Test Task',
    prompt: 'Do something',
    type: 'coding',
    depends_on,
  }
}

// ---------------------------------------------------------------------------
// detectCycle tests
// ---------------------------------------------------------------------------

describe('detectCycle', () => {
  it('returns null for an acyclic graph with no dependencies', () => {
    const tasks = {
      'a': task([]),
      'b': task([]),
    }
    expect(detectCycle(tasks)).toBeNull()
  })

  it('returns null for an acyclic linear chain (A → B → C)', () => {
    const tasks = {
      'a': task(['b']),
      'b': task(['c']),
      'c': task([]),
    }
    expect(detectCycle(tasks)).toBeNull()
  })

  it('returns null for a diamond DAG (A→B, A→C, B→D, C→D)', () => {
    const tasks = {
      'a': task(['b', 'c']),
      'b': task(['d']),
      'c': task(['d']),
      'd': task([]),
    }
    expect(detectCycle(tasks)).toBeNull()
  })

  it('detects a direct cycle (A → B → A)', () => {
    const tasks = {
      'a': task(['b']),
      'b': task(['a']),
    }
    const cycle = detectCycle(tasks)
    expect(cycle).not.toBeNull()
    expect(cycle).toBeDefined()
    // Cycle path should contain both nodes
    if (cycle) {
      expect(cycle).toContain('a')
      expect(cycle).toContain('b')
    }
  })

  it('detects a transitive cycle (A → B → C → A)', () => {
    const tasks = {
      'a': task(['b']),
      'b': task(['c']),
      'c': task(['a']),
    }
    const cycle = detectCycle(tasks)
    expect(cycle).not.toBeNull()
    if (cycle) {
      // Should form a cycle path
      expect(cycle.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('cycle path ends with the repeated node', () => {
    const tasks = {
      'a': task(['b']),
      'b': task(['a']),
    }
    const cycle = detectCycle(tasks)
    expect(cycle).not.toBeNull()
    if (cycle) {
      // The first element should equal the last element (completing the cycle)
      expect(cycle[0]).toBe(cycle[cycle.length - 1])
    }
  })

  it('handles empty tasks object', () => {
    expect(detectCycle({})).toBeNull()
  })

  it('handles single task with no deps', () => {
    const tasks = { 'only': task([]) }
    expect(detectCycle(tasks)).toBeNull()
  })

  it('detects cycle even with multiple disconnected subgraphs', () => {
    const tasks = {
      // Acyclic subgraph
      'x': task(['y']),
      'y': task([]),
      // Cyclic subgraph
      'a': task(['b']),
      'b': task(['a']),
    }
    const cycle = detectCycle(tasks)
    expect(cycle).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validateDependencies tests
// ---------------------------------------------------------------------------

describe('validateDependencies', () => {
  it('returns empty array for graph with no missing deps', () => {
    const tasks = {
      'a': task([]),
      'b': task(['a']),
    }
    const errors = validateDependencies(tasks)
    expect(errors).toHaveLength(0)
  })

  it('returns error for task referencing a missing dependency', () => {
    const tasks = {
      'a': task(['nonexistent']),
    }
    const errors = validateDependencies(tasks)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('a')
    expect(errors[0]).toContain('nonexistent')
  })

  it('returns multiple errors for multiple missing deps', () => {
    const tasks = {
      'a': task(['missing-1', 'missing-2']),
    }
    const errors = validateDependencies(tasks)
    expect(errors).toHaveLength(2)
  })

  it('returns error for each task with missing dep', () => {
    const tasks = {
      'a': task(['ghost']),
      'b': task(['phantom']),
    }
    const errors = validateDependencies(tasks)
    expect(errors).toHaveLength(2)
  })

  it('returns empty array for empty tasks', () => {
    const errors = validateDependencies({})
    expect(errors).toHaveLength(0)
  })

  it('error message mentions the referencing task and missing dep', () => {
    const tasks = {
      'my-task': task(['dep-that-doesnt-exist']),
    }
    const errors = validateDependencies(tasks)
    expect(errors[0]).toContain('my-task')
    expect(errors[0]).toContain('dep-that-doesnt-exist')
  })
})
