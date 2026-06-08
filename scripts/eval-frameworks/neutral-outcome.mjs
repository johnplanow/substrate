// ---------------------------------------------------------------------------
// Neutral outcome oracle — a framework-AGNOSTIC definition of "did it succeed"
// (Phase 1 fairness scaffolding for framework-eval-strategy.md, dimension 4)
//
// "Did it succeed" is SHIP_IT for BMad, loop-halt for Ralph, human-approval for
// Lattice — all self-reported in the framework's own vocabulary, and therefore
// useless for a fair cross-framework comparison. This oracle defines success from
// the ARTIFACT alone, identically for every framework:
//
//     success  ==  build passes  AND  tests pass  AND  file-overlap(produced, ground-truth) >= threshold
//
// build/test execution is INJECTED (the caller runs them in the worktree and passes
// booleans); the overlap math is pure and reuses the existing diff helpers. No
// framework self-report is consulted.
// ---------------------------------------------------------------------------

import { extractFilesFromDiff } from '../eval-pack-upgrade/grader-lib.mjs'
import { jaccard } from '../eval-reconstruction/grader.mjs'

/**
 * @typedef {Object} NeutralOutcome
 * @property {boolean} success
 * @property {boolean} build_passed
 * @property {boolean} tests_passed
 * @property {number|null} file_overlap        jaccard(produced files, ground-truth files) ∈ [0,1], or null if no ground truth
 * @property {number} overlap_threshold
 * @property {boolean} overlap_met
 * @property {string} reason                   the first failing gate, or 'all-gates-passed'
 */

/**
 * Compute the neutral success outcome from artifact signals only.
 *
 * @param {object} args
 * @param {boolean} args.buildPassed           did the worktree build? (injected I/O)
 * @param {boolean} args.testsPassed           did the test suite pass? (injected I/O)
 * @param {string|string[]|null} args.runDiff        the framework's produced change
 * @param {string|string[]|null} args.groundTruthDiff  the reference change (null → overlap gate skipped)
 * @param {number} [args.overlapThreshold=0.5] minimum file-overlap to count as on-target
 * @returns {NeutralOutcome}
 */
export function computeNeutralOutcome({
  buildPassed,
  testsPassed,
  runDiff,
  groundTruthDiff,
  overlapThreshold = 0.5,
}) {
  const build_passed = buildPassed === true
  const tests_passed = testsPassed === true

  // Overlap gate. When no ground truth is supplied the gate is N/A (skipped), not failed —
  // some neutral tasks may be graded on build+test alone.
  let file_overlap = null
  let overlap_met = true
  if (groundTruthDiff != null) {
    const produced = extractFilesFromDiff(runDiff)
    const truth = extractFilesFromDiff(groundTruthDiff)
    // jaccard of two empty sets is conventionally 1; but if the ground truth names
    // files and the run produced none, that is overlap 0 (a real miss), which
    // jaccard(∅, truth) already yields. Empty-empty (no truth files) is handled by
    // the groundTruthDiff != null guard plus this size check.
    if (truth.size === 0) {
      file_overlap = null // ground truth resolved to no files → no usable signal
      overlap_met = true
    } else {
      file_overlap = jaccard(produced, truth)
      overlap_met = file_overlap >= overlapThreshold
    }
  }

  let reason
  if (!build_passed) reason = 'build-failed'
  else if (!tests_passed) reason = 'tests-failed'
  else if (!overlap_met) reason = 'below-overlap-threshold'
  else reason = 'all-gates-passed'

  const success = build_passed && tests_passed && overlap_met

  return {
    success,
    build_passed,
    tests_passed,
    file_overlap,
    overlap_threshold: overlapThreshold,
    overlap_met,
    reason,
  }
}
