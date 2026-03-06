/**
 * Unit tests for detectConflictGroups().
 *
 * Covers:
 *  - Unknown projects default to per-story isolation (no moduleMap)
 *  - Pack-configured conflict groups work correctly
 *  - Backward-compatible behavior when moduleMap is provided explicitly
 */

import { describe, it, expect } from 'vitest'
import { detectConflictGroups } from '../conflict-detector.js'

// ---------------------------------------------------------------------------
// The substrate-specific moduleMap (previously hardcoded; now lives in BMAD pack config)
// ---------------------------------------------------------------------------
const SUBSTRATE_MODULE_MAP: Record<string, string> = {
  '1-': 'core',
  '2-': 'core',
  '3-': 'core',
  '4-': 'core',
  '5-': 'core',
  '6-': 'task-graph',
  '7-': 'worker-pool',
  '8-': 'monitor',
  '9-': 'bmad-context-engine',
  '10-1': 'compiled-workflows',
  '10-2': 'compiled-workflows',
  '10-3': 'compiled-workflows',
  '10-4': 'implementation-orchestrator',
  '10-5': 'cli',
  '11-': 'pipeline-phases',
}

describe('detectConflictGroups — default (no moduleMap)', () => {
  it('isolates every story into its own group when no moduleMap is given', () => {
    const result = detectConflictGroups(['4-1', '4-2', '4-3', '4-4', '4-5', '4-6'])
    // Without a map, every story is its own conflict group → max parallelism
    expect(result).toHaveLength(6)
    expect(result.flat()).toEqual(expect.arrayContaining(['4-1', '4-2', '4-3', '4-4', '4-5', '4-6']))
    for (const group of result) {
      expect(group).toHaveLength(1)
    }
  })

  it('returns one group with one story for a single story key', () => {
    const result = detectConflictGroups(['10-1'])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(['10-1'])
  })

  it('returns an empty array for an empty input', () => {
    const result = detectConflictGroups([])
    expect(result).toEqual([])
  })

  it('isolates cross-project story keys (unknown prefix) into separate groups', () => {
    const result = detectConflictGroups(['99-1', '99-2'])
    // No map → each is isolated regardless of prefix similarity
    expect(result).toHaveLength(2)
    expect(result.flat()).toContain('99-1')
    expect(result.flat()).toContain('99-2')
    // Each is in its own group
    for (const group of result) {
      expect(group).toHaveLength(1)
    }
  })

  it('isolates story keys with descriptive suffixes into separate groups', () => {
    // Without a map, even keys that share the same "10-" prefix are isolated
    const result = detectConflictGroups(['10-1-create-story', '10-2-dev-story'])
    expect(result).toHaveLength(2)
    expect(result.flat()).toContain('10-1-create-story')
    expect(result.flat()).toContain('10-2-dev-story')
  })
})

describe('detectConflictGroups — with moduleMap (pack-configured conflict groups)', () => {
  it('groups stories that share the same module into one conflict group', () => {
    const result = detectConflictGroups(['12-1', '12-2'], { moduleMap: { '12-': 'my-module' } })
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('12-1')
    expect(result[0]).toContain('12-2')
  })

  it('places stories with different modules in separate groups', () => {
    const result = detectConflictGroups(['12-1', '13-1'], {
      moduleMap: { '12-': 'module-a', '13-': 'module-b' },
    })
    expect(result).toHaveLength(2)
    expect(result.flat()).toContain('12-1')
    expect(result.flat()).toContain('13-1')
  })

  it('handles mixed known/unknown prefixes: known grouped, unknown isolated', () => {
    const result = detectConflictGroups(['12-1', '12-2', '99-1'], {
      moduleMap: { '12-': 'my-module' },
    })
    // 12-1 and 12-2 share 'my-module'; 99-1 is unknown → isolated
    expect(result).toHaveLength(2)
    const knownGroup = result.find((g) => g.includes('12-1'))
    expect(knownGroup).toBeDefined()
    expect(knownGroup).toContain('12-2')
    expect(knownGroup).not.toContain('99-1')
    const unknownGroup = result.find((g) => g.includes('99-1'))
    expect(unknownGroup).toHaveLength(1)
  })

  it('respects most-specific prefix (10-1 over 10-)', () => {
    const moduleMap = {
      '10-1': 'compiled-workflows',
      '10-2': 'compiled-workflows',
      '10-': 'other-module',
    }
    // '10-1' matches '10-1' (most specific) → compiled-workflows
    // '10-4' matches '10-' → other-module
    const result = detectConflictGroups(['10-1', '10-4'], { moduleMap })
    expect(result).toHaveLength(2)
    const group1 = result.find((g) => g.includes('10-1'))
    expect(group1).not.toContain('10-4')
  })
})

describe('detectConflictGroups — substrate self-run backward compatibility', () => {
  it('groups same-module stories into the same conflict group (substrate map)', () => {
    const result = detectConflictGroups(['10-1', '10-2', '10-3'], { moduleMap: SUBSTRATE_MODULE_MAP })
    // All map to 'compiled-workflows'
    expect(result).toHaveLength(1)
    const group = result[0]
    expect(group).toContain('10-1')
    expect(group).toContain('10-2')
    expect(group).toContain('10-3')
  })

  it('places stories with different module prefixes in separate groups (substrate map)', () => {
    const result = detectConflictGroups(['10-4', '10-5'], { moduleMap: SUBSTRATE_MODULE_MAP })
    // 10-4 → implementation-orchestrator, 10-5 → cli — different modules
    expect(result).toHaveLength(2)
    const flat = result.flat()
    expect(flat).toContain('10-4')
    expect(flat).toContain('10-5')
    const group4 = result.find((g) => g.includes('10-4'))
    const group5 = result.find((g) => g.includes('10-5'))
    expect(group4).not.toEqual(group5)
  })

  it('handles mixed: some conflicting, some independent (substrate map)', () => {
    // 10-1, 10-2 → compiled-workflows (same group)
    // 10-4 → implementation-orchestrator (own group)
    // 10-5 → cli (own group)
    const result = detectConflictGroups(['10-1', '10-2', '10-4', '10-5'], { moduleMap: SUBSTRATE_MODULE_MAP })
    expect(result).toHaveLength(3)

    const compiledGroup = result.find((g) => g.includes('10-1'))
    expect(compiledGroup).toBeDefined()
    expect(compiledGroup).toContain('10-2')
    expect(compiledGroup).not.toContain('10-4')
    expect(compiledGroup).not.toContain('10-5')
  })

  it('handles story keys with descriptive suffixes using substrate map', () => {
    // '10-1-create-story' starts with '10-1' → compiled-workflows
    const result = detectConflictGroups(['10-1-create-story', '10-2-dev-story'], {
      moduleMap: SUBSTRATE_MODULE_MAP,
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('10-1-create-story')
    expect(result[0]).toContain('10-2-dev-story')
  })

  it('uses most-specific prefix (10-1 before 10-) with substrate map', () => {
    // 10-1, 10-2, 10-3 → compiled-workflows; 10-4 → implementation-orchestrator
    const result = detectConflictGroups(['10-1', '10-4'], { moduleMap: SUBSTRATE_MODULE_MAP })
    expect(result).toHaveLength(2)
    const group1 = result.find((g) => g.includes('10-1'))
    expect(group1).not.toContain('10-4')
  })

  it('preserves epics 1-5 in the same core group with substrate map', () => {
    // Stories 1-1, 2-1, 3-1, 4-1, 5-1 all map to 'core'
    const result = detectConflictGroups(['1-1', '2-1', '3-1', '4-1', '5-1'], { moduleMap: SUBSTRATE_MODULE_MAP })
    expect(result).toHaveLength(1)
    expect(result[0]).toHaveLength(5)
  })
})
