/**
 * Experimenter — automated experimentation engine for the pipeline supervisor.
 *
 * Implements the experiment state machine for Story 17-4:
 *   SELECTING → BRANCHING → MODIFYING → RUNNING → COMPARING → REPORTING
 *
 * The experimenter takes supervisor recommendations (from Story 17-3 analysis),
 * creates isolated git branches, applies template-based modifications to prompt files,
 * runs single-story controlled experiments, and compares results to produce verdicts.
 *
 * Architecture:
 *   - All git operations via injectable `git` dependency (defaults to spawnGit)
 *   - All file I/O via injectable `readFile`/`writeFile` dependencies
 *   - Pipeline execution via injectable `runStory` dependency
 *   - Metrics retrieval via injectable `getRunMetrics`/`getStoryMetrics` dependencies
 *   - Never touches main/master directly — all changes on branches
 */

import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn as nodeSpawn } from 'node:child_process'
import { spawnGit } from '../git-worktree/git-utils.js'
import type { GitSpawnResult, SpawnOptions } from '../git-worktree/git-utils.js'
import { getRunMetrics, getStoryMetricsForRun } from '../../persistence/queries/metrics.js'
import type { RunMetricsRow, StoryMetricsRow } from '../../persistence/queries/metrics.js'
import { createDecision } from '../../persistence/queries/decisions.js'
import { EXPERIMENT_RESULT } from '../../persistence/schemas/operational.js'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Generic spawn helper (for gh CLI)
// ---------------------------------------------------------------------------

/**
 * Injectable function type for spawning arbitrary processes (e.g., `gh pr create`).
 */
export type SpawnFn = (cmd: string, args: string[], opts?: SpawnOptions) => Promise<GitSpawnResult>

/**
 * Default spawn implementation used when no `spawn` dep is injected.
 */
function spawnCommand(cmd: string, args: string[], opts?: SpawnOptions): Promise<GitSpawnResult> {
  return new Promise((resolve) => {
    const proc = nodeSpawn(cmd, args, {
      cwd: opts?.cwd,
      env: opts?.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('close', (code) => { resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }) })
    proc.on('error', (err) => { resolve({ stdout: '', stderr: err.message, code: 1 }) })
  })
}

// ---------------------------------------------------------------------------
// Recommendation types (output of Story 17-3 analysis engine)
// ---------------------------------------------------------------------------

/**
 * The type of optimization recommendation produced by the supervisor analysis engine.
 *
 *  - token_regression: A phase used significantly more tokens than the baseline
 *  - review_cycles: A story required more review cycles than the baseline average
 *  - timing_bottleneck: A phase accounts for a disproportionate share of wall-clock time
 */
export type RecommendationType = 'token_regression' | 'review_cycles' | 'timing_bottleneck'

/**
 * A machine-readable recommendation produced by the supervisor analysis engine (Story 17-3).
 * The experimenter consumes these to decide what to branch, modify, and test.
 */
export interface SupervisorRecommendation {
  /** Category of finding */
  type: RecommendationType

  /** The story key that exhibited the regression or bottleneck */
  story_key: string

  /**
   * The phase where the issue occurred.
   * Maps to a prompt file: 'dev-story' → 'dev-story.md', 'code-review' → 'code-review.md', etc.
   */
  phase: string

  /** Human-readable description of the finding */
  description: string

  /**
   * Short slug used in branch naming (safe chars: [a-z0-9-] only, max 40 chars).
   * Example: 'dev-story-token-regression'
   */
  short_desc: string

  // Token regression fields
  tokens_actual?: number
  tokens_baseline?: number
  delta_pct?: number

  // Review cycle fields
  review_cycles?: number
  avg_review_cycles_baseline?: number

  // Timing bottleneck fields
  timing_seconds?: number
}

// ---------------------------------------------------------------------------
// Experiment types
// ---------------------------------------------------------------------------

/**
 * Phase names for the experiment state machine.
 */
export type ExperimentPhase =
  | 'SELECTING'
  | 'BRANCHING'
  | 'MODIFYING'
  | 'RUNNING'
  | 'COMPARING'
  | 'REPORTING'

/**
 * Verdict for an experiment run.
 *
 *  - IMPROVED: Target metric improved and no other metrics regressed by >20%
 *  - MIXED: Target metric improved but at least one other metric regressed by >20%
 *  - REGRESSED: Target metric worsened or experiment failed
 */
export type ExperimentVerdict = 'IMPROVED' | 'MIXED' | 'REGRESSED'

/**
 * Percentage deltas between the experiment run and the baseline run.
 * Negative values mean the experiment was better (fewer tokens, less time, etc.).
 * Null means the metric could not be computed (e.g., baseline was 0).
 */
export interface ExperimentMetricDeltas {
  /** Total token delta (input + output) as percentage of baseline */
  tokens_pct: number | null
  /** Cost delta as percentage of baseline */
  cost_pct: number | null
  /** Review cycle count delta as percentage of baseline */
  review_cycles_pct: number | null
  /** Wall-clock time delta as percentage of baseline */
  wall_clock_pct: number | null
}

/**
 * The outcome of a single experiment run.
 */
export interface ExperimentResult {
  /** The recommendation that was tested */
  recommendation: SupervisorRecommendation

  /** The git branch created for this experiment */
  branchName: string

  /** The run ID of the baseline that was compared against */
  baselineRunId: string

  /** The run ID of the experiment run (null if run failed to start) */
  experimentRunId: string | null

  /** Verdict: IMPROVED, MIXED, or REGRESSED */
  verdict: ExperimentVerdict

  /** Metric deltas between experiment run and baseline */
  deltas: ExperimentMetricDeltas

  /** The phase the state machine was in when results were produced */
  currentPhase: ExperimentPhase

  /** Error message if the experiment failed */
  error?: string

  /** GitHub PR URL if a PR was created (IMPROVED or MIXED verdict), null otherwise */
  prLink?: string | null
}

/**
 * Configuration for the Experimenter.
 */
export interface ExperimentConfig {
  /** Project root directory */
  projectRoot: string

  /** Methodology pack name (e.g., 'bmad') */
  pack: string

  /** Maximum number of experiments to run per analysis cycle (AC6). Default: 2 */
  maxExperiments: number

  /**
   * Token budget multiplier: the experiment is aborted if it would cost more than
   * (multiplier × baseline story cost). Default: 2 (AC6).
   */
  tokenBudgetMultiplier: number
}

/**
 * Options passed to runStory when executing a controlled experiment.
 */
export interface ExperimentRunOptions {
  stories: string
  projectRoot: string
  pack: string
}

/**
 * Injectable function to run a single story.
 * Returns the new run ID and exit code.
 */
export type RunStoryFn = (opts: ExperimentRunOptions) => Promise<{ runId: string; exitCode: number }>

/**
 * Injectable dependencies for the Experimenter.
 * All fields are optional — defaults are the real implementations.
 */
export interface ExperimenterDeps {
  git: (args: string[], opts?: SpawnOptions) => Promise<GitSpawnResult>
  /** Generic process spawner used for `gh pr create` and similar CLI tools. */
  spawn: SpawnFn
  runStory: RunStoryFn
  getRunMetrics: (db: BetterSqlite3Database, runId: string) => RunMetricsRow | undefined
  getStoryMetrics: (db: BetterSqlite3Database, runId: string) => StoryMetricsRow[]
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  /** Create directory (recursive). Used to ensure audit log directories exist. */
  mkdir: (path: string, opts?: { recursive: boolean }) => Promise<void>
  log: (msg: string) => void
}

/**
 * The Experimenter interface. Created via createExperimenter().
 */
export interface Experimenter {
  /**
   * Run experiments for the given recommendations, sequentially.
   * Respects config.maxExperiments limit.
   *
   * @param db - SQLite database for reading metrics
   * @param recommendations - Ordered list of recommendations to experiment with
   * @param baselineRunId - The run ID to use as the comparison baseline
   * @returns Results for each experiment that was attempted
   */
  runExperiments(
    db: BetterSqlite3Database,
    recommendations: SupervisorRecommendation[],
    baselineRunId: string,
  ): Promise<ExperimentResult[]>
}

// ---------------------------------------------------------------------------
// Branch name construction
// ---------------------------------------------------------------------------

/**
 * Build a git branch name for an experiment.
 * Format: supervisor/experiment/<run-id-prefix>-<short-desc>
 *
 * The run-id is truncated to 8 characters. The short_desc is sanitized and
 * truncated to 30 characters.
 */
export function buildBranchName(runId: string, shortDesc: string): string {
  const safe = shortDesc
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 30)
    .replace(/^-|-$/g, '')

  const runIdShort = runId.slice(0, 8)
  return `supervisor/experiment/${runIdShort}-${safe}`
}

/**
 * Build a worktree directory path for an experiment.
 * Format: <projectRoot>/.claude/worktrees/experiment-<run-id-prefix>-<short-desc-truncated>
 *
 * The run-id is truncated to 8 characters. The short_desc is sanitized and
 * truncated to 20 characters for the directory name.
 */
export function buildWorktreePath(projectRoot: string, baselineRunId: string, shortDesc: string): string {
  const safe = shortDesc
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 20)
    .replace(/^-|-$/g, '')

  const idShort = baselineRunId.slice(0, 8)
  return join(projectRoot, '.claude', 'worktrees', `experiment-${idShort}-${safe}`)
}

// ---------------------------------------------------------------------------
// Modification strategy
// ---------------------------------------------------------------------------

/**
 * Maps phase names to their prompt template filenames.
 */
const PHASE_TO_PROMPT_FILE: Record<string, string> = {
  'create-story': 'create-story.md',
  'dev-story': 'dev-story.md',
  'code-review': 'code-review.md',
  'fix': 'fix-story.md',
}

/**
 * Build the modification directive to append to a prompt file.
 * The directive is a HTML comment that instructs the agent to apply
 * the recommended optimization strategy for this experiment.
 *
 * These are template-based strategies per recommendation type.
 * Future iterations could use an LLM to generate novel modifications.
 */
export function buildModificationDirective(rec: SupervisorRecommendation): string {
  switch (rec.type) {
    case 'token_regression':
      return (
        '\n<!-- supervisor-experiment: token_regression fix' +
        ` — compress context injection, limit summaries to key points` +
        ` (story: ${rec.story_key}, phase: ${rec.phase}, delta: +${rec.delta_pct ?? '?'}%)` +
        ' -->'
      )
    case 'review_cycles':
      return (
        '\n<!-- supervisor-experiment: review_cycles fix' +
        ` — accept passing implementations with minor style issues,` +
        ` reduce strictness for non-critical checks` +
        ` (story: ${rec.story_key}, cycles: ${rec.review_cycles ?? '?'})` +
        ' -->'
      )
    case 'timing_bottleneck':
      return (
        '\n<!-- supervisor-experiment: timing_bottleneck fix' +
        ` — reduce max_turns by 20% for this phase to enforce time-boxing` +
        ` (story: ${rec.story_key}, phase: ${rec.phase})` +
        ' -->'
      )
  }
}

/**
 * Resolve the absolute path to the prompt file for a recommendation's phase.
 */
export function resolvePromptFile(
  rec: SupervisorRecommendation,
  projectRoot: string,
  pack: string,
): string {
  const filename = PHASE_TO_PROMPT_FILE[rec.phase] ?? `${rec.phase}.md`
  return join(projectRoot, 'packs', pack, 'prompts', filename)
}

// ---------------------------------------------------------------------------
// Verdict determination (AC4)
// ---------------------------------------------------------------------------

const REGRESSION_THRESHOLD_PCT = 20

/**
 * Determine the experiment verdict based on metric deltas and the recommendation type.
 *
 * Rules:
 *  - IMPROVED: target metric improved (negative delta) AND no other metric regressed by >20%
 *  - MIXED: target metric improved BUT at least one other metric regressed by >20%
 *  - REGRESSED: target metric did not improve (or could not be measured)
 */
export function determineVerdict(
  rec: SupervisorRecommendation,
  deltas: ExperimentMetricDeltas,
): ExperimentVerdict {
  const targetImproved = isTargetMetricImproved(rec, deltas)
  const hasRegression = hasNonTargetRegression(rec, deltas)

  if (!targetImproved) return 'REGRESSED'
  if (hasRegression) return 'MIXED'
  return 'IMPROVED'
}

function isTargetMetricImproved(
  rec: SupervisorRecommendation,
  deltas: ExperimentMetricDeltas,
): boolean {
  switch (rec.type) {
    case 'token_regression':
      return deltas.tokens_pct !== null && deltas.tokens_pct < 0
    case 'review_cycles':
      return deltas.review_cycles_pct !== null && deltas.review_cycles_pct < 0
    case 'timing_bottleneck':
      return deltas.wall_clock_pct !== null && deltas.wall_clock_pct < 0
  }
}

function hasNonTargetRegression(
  rec: SupervisorRecommendation,
  deltas: ExperimentMetricDeltas,
): boolean {
  // Check non-target metrics for regressions above the threshold
  if (
    rec.type !== 'token_regression' &&
    deltas.tokens_pct !== null &&
    deltas.tokens_pct > REGRESSION_THRESHOLD_PCT
  ) {
    return true
  }
  if (
    rec.type !== 'review_cycles' &&
    deltas.review_cycles_pct !== null &&
    deltas.review_cycles_pct > REGRESSION_THRESHOLD_PCT
  ) {
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Delta computation
// ---------------------------------------------------------------------------

/**
 * Compute percentage deltas between baseline and experiment run metrics.
 * Negative values mean the experiment was better.
 */
function computeDeltas(
  baselineMetrics: RunMetricsRow,
  experimentMetrics: RunMetricsRow,
): ExperimentMetricDeltas {
  const pct = (base: number, exp: number): number | null =>
    base === 0 ? null : Math.round(((exp - base) / base) * 100 * 10) / 10

  const baseTokens =
    (baselineMetrics.total_input_tokens ?? 0) + (baselineMetrics.total_output_tokens ?? 0)
  const expTokens =
    (experimentMetrics.total_input_tokens ?? 0) + (experimentMetrics.total_output_tokens ?? 0)

  return {
    tokens_pct: pct(baseTokens, expTokens),
    cost_pct: pct(baselineMetrics.total_cost_usd ?? 0, experimentMetrics.total_cost_usd ?? 0),
    review_cycles_pct: pct(
      baselineMetrics.total_review_cycles ?? 0,
      experimentMetrics.total_review_cycles ?? 0,
    ),
    wall_clock_pct: pct(
      baselineMetrics.wall_clock_seconds ?? 0,
      experimentMetrics.wall_clock_seconds ?? 0,
    ),
  }
}

// ---------------------------------------------------------------------------
// PR body and audit log builders (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Format a percentage delta for display (e.g., "+15%" or "-20%" or "N/A").
 */
function fmtPct(pct: number | null): string {
  if (pct === null) return 'N/A'
  return `${pct > 0 ? '+' : ''}${pct}%`
}

/**
 * Build the GitHub PR body with a metrics comparison table and raw data.
 * Used by createPR() when the verdict is IMPROVED or MIXED (AC5).
 */
export function buildPRBody(result: ExperimentResult): string {
  const { recommendation: rec, verdict, deltas, baselineRunId, experimentRunId, branchName } = result
  return [
    `## Experiment Results`,
    ``,
    `**Verdict**: \`${verdict}\``,
    ``,
    `### Recommendation`,
    `- **Type**: ${rec.type}`,
    `- **Story**: ${rec.story_key}`,
    `- **Phase**: ${rec.phase}`,
    `- **Description**: ${rec.description}`,
    ``,
    `### Metrics Comparison`,
    ``,
    `| Metric | Delta |`,
    `|--------|-------|`,
    `| Tokens | ${fmtPct(deltas.tokens_pct)} |`,
    `| Cost | ${fmtPct(deltas.cost_pct)} |`,
    `| Review Cycles | ${fmtPct(deltas.review_cycles_pct)} |`,
    `| Wall Clock | ${fmtPct(deltas.wall_clock_pct)} |`,
    ``,
    `### Raw Data`,
    `- Baseline Run: \`${baselineRunId}\``,
    `- Experiment Run: \`${experimentRunId ?? 'N/A'}\``,
    `- Branch: \`${branchName}\``,
  ].join('\n')
}

/**
 * Build an audit log entry for a single experiment result.
 * The entry is markdown formatted and suitable for appending to the audit log file.
 */
export function buildAuditLogEntry(
  result: ExperimentResult,
  timestamp: string = new Date().toISOString(),
): string {
  const { recommendation: rec, verdict, deltas, error, prLink } = result
  const lines: string[] = [
    `## Experiment: ${rec.short_desc} (${timestamp})`,
    ``,
    `**Hypothesis**: ${rec.description}`,
    ``,
    `**Modification**: Applied \`${rec.type}\` strategy to \`${rec.phase}\` prompt`,
    ``,
    `**Results**:`,
    `- Verdict: ${verdict}`,
    `- Tokens delta: ${fmtPct(deltas.tokens_pct)}`,
    `- Cost delta: ${fmtPct(deltas.cost_pct)}`,
    `- Review cycles delta: ${fmtPct(deltas.review_cycles_pct)}`,
    `- Wall clock delta: ${fmtPct(deltas.wall_clock_pct)}`,
  ]
  if (error) {
    lines.push(`- Error: ${error}`)
  }
  lines.push(``)
  if (prLink) {
    lines.push(`**PR**: ${prLink}`, ``)
  }
  lines.push(`---`, ``)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// createExperimenter factory
// ---------------------------------------------------------------------------

/**
 * Create an Experimenter with the given configuration and injectable dependencies.
 *
 * The Experimenter implements the AC2/AC3/AC4 state machine:
 *   SELECTING → BRANCHING → MODIFYING → RUNNING → COMPARING → REPORTING
 */
export function createExperimenter(
  config: ExperimentConfig,
  deps?: Partial<ExperimenterDeps>,
): Experimenter {
  const resolvedDeps: ExperimenterDeps = {
    git: deps?.git ?? spawnGit,
    spawn: deps?.spawn ?? spawnCommand,
    runStory: deps?.runStory ?? (async () => { throw new Error('runStory dependency not provided') }),
    getRunMetrics: deps?.getRunMetrics ?? getRunMetrics,
    getStoryMetrics: deps?.getStoryMetrics ?? getStoryMetricsForRun,
    readFile: deps?.readFile ?? ((p) => readFile(p, 'utf-8')),
    writeFile: deps?.writeFile ?? ((p, c) => writeFile(p, c, 'utf-8')),
    mkdir: deps?.mkdir ?? ((p, o) => mkdir(p, o).then(() => undefined)),
    log: deps?.log ?? ((msg) => process.stdout.write(msg + '\n')),
  }

  const { git, spawn: sp, runStory, getRunMetrics: getRun, getStoryMetrics: getStory, readFile: rf, writeFile: wf, mkdir: md, log } = resolvedDeps

  // ---------------------------------------------------------------------------
  // Git helpers
  // ---------------------------------------------------------------------------

  async function getCurrentBranch(): Promise<string> {
    const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: config.projectRoot })
    return result.stdout.trim()
  }

  /**
   * Create an isolated git worktree for an experiment.
   * Uses `git worktree add <path> -b <branch>` so the main working tree is never affected.
   */
  async function createWorktree(worktreePath: string, branchName: string): Promise<void> {
    const result = await git(['worktree', 'add', worktreePath, '-b', branchName], { cwd: config.projectRoot })
    if (result.code !== 0) {
      throw new Error(`Failed to create worktree ${worktreePath}: ${result.stderr}`)
    }
  }

  /**
   * Remove an experiment worktree after the experiment completes.
   * Always called in the finally block (regardless of verdict).
   * Uses --force to handle cases where the worktree directory may be dirty.
   */
  async function removeWorktree(worktreePath: string): Promise<void> {
    const result = await git(['worktree', 'remove', worktreePath, '--force'], { cwd: config.projectRoot })
    if (result.code !== 0) {
      log(`[experimenter] Warning: could not remove worktree ${worktreePath}: ${result.stderr}`)
    } else {
      log(`[experimenter] Removed experiment worktree: ${worktreePath}`)
    }
  }

  async function commitModification(
    rec: SupervisorRecommendation,
    filePath: string,
    cwd: string,
  ): Promise<void> {
    await git(['add', filePath], { cwd })
    const message =
      `supervisor-experiment: ${rec.type} fix for ${rec.story_key}/${rec.phase}\n\n` +
      `Recommendation: ${rec.description}`
    const result = await git(['commit', '-m', message], { cwd })
    if (result.code !== 0) {
      throw new Error(`Failed to commit modification: ${result.stderr}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Branch deletion (AC5: delete branch on REGRESSED verdict)
  // ---------------------------------------------------------------------------

  async function deleteBranch(branchName: string): Promise<void> {
    const result = await git(['branch', '-D', branchName], { cwd: config.projectRoot })
    if (result.code !== 0) {
      log(`[experimenter] Warning: could not delete branch ${branchName}: ${result.stderr}`)
    } else {
      log(`[experimenter] Deleted REGRESSED experiment branch: ${branchName}`)
    }
  }

  // ---------------------------------------------------------------------------
  // PR creation via gh CLI (AC5)
  // ---------------------------------------------------------------------------

  /**
   * Open a GitHub PR for the experiment. Returns the PR URL, or null if gh is not available.
   * Degrades gracefully if gh CLI is not installed.
   */
  async function createPR(result: ExperimentResult): Promise<string | null> {
    const { recommendation: rec, branchName, verdict } = result
    const title = `[supervisor] ${rec.description}`
    const body = buildPRBody(result)

    const ghResult = await sp(
      'gh',
      [
        'pr', 'create',
        '--title', title,
        '--body', body,
        '--label', 'supervisor',
        '--label', 'automated-experiment',
        '--head', branchName,
      ],
      { cwd: config.projectRoot },
    )

    if (ghResult.code !== 0) {
      log(`[experimenter] Warning: gh pr create failed (verdict: ${verdict}): ${ghResult.stderr}`)
      log(`[experimenter] Is the gh CLI installed and authenticated?`)
      return null
    }

    const prUrl = ghResult.stdout.trim()
    log(`[experimenter] PR created: ${prUrl}`)
    return prUrl
  }

  // ---------------------------------------------------------------------------
  // Audit trail (AC7)
  // ---------------------------------------------------------------------------

  /**
   * Append an experiment result to the audit log file.
   * Path: _bmad-output/supervisor-reports/<baselineRunId>-experiments.md
   * Append-only: reads existing content and appends the new entry.
   */
  async function appendExperimentLog(
    result: ExperimentResult,
  ): Promise<void> {
    const { baselineRunId } = result
    const reportDir = join(config.projectRoot, '_bmad-output', 'supervisor-reports')
    const logPath = join(reportDir, `${baselineRunId}-experiments.md`)

    try {
      await md(reportDir, { recursive: true })

      let existing = ''
      try {
        existing = await rf(logPath)
      } catch {
        // File doesn't exist yet — that's fine, we'll create it
        existing = `# Supervisor Experiment Log\n\nRun ID: \`${baselineRunId}\`\n\n`
      }

      const entry = buildAuditLogEntry(result)
      await wf(logPath, existing + entry)
      log(`[experimenter] Audit log updated: ${logPath}`)
    } catch (err) {
      log(`[experimenter] Warning: could not write audit log: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Token budget check (AC6)
  // ---------------------------------------------------------------------------

  /**
   * Check if the experiment run exceeded the token budget cap (AC6).
   * Budget cap = baseline story tokens × tokenBudgetMultiplier.
   *
   * Returns false (budget exceeded) if the experiment used more than the cap.
   * Returns true (within budget) if the cap is satisfied or metrics are unavailable.
   */
  function isWithinTokenBudget(
    db: BetterSqlite3Database,
    storyKey: string,
    baselineRunId: string,
    experimentRunId: string,
  ): boolean {
    try {
      const baselineStories = getStory(db, baselineRunId)
      const experimentStories = getStory(db, experimentRunId)

      const baselineStory = baselineStories.find((m) => m.story_key === storyKey)
      const experimentStory = experimentStories.find((m) => m.story_key === storyKey)

      if (!baselineStory || !experimentStory) return true // can't check — allow

      const baselineTokens = (baselineStory.input_tokens ?? 0) + (baselineStory.output_tokens ?? 0)
      const experimentTokens = (experimentStory.input_tokens ?? 0) + (experimentStory.output_tokens ?? 0)

      if (baselineTokens === 0) return true // no baseline — allow

      const cap = baselineTokens * config.tokenBudgetMultiplier
      const withinBudget = experimentTokens <= cap
      if (!withinBudget) {
        log(
          `[experimenter] Token budget exceeded: experiment used ${experimentTokens} tokens,` +
          ` cap is ${cap} (${config.tokenBudgetMultiplier}x baseline of ${baselineTokens})`,
        )
      }
      return withinBudget
    } catch {
      return true // if we can't check, don't penalize
    }
  }

  // ---------------------------------------------------------------------------
  // Single experiment execution
  // ---------------------------------------------------------------------------

  async function runOneExperiment(
    db: BetterSqlite3Database,
    rec: SupervisorRecommendation,
    baselineRunId: string,
  ): Promise<ExperimentResult> {
    const branchName = buildBranchName(baselineRunId, rec.short_desc)
    const worktreePath = buildWorktreePath(config.projectRoot, baselineRunId, rec.short_desc)
    let experimentRunId: string | null = null
    let currentPhase: ExperimentPhase = 'SELECTING'
    let verdict: ExperimentVerdict = 'REGRESSED'
    let deltas: ExperimentMetricDeltas = { tokens_pct: null, cost_pct: null, review_cycles_pct: null, wall_clock_pct: null }
    let caughtError: string | undefined
    let worktreeCreated = false

    try {
      // ---- BRANCHING: create an isolated git worktree (main working tree unaffected) ----
      currentPhase = 'BRANCHING'
      log(`[experimenter] Creating worktree: ${worktreePath} on branch ${branchName}`)
      await createWorktree(worktreePath, branchName)
      worktreeCreated = true

      // ---- MODIFYING: apply template-based modification to prompt file in the worktree ----
      currentPhase = 'MODIFYING'
      const promptFile = resolvePromptFile(rec, worktreePath, config.pack)
      const directive = buildModificationDirective(rec)
      const originalContent = await rf(promptFile)
      await wf(promptFile, originalContent + directive)
      await commitModification(rec, promptFile, worktreePath)
      log(`[experimenter] Applied modification to ${promptFile}`)

      // ---- RUNNING: execute a controlled single-story run in the worktree ----
      currentPhase = 'RUNNING'
      log(`[experimenter] Running single-story experiment for ${rec.story_key}`)
      const { runId, exitCode } = await runStory({
        stories: rec.story_key,
        projectRoot: worktreePath,
        pack: config.pack,
      })
      experimentRunId = runId
      log(`[experimenter] Experiment run completed: ${runId} (exit: ${exitCode})`)

      // ---- COMPARING: query metrics, check token budget, compute verdict ----
      currentPhase = 'COMPARING'
      const baselineMetrics = getRun(db, baselineRunId)
      const experimentMetrics = getRun(db, runId)

      if (!baselineMetrics || !experimentMetrics) {
        log(`[experimenter] Warning: metrics unavailable for comparison`)
        verdict = 'REGRESSED'
        caughtError = 'Could not retrieve metrics for comparison'
      } else {
        deltas = computeDeltas(baselineMetrics, experimentMetrics)

        // AC6: token budget cap — check story-level tokens before computing final verdict
        const withinBudget = isWithinTokenBudget(db, rec.story_key, baselineRunId, runId)
        if (!withinBudget) {
          verdict = 'REGRESSED'
          caughtError = `Token budget cap exceeded (${config.tokenBudgetMultiplier}x baseline)`
          log(`[experimenter] Aborting experiment: token budget exceeded`)
        } else {
          verdict = determineVerdict(rec, deltas)
        }
      }

      currentPhase = 'REPORTING'
      log(`[experimenter] Verdict for ${rec.story_key}/${rec.type}: ${verdict}`)
      log(`[experimenter] Deltas: tokens=${deltas.tokens_pct}% cost=${deltas.cost_pct}% cycles=${deltas.review_cycles_pct}% clock=${deltas.wall_clock_pct}%`)
    } catch (err) {
      caughtError = err instanceof Error ? err.message : String(err)
      verdict = 'REGRESSED'
      log(`[experimenter] Error in phase ${currentPhase}: ${caughtError}`)
    } finally {
      // Always remove the worktree — main working tree is never affected
      if (worktreeCreated) {
        try {
          await removeWorktree(worktreePath)
        } catch {
          // Best-effort: log but don't re-throw
          log(`[experimenter] Warning: could not remove worktree ${worktreePath}`)
        }
      }
    }

    // ---- REPORTING: PR creation / branch cleanup / audit trail ----
    // (Worktree has already been removed in finally; branch still exists for IMPROVED/MIXED)
    let prLink: string | null = null

    if (verdict === 'REGRESSED' && worktreeCreated) {
      // AC5: delete branch on REGRESSED verdict (worktree removed in finally, branch cleanup here)
      await deleteBranch(branchName)
    } else if (verdict === 'IMPROVED' || verdict === 'MIXED') {
      // AC5: create PR for IMPROVED or MIXED
      const partialResult: ExperimentResult = {
        recommendation: rec,
        branchName,
        baselineRunId,
        experimentRunId,
        verdict,
        deltas,
        currentPhase: 'REPORTING',
        ...(caughtError !== undefined ? { error: caughtError } : {}),
      }
      prLink = await createPR(partialResult)
    }

    // AC7: append to audit trail
    const finalResult: ExperimentResult = {
      recommendation: rec,
      branchName,
      baselineRunId,
      experimentRunId,
      verdict,
      deltas,
      currentPhase: 'REPORTING',
      ...(caughtError !== undefined ? { error: caughtError } : {}),
      prLink,
    }
    await appendExperimentLog(finalResult)

    // AC3 of Story 21-1: persist experiment result to decision store
    try {
      const targetMetricValue =
        rec.type === 'token_regression'
          ? (rec.tokens_actual ?? 0)
          : rec.type === 'review_cycles'
            ? (rec.review_cycles ?? 0)
            : (rec.timing_seconds ?? 0)
      const afterValue =
        rec.type === 'token_regression'
          ? (deltas.tokens_pct !== null ? Math.round(targetMetricValue * (1 + deltas.tokens_pct / 100)) : targetMetricValue)
          : rec.type === 'review_cycles'
            ? (deltas.review_cycles_pct !== null ? Math.round(targetMetricValue * (1 + deltas.review_cycles_pct / 100)) : targetMetricValue)
            : (deltas.wall_clock_pct !== null ? Math.round(targetMetricValue * (1 + deltas.wall_clock_pct / 100)) : targetMetricValue)

      createDecision(db, {
        pipeline_run_id: baselineRunId,
        phase: 'supervisor',
        category: EXPERIMENT_RESULT,
        key: `experiment:${baselineRunId}:${Date.now()}`,
        value: JSON.stringify({
          target_metric: rec.type,
          before: targetMetricValue,
          after: afterValue,
          verdict,
          branch_name: (verdict === 'IMPROVED' || verdict === 'MIXED') ? branchName : null,
        }),
        rationale: `Experiment for ${rec.story_key}/${rec.phase}: ${rec.description}. Verdict: ${verdict}.`,
      })
    } catch {
      // Best-effort — don't fail the experiment over decision store writes
    }

    return finalResult
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  return {
    async runExperiments(
      db: BetterSqlite3Database,
      recommendations: SupervisorRecommendation[],
      baselineRunId: string,
    ): Promise<ExperimentResult[]> {
      if (recommendations.length === 0) return []

      const currentBranch = await getCurrentBranch()
      const results: ExperimentResult[] = []
      const limit = Math.min(recommendations.length, config.maxExperiments)

      log(`[experimenter] Starting experiment cycle: ${limit} of ${recommendations.length} recommendations`)
      log(`[experimenter] Current branch: ${currentBranch} (worktrees will not affect this)`)

      for (let i = 0; i < limit; i++) {
        const rec = recommendations[i]!
        log(`[experimenter] Experiment ${i + 1}/${limit}: ${rec.type} for ${rec.story_key}/${rec.phase}`)

        // Run sequentially — never in parallel (AC6)
        // Each experiment runs in its own isolated worktree — main working tree unaffected
        const result = await runOneExperiment(db, rec, baselineRunId)
        results.push(result)
      }

      log(`[experimenter] Experiment cycle complete: ${results.filter(r => r.verdict === 'IMPROVED').length} improved, ${results.filter(r => r.verdict === 'MIXED').length} mixed, ${results.filter(r => r.verdict === 'REGRESSED').length} regressed`)

      return results
    },
  }
}
