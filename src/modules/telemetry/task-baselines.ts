/**
 * Per-task-type baseline profiles for efficiency scoring (Story 35-2).
 *
 * Calibrated from ynab cross-project validation run data (Epics 5-6, v0.5.8-v0.5.10).
 * Used by EfficiencyScorer for task-type-aware io_ratio and token density scoring.
 *
 * Baseline data (ynab Epics 5-6):
 *   dev-story:      400 turns, avg 544 output/turn, io mean 398 (totalIn/out)
 *   create-story:    83 turns, avg 1522 output/turn, io mean 149
 *   code-review:     59 turns, avg 3937 output/turn, io mean 79
 *   minor-fixes:     48 turns, avg 714 output/turn,  io mean 169
 *   test-plan:       15 turns, avg 1608 output/turn, io mean 28
 *   test-expansion:   7 turns, avg 1953 output/turn, io mean 12
 */

// ---------------------------------------------------------------------------
// TaskBaseline
// ---------------------------------------------------------------------------

export interface TaskBaseline {
  /** Expected avg output tokens per turn (for token density sub-score) */
  expectedOutputPerTurn: number
  /** Target output/freshInput ratio for io_ratio sub-score logarithmic curve */
  targetIoRatio: number
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

export const TASK_BASELINES: Readonly<Record<string, TaskBaseline>> = {
  'dev-story': { expectedOutputPerTurn: 550, targetIoRatio: 100 },
  'create-story': { expectedOutputPerTurn: 1500, targetIoRatio: 100 },
  'code-review': { expectedOutputPerTurn: 3900, targetIoRatio: 50 },
  'minor-fixes': { expectedOutputPerTurn: 700, targetIoRatio: 100 },
  'test-plan': { expectedOutputPerTurn: 1600, targetIoRatio: 30 },
  'test-expansion': { expectedOutputPerTurn: 1950, targetIoRatio: 15 },
}

export const DEFAULT_BASELINE: Readonly<TaskBaseline> = {
  expectedOutputPerTurn: 800,
  targetIoRatio: 100,
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Get the baseline for a task type, falling back to DEFAULT_BASELINE
 * when taskType is undefined, empty, or unknown.
 */
export function getBaseline(taskType?: string): TaskBaseline {
  if (taskType === undefined || taskType === '') return DEFAULT_BASELINE
  return TASK_BASELINES[taskType] ?? DEFAULT_BASELINE
}
