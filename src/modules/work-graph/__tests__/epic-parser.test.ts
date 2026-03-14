// @vitest-environment node
/**
 * Unit tests for EpicParser.
 *
 * Story 31-2: Epic Doc Ingestion (AC1, AC2, AC7)
 */

import { describe, it, expect } from 'vitest'
import { EpicParser } from '../epic-parser.js'
import type { ParsedStory, ParsedDependency } from '../epic-parser.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Minimal epic doc fixture with a story map section.
 * Contains two sprints and four stories.
 */
const FIXTURE_EPIC_DOC = `
# Epic 31 — Dolt Work Graph

Some introductory text.

#### Story Map

**Sprint 1 — Foundation:**
- 31-1: Schema and Dolt init (P0, Small)
- 31-2: Epic doc ingestion (P0, Medium)

**Sprint 2 — Integration:**
- 31-3: Auto-ingest on run startup (P1, Medium)
- 31-4: Ready-story dispatcher integration (P1, Large)

**Dependency chain**: 31-1 → 31-2 → 31-3 → 31-4; 31-3 also gates 31-5, 31-6
`

const FIXTURE_LINEAR_CHAIN_ONLY = `
#### Story Map

**Sprint 1 — Alpha:**
- 10-1: First story (P0, Small)
- 10-2: Second story (P1, Medium)

**Dependency chain**: 10-1 → 10-2
`

const FIXTURE_NO_DEPS = `
#### Story Map

**Sprint 1 — Solo:**
- 99-1: Only story (P2, Large)
`

const FIXTURE_NO_STORY_MAP = `
# Epic 42

This document has no story map section.

Some content here.
`

const FIXTURE_STORY_MAP_PRESENT_NO_VALID_LINES = `
#### Story Map

This section exists but has no valid story lines.
Just some random text here.
`

// ---------------------------------------------------------------------------
// parseStories tests
// ---------------------------------------------------------------------------

describe('EpicParser.parseStories', () => {
  const parser = new EpicParser()

  it('returns correct story_key for each story', () => {
    const stories = parser.parseStories(FIXTURE_EPIC_DOC)
    const keys = stories.map((s) => s.story_key)
    expect(keys).toEqual(['31-1', '31-2', '31-3', '31-4'])
  })

  it('populates epic_num and story_num correctly', () => {
    const stories = parser.parseStories(FIXTURE_EPIC_DOC)
    expect(stories[0]).toMatchObject({ epic_num: 31, story_num: 1 })
    expect(stories[1]).toMatchObject({ epic_num: 31, story_num: 2 })
    expect(stories[2]).toMatchObject({ epic_num: 31, story_num: 3 })
    expect(stories[3]).toMatchObject({ epic_num: 31, story_num: 4 })
  })

  it('extracts title, priority, and size correctly', () => {
    const stories = parser.parseStories(FIXTURE_EPIC_DOC)

    expect(stories[0]).toMatchObject({
      title: 'Schema and Dolt init',
      priority: 'P0',
      size: 'Small',
    })
    expect(stories[1]).toMatchObject({
      title: 'Epic doc ingestion',
      priority: 'P0',
      size: 'Medium',
    })
  })

  it('assigns sprint number from the nearest Sprint header above each story', () => {
    const stories = parser.parseStories(FIXTURE_EPIC_DOC)

    // Stories 31-1 and 31-2 are under Sprint 1
    expect(stories[0]!.sprint).toBe(1)
    expect(stories[1]!.sprint).toBe(1)

    // Stories 31-3 and 31-4 are under Sprint 2
    expect(stories[2]!.sprint).toBe(2)
    expect(stories[3]!.sprint).toBe(2)
  })

  it('increments sprint number correctly across multiple Sprint headers', () => {
    const doc = `
#### Story Map

**Sprint 1 — First:**
- 5-1: Story A (P0, Small)

**Sprint 2 — Second:**
- 5-2: Story B (P0, Small)

**Sprint 3 — Third:**
- 5-3: Story C (P0, Small)
`
    const stories = parser.parseStories(doc)
    expect(stories.map((s) => s.sprint)).toEqual([1, 2, 3])
  })

  it('parses stories with hyphenated size (e.g. Extra-Large)', () => {
    const doc = `
#### Story Map

**Sprint 1 — Big:**
- 7-1: Chunky story (P0, Extra-Large)
`
    const stories = parser.parseStories(doc)
    expect(stories[0]!.size).toBe('Extra-Large')
  })

  it('works with H2-level Story Map heading', () => {
    const doc = `
## Story Map

**Sprint 1 — Alpha:**
- 3-1: A story (P1, Small)
`
    const stories = parser.parseStories(doc)
    expect(stories).toHaveLength(1)
    expect(stories[0]!.story_key).toBe('3-1')
  })

  it('works with H5-level Story Map heading', () => {
    const doc = `
##### Story Map

**Sprint 1 — Alpha:**
- 3-1: A story (P1, Small)
`
    const stories = parser.parseStories(doc)
    expect(stories).toHaveLength(1)
  })

  it('throws with "No story map section" message when section is absent', () => {
    expect(() => parser.parseStories(FIXTURE_NO_STORY_MAP)).toThrowError(
      /No story map section/i,
    )
  })

  it('throws when story map section is present but all lines are malformed', () => {
    expect(() => parser.parseStories(FIXTURE_STORY_MAP_PRESENT_NO_VALID_LINES)).toThrow()
  })

  it('returns a ParsedStory for each matching story line', () => {
    const stories = parser.parseStories(FIXTURE_LINEAR_CHAIN_ONLY)
    expect(stories).toHaveLength(2)
  })

  it('handles an epic with no dependency section (story-only doc)', () => {
    const stories = parser.parseStories(FIXTURE_NO_DEPS)
    expect(stories).toHaveLength(1)
    expect(stories[0]!.story_key).toBe('99-1')
  })
})

// ---------------------------------------------------------------------------
// parseDependencies tests
// ---------------------------------------------------------------------------

describe('EpicParser.parseDependencies', () => {
  const parser = new EpicParser()

  it('returns empty array when no Dependency chain line is present', () => {
    const deps = parser.parseDependencies(FIXTURE_NO_DEPS)
    expect(deps).toEqual([])
  })

  it('parses a simple linear chain: A → B → C produces two deps', () => {
    const doc = `
**Dependency chain**: 10-1 → 10-2 → 10-3
`
    const deps = parser.parseDependencies(doc)
    expect(deps).toHaveLength(2)
    // 10-2 depends_on 10-1
    expect(deps[0]).toMatchObject<ParsedDependency>({
      story_key: '10-2',
      depends_on: '10-1',
      dependency_type: 'blocks',
      source: 'explicit',
    })
    // 10-3 depends_on 10-2
    expect(deps[1]).toMatchObject<ParsedDependency>({
      story_key: '10-3',
      depends_on: '10-2',
      dependency_type: 'blocks',
      source: 'explicit',
    })
  })

  it('parses "also gates" clause and produces extra blocking deps', () => {
    const doc = `
**Dependency chain**: 31-1 → 31-2; 31-2 also gates 31-5, 31-6
`
    const deps = parser.parseDependencies(doc)

    // From the linear chain: 31-2 depends_on 31-1
    const linDep = deps.find((d) => d.story_key === '31-2' && d.depends_on === '31-1')
    expect(linDep).toBeDefined()

    // From also gates: 31-5 and 31-6 depend_on 31-2
    const gate5 = deps.find((d) => d.story_key === '31-5' && d.depends_on === '31-2')
    expect(gate5).toBeDefined()

    const gate6 = deps.find((d) => d.story_key === '31-6' && d.depends_on === '31-2')
    expect(gate6).toBeDefined()
  })

  it('parses the combined fixture correctly', () => {
    const deps = parser.parseDependencies(FIXTURE_EPIC_DOC)

    // Linear chain: 31-1 → 31-2 → 31-3 → 31-4
    expect(deps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ story_key: '31-2', depends_on: '31-1' }),
        expect.objectContaining({ story_key: '31-3', depends_on: '31-2' }),
        expect.objectContaining({ story_key: '31-4', depends_on: '31-3' }),
      ]),
    )

    // Also gates: 31-5 and 31-6 depend_on 31-3
    expect(deps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ story_key: '31-5', depends_on: '31-3' }),
        expect.objectContaining({ story_key: '31-6', depends_on: '31-3' }),
      ]),
    )
  })

  it('all parsed dependencies have source = "explicit" and dependency_type = "blocks"', () => {
    const deps = parser.parseDependencies(FIXTURE_EPIC_DOC)
    for (const dep of deps) {
      expect(dep.source).toBe('explicit')
      expect(dep.dependency_type).toBe('blocks')
    }
  })

  it('returns empty array for a single-story chain (no arrows)', () => {
    const doc = `**Dependency chain**: 31-1`
    const deps = parser.parseDependencies(doc)
    // Single node chain produces zero dependency pairs
    expect(deps).toHaveLength(0)
  })

  it('handles FIXTURE_LINEAR_CHAIN_ONLY correctly', () => {
    const deps = parser.parseDependencies(FIXTURE_LINEAR_CHAIN_ONLY)
    expect(deps).toHaveLength(1)
    expect(deps[0]).toMatchObject({ story_key: '10-2', depends_on: '10-1' })
  })
})

// ---------------------------------------------------------------------------
// Type-level check: ParsedStory fields are complete
// ---------------------------------------------------------------------------

describe('ParsedStory shape', () => {
  it('has all required fields', () => {
    const parser = new EpicParser()
    const stories = parser.parseStories(FIXTURE_EPIC_DOC)
    const s: ParsedStory = stories[0]!

    expect(typeof s.story_key).toBe('string')
    expect(typeof s.epic_num).toBe('number')
    expect(typeof s.story_num).toBe('number')
    expect(typeof s.title).toBe('string')
    expect(typeof s.priority).toBe('string')
    expect(typeof s.size).toBe('string')
    expect(typeof s.sprint).toBe('number')
  })
})
