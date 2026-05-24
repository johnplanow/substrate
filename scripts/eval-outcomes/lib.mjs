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
