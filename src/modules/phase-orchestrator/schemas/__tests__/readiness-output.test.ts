/**
 * Unit tests for ReadinessOutputSchema and ReadinessFindingSchema.
 *
 * Covers AC2: Output structure validation — ensures the schema correctly
 * validates readiness check agent output including verdict, coverage_score,
 * and findings array with category, severity, description, affected_items.
 */

import { describe, it, expect } from 'vitest'
import { ReadinessOutputSchema, ReadinessFindingSchema } from '../readiness-output.js'

// ---------------------------------------------------------------------------
// ReadinessFindingSchema tests
// ---------------------------------------------------------------------------

describe('ReadinessFindingSchema', () => {
  it('accepts a valid finding with all required fields', () => {
    const finding = {
      category: 'fr_coverage',
      severity: 'blocker',
      description: 'FR-1 is not covered by any story',
      affected_items: ['FR-1'],
    }
    const result = ReadinessFindingSchema.safeParse(finding)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.category).toBe('fr_coverage')
      expect(result.data.severity).toBe('blocker')
      expect(result.data.description).toBe('FR-1 is not covered by any story')
      expect(result.data.affected_items).toEqual(['FR-1'])
    }
  })

  it('accepts all valid category values', () => {
    const validCategories = [
      'fr_coverage',
      'architecture_compliance',
      'story_quality',
      'ux_alignment',
      'dependency_validity',
    ] as const

    for (const category of validCategories) {
      const result = ReadinessFindingSchema.safeParse({
        category,
        severity: 'minor',
        description: 'A test finding description',
        affected_items: [],
      })
      expect(result.success, `Expected category "${category}" to be valid`).toBe(true)
    }
  })

  it('accepts all valid severity values', () => {
    const validSeverities = ['blocker', 'major', 'minor'] as const

    for (const severity of validSeverities) {
      const result = ReadinessFindingSchema.safeParse({
        category: 'story_quality',
        severity,
        description: 'A test finding description',
        affected_items: [],
      })
      expect(result.success, `Expected severity "${severity}" to be valid`).toBe(true)
    }
  })

  it('defaults affected_items to empty array when omitted', () => {
    const result = ReadinessFindingSchema.safeParse({
      category: 'architecture_compliance',
      severity: 'major',
      description: 'Story contradicts architecture decisions',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.affected_items).toEqual([])
    }
  })

  it('accepts unknown category values (extensible for new finding types)', () => {
    const result = ReadinessFindingSchema.safeParse({
      category: 'custom_project_specific_check',
      severity: 'blocker',
      description: 'Some description',
      affected_items: [],
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty category', () => {
    const result = ReadinessFindingSchema.safeParse({
      category: '',
      severity: 'blocker',
      description: 'Some description',
      affected_items: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid severity', () => {
    const result = ReadinessFindingSchema.safeParse({
      category: 'fr_coverage',
      severity: 'critical',
      description: 'Some description',
      affected_items: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects an empty description', () => {
    const result = ReadinessFindingSchema.safeParse({
      category: 'fr_coverage',
      severity: 'blocker',
      description: '',
      affected_items: [],
    })
    expect(result.success).toBe(false)
  })

  it('accepts a finding with multiple affected_items', () => {
    const result = ReadinessFindingSchema.safeParse({
      category: 'dependency_validity',
      severity: 'major',
      description: 'Multiple stories depend on missing artifact',
      affected_items: ['1-1', '1-2', '2-1', 'arch-001'],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.affected_items).toHaveLength(4)
    }
  })
})

// ---------------------------------------------------------------------------
// ReadinessOutputSchema tests
// ---------------------------------------------------------------------------

describe('ReadinessOutputSchema', () => {
  it('accepts a READY verdict with no findings', () => {
    const output = {
      verdict: 'READY',
      coverage_score: 100,
      findings: [],
    }
    const result = ReadinessOutputSchema.safeParse(output)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.verdict).toBe('READY')
      expect(result.data.coverage_score).toBe(100)
      expect(result.data.findings).toEqual([])
    }
  })

  it('accepts a NEEDS_WORK verdict with major findings', () => {
    const output = {
      verdict: 'NEEDS_WORK',
      coverage_score: 65,
      findings: [
        {
          category: 'fr_coverage',
          severity: 'major',
          description: 'FR-3 has only partial coverage in story 2-1',
          affected_items: ['FR-3', '2-1'],
        },
      ],
    }
    const result = ReadinessOutputSchema.safeParse(output)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.verdict).toBe('NEEDS_WORK')
      expect(result.data.coverage_score).toBe(65)
      expect(result.data.findings).toHaveLength(1)
      expect(result.data.findings[0].severity).toBe('major')
    }
  })

  it('accepts a NOT_READY verdict with blocker findings', () => {
    const output = {
      verdict: 'NOT_READY',
      coverage_score: 20,
      findings: [
        {
          category: 'fr_coverage',
          severity: 'blocker',
          description: 'FR-1 is not traceable to any story',
          affected_items: ['FR-1'],
        },
        {
          category: 'architecture_compliance',
          severity: 'blocker',
          description: 'Story 1-3 uses REST but architecture specifies GraphQL',
          affected_items: ['1-3', 'arch-api-style'],
        },
      ],
    }
    const result = ReadinessOutputSchema.safeParse(output)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.verdict).toBe('NOT_READY')
      expect(result.data.coverage_score).toBe(20)
      expect(result.data.findings).toHaveLength(2)
    }
  })

  it('defaults findings to empty array when omitted', () => {
    const result = ReadinessOutputSchema.safeParse({
      verdict: 'READY',
      coverage_score: 100,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.findings).toEqual([])
    }
  })

  it('rejects an invalid verdict', () => {
    const result = ReadinessOutputSchema.safeParse({
      verdict: 'PASS',
      coverage_score: 100,
      findings: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects coverage_score below 0', () => {
    const result = ReadinessOutputSchema.safeParse({
      verdict: 'READY',
      coverage_score: -1,
      findings: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects coverage_score above 100', () => {
    const result = ReadinessOutputSchema.safeParse({
      verdict: 'NOT_READY',
      coverage_score: 101,
      findings: [],
    })
    expect(result.success).toBe(false)
  })

  it('accepts coverage_score at boundaries (0 and 100)', () => {
    const atZero = ReadinessOutputSchema.safeParse({
      verdict: 'NOT_READY',
      coverage_score: 0,
      findings: [],
    })
    expect(atZero.success).toBe(true)

    const atHundred = ReadinessOutputSchema.safeParse({
      verdict: 'READY',
      coverage_score: 100,
      findings: [],
    })
    expect(atHundred.success).toBe(true)
  })

  it('rejects missing verdict', () => {
    const result = ReadinessOutputSchema.safeParse({
      coverage_score: 80,
      findings: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing coverage_score', () => {
    const result = ReadinessOutputSchema.safeParse({
      verdict: 'READY',
      findings: [],
    })
    expect(result.success).toBe(false)
  })

  it('accepts findings with unknown category (extensible)', () => {
    const result = ReadinessOutputSchema.safeParse({
      verdict: 'NEEDS_WORK',
      coverage_score: 70,
      findings: [
        {
          category: 'unknown_category',
          severity: 'minor',
          description: 'A description',
          affected_items: [],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('accepts a realistic full readiness output with mixed findings', () => {
    const output = {
      verdict: 'NEEDS_WORK',
      coverage_score: 72,
      findings: [
        {
          category: 'fr_coverage',
          severity: 'blocker',
          description: 'FR-5 (real-time notifications) is not addressed by any story',
          affected_items: ['FR-5'],
        },
        {
          category: 'story_quality',
          severity: 'major',
          description: 'Story 3-2 ACs are not expressed in Given/When/Then format',
          affected_items: ['3-2'],
        },
        {
          category: 'ux_alignment',
          severity: 'minor',
          description:
            'Story 2-1 does not reference the accessibility requirement from UX decisions',
          affected_items: ['2-1', 'ux-accessibility-001'],
        },
      ],
    }
    const result = ReadinessOutputSchema.safeParse(output)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.findings).toHaveLength(3)
      const blockers = result.data.findings.filter((f) => f.severity === 'blocker')
      expect(blockers).toHaveLength(1)
    }
  })
})
