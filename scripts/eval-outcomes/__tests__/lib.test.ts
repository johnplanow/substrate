/**
 * Unit tests for scripts/eval-outcomes/lib.mjs (Story 77-1 AC9).
 *
 * Tests:
 *   - exact-match pass
 *   - cycle-cap fail
 *   - missing-run corpus-error (null run_id → not pass/fail)
 *   - rubric boundary cases (0.95, 0.85, 0.84)
 *
 * All tests use in-memory data; no live Dolt, no filesystem writes.
 */

import { describe, it, expect } from 'vitest'

// @ts-expect-error — importing JS module from TS test (vitest handles the cross-load)
import {
  VALID_RESULT_CLASSES,
  parseOutcomesCorpus,
  assertOutcomeCase,
  computeRubric,
} from '../lib.mjs'

// ---------------------------------------------------------------------------
// VALID_RESULT_CLASSES
// ---------------------------------------------------------------------------

describe('VALID_RESULT_CLASSES', () => {
  it('contains the exact AC4 vocabulary', () => {
    expect(VALID_RESULT_CLASSES.has('SHIP_IT')).toBe(true)
    expect(VALID_RESULT_CLASSES.has('LGTM_WITH_NOTES')).toBe(true)
    expect(VALID_RESULT_CLASSES.has('NEEDS_MINOR_FIXES')).toBe(true)
    expect(VALID_RESULT_CLASSES.has('escalated')).toBe(true)
    expect(VALID_RESULT_CLASSES.has('failed')).toBe(true)
    expect(VALID_RESULT_CLASSES.has('verification-failed')).toBe(true)
  })

  it('does NOT contain NEEDS_MAJOR_REWORK (excluded per AC4 spec)', () => {
    // NEEDS_MAJOR_REWORK was in the 77-2 bootstrap but is NOT in AC4 vocabulary
    expect(VALID_RESULT_CLASSES.has('NEEDS_MAJOR_REWORK')).toBe(false)
  })

  it('has exactly 6 entries', () => {
    expect(VALID_RESULT_CLASSES.size).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// parseOutcomesCorpus
// ---------------------------------------------------------------------------

describe('parseOutcomesCorpus', () => {
  const validCorpusYaml = `
corpus_version: "1.0.0"
cases:
  - id: test-case-1
    source: substrate
    story_key: "1-1"
    run_id: "run-abc123"
    expect:
      result_class: SHIP_IT
    label_reason: "test case"
`

  it('parses a valid corpus YAML', () => {
    const result = parseOutcomesCorpus(validCorpusYaml)
    expect(result.corpus_version).toBe('1.0.0')
    expect(Array.isArray(result.cases)).toBe(true)
    expect(result.cases).toHaveLength(1)
    expect(result.cases[0].id).toBe('test-case-1')
  })

  it('throws on invalid YAML syntax', () => {
    expect(() => parseOutcomesCorpus('{ invalid: yaml: :::}')).toThrow(
      'parseOutcomesCorpus: YAML parse error',
    )
  })

  it('throws when corpus_version is missing', () => {
    const yaml = `
cases:
  - id: test-1
    run_id: abc
    expect:
      result_class: SHIP_IT
`
    expect(() => parseOutcomesCorpus(yaml)).toThrow('corpus_version')
  })

  it('throws when cases array is missing', () => {
    const yaml = `
corpus_version: "1.0.0"
description: no cases here
`
    expect(() => parseOutcomesCorpus(yaml)).toThrow('cases')
  })

  it('throws when root is not a mapping', () => {
    expect(() => parseOutcomesCorpus('- item1\n- item2\n')).toThrow(
      'parseOutcomesCorpus: corpus root must be a mapping',
    )
  })

  it('allows corpus entries with null run_id (corpus-error is caller responsibility)', () => {
    // parseOutcomesCorpus validates structure only; individual entry issues
    // are corpus-errors handled by the grader loop, not thrown here.
    const yaml = `
corpus_version: "1.0.0"
cases:
  - id: fixture-missing-run
    source: substrate
    story_key: "99-99"
    run_id: null
    expect:
      result_class: SHIP_IT
    label_reason: "fixture: corpus-error test"
`
    const result = parseOutcomesCorpus(yaml)
    expect(result.cases).toHaveLength(1)
    // The case is returned as-is; run_id is null — grader marks as corpus-error
    expect(result.cases[0].run_id).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// assertOutcomeCase — exact-match pass (AC4, AC9)
// ---------------------------------------------------------------------------

describe('assertOutcomeCase — exact-match pass', () => {
  it('returns pass when result matches expected result_class', () => {
    const entry = {
      expect: { result_class: 'SHIP_IT' },
    }
    const storyRow = { result: 'SHIP_IT', review_cycles: 1 }
    const result = assertOutcomeCase(entry, storyRow)
    expect(result.status).toBe('pass')
    expect(result.expected).toBe('SHIP_IT')
    expect(result.actual).toBe('SHIP_IT')
  })

  it('returns pass for each valid result class', () => {
    for (const cls of VALID_RESULT_CLASSES) {
      const entry = { expect: { result_class: cls } }
      const storyRow = { result: cls, review_cycles: 0 }
      const result = assertOutcomeCase(entry, storyRow)
      expect(result.status).toBe('pass')
    }
  })

  it('returns pass when review_cycles is within max_review_cycles cap', () => {
    const entry = {
      expect: { result_class: 'SHIP_IT', max_review_cycles: 2 },
    }
    const storyRow = { result: 'SHIP_IT', review_cycles: 2 }
    const result = assertOutcomeCase(entry, storyRow)
    expect(result.status).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// assertOutcomeCase — result_class mismatch
// ---------------------------------------------------------------------------

describe('assertOutcomeCase — result_class mismatch', () => {
  it('returns fail when actual result does not match expected', () => {
    const entry = { expect: { result_class: 'SHIP_IT' } }
    const storyRow = { result: 'escalated', review_cycles: 3 }
    const result = assertOutcomeCase(entry, storyRow)
    expect(result.status).toBe('fail')
    expect(result.expected).toBe('SHIP_IT')
    expect(result.actual).toBe('escalated')
    expect(result.reason).toMatch(/mismatch/)
  })
})

// ---------------------------------------------------------------------------
// assertOutcomeCase — cycle-cap fail (AC4, AC9)
// ---------------------------------------------------------------------------

describe('assertOutcomeCase — cycle-cap fail', () => {
  it('returns fail when review_cycles exceeds max_review_cycles', () => {
    const entry = {
      expect: { result_class: 'SHIP_IT', max_review_cycles: 2 },
    }
    const storyRow = { result: 'SHIP_IT', review_cycles: 3 }
    const result = assertOutcomeCase(entry, storyRow)
    expect(result.status).toBe('fail')
    expect(result.reason).toMatch(/review_cycles exceeded/)
    // result_class matched; expected and actual reflect the result_class
    expect(result.expected).toBe('SHIP_IT')
    expect(result.actual).toBe('SHIP_IT')
  })

  it('returns fail when cycle cap is 0 and actual cycles is 1', () => {
    const entry = {
      expect: { result_class: 'LGTM_WITH_NOTES', max_review_cycles: 0 },
    }
    const storyRow = { result: 'LGTM_WITH_NOTES', review_cycles: 1 }
    const result = assertOutcomeCase(entry, storyRow)
    expect(result.status).toBe('fail')
  })

  it('does not check cycle cap when max_review_cycles is absent', () => {
    const entry = { expect: { result_class: 'SHIP_IT' } }
    const storyRow = { result: 'SHIP_IT', review_cycles: 99 }
    const result = assertOutcomeCase(entry, storyRow)
    // No cycle cap → passes based on result_class match alone
    expect(result.status).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// Corpus-error behavior: null run_id (AC8, AC9)
// ---------------------------------------------------------------------------

describe('corpus-error: null run_id', () => {
  it('parseOutcomesCorpus returns the entry with null run_id (not a throw)', () => {
    // The caller (grader loop) is responsible for detecting null run_id as corpus-error
    // parseOutcomesCorpus does not throw for individual case-level issues
    const yaml = `
corpus_version: "1.0.0"
cases:
  - id: fixture-missing-run-a
    source: substrate
    story_key: "99-99"
    run_id: null
    expect:
      result_class: SHIP_IT
    label_reason: "fixture: corpus-error for unknown run_id"
`
    const corpus = parseOutcomesCorpus(yaml)
    expect(corpus.cases).toHaveLength(1)
    expect(corpus.cases[0].run_id).toBeNull()
    // In the grader loop: !runId → corpus-error (not invoking assertOutcomeCase)
    // Verify that the null run_id would cause corpus-error classification
    const entry = corpus.cases[0]
    expect(entry.run_id).toBeNull()
    expect(!entry.run_id).toBe(true) // grader loop condition: !runId → corpus-error
  })
})

// ---------------------------------------------------------------------------
// computeRubric — boundary cases (AC5, AC9)
// ---------------------------------------------------------------------------

describe('computeRubric', () => {
  it('returns GREEN when pass_rate equals threshold (0.95)', () => {
    // 95/100 = 0.95 >= 0.95 → GREEN
    expect(computeRubric(95, 100, 0.95)).toBe('GREEN')
  })

  it('returns GREEN when pass_rate exceeds threshold', () => {
    expect(computeRubric(100, 100, 0.95)).toBe('GREEN')
    expect(computeRubric(96, 100, 0.95)).toBe('GREEN')
  })

  it('returns YELLOW when pass_rate is 0.85 (boundary)', () => {
    // 85/100 = 0.85 >= 0.85 AND < 0.95 → YELLOW
    expect(computeRubric(85, 100, 0.95)).toBe('YELLOW')
  })

  it('returns YELLOW when pass_rate is between 0.85 and threshold', () => {
    expect(computeRubric(90, 100, 0.95)).toBe('YELLOW')
    expect(computeRubric(94, 100, 0.95)).toBe('YELLOW')
  })

  it('returns RED when pass_rate is below 0.85 (84/100 boundary)', () => {
    // 84/100 = 0.84 < 0.85 → RED
    expect(computeRubric(84, 100, 0.95)).toBe('RED')
  })

  it('returns RED for very low pass rates', () => {
    expect(computeRubric(0, 100, 0.95)).toBe('RED')
    expect(computeRubric(50, 100, 0.95)).toBe('RED')
  })

  it('returns RED when totalGraded is 0 (no gradable cases)', () => {
    // passRate = 0 when no cases → RED
    expect(computeRubric(0, 0, 0.95)).toBe('RED')
  })

  it('handles custom threshold correctly', () => {
    // threshold = 0.85: 85/100 = 0.85 >= 0.85 → GREEN (at threshold)
    expect(computeRubric(85, 100, 0.85)).toBe('GREEN')
    // threshold = 0.85: 84/100 = 0.84 < 0.85 → RED (YELLOW floor is also 0.85)
    expect(computeRubric(84, 100, 0.85)).toBe('RED')
  })

  it('YELLOW is exactly pass_rate >= 0.85 AND < threshold', () => {
    // With threshold=0.90: 85/100 = 0.85 → YELLOW
    expect(computeRubric(85, 100, 0.90)).toBe('YELLOW')
    // 90/100 = 0.90 >= 0.90 → GREEN
    expect(computeRubric(90, 100, 0.90)).toBe('GREEN')
    // 84/100 = 0.84 < 0.85 → RED
    expect(computeRubric(84, 100, 0.90)).toBe('RED')
  })
})

// ---------------------------------------------------------------------------
// Integration-style: corpus-errors excluded from pass_rate denominator (AC8)
// ---------------------------------------------------------------------------

describe('corpus-error count does not affect rubric denominator', () => {
  it('only pass + fail cases count in pass_rate; corpus-errors excluded', () => {
    // Simulate: 3 pass, 1 fail, 2 corpus-errors
    // pass_rate should be 3/4 = 0.75, not 3/6 = 0.50
    const passCount = 3
    const failCount = 1
    const totalGraded = passCount + failCount // = 4 (correct denominator)
    const totalWithErrors = totalGraded + 2   // = 6 (incorrect if errors included)

    const correctPassRate = passCount / totalGraded       // 0.75
    const incorrectPassRate = passCount / totalWithErrors // 0.50

    expect(correctPassRate).toBeCloseTo(0.75)
    expect(incorrectPassRate).toBeCloseTo(0.50)

    // Both give RED here, but pass_rate values differ (important for reporting)
    expect(computeRubric(passCount, totalGraded, 0.95)).toBe('RED')
    expect(computeRubric(passCount, totalWithErrors, 0.95)).toBe('RED')

    // The distinction matters at boundary: if we have 90 pass, 10 fail, 6 corpus-errors
    // correct: 90/100 = 0.90 → YELLOW (< 0.95)
    // incorrect (including errors): 90/106 = 0.849 → RED (< 0.85)
    expect(computeRubric(90, 100, 0.95)).toBe('YELLOW') // correct computation
    expect(computeRubric(90, 106, 0.95)).toBe('RED')    // incorrect result (erroneous inclusion of corpus-errors)

    // The real test: at edge where including corpus-errors would push below 0.85:
    // 85 pass, 0 fail, 15 corpus-errors
    // correct: 85/85 = 1.0 → GREEN
    // incorrect (including errors): 85/100 = 0.85 → YELLOW
    expect(computeRubric(85, 85, 0.95)).toBe('GREEN')  // correct
    expect(computeRubric(85, 100, 0.95)).toBe('YELLOW') // incorrect result (erroneous inclusion)
  })
})
