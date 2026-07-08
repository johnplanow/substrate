/**
 * A0.2 — journey tags in story-artifact frontmatter (AC2).
 *
 * The critical isolation property: a malformed `journeys` value must fall
 * back to `[]` WITHOUT nuking `external_state_dependencies` (the pre-A0.2
 * parser reset the whole frontmatter block on any field failure — adding a
 * fragile field would have silently weakened the runtime-probe gate).
 */

import { describe, it, expect } from 'vitest'
import { parseStoryFrontmatter } from '../../run-model/story-artifact-schema.js'

describe('parseStoryFrontmatter journeys (A0.2)', () => {
  it('extracts journey tags from frontmatter', () => {
    const fm = parseStoryFrontmatter('---\njourneys:\n  - UJ-1\n  - UJ-2\n---\n# Story\n')

    expect(fm.journeys).toEqual(['UJ-1', 'UJ-2'])
  })

  it('coerces a bare string to a one-element list', () => {
    const fm = parseStoryFrontmatter('---\njourneys: UJ-1\n---\n# Story\n')

    expect(fm.journeys).toEqual(['UJ-1'])
  })

  it('defaults to [] when the field is absent (untagged is legal)', () => {
    const fm = parseStoryFrontmatter('---\nexternal_state_dependencies:\n  - git\n---\n# Story\n')

    expect(fm.journeys).toEqual([])
  })

  it('defaults to [] with no frontmatter block at all', () => {
    const fm = parseStoryFrontmatter('# Story\n')

    expect(fm.journeys).toEqual([])
  })

  it('ISOLATION: a malformed journeys value falls back to [] without dropping external_state_dependencies', () => {
    const fm = parseStoryFrontmatter('---\nexternal_state_dependencies:\n  - subprocess\njourneys: 42\n---\n# Story\n')

    expect(fm.journeys).toEqual([])
    expect(fm.external_state_dependencies).toEqual(['subprocess'])
  })

  it('both fields parse together', () => {
    const fm = parseStoryFrontmatter('---\nexternal_state_dependencies:\n  - git\njourneys:\n  - UJ-2\n---\n# Story\n')

    expect(fm.external_state_dependencies).toEqual(['git'])
    expect(fm.journeys).toEqual(['UJ-2'])
  })
})
