/**
 * Pure functions powering eval-outcomes (Story 77-1).
 *
 * Separated into a library module so unit tests can exercise the logic
 * without Dolt queries or file I/O.
 *
 * Exports:
 *   - VALID_RESULT_CLASSES: set of known result class vocabulary (AC4)
 *   - parseOutcomesCorpus(yamlContent): validates corpus_version header + cases[]; throws on schema violation
 *   - assertOutcomeCase(entry, storyRow): returns { status: 'pass'|'fail', expected, actual, reason? }
 *   - computeRubric(passCount, totalGraded, threshold): returns 'GREEN'|'YELLOW'|'RED'
 *   - readManifest(projectRoot, runId): reads run manifest JSON; returns null if missing
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import yaml from 'js-yaml'

// ---------------------------------------------------------------------------
// Known result class vocabulary (77-1 AC4)
// NOTE: NEEDS_MAJOR_REWORK is intentionally excluded — it is NOT in the AC4 spec.
// The 77-2 bootstrap impl added it in error; this library corrects that.
// ---------------------------------------------------------------------------

export const VALID_RESULT_CLASSES = new Set([
  'SHIP_IT',
  'LGTM_WITH_NOTES',
  'NEEDS_MINOR_FIXES',
  'escalated',
  'failed',
  'verification-failed',
])

// ---------------------------------------------------------------------------
// Case categories (77-3 AC4)
//
// regression: assert the RECORDED story_metrics.result of a historical run.
//   Immutable — the record never changes — so a correct regression case always
//   passes. These gate the build (near-100% target).
//
// capability: assert the outcome substrate SHOULD produce (e.g. the post-fix
//   class for a known false-escalation). Tier 2a replays immutable historical
//   records, so these can't be validated by replay — proving the fix requires a
//   FRESH run (Tier 1 / 77-6). They are reported as INFORMATIONAL and never gate.
//   See the obs_026 false-escalation cluster in the corpus.
// ---------------------------------------------------------------------------

export const CATEGORY_REGRESSION = 'regression'
export const CATEGORY_CAPABILITY = 'capability'

/**
 * Resolve a corpus entry's category. Defaults to `regression` when the field is
 * absent so the gate is conservative (an unlabeled case must pass).
 *
 * @param {object} entry - Corpus entry
 * @returns {'regression'|'capability'}
 */
export function caseCategory(entry) {
  return entry?.category === CATEGORY_CAPABILITY ? CATEGORY_CAPABILITY : CATEGORY_REGRESSION
}

// ---------------------------------------------------------------------------
// parseOutcomesCorpus
// ---------------------------------------------------------------------------

/**
 * Parse and validate an outcome corpus YAML string.
 * Validates the corpus_version header and cases[] array structure.
 * Throws on schema violation (structural errors).
 *
 * Note: individual case-level issues (missing run_id, invalid result_class)
 * are surfaced as corpus-errors by the grader, not thrown here, since
 * partial corpora should still produce valid gradable output for clean entries.
 *
 * @param {string} yamlContent - Raw YAML content
 * @returns {object} Parsed corpus object with corpus_version and cases[]
 * @throws {Error} When YAML is malformed or top-level structure is invalid
 */
export function parseOutcomesCorpus(yamlContent) {
  let parsed
  try {
    parsed = yaml.load(yamlContent)
  } catch (err) {
    throw new Error(`parseOutcomesCorpus: YAML parse error: ${err.message ?? err}`)
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'parseOutcomesCorpus: corpus root must be a mapping with corpus_version and cases',
    )
  }

  if (parsed.corpus_version === undefined || parsed.corpus_version === null) {
    throw new Error('parseOutcomesCorpus: corpus_version field is required')
  }

  if (!Array.isArray(parsed.cases)) {
    throw new Error('parseOutcomesCorpus: corpus must contain a "cases" array')
  }

  return parsed
}

// ---------------------------------------------------------------------------
// assertOutcomeCase
// ---------------------------------------------------------------------------

/**
 * Assert an outcome case against a story metrics row.
 * Applies exact result_class match and optional cycle-cap check.
 *
 * Does NOT check for missing run_id or manifest resolution — those are
 * corpus-errors handled before calling this function.
 *
 * @param {object} entry - Corpus entry with expect.result_class (and optionally expect.max_review_cycles)
 * @param {object} storyRow - Story metrics row with result and review_cycles
 * @returns {{ status: 'pass'|'fail', expected: string, actual: string, reason?: string }}
 */
export function assertOutcomeCase(entry, storyRow) {
  const expected = entry.expect?.result_class
  const actual = storyRow?.result
  const maxReviewCycles = entry.expect?.max_review_cycles
  const actualReviewCycles = storyRow?.review_cycles

  // Exact result_class match
  if (actual !== expected) {
    return {
      status: 'fail',
      expected,
      actual,
      reason: `result_class mismatch: expected "${expected}", got "${actual}"`,
    }
  }

  // Optional cycle cap check (AC4: cycle-cap fail when review_cycles > max_review_cycles)
  if (maxReviewCycles !== undefined && maxReviewCycles !== null) {
    if (actualReviewCycles > maxReviewCycles) {
      return {
        status: 'fail',
        expected,
        actual,
        reason: `review_cycles exceeded: expected ≤${maxReviewCycles}, got ${actualReviewCycles}`,
      }
    }
  }

  return { status: 'pass', expected, actual }
}

// ---------------------------------------------------------------------------
// Decision-replay assertions (Story 77-5, Tier 2b)
//
// Asserts harness *decisions* now that 77-4 persists them:
//   - expect.primary_model      → story_metrics.primary_model
//   - expect.escalation_reason  → manifest.per_story_state[storyKey].escalation_reason
//   - expect.recovery_actions[] → strategies in manifest.recovery_history for the story
//
// A case asserts ONLY the decision fields it declares (partial assertion, AC1).
// `escalation_reason: null` means "should NOT have escalated" — a recorded reason
// then FAILS the case (a re-introduced false escalation; AC3). For non-null
// expectations, a null/absent recorded value is a CORPUS-ERROR, not a silent
// pass (AC4) — so pre-77-4 runs (empty provenance) are flagged, never mistaken
// for passes.
// ---------------------------------------------------------------------------

export const DECISION_EXPECT_FIELDS = ['primary_model', 'escalation_reason', 'recovery_actions']

/**
 * True when a corpus entry declares any decision-class expectation.
 *
 * @param {object} entry - Corpus entry
 * @returns {boolean}
 */
export function hasDecisionExpectations(entry) {
  const exp = entry?.expect
  if (exp === undefined || exp === null) return false
  return DECISION_EXPECT_FIELDS.some((f) => f in exp)
}

/**
 * Resolve the recovery-action strategies recorded for a story from a manifest.
 *
 * @param {object|null} manifest - Run manifest
 * @param {string} storyKey - Story key
 * @returns {string[]} ordered list of recovery strategies for the story
 */
export function recoveryActionsForStory(manifest, storyKey) {
  const history = Array.isArray(manifest?.recovery_history) ? manifest.recovery_history : []
  return history.filter((e) => e?.story_key === storyKey).map((e) => e?.strategy)
}

/**
 * Assert a case's declared decision-class expectations against the recorded
 * provenance. Returns a single combined verdict: corpus-error takes precedence
 * (an asserted non-null field whose recorded value is absent), then fail, then
 * pass. Only invoked when hasDecisionExpectations(entry) is true.
 *
 * @param {object} entry - Corpus entry (entry.expect declares the decision fields)
 * @param {object} storyRow - story_metrics row (provides primary_model)
 * @param {object|null} manifest - run manifest (provides escalation_reason + recovery_history)
 * @param {string} storyKey - story key
 * @returns {{ status: 'pass'|'fail'|'corpus-error', field?: string, expected?: unknown, actual?: unknown, reason?: string }}
 */
export function assertDecisionCase(entry, storyRow, manifest, storyKey) {
  const exp = entry.expect ?? {}

  // -- primary_model --
  if ('primary_model' in exp) {
    const actual = storyRow?.primary_model ?? null
    if (exp.primary_model === null) {
      if (actual !== null) {
        return { status: 'fail', field: 'primary_model', expected: null, actual, reason: `primary_model expected null, got "${actual}"` }
      }
    } else if (actual === null) {
      return { status: 'corpus-error', field: 'primary_model', expected: exp.primary_model, actual: null, reason: 'primary_model not recorded (null/absent) — pre-77-4 provenance run?' }
    } else if (actual !== exp.primary_model) {
      return { status: 'fail', field: 'primary_model', expected: exp.primary_model, actual, reason: `primary_model mismatch: expected "${exp.primary_model}", got "${actual}"` }
    }
  }

  // -- escalation_reason --
  if ('escalation_reason' in exp) {
    const actual = manifest?.per_story_state?.[storyKey]?.escalation_reason ?? null
    if (exp.escalation_reason === null) {
      // "should not have escalated" — a recorded reason is a regression (false escalation).
      if (actual !== null) {
        return { status: 'fail', field: 'escalation_reason', expected: null, actual, reason: `escalation_reason expected null (no escalation), got "${actual}"` }
      }
    } else if (actual === null) {
      return { status: 'corpus-error', field: 'escalation_reason', expected: exp.escalation_reason, actual: null, reason: 'escalation_reason not recorded (null/absent) — pre-77-4 provenance run or story did not escalate' }
    } else if (actual !== exp.escalation_reason) {
      return { status: 'fail', field: 'escalation_reason', expected: exp.escalation_reason, actual, reason: `escalation_reason mismatch: expected "${exp.escalation_reason}", got "${actual}"` }
    }
  }

  // -- recovery_actions[] (subset assertion: all expected strategies must be present) --
  if ('recovery_actions' in exp && Array.isArray(exp.recovery_actions)) {
    const actual = recoveryActionsForStory(manifest, storyKey)
    if (exp.recovery_actions.length === 0) {
      // "no recovery should have run" — any recorded action is a regression.
      if (actual.length > 0) {
        return { status: 'fail', field: 'recovery_actions', expected: [], actual, reason: `recovery_actions expected none, got [${actual.join(', ')}]` }
      }
    } else if (actual.length === 0) {
      return { status: 'corpus-error', field: 'recovery_actions', expected: exp.recovery_actions, actual: [], reason: 'recovery_history empty for story — pre-77-4 provenance run?' }
    } else {
      const missing = exp.recovery_actions.filter((s) => !actual.includes(s))
      if (missing.length > 0) {
        return { status: 'fail', field: 'recovery_actions', expected: exp.recovery_actions, actual, reason: `missing recovery actions: [${missing.join(', ')}]` }
      }
    }
  }

  return { status: 'pass' }
}

// ---------------------------------------------------------------------------
// computePassCaretK (77-3 AC3)
// ---------------------------------------------------------------------------

/**
 * Compute pass^k reliability over corpus cases flagged `stable: true`.
 *
 * pass^k = the probability that ALL k recorded trials of the same logical case
 * succeed (reliability), as opposed to pass@k (at-least-one). A logical case is
 * identified by `logical_id` (falling back to `story_key`); k = the number of
 * distinct recorded run_ids graded for it.
 *
 * This is the mechanism only — the current corpus has no `stable: true` cases,
 * so it returns an empty groups[] with a note. It activates automatically when
 * stable multi-run cases are added (e.g. after Tier 1 fresh-run support lands).
 *
 * @param {Array<{entry: object, status: 'pass'|'fail'}>} gradedCases - regression cases with grade status
 * @returns {{ groups: Array<{logical_id: string, k: number, all_passed: boolean}>, note: string }}
 */
export function computePassCaretK(gradedCases) {
  const stable = gradedCases.filter((g) => g.entry?.stable === true)
  if (stable.length === 0) {
    return { groups: [], note: 'no stable:true cases in corpus — pass^k not applicable yet' }
  }
  const byLogical = new Map()
  for (const g of stable) {
    const key = g.entry.logical_id ?? g.entry.story_key
    if (!byLogical.has(key)) byLogical.set(key, [])
    byLogical.get(key).push(g)
  }
  const groups = []
  for (const [logicalId, members] of byLogical) {
    if (members.length < 2) continue // pass^k needs ≥2 trials to be meaningful
    groups.push({
      logical_id: logicalId,
      k: members.length,
      all_passed: members.every((m) => m.status === 'pass'),
    })
  }
  return { groups, note: groups.length === 0 ? 'stable cases present but none with k≥2 trials' : 'pass^k computed' }
}

// ---------------------------------------------------------------------------
// computeRubric
// ---------------------------------------------------------------------------

/**
 * Compute the rubric verdict based on pass count and total graded cases.
 *
 * Rubric (AC5, matching probe-author-validation-protocol.md):
 * - GREEN:  passRate >= threshold
 * - YELLOW: 0.85 <= passRate < threshold
 * - RED:    passRate < 0.85
 *
 * Corpus-error cases do NOT count in the denominator (only pass + fail cases).
 *
 * @param {number} passCount - Number of passed cases
 * @param {number} totalGraded - Total gradable cases (pass + fail only; excludes corpus-errors)
 * @param {number} threshold - GREEN threshold (e.g., 0.95)
 * @returns {'GREEN'|'YELLOW'|'RED'}
 */
export function computeRubric(passCount, totalGraded, threshold) {
  const passRate = totalGraded === 0 ? 0 : passCount / totalGraded
  if (passRate >= threshold) return 'GREEN'
  if (passRate >= 0.85) return 'YELLOW'
  return 'RED'
}

// ---------------------------------------------------------------------------
// readManifest
// ---------------------------------------------------------------------------

/**
 * Read a run manifest file from .substrate/runs/<runId>.json.
 * Returns null if the file doesn't exist or can't be parsed.
 *
 * @param {string} projectRoot - Root directory of the project
 * @param {string} runId - Run ID (used as filename without .json extension)
 * @returns {object|null} Manifest object or null
 */
export function readManifest(projectRoot, runId) {
  const manifestPath = join(projectRoot, '.substrate', 'runs', `${runId}.json`)
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}
