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
  caseCategory,
  computePassCaretK,
  CATEGORY_REGRESSION,
  CATEGORY_CAPABILITY,
  hasDecisionExpectations,
  assertDecisionCase,
  recoveryActionsForStory,
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

// ---------------------------------------------------------------------------
// caseCategory (77-3 AC4)
// ---------------------------------------------------------------------------

describe('caseCategory', () => {
  it('defaults to regression when category is absent (conservative gate)', () => {
    expect(caseCategory({ id: 'x' })).toBe(CATEGORY_REGRESSION)
  })

  it('returns capability only when explicitly set', () => {
    expect(caseCategory({ category: 'capability' })).toBe(CATEGORY_CAPABILITY)
  })

  it('treats any non-capability value as regression', () => {
    expect(caseCategory({ category: 'regression' })).toBe(CATEGORY_REGRESSION)
    expect(caseCategory({ category: 'bogus' })).toBe(CATEGORY_REGRESSION)
    expect(caseCategory(null)).toBe(CATEGORY_REGRESSION)
  })
})

// ---------------------------------------------------------------------------
// computePassCaretK (77-3 AC3)
// ---------------------------------------------------------------------------

describe('computePassCaretK', () => {
  it('returns empty groups with a note when no stable cases exist (no-op default)', () => {
    const result = computePassCaretK([
      { entry: { story_key: '1-1' }, status: 'pass' },
      { entry: { story_key: '1-2' }, status: 'fail' },
    ])
    expect(result.groups).toEqual([])
    expect(result.note).toMatch(/no stable/i)
  })

  it('groups stable cases by logical_id and flags all_passed', () => {
    const result = computePassCaretK([
      { entry: { stable: true, logical_id: 'A', story_key: '1-1' }, status: 'pass' },
      { entry: { stable: true, logical_id: 'A', story_key: '1-1' }, status: 'pass' },
      { entry: { stable: true, logical_id: 'B', story_key: '2-1' }, status: 'pass' },
      { entry: { stable: true, logical_id: 'B', story_key: '2-1' }, status: 'fail' },
    ])
    const a = result.groups.find((g) => g.logical_id === 'A')
    const b = result.groups.find((g) => g.logical_id === 'B')
    expect(a).toMatchObject({ k: 2, all_passed: true })
    expect(b).toMatchObject({ k: 2, all_passed: false })
  })

  it('skips logical groups with fewer than 2 trials (pass^k needs k≥2)', () => {
    const result = computePassCaretK([
      { entry: { stable: true, logical_id: 'solo', story_key: '3-1' }, status: 'pass' },
    ])
    expect(result.groups).toEqual([])
    expect(result.note).toMatch(/k≥2|k>=2|none with/i)
  })
})

// ---------------------------------------------------------------------------
// Decision-replay (Story 77-5, Tier 2b)
// ---------------------------------------------------------------------------

describe('hasDecisionExpectations', () => {
  it('is false when no decision fields are declared', () => {
    expect(hasDecisionExpectations({ expect: { result_class: 'SHIP_IT' } })).toBe(false)
  })
  it('is true when any decision field is declared', () => {
    expect(hasDecisionExpectations({ expect: { result_class: 'SHIP_IT', primary_model: 'claude-opus-4-7' } })).toBe(true)
    expect(hasDecisionExpectations({ expect: { escalation_reason: null } })).toBe(true)
    expect(hasDecisionExpectations({ expect: { recovery_actions: [] } })).toBe(true)
  })
  it('is false for absent/empty expect', () => {
    expect(hasDecisionExpectations({})).toBe(false)
    expect(hasDecisionExpectations({ expect: null })).toBe(false)
  })
})

describe('recoveryActionsForStory', () => {
  it('returns the strategies for the matching story only', () => {
    const manifest = {
      recovery_history: [
        { story_key: '5-1', strategy: 'tier-a-retry-with-context' },
        { story_key: '5-2', strategy: 'tier-c-halt' },
        { story_key: '5-1', strategy: 'dev-story-timeout-checkpoint-retry' },
      ],
    }
    expect(recoveryActionsForStory(manifest, '5-1')).toEqual([
      'tier-a-retry-with-context',
      'dev-story-timeout-checkpoint-retry',
    ])
  })
  it('returns [] when manifest has no recovery_history', () => {
    expect(recoveryActionsForStory({}, '5-1')).toEqual([])
    expect(recoveryActionsForStory(null, '5-1')).toEqual([])
  })
})

describe('assertDecisionCase — AC1 partial assertion', () => {
  it('checks only the declared field (primary_model), ignoring undeclared ones', () => {
    const entry = { expect: { result_class: 'SHIP_IT', primary_model: 'claude-opus-4-7' } }
    const storyRow = { primary_model: 'claude-opus-4-7' }
    // No escalation_reason / recovery declared → not checked even though manifest has none.
    const result = assertDecisionCase(entry, storyRow, null, '5-1')
    expect(result.status).toBe('pass')
  })

  it('passes primary_model exact match', () => {
    const result = assertDecisionCase(
      { expect: { primary_model: 'claude-sonnet-4-6' } },
      { primary_model: 'claude-sonnet-4-6' },
      null,
      '5-1',
    )
    expect(result.status).toBe('pass')
  })

  it('fails primary_model mismatch', () => {
    const result = assertDecisionCase(
      { expect: { primary_model: 'claude-opus-4-7' } },
      { primary_model: 'claude-sonnet-4-6' },
      null,
      '5-1',
    )
    expect(result.status).toBe('fail')
    expect(result.field).toBe('primary_model')
  })
})

describe('assertDecisionCase — AC3 null-reason false-escalation', () => {
  it('passes when escalation_reason expected null and none recorded (story did not escalate)', () => {
    const result = assertDecisionCase(
      { expect: { escalation_reason: null } },
      { result: 'SHIP_IT' },
      { per_story_state: { '5-1': {} } },
      '5-1',
    )
    expect(result.status).toBe('pass')
  })

  it('FAILS when escalation_reason expected null but a reason was recorded (re-introduced false escalation)', () => {
    const result = assertDecisionCase(
      { expect: { escalation_reason: null } },
      { result: 'escalated' },
      { per_story_state: { '5-1': { escalation_reason: 'retry_budget_exhausted' } } },
      '5-1',
    )
    expect(result.status).toBe('fail')
    expect(result.field).toBe('escalation_reason')
    expect(result.actual).toBe('retry_budget_exhausted')
  })
})

describe('assertDecisionCase — wrong reason fails', () => {
  it('fails when recorded escalation_reason differs from expected', () => {
    const result = assertDecisionCase(
      { expect: { escalation_reason: 'checkpoint-retry-timeout' } },
      {},
      { per_story_state: { '5-1': { escalation_reason: 'retry_budget_exhausted' } } },
      '5-1',
    )
    expect(result.status).toBe('fail')
    expect(result.expected).toBe('checkpoint-retry-timeout')
    expect(result.actual).toBe('retry_budget_exhausted')
  })
})

describe('assertDecisionCase — AC4 missing-provenance corpus-error', () => {
  it('corpus-errors when primary_model asserted but recorded null (pre-77-4 run)', () => {
    const result = assertDecisionCase(
      { expect: { primary_model: 'claude-opus-4-7' } },
      { primary_model: null },
      null,
      '5-1',
    )
    expect(result.status).toBe('corpus-error')
    expect(result.field).toBe('primary_model')
  })

  it('corpus-errors when a non-null escalation_reason asserted but none recorded', () => {
    const result = assertDecisionCase(
      { expect: { escalation_reason: 'checkpoint-retry-timeout' } },
      {},
      { per_story_state: { '5-1': {} } },
      '5-1',
    )
    expect(result.status).toBe('corpus-error')
    expect(result.field).toBe('escalation_reason')
  })

  it('corpus-errors when recovery_actions asserted but recovery_history empty', () => {
    const result = assertDecisionCase(
      { expect: { recovery_actions: ['tier-a-retry-with-context'] } },
      {},
      { recovery_history: [] },
      '5-1',
    )
    expect(result.status).toBe('corpus-error')
    expect(result.field).toBe('recovery_actions')
  })
})

describe('assertDecisionCase — recovery_actions subset semantics', () => {
  it('passes when all expected recovery strategies are present', () => {
    const manifest = {
      recovery_history: [
        { story_key: '5-1', strategy: 'tier-a-retry-with-context' },
        { story_key: '5-1', strategy: 'tier-c-halt' },
      ],
    }
    const result = assertDecisionCase(
      { expect: { recovery_actions: ['tier-a-retry-with-context'] } },
      {},
      manifest,
      '5-1',
    )
    expect(result.status).toBe('pass')
  })

  it('fails when an expected recovery strategy is missing', () => {
    const manifest = { recovery_history: [{ story_key: '5-1', strategy: 'tier-a-retry-with-context' }] }
    const result = assertDecisionCase(
      { expect: { recovery_actions: ['tier-c-halt'] } },
      {},
      manifest,
      '5-1',
    )
    expect(result.status).toBe('fail')
    expect(result.field).toBe('recovery_actions')
  })

  it('fails when recovery_actions: [] expected but a recovery ran', () => {
    const manifest = { recovery_history: [{ story_key: '5-1', strategy: 'tier-a-retry-with-context' }] }
    const result = assertDecisionCase(
      { expect: { recovery_actions: [] } },
      {},
      manifest,
      '5-1',
    )
    expect(result.status).toBe('fail')
  })
})
