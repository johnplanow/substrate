/**
 * Experimenter — automated experimentation engine for the pipeline supervisor.
 * Migrated to @substrate-ai/core (Story 41-7)
 *
 * Implements the experiment state machine:
 *   SELECTING → BRANCHING → MODIFYING → RUNNING → COMPARING → REPORTING
 *
 * Architecture:
 *   - spawnGit is NOT imported — git dependency is caller-supplied via ExperimenterDeps
 *   - story 41-8 will supply a concrete git spawn implementation
 *   - All persistence imports use core-relative paths
 */

import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn as nodeSpawn } from 'node:child_process'
import { getRunMetrics, getStoryMetricsForRun } from '../persistence/queries/metrics.js'
import type { RunMetricsRow, StoryMetricsRow } from '../persistence/queries/metrics.js'
import { createDecision } from '../persistence/queries/decisions.js'
import { EXPERIMENT_RESULT } from '../persistence/schemas/operational.js'
import type { DatabaseAdapter } from '../persistence/types.js'
import type { RecommendationType } from './analysis.js'

// ---------------------------------------------------------------------------
// Local spawn result / options types
// (replaces git-utils.GitSpawnResult and SpawnOptions which are not yet in core)
// ---------------------------------------------------------------------------

interface SpawnResult {
  stdout: string
  stderr: string
  code: number
}

interface LocalSpawnOptions {
  cwd?: string
  env?: Record<string, string | undefined>
}

// ---------------------------------------------------------------------------
// Generic spawn helper (for gh CLI)
// ---------------------------------------------------------------------------

/**
 * Injectable function type for spawning arbitrary processes (e.g., `gh pr create`).
 */
export type SpawnFn = (cmd: string, args: string[], opts?: LocalSpawnOptions) => Promise<SpawnResult>

/**
 * Default spawn implementation used when no `spawn` dep is injected.
 */
function spawnCommand(cmd: string, args: string[], opts?: LocalSpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const proc = nodeSpawn(cmd, args, {
      cwd: opts?.cwd,
      env: (opts?.env as NodeJS.ProcessEnv | undefined) ?? process.env,
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
// Recommendation types (output of analysis engine)
// ---------------------------------------------------------------------------

// RecommendationType is imported from ./analysis.js to avoid duplication.

/**
 * A machine-readable recommendation produced by the supervisor analysis engine.
 */
export interface SupervisorRecommendation {
  /** Category of finding */
  type: RecommendationType

  /** The story key that exhibited the regression or bottleneck */
  story_key: string

  /**
   * The phase where the issue occurred.
   */
  phase: string

  /** Human-readable description of the finding */
  description: string

  /**
   * Short slug used in branch naming (safe chars: [a-z0-9-] only, max 40 chars).
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

export type ExperimentPhase =
  | 'SELECTING'
  | 'BRANCHING'
  | 'MODIFYING'
  | 'RUNNING'
  | 'COMPARING'
  | 'REPORTING'

export type ExperimentVerdict = 'IMPROVED' | 'MIXED' | 'REGRESSED'

export interface ExperimentMetricDeltas {
  tokens_pct: number | null
  cost_pct: number | null
  review_cycles_pct: number | null
  wall_clock_pct: number | null
}

export interface ExperimentResult {
  recommendation: SupervisorRecommendation
  branchName: string
  baselineRunId: string
  experimentRunId: string | null
  verdict: ExperimentVerdict
  deltas: ExperimentMetricDeltas
  currentPhase: ExperimentPhase
  error?: string
  prLink?: string | null
}

export interface ExperimentConfig {
  projectRoot: string
  pack: string
  maxExperiments: number
  tokenBudgetMultiplier: number
}

export interface ExperimentRunOptions {
  stories: string
  projectRoot: string
  pack: string
}

export type RunStoryFn = (opts: ExperimentRunOptions) => Promise<{ runId: string; exitCode: number }>

/**
 * Injectable dependencies for the Experimenter.
 * git must be provided by the caller (spawnGit is not yet in core).
 */
export interface ExperimenterDeps {
  /** Git spawn function — caller-supplied (story 41-8 will provide a concrete impl) */
  git: (args: string[], opts?: LocalSpawnOptions) => Promise<SpawnResult>
  spawn: SpawnFn
  runStory: RunStoryFn
  getRunMetrics: (db: DatabaseAdapter, runId: string) => Promise<RunMetricsRow | undefined>
  getStoryMetrics: (db: DatabaseAdapter, runId: string) => Promise<StoryMetricsRow[]>
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  mkdir: (path: string, opts?: { recursive: boolean }) => Promise<void>
  log: (msg: string) => void
}

export interface Experimenter {
  runExperiments(
    db: DatabaseAdapter,
    recommendations: SupervisorRecommendation[],
    baselineRunId: string,
  ): Promise<ExperimentResult[]>
}

// ---------------------------------------------------------------------------
// Branch name construction
// ---------------------------------------------------------------------------

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

const PHASE_TO_PROMPT_FILE: Record<string, string> = {
  'create-story': 'create-story.md',
  'dev-story': 'dev-story.md',
  'code-review': 'code-review.md',
  'fix': 'fix-story.md',
}

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

export function resolvePromptFile(
  rec: SupervisorRecommendation,
  projectRoot: string,
  pack: string,
): string {
  const filename = PHASE_TO_PROMPT_FILE[rec.phase] ?? `${rec.phase}.md`
  return join(projectRoot, 'packs', pack, 'prompts', filename)
}

// ---------------------------------------------------------------------------
// Verdict determination
// ---------------------------------------------------------------------------

const REGRESSION_THRESHOLD_PCT = 20

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
// PR body and audit log builders
// ---------------------------------------------------------------------------

function fmtPct(pct: number | null): string {
  if (pct === null) return 'N/A'
  return `${pct > 0 ? '+' : ''}${pct}%`
}

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

export function createExperimenter(
  config: ExperimentConfig,
  deps?: Partial<ExperimenterDeps>,
): Experimenter {
  const resolvedDeps: ExperimenterDeps = {
    // git must be provided by caller; spawnGit is not in core (migrates in story 41-8)
    git: deps?.git ?? (() => { throw new Error('git dependency must be provided to createExperimenter (spawnGit is not available in @substrate-ai/core)') }),
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

  async function createWorktree(worktreePath: string, branchName: string): Promise<void> {
    const result = await git(['worktree', 'add', worktreePath, '-b', branchName], { cwd: config.projectRoot })
    if (result.code !== 0) {
      throw new Error(`Failed to create worktree ${worktreePath}: ${result.stderr}`)
    }
  }

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

  async function deleteBranch(branchName: string): Promise<void> {
    const result = await git(['branch', '-D', branchName], { cwd: config.projectRoot })
    if (result.code !== 0) {
      log(`[experimenter] Warning: could not delete branch ${branchName}: ${result.stderr}`)
    } else {
      log(`[experimenter] Deleted REGRESSED experiment branch: ${branchName}`)
    }
  }

  // ---------------------------------------------------------------------------
  // PR creation via gh CLI
  // ---------------------------------------------------------------------------

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
  // Audit trail
  // ---------------------------------------------------------------------------

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
  // Token budget check
  // ---------------------------------------------------------------------------

  async function isWithinTokenBudget(
    db: DatabaseAdapter,
    storyKey: string,
    baselineRunId: string,
    experimentRunId: string,
  ): Promise<boolean> {
    try {
      const baselineStories = await getStory(db, baselineRunId)
      const experimentStories = await getStory(db, experimentRunId)

      const baselineStory = baselineStories.find((m) => m.story_key === storyKey)
      const experimentStory = experimentStories.find((m) => m.story_key === storyKey)

      if (!baselineStory || !experimentStory) return true

      const baselineTokens = (baselineStory.input_tokens ?? 0) + (baselineStory.output_tokens ?? 0)
      const experimentTokens = (experimentStory.input_tokens ?? 0) + (experimentStory.output_tokens ?? 0)

      if (baselineTokens === 0) return true

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
      return true
    }
  }

  // ---------------------------------------------------------------------------
  // Single experiment execution
  // ---------------------------------------------------------------------------

  async function runOneExperiment(
    db: DatabaseAdapter,
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
      currentPhase = 'BRANCHING'
      log(`[experimenter] Creating worktree: ${worktreePath} on branch ${branchName}`)
      await createWorktree(worktreePath, branchName)
      worktreeCreated = true

      currentPhase = 'MODIFYING'
      const promptFile = resolvePromptFile(rec, worktreePath, config.pack)
      const directive = buildModificationDirective(rec)
      const originalContent = await rf(promptFile)
      await wf(promptFile, originalContent + directive)
      await commitModification(rec, promptFile, worktreePath)
      log(`[experimenter] Applied modification to ${promptFile}`)

      currentPhase = 'RUNNING'
      log(`[experimenter] Running single-story experiment for ${rec.story_key}`)
      const { runId, exitCode } = await runStory({
        stories: rec.story_key,
        projectRoot: worktreePath,
        pack: config.pack,
      })
      experimentRunId = runId
      log(`[experimenter] Experiment run completed: ${runId} (exit: ${exitCode})`)

      currentPhase = 'COMPARING'
      const baselineMetrics = await getRun(db, baselineRunId)
      const experimentMetrics = await getRun(db, runId)

      if (!baselineMetrics || !experimentMetrics) {
        log(`[experimenter] Warning: metrics unavailable for comparison`)
        verdict = 'REGRESSED'
        caughtError = 'Could not retrieve metrics for comparison'
      } else {
        deltas = computeDeltas(baselineMetrics, experimentMetrics)

        const withinBudget = await isWithinTokenBudget(db, rec.story_key, baselineRunId, runId)
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
      if (worktreeCreated) {
        try {
          await removeWorktree(worktreePath)
        } catch {
          log(`[experimenter] Warning: could not remove worktree ${worktreePath}`)
        }
      }
    }

    let prLink: string | null = null

    if (verdict === 'REGRESSED' && worktreeCreated) {
      await deleteBranch(branchName)
    } else if (verdict === 'IMPROVED' || verdict === 'MIXED') {
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

    // Persist experiment result to decision store
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

      await createDecision(db, {
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
      db: DatabaseAdapter,
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

        const result = await runOneExperiment(db, rec, baselineRunId)
        results.push(result)
      }

      log(`[experimenter] Experiment cycle complete: ${results.filter(r => r.verdict === 'IMPROVED').length} improved, ${results.filter(r => r.verdict === 'MIXED').length} mixed, ${results.filter(r => r.verdict === 'REGRESSED').length} regressed`)

      return results
    },
  }
}
