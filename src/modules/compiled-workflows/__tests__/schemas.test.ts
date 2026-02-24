/**
 * Tests for compiled-workflow Zod schemas.
 *
 * Validates that schemas correctly coerce agent output quirks
 * (string numbers, miscounted issues) while rejecting truly invalid data.
 */

import { describe, it, expect } from 'vitest'
import {
  CodeReviewIssueSchema,
  CodeReviewResultSchema,
  DevStoryResultSchema,
  CreateStoryResultSchema,
} from '../schemas.js'

// ---------------------------------------------------------------------------
// CodeReviewIssueSchema
// ---------------------------------------------------------------------------

describe('CodeReviewIssueSchema', () => {
  it('accepts line as a number', () => {
    const result = CodeReviewIssueSchema.safeParse({
      severity: 'minor',
      description: 'Missing error handling',
      file: 'src/foo.ts',
      line: 42,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.line).toBe(42)
    }
  })

  it('coerces line from string to number', () => {
    const result = CodeReviewIssueSchema.safeParse({
      severity: 'major',
      description: 'AC2 not implemented',
      file: 'src/foo.ts',
      line: '42',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.line).toBe(42)
    }
  })

  it('accepts missing line (optional)', () => {
    const result = CodeReviewIssueSchema.safeParse({
      severity: 'blocker',
      description: 'Security vulnerability',
      file: 'src/auth.ts',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.line).toBeUndefined()
    }
  })

  it('rejects non-numeric string for line', () => {
    const result = CodeReviewIssueSchema.safeParse({
      severity: 'minor',
      description: 'Bad line number',
      file: 'src/foo.ts',
      line: 'not-a-number',
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CodeReviewResultSchema
// ---------------------------------------------------------------------------

describe('CodeReviewResultSchema', () => {
  it('accepts well-formed review output', () => {
    const result = CodeReviewResultSchema.safeParse({
      verdict: 'NEEDS_MINOR_FIXES',
      issues: 2,
      issue_list: [
        { severity: 'minor', description: 'Style issue', file: 'src/a.ts', line: 10 },
        { severity: 'minor', description: 'Naming issue', file: 'src/b.ts', line: 20 },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.verdict).toBe('NEEDS_MINOR_FIXES')
      expect(result.data.issues).toBe(2)
    }
  })

  it('coerces issues count from string to number', () => {
    const result = CodeReviewResultSchema.safeParse({
      verdict: 'SHIP_IT',
      issues: '0',
      issue_list: [],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.issues).toBe(0)
    }
  })

  it('auto-corrects issues count when agent miscounts', () => {
    const result = CodeReviewResultSchema.safeParse({
      verdict: 'NEEDS_MINOR_FIXES',
      issues: 5, // agent says 5 but only listed 2
      issue_list: [
        { severity: 'minor', description: 'Issue A', file: 'src/a.ts' },
        { severity: 'minor', description: 'Issue B', file: 'src/b.ts' },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.issues).toBe(2) // auto-corrected to actual length
    }
  })

  it('auto-corrects issues count of zero when issues exist', () => {
    const result = CodeReviewResultSchema.safeParse({
      verdict: 'NEEDS_MAJOR_REWORK',
      issues: 0, // agent forgot to count
      issue_list: [
        { severity: 'blocker', description: 'Critical bug', file: 'src/c.ts', line: 1 },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.issues).toBe(1)
    }
  })

  it('coerces string line numbers inside issue_list', () => {
    const result = CodeReviewResultSchema.safeParse({
      verdict: 'NEEDS_MINOR_FIXES',
      issues: 1,
      issue_list: [
        { severity: 'major', description: 'Bug', file: 'src/foo.ts', line: '99' },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.issue_list[0].line).toBe(99)
    }
  })

  it('accepts SHIP_IT with empty issue_list', () => {
    const result = CodeReviewResultSchema.safeParse({
      verdict: 'SHIP_IT',
      issues: 0,
      issue_list: [],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.verdict).toBe('SHIP_IT')
      expect(result.data.issues).toBe(0)
    }
  })

  it('rejects invalid verdict', () => {
    const result = CodeReviewResultSchema.safeParse({
      verdict: 'LOOKS_GOOD',
      issues: 0,
      issue_list: [],
    })
    expect(result.success).toBe(false)
  })

  it('includes optional notes field', () => {
    const result = CodeReviewResultSchema.safeParse({
      verdict: 'SHIP_IT',
      issues: 0,
      issue_list: [],
      notes: 'Clean implementation overall.',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.notes).toBe('Clean implementation overall.')
    }
  })
})

// ---------------------------------------------------------------------------
// DevStoryResultSchema — coerceToString regression tests
// ---------------------------------------------------------------------------

describe('DevStoryResultSchema', () => {
  it('accepts well-formed dev-story output', () => {
    const result = DevStoryResultSchema.safeParse({
      result: 'success',
      ac_met: ['AC1', 'AC2'],
      ac_failures: [],
      files_modified: ['src/foo.ts'],
      tests: 'pass',
    })
    expect(result.success).toBe(true)
  })

  it('coerces YAML mapping in ac_failures to string', () => {
    // Agents emit `ac_failures: [AC7: explanation]` which YAML parses as { AC7: "explanation" }
    const result = DevStoryResultSchema.safeParse({
      result: 'failed',
      ac_met: [],
      ac_failures: [{ AC7: 'explanation text' }],
      files_modified: [],
      tests: 'fail',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.ac_failures[0]).toBe('AC7: explanation text')
    }
  })
})

// ---------------------------------------------------------------------------
// CreateStoryResultSchema — basic smoke test
// ---------------------------------------------------------------------------

describe('CreateStoryResultSchema', () => {
  it('accepts minimal success output', () => {
    const result = CreateStoryResultSchema.safeParse({
      result: 'success',
    })
    expect(result.success).toBe(true)
  })

  it('accepts full output with optional fields', () => {
    const result = CreateStoryResultSchema.safeParse({
      result: 'success',
      story_file: '/path/to/story.md',
      story_key: '7-1',
      story_title: 'Mode Selection',
    })
    expect(result.success).toBe(true)
  })
})
