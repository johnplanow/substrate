/**
 * Unit tests for src/modules/implementation-orchestrator/story-discovery.ts
 *
 * Covers:
 *   - parseStoryKeysFromEpics: extraction of N-M keys from all three formats
 *   - Deduplication across formats
 *   - Numeric sort (not lexicographic)
 *   - Empty / no-match content
 *   - discoverPendingStoryKeys: pending = all - existing
 *   - discoverPendingStoryKeys: missing epics.md → empty array
 *   - discoverPendingStoryKeys: all stories done → empty array
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — declared before imports (Vitest hoisting)
// ---------------------------------------------------------------------------

const mockExistsSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockReaddirSync = vi.fn()

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import {
  parseStoryKeysFromEpics,
  discoverPendingStoryKeys,
  parseEpicsDependencies,
  topologicalSortByDependencies,
} from '../story-discovery.js'

// ---------------------------------------------------------------------------
// parseStoryKeysFromEpics tests
// ---------------------------------------------------------------------------

describe('parseStoryKeysFromEpics', () => {
  it('returns empty array for empty content', () => {
    expect(parseStoryKeysFromEpics('')).toEqual([])
  })

  it('returns empty array when content has no story key patterns', () => {
    const content = `# Epics

## Epic 1: Foundation
This epic covers the foundation work.
No specific story keys here.
`
    expect(parseStoryKeysFromEpics(content)).toEqual([])
  })

  it('extracts keys from explicit **Story key:** backtick format', () => {
    const content = `
**Story key:** \`7-2-human-turn-loop\`
**Story key:** \`7-3-some-other-story\`
`
    expect(parseStoryKeysFromEpics(content)).toEqual(['7-2', '7-3'])
  })

  it('extracts keys from explicit **Story key:** without backticks', () => {
    const content = `**Story key:** 1-1\n**Story key:** 2-3`
    expect(parseStoryKeysFromEpics(content)).toEqual(['1-1', '2-3'])
  })

  it('extracts keys from ### Story N.M: headings', () => {
    const content = `
### Story 7.2: Human Turn Loop
Some description.

### Story 7.3: Another Story
More description.
`
    expect(parseStoryKeysFromEpics(content)).toEqual(['7-2', '7-3'])
  })

  it('extracts keys from ### Story N.M headings without colon', () => {
    const content = `### Story 5.1 First Story\n### Story 10.3 Tenth Epic Third Story`
    expect(parseStoryKeysFromEpics(content)).toEqual(['5-1', '10-3'])
  })

  it('extracts keys from file path references', () => {
    const content = `
See _bmad-output/implementation-artifacts/7-2-human-turn-loop.md
See _bmad-output/implementation-artifacts/7-3-another.md
`
    expect(parseStoryKeysFromEpics(content)).toEqual(['7-2', '7-3'])
  })

  it('deduplicates keys appearing in multiple formats', () => {
    const content = `
**Story key:** \`7-2-human-turn-loop\`

### Story 7.2: Human Turn Loop

See _bmad-output/implementation-artifacts/7-2-human-turn-loop.md
`
    // All three patterns match 7-2 — should appear only once
    expect(parseStoryKeysFromEpics(content)).toEqual(['7-2'])
  })

  it('deduplicates keys across different sections', () => {
    const content = `
**Story key:** \`1-1-setup\`
**Story key:** \`1-2-config\`
**Story key:** \`1-1-setup\`
`
    expect(parseStoryKeysFromEpics(content)).toEqual(['1-1', '1-2'])
  })

  it('sorts numerically: epic number primary, story number secondary', () => {
    const content = `
**Story key:** \`10-1-tenth-epic\`
**Story key:** \`1-2-second-story\`
**Story key:** \`2-1-second-epic\`
**Story key:** \`1-1-first-story\`
`
    expect(parseStoryKeysFromEpics(content)).toEqual(['1-1', '1-2', '2-1', '10-1'])
  })

  it('correctly sorts 10-1 after 9-1 (numeric not lexicographic)', () => {
    const content = `
**Story key:** \`10-1-ten\`
**Story key:** \`9-1-nine\`
**Story key:** \`2-1-two\`
`
    const result = parseStoryKeysFromEpics(content)
    // Numeric sort: 2-1, 9-1, 10-1
    expect(result).toEqual(['2-1', '9-1', '10-1'])
    // Verify it's NOT lexicographic ("10" < "2" lexicographically)
    expect(result[0]).toBe('2-1')
    expect(result[2]).toBe('10-1')
  })

  it('handles all three formats in a real-world-like epics.md excerpt', () => {
    const content = `
## Epic 7: Implementation Pipeline

### Story 7.1: Basic Runner

**Story key:** \`7-1-basic-runner\`

This story implements the basic runner.

### Story 7.2: Human Turn Loop

**Story key:** \`7-2-human-turn-loop\`

See existing work at _bmad-output/implementation-artifacts/7-2-human-turn-loop.md

### Story 7.3: Error Handling

**Story key:** \`7-3-error-handling\`
`
    expect(parseStoryKeysFromEpics(content)).toEqual(['7-1', '7-2', '7-3'])
  })
})

// ---------------------------------------------------------------------------
// discoverPendingStoryKeys tests
// ---------------------------------------------------------------------------

describe('discoverPendingStoryKeys', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty array when epics.md does not exist', () => {
    mockExistsSync.mockReturnValue(false)

    const result = discoverPendingStoryKeys('/project')
    expect(result).toEqual([])
    expect(mockReadFileSync).not.toHaveBeenCalled()
  })

  it('returns empty array when epics.md exists but is unreadable', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    const result = discoverPendingStoryKeys('/project')
    expect(result).toEqual([])
  })

  it('returns empty array when epics.md has no story keys', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('epics.md')) return true
      return false // implementation-artifacts dir
    })
    mockReadFileSync.mockReturnValue('# Epics\nNo stories yet.')
    mockReaddirSync.mockReturnValue([])

    const result = discoverPendingStoryKeys('/project')
    expect(result).toEqual([])
  })

  it('returns all story keys when implementation-artifacts dir does not exist', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('epics.md')) return true
      return false // implementation-artifacts dir doesn't exist
    })
    mockReadFileSync.mockReturnValue(`
**Story key:** \`7-1-setup\`
**Story key:** \`7-2-config\`
`)

    const result = discoverPendingStoryKeys('/project')
    expect(result).toEqual(['7-1', '7-2'])
  })

  it('returns only pending (not-yet-implemented) story keys', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('epics.md')) return true
      if (p.endsWith('implementation-artifacts')) return true
      return false
    })
    mockReadFileSync.mockReturnValue(`
**Story key:** \`7-1-setup\`
**Story key:** \`7-2-config\`
**Story key:** \`7-3-feature\`
`)
    // 7-1 and 7-3 already exist as files
    mockReaddirSync.mockReturnValue(['7-1-setup.md', '7-3-feature.md'])

    const result = discoverPendingStoryKeys('/project')
    expect(result).toEqual(['7-2'])
  })

  it('returns empty array when all story files already exist', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('epics.md')) return true
      if (p.endsWith('implementation-artifacts')) return true
      return false
    })
    mockReadFileSync.mockReturnValue(`
**Story key:** \`5-1-story-one\`
**Story key:** \`5-2-story-two\`
`)
    mockReaddirSync.mockReturnValue(['5-1-story-one.md', '5-2-story-two.md'])

    const result = discoverPendingStoryKeys('/project')
    expect(result).toEqual([])
  })

  it('ignores non-.md files in implementation-artifacts', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('epics.md')) return true
      if (p.endsWith('implementation-artifacts')) return true
      return false
    })
    mockReadFileSync.mockReturnValue(`**Story key:** \`1-1-setup\``)
    // Only a .json file exists — should not count as "done"
    mockReaddirSync.mockReturnValue(['1-1-setup.json', 'notes.txt'])

    const result = discoverPendingStoryKeys('/project')
    expect(result).toEqual(['1-1'])
  })

  it('uses fallback path _bmad-output/epics.md when primary path missing', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes('planning-artifacts/epics.md')) return false
      if (p.includes('_bmad-output/epics.md')) return true
      return false
    })
    mockReadFileSync.mockReturnValue(`**Story key:** \`3-1-feature\``)
    mockReaddirSync.mockReturnValue([])

    const result = discoverPendingStoryKeys('/project')
    expect(result).toEqual(['3-1'])
  })

  it('discovers consolidated epics file via glob (e.g. epics-and-stories-*.md)', () => {
    mockExistsSync.mockImplementation((p: string) => {
      // Exact epics.md candidates don't exist
      if (p.endsWith('planning-artifacts/epics.md')) return false
      if (p.endsWith('_bmad-output/epics.md')) return false
      // But the planning-artifacts directory does exist
      if (p.endsWith('planning-artifacts')) return true
      if (p.endsWith('implementation-artifacts')) return true
      return false
    })
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir.includes('planning-artifacts')) {
        return ['epic-33-validation-harness.md', 'epics-and-stories-software-factory.md']
      }
      if (dir.includes('implementation-artifacts')) {
        return ['40-1-setup.md', '40-2-config.md'] // some done
      }
      return []
    })
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('epics-and-stories')) {
        return `### Story 40-1: Setup\n### Story 40-2: Config\n### Story 50-1: Parallel Handler\n### Story 50-2: Fan-In Handler`
      }
      return ''
    })

    const result = discoverPendingStoryKeys('/project')
    // 40-1 and 40-2 have artifacts → filtered out; 50-1 and 50-2 are pending
    expect(result).toEqual(['50-1', '50-2'])
  })

  it('returns results sorted numerically', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('epics.md')) return true
      if (p.endsWith('implementation-artifacts')) return true
      return false
    })
    mockReadFileSync.mockReturnValue(`
**Story key:** \`10-2-tenth-second\`
**Story key:** \`1-1-first\`
**Story key:** \`2-1-second-epic\`
`)
    mockReaddirSync.mockReturnValue([]) // nothing done yet

    const result = discoverPendingStoryKeys('/project')
    expect(result).toEqual(['1-1', '2-1', '10-2'])
  })

  it('handles readdirSync error gracefully (returns all from epics.md)', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('epics.md')) return true
      if (p.endsWith('implementation-artifacts')) return true
      return false
    })
    mockReadFileSync.mockReturnValue(`**Story key:** \`4-1-feature\``)
    mockReaddirSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    const result = discoverPendingStoryKeys('/project')
    // Can't read dir → no existing keys → all from epics are pending
    expect(result).toEqual(['4-1'])
  })
})

// ---------------------------------------------------------------------------
// parseEpicsDependencies tests
// ---------------------------------------------------------------------------

describe('parseEpicsDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty map when no epics file exists', () => {
    mockExistsSync.mockReturnValue(false)
    const result = parseEpicsDependencies('/project', new Set(['50-1', '50-2']))
    expect(result.size).toBe(0)
  })

  it('parses comma-separated dependencies', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('planning-artifacts')) return true
      return p.endsWith('epics.md')
    })
    mockReadFileSync.mockReturnValue(`
### Story 50-1: Parallel Handler
**Dependencies:** None

### Story 50-2: Fan-In Handler
**Dependencies:** 50-1

### Story 50-9: Event Extensions
**Dependencies:** 50-1, 50-4, 50-5
`)
    const keys = new Set(['50-1', '50-2', '50-4', '50-5', '50-9'])
    const result = parseEpicsDependencies('/project', keys)

    expect(result.has('50-1')).toBe(false) // None
    expect(result.get('50-2')).toEqual(new Set(['50-1']))
    expect(result.get('50-9')).toEqual(new Set(['50-1', '50-4', '50-5']))
  })

  it('parses "through" range syntax', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('planning-artifacts')) return true
      return p.endsWith('epics.md')
    })
    mockReadFileSync.mockReturnValue(`
### Story 50-11: Integration Tests
**Dependencies:** 50-1 through 50-9
`)
    const keys = new Set(['50-1', '50-2', '50-3', '50-9', '50-11'])
    const result = parseEpicsDependencies('/project', keys)

    expect(result.get('50-11')).toEqual(new Set(['50-1', '50-2', '50-3', '50-9']))
  })

  it('filters out dependencies not in the provided key set', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('planning-artifacts')) return true
      return p.endsWith('epics.md')
    })
    mockReadFileSync.mockReturnValue(`
### Story 50-7: Stylesheet RoutingEngine
**Dependencies:** 50-6, 41-4
`)
    // 41-4 is external (not in our set), should be excluded
    const keys = new Set(['50-6', '50-7'])
    const result = parseEpicsDependencies('/project', keys)

    expect(result.get('50-7')).toEqual(new Set(['50-6']))
  })
})

// ---------------------------------------------------------------------------
// topologicalSortByDependencies tests
// ---------------------------------------------------------------------------

describe('topologicalSortByDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns single key as-is', () => {
    const result = topologicalSortByDependencies(['50-1'], '/project')
    expect(result).toEqual(['50-1'])
  })

  it('sorts keys by dependencies (prerequisites first)', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('planning-artifacts')) return true
      return p.endsWith('epics.md')
    })
    mockReadFileSync.mockReturnValue(`
### Story 50-1: Parallel Handler
**Dependencies:** None

### Story 50-2: Fan-In Handler
**Dependencies:** 50-1

### Story 50-3: Join Policies
**Dependencies:** 50-1
`)
    mockReaddirSync.mockReturnValue([])

    const result = topologicalSortByDependencies(['50-3', '50-2', '50-1'], '/project')
    // 50-1 must come before 50-2 and 50-3
    expect(result.indexOf('50-1')).toBeLessThan(result.indexOf('50-2'))
    expect(result.indexOf('50-1')).toBeLessThan(result.indexOf('50-3'))
  })

  it('handles multi-level dependency chains', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('planning-artifacts')) return true
      return p.endsWith('epics.md')
    })
    mockReadFileSync.mockReturnValue(`
### Story 50-1: First
**Dependencies:** None

### Story 50-2: Second
**Dependencies:** 50-1

### Story 50-10: Third
**Dependencies:** 50-2
`)
    mockReaddirSync.mockReturnValue([])

    const result = topologicalSortByDependencies(['50-10', '50-1', '50-2'], '/project')
    expect(result).toEqual(['50-1', '50-2', '50-10'])
  })

  it('falls back to numeric sort when no epics file exists', () => {
    mockExistsSync.mockReturnValue(false)

    const result = topologicalSortByDependencies(['50-3', '50-1', '50-2'], '/project')
    expect(result).toEqual(['50-1', '50-2', '50-3'])
  })

  it('places independent stories in earliest wave', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('planning-artifacts')) return true
      return p.endsWith('epics.md')
    })
    mockReadFileSync.mockReturnValue(`
### Story 50-1: Parallel
**Dependencies:** None

### Story 50-2: Fan-In
**Dependencies:** 50-1

### Story 50-4: LLM Edges
**Dependencies:** None

### Story 50-5: Subgraph
**Dependencies:** None
`)
    mockReaddirSync.mockReturnValue([])

    const result = topologicalSortByDependencies(
      ['50-5', '50-2', '50-4', '50-1'],
      '/project',
    )
    // 50-1, 50-4, 50-5 are independent → come first; 50-2 depends on 50-1 → comes last
    expect(result.indexOf('50-2')).toBe(result.length - 1)
    // 50-1, 50-4, 50-5 should all come before 50-2
    expect(result.indexOf('50-1')).toBeLessThan(result.indexOf('50-2'))
    expect(result.indexOf('50-4')).toBeLessThan(result.indexOf('50-2'))
    expect(result.indexOf('50-5')).toBeLessThan(result.indexOf('50-2'))
  })
})
