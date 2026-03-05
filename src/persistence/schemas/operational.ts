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
