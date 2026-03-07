/**
 * Category and key-schema constants for operational findings in the decision store.
 *
 * These constants avoid string literals scattered across supervisor, orchestrator,
 * and experimenter code. Import them wherever you need to insert or query
 * operational decisions.
 */

// ---------------------------------------------------------------------------
// Category constants
// ---------------------------------------------------------------------------

/**
 * Category for supervisor stall events and run-level summaries.
 *
 * Key schemas:
 *   - Stall finding:  "stall:{storyKey}:{timestamp}"
 *   - Run summary:    "run-summary:{runId}"
 *
 * Value shapes:
 *
 * Stall finding:
 * ```json
 * {
 *   "phase": "string",                     // story phase at stall time, e.g. "code-review"
 *   "staleness_secs": 700,
 *   "attempt": 1,                          // restart attempt number (1-based)
 *   "outcome": "recovered"                 // "recovered" | "failed" | "max-restarts-escalated"
 * }
 * ```
 *
 * Run summary:
 * ```json
 * {
 *   "succeeded": ["1-1", "1-2"],
 *   "failed": ["1-3"],
 *   "escalated": [],
 *   "total_restarts": 0,
 *   "elapsed_seconds": 1234,
 *   "total_input_tokens": 50000,
 *   "total_output_tokens": 10000
 * }
 * ```
 */
export const OPERATIONAL_FINDING = 'operational-finding' as const

/**
 * Category for supervisor experiment results.
 *
 * Key schema: "experiment:{runId}:{timestamp}"
 *
 * Value shape:
 * ```json
 * {
 *   "target_metric": "token_regression",
 *   "before": 12000,
 *   "after": 9500,
 *   "verdict": "IMPROVED",                // "IMPROVED" | "MIXED" | "REGRESSED"
 *   "branch_name": "supervisor/experiment/abc12345-dev-story-token-regression"
 * }
 * ```
 */
export const EXPERIMENT_RESULT = 'experiment-result' as const

/**
 * Category for per-story wall-clock and efficiency metrics.
 *
 * Key schema: "{storyKey}:{runId}"
 *
 * Value shape:
 * ```json
 * {
 *   "wall_clock_seconds": 180,
 *   "input_tokens": 8000,
 *   "output_tokens": 2000,
 *   "review_cycles": 2,
 *   "stalled": false
 * }
 * ```
 */
export const STORY_METRICS = 'story-metrics' as const

/**
 * Category for structured escalation diagnoses.
 *
 * Key schema: "{storyKey}:{runId}"
 *
 * Value shape:
 * ```json
 * {
 *   "issueDistribution": "concentrated",
 *   "severityProfile": "major-only",
 *   "totalIssues": 3,
 *   "blockerCount": 0,
 *   "majorCount": 3,
 *   "minorCount": 0,
 *   "affectedFiles": ["src/foo.ts"],
 *   "reviewCycles": 3,
 *   "recommendedAction": "retry-targeted",
 *   "rationale": "3 major issues concentrated in few files."
 * }
 * ```
 */
export const ESCALATION_DIAGNOSIS = 'escalation-diagnosis' as const

/**
 * Category for per-story outcome findings (learning loop).
 *
 * Key schema: "{storyKey}:{runId}"
 *
 * Value shape:
 * ```json
 * {
 *   "storyKey": "22-1",
 *   "outcome": "complete",
 *   "reviewCycles": 2,
 *   "verdictHistory": ["NEEDS_MINOR_FIXES", "SHIP_IT"],
 *   "recurringPatterns": ["missing error handling"]
 * }
 * ```
 */
export const STORY_OUTCOME = 'story-outcome' as const

/**
 * Category for post-implementation test expansion findings generated per-story.
 *
 * Key schema: "{storyKey}:{runId}"
 *
 * Value shape:
 * ```json
 * {
 *   "expansion_priority": "medium",        // "low" | "medium" | "high"
 *   "coverage_gaps": [
 *     {
 *       "ac_ref": "AC1",
 *       "description": "Happy path not exercised at module boundary",
 *       "gap_type": "missing-integration"  // "missing-e2e" | "missing-integration" | "unit-only"
 *     }
 *   ],
 *   "suggested_tests": [
 *     {
 *       "test_name": "runFoo integration happy path",
 *       "test_type": "integration",        // "e2e" | "integration" | "unit"
 *       "description": "Test runFoo with real DB instance",
 *       "target_ac": "AC1"                 // optional
 *     }
 *   ],
 *   "notes": "Optional free-text notes",  // optional
 *   "error": "Error message if fallback"  // optional — present only on graceful fallback
 * }
 * ```
 */
export const TEST_EXPANSION_FINDING = 'test-expansion-finding' as const

/**
 * Category for pre-implementation test plans generated per-story.
 *
 * Key schema: "{storyKey}"
 *
 * Value shape:
 * ```json
 * {
 *   "test_files": ["src/modules/foo/__tests__/foo.test.ts"],
 *   "test_categories": ["unit", "integration"],
 *   "coverage_notes": "AC1 covered by foo.test.ts"
 * }
 * ```
 */
export const TEST_PLAN = 'test-plan' as const

/**
 * Category for advisory notes persisted when a code review returns LGTM_WITH_NOTES.
 *
 * Key schema: "{storyKey}:{runId}"
 *
 * Value shape:
 * ```json
 * {
 *   "storyKey": "25-3",
 *   "notes": "Consider extracting the helper into a shared module for reuse."
 * }
 * ```
 */
export const ADVISORY_NOTES = 'advisory-notes' as const
