/**
 * Unit tests for detectConflictGroups().
 *
 * Covers AC5: conflict detection heuristic groups stories by module prefix.
 */

import { describe, it, expect } from 'vitest'
import { detectConflictGroups } from '../conflict-detector.js'

describe('detectConflictGroups', () => {
  it('returns one group with one story for a single story key', () => {
    const result = detectConflictGroups(['10-1'])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(['10-1'])
  })

  it('groups same-module stories into the same conflict group', () => {
    const result = detectConflictGroups(['10-1', '10-2', '10-3'])
    // All map to 'compiled-workflows'
    expect(result).toHaveLength(1)
    const group = result[0]
    expect(group).toContain('10-1')
    expect(group).toContain('10-2')
    expect(group).toContain('10-3')
  })

  it('places stories with different module prefixes in separate groups', () => {
    const result = detectConflictGroups(['10-4', '10-5'])
    // 10-4 → implementation-orchestrator, 10-5 → cli — different modules
    expect(result).toHaveLength(2)
    const flat = result.flat()
    expect(flat).toContain('10-4')
    expect(flat).toContain('10-5')
    // Each is in its own group
    const group4 = result.find((g) => g.includes('10-4'))
    const group5 = result.find((g) => g.includes('10-5'))
    expect(group4).not.toEqual(group5)
  })

  it('handles mixed: some conflicting, some independent', () => {
    // 10-1, 10-2 → compiled-workflows (same group)
    // 10-4 → implementation-orchestrator (own group)
    // 10-5 → cli (own group)
    const result = detectConflictGroups(['10-1', '10-2', '10-4', '10-5'])
    expect(result).toHaveLength(3)

    const compiledGroup = result.find((g) => g.includes('10-1'))
    expect(compiledGroup).toBeDefined()
    expect(compiledGroup).toContain('10-2')
    expect(compiledGroup).not.toContain('10-4')
    expect(compiledGroup).not.toContain('10-5')
  })

  it('handles unknown story keys by isolating each in its own group', () => {
    const result = detectConflictGroups(['99-1', '99-2'])
    // 99- has no prefix mapping; each becomes isolated
    expect(result).toHaveLength(2)
    expect(result.flat()).toContain('99-1')
    expect(result.flat()).toContain('99-2')
  })

  it('returns an empty array for an empty input', () => {
    const result = detectConflictGroups([])
    expect(result).toEqual([])
  })

  it('uses most-specific prefix (10-1 before 10-)', () => {
    // 10-1, 10-2, 10-3 → compiled-workflows; 10-4 → implementation-orchestrator
    const result = detectConflictGroups(['10-1', '10-4'])
    expect(result).toHaveLength(2)
    const group1 = result.find((g) => g.includes('10-1'))
    expect(group1).not.toContain('10-4')
  })

  it('handles story keys with descriptive suffixes (e.g., 10-1-create-story)', () => {
    // '10-1-create-story' starts with '10-1' → compiled-workflows
    const result = detectConflictGroups(['10-1-create-story', '10-2-dev-story'])
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('10-1-create-story')
    expect(result[0]).toContain('10-2-dev-story')
  })
})
