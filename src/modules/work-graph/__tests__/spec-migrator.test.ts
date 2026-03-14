/**
 * Unit tests for spec-migrator.ts
 *
 * Story 31-8: Deprecate Status Field in Story Spec Frontmatter
 *
 * These tests cover pure string operations — no DB adapter or mocking needed.
 */

import { describe, it, expect } from 'vitest'
import {
  stripDeprecatedStatusField,
  detectDeprecatedStatusField,
} from '../spec-migrator.js'

// ---------------------------------------------------------------------------
// stripDeprecatedStatusField
// ---------------------------------------------------------------------------

describe('stripDeprecatedStatusField', () => {
  it('strips Status: ready-for-dev and the trailing blank line from a full spec', () => {
    const input = `# Story 1-1: My Story

Status: ready-for-dev

## Story

As a user,
I want something,
so that it works.

## Acceptance Criteria

### AC1: Something
**Given** context
**When** action
**Then** outcome

## Tasks / Subtasks

- [ ] Task 1
`

    const result = stripDeprecatedStatusField(input)

    expect(result).not.toContain('Status:')
    expect(result).not.toContain('ready-for-dev')
    // All other content preserved
    expect(result).toContain('# Story 1-1: My Story')
    expect(result).toContain('## Story')
    expect(result).toContain('As a user,')
    expect(result).toContain('## Acceptance Criteria')
    expect(result).toContain('## Tasks / Subtasks')
    expect(result).toContain('- [ ] Task 1')
  })

  it('strips Status: draft (different value)', () => {
    const input = `# Story 2-1: Draft Story

Status: draft

## Story

Content here.
`

    const result = stripDeprecatedStatusField(input)

    expect(result).not.toContain('Status:')
    expect(result).not.toContain('draft')
    expect(result).toContain('# Story 2-1: Draft Story')
    expect(result).toContain('## Story')
    expect(result).toContain('Content here.')
  })

  it('is a no-op when content has no Status field', () => {
    const input = `# Story 3-1: Clean Story

## Story

No status field here.
`

    const result = stripDeprecatedStatusField(input)

    expect(result).toBe(input)
  })

  it('does NOT strip a line containing "Status" mid-sentence', () => {
    const input = `# Story 4-1: Story

## Status Notes

The status is good.

## Story

Content here.
`

    const result = stripDeprecatedStatusField(input)

    // Should be unchanged — "## Status Notes" and "The status is good." are not matches
    expect(result).toBe(input)
    expect(result).toContain('## Status Notes')
    expect(result).toContain('The status is good.')
  })

  it('strips Status field even when it appears after other content', () => {
    const input = `## Some Section

Content above.

Status: in_progress

## Another Section

Content below.
`

    const result = stripDeprecatedStatusField(input)

    expect(result).not.toContain('Status:')
    expect(result).not.toContain('in_progress')
    expect(result).toContain('## Some Section')
    expect(result).toContain('Content above.')
    expect(result).toContain('## Another Section')
    expect(result).toContain('Content below.')
  })

  it('strips Status field without trailing blank line when at end of file', () => {
    const input = `# Story

Status: done`

    const result = stripDeprecatedStatusField(input)

    expect(result).not.toContain('Status:')
    expect(result).toContain('# Story')
  })
})

// ---------------------------------------------------------------------------
// detectDeprecatedStatusField
// ---------------------------------------------------------------------------

describe('detectDeprecatedStatusField', () => {
  it('returns the status value for content containing Status: ready-for-dev', () => {
    const input = `# Story

Status: ready-for-dev

## Story
`

    expect(detectDeprecatedStatusField(input)).toBe('ready-for-dev')
  })

  it('returns null for content without a Status line', () => {
    const input = `# Story

## Story

No status here.
`

    expect(detectDeprecatedStatusField(input)).toBeNull()
  })

  it('returns trimmed value for Status with surrounding whitespace', () => {
    // Extra spaces after the colon
    const input = `Status:   in_progress   \n\n## Story`

    expect(detectDeprecatedStatusField(input)).toBe('in_progress')
  })

  it('does NOT match ## Status Notes section heading', () => {
    const input = `# Story

## Status Notes

Some notes here.
`

    expect(detectDeprecatedStatusField(input)).toBeNull()
  })

  it('does NOT match "The status is good" mid-sentence', () => {
    const input = `# Story

The status is good and everything is fine.
`

    expect(detectDeprecatedStatusField(input)).toBeNull()
  })
})
