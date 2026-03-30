/**
 * Pipeline Template Catalog — pre-built DOT graph pipeline templates for common patterns.
 *
 * Story 50-10.
 *
 * Node type strings used:
 *   - `start`          — start node (registered by default registry)
 *   - `exit`           — exit node (registered by default registry)
 *   - `codergen`       — coding agent node (registered by default registry)
 *   - `parallel`       — parallel fan-out node (story 50-1, shape=component)
 *   - `parallel.fan_in`— fan-in/merge node (story 50-2, shape=tripleoctagon)
 */

// ---------------------------------------------------------------------------
// PipelineTemplate interface
// ---------------------------------------------------------------------------

/**
 * A single entry in the pipeline template catalog.
 */
export interface PipelineTemplate {
  /** Unique template name (used as the `--template` flag value) */
  name: string
  /** One-line description displayed in `factory templates list` */
  description: string
  /** DOT graph source string written to `pipeline.dot` on `factory templates init` */
  dotContent: string
}

// ---------------------------------------------------------------------------
// Built-in template DOT content
// ---------------------------------------------------------------------------

const trycycleDotContent = `digraph trycycle {
  // Trycycle Pattern: iterative refinement with eval gates
  // Flow: define → plan → eval_plan ⇄ implement → eval_impl → exit
  // eval nodes can loop back to their upstream node on revision_needed.

  start      [type="start"];
  define     [type="codergen", label="Define Requirements"];
  plan       [type="codergen", label="Plan Implementation"];
  eval_plan  [type="codergen", label="Evaluate Plan"];
  implement  [type="codergen", label="Implement"];
  eval_impl  [type="codergen", label="Evaluate Implementation"];
  exit       [type="exit"];

  start     -> define;
  define    -> plan;
  plan      -> eval_plan;
  eval_plan -> implement     [label="approved"];
  eval_plan -> plan          [label="revision_needed"];
  implement -> eval_impl;
  eval_impl -> exit          [label="approved"];
  eval_impl -> implement     [label="revision_needed"];
}
`

const dualReviewDotContent = `digraph dual_review {
  // Dual-Review Pattern: fan-out to two independent reviewers, then fan-in
  // Flow: implement → (reviewer_a + reviewer_b) in parallel → merge → exit

  start           [type="start"];
  implement       [type="codergen",       label="Implement"];
  review_parallel [type="parallel",       label="Fan-Out to Reviewers"];
  reviewer_a      [type="codergen",       label="Reviewer A"];
  reviewer_b      [type="codergen",       label="Reviewer B"];
  review_merge    [type="parallel.fan_in",label="Merge Reviews"];
  exit            [type="exit"];

  start           -> implement;
  implement       -> review_parallel;
  review_parallel -> reviewer_a;
  review_parallel -> reviewer_b;
  reviewer_a      -> review_merge;
  reviewer_b      -> review_merge;
  review_merge    -> exit;
}
`

const parallelExplorationDotContent = `digraph parallel_exploration {
  // Parallel-Exploration Pattern: dispatch multiple approaches concurrently,
  // select the best-scoring result, then refine the winner.
  // Flow: (approach_a + approach_b) in parallel → select best → refine → exit

  start           [type="start"];
  explore_parallel[type="parallel",        label="Fan-Out Exploration"];
  approach_a      [type="codergen",        label="Approach A"];
  approach_b      [type="codergen",        label="Approach B"];
  select_best     [type="parallel.fan_in", label="Select Best Candidate", selection="best"];
  refine          [type="codergen",        label="Refine Winner"];
  exit            [type="exit"];

  start            -> explore_parallel;
  explore_parallel -> approach_a;
  explore_parallel -> approach_b;
  approach_a       -> select_best;
  approach_b       -> select_best;
  select_best      -> refine;
  refine           -> exit;
}
`

const stagedValidationDotContent = `digraph staged_validation {
  // Staged-Validation Pattern: sequential quality gates
  // Flow: implement → lint → test → validate → exit
  // Each stage is a separate codergen node; no parallel branches.

  start    [type="start"];
  implement[type="codergen", label="Implement"];
  lint     [type="codergen", label="Lint"];
  test     [type="codergen", label="Test"];
  validate [type="codergen", label="Validate"];
  exit     [type="exit"];

  start     -> implement;
  implement -> lint;
  lint      -> test;
  test      -> validate;
  validate  -> exit;
}
`

// ---------------------------------------------------------------------------
// Template objects
// ---------------------------------------------------------------------------

const trycycleTemplate: PipelineTemplate = {
  name: 'trycycle',
  description: 'Iterative refinement loop with plan and implementation eval gates',
  dotContent: trycycleDotContent,
}

const dualReviewTemplate: PipelineTemplate = {
  name: 'dual-review',
  description: 'Fan-out to two independent reviewers, then fan-in to merge results',
  dotContent: dualReviewDotContent,
}

const parallelExplorationTemplate: PipelineTemplate = {
  name: 'parallel-exploration',
  description: 'Dispatch parallel implementation approaches and select the best candidate',
  dotContent: parallelExplorationDotContent,
}

const stagedValidationTemplate: PipelineTemplate = {
  name: 'staged-validation',
  description: 'Sequential quality gate stages: implement → lint → test → validate',
  dotContent: stagedValidationDotContent,
}

// ---------------------------------------------------------------------------
// Template catalog
// ---------------------------------------------------------------------------

/**
 * Map of all built-in pipeline templates, keyed by template name.
 * Insertion order determines display order in `factory templates list`.
 */
export const PIPELINE_TEMPLATES: Map<string, PipelineTemplate> = new Map([
  [trycycleTemplate.name, trycycleTemplate],
  [dualReviewTemplate.name, dualReviewTemplate],
  [parallelExplorationTemplate.name, parallelExplorationTemplate],
  [stagedValidationTemplate.name, stagedValidationTemplate],
])

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Returns all available pipeline template entries in insertion order.
 */
export function listPipelineTemplates(): PipelineTemplate[] {
  return Array.from(PIPELINE_TEMPLATES.values())
}

/**
 * Returns the pipeline template entry for the given name (case-sensitive),
 * or `undefined` if not found.
 */
export function getPipelineTemplate(name: string): PipelineTemplate | undefined {
  return PIPELINE_TEMPLATES.get(name)
}
