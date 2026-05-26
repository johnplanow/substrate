#!/usr/bin/env node
/**
 * harness.mjs — Single-phase reconstruction harness (Story 77-8).
 *
 * Given a reconstruction-corpus triple (from Story 77-6's census), reconstruct
 * the producing phase: check out the corpus repo at the commit's PARENT SHA in
 * an isolated worktree, re-dispatch ONLY the producing phase via a single
 * `dispatcher.dispatch()` (panel decision A — bare dispatch, no orchestrator
 * lifecycle, no review loop), capture the reconstructed artifact set, and tear
 * the checkout down. Story 77-9 grades the captured output against the actual
 * commit.
 *
 * Design (bmad-party-mode panel 2026-05-25):
 *   - Capability-tier, scheduled — NEVER an every-ship gate.
 *   - Surgical signal: measures the ONE producing phase, not the surrounding
 *     pipeline, so the cost is bounded and the result is attributable.
 *   - Cost ceiling: one dispatch per case, guarded by a per-case budget. A case
 *     whose measured cost exceeds the cap is recorded `budget-exceeded` and NOT
 *     graded — the harness never silently overspends (AC3).
 *   - Failure-tolerant: a dispatch error (or bad triple) on one case is recorded
 *     and skipped; it never aborts the run (AC5).
 *
 * The corpus is forward-thin today (Story 77-6: 0 clean pairs — F-commitsha only
 * persists the auto-commit SHA going forward), so this harness has nothing real
 * to reconstruct yet. Its wiring is validated by unit tests against SYNTHETIC
 * corpus fixtures (scripts/eval-reconstruction/__tests__/harness.test.ts); it
 * activates against real pairs as post-v0.20.118 auto-commits accumulate.
 *
 * I/O (git worktree, dispatch, fs capture) is injected via `deps` so the
 * orchestration is unit-testable without a real repo or LLM. Production callers
 * pass none and get the real implementations.
 *
 * Usage:
 *   node scripts/eval-reconstruction/harness.mjs \
 *     --corpus _bmad-output/eval-results/corpus/reconstruction-corpus.yaml \
 *     [--budget-per-case-usd 0.50] \
 *     [--output _bmad-output/eval-results/reconstruction-<date>.json]
 *
 * Exits non-zero only on a usage error (missing/unreadable corpus). A run with
 * 0 reconstructable cases exits 0 — an empty corpus is a valid (forward-thin) state.
 */

import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import yaml from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')

const DEFAULT_CORPUS_PATH = join(
  repoRoot,
  '_bmad-output',
  'eval-results',
  'corpus',
  'reconstruction-corpus.yaml',
)

// Default per-case budget: one phase dispatch should be cheap. Conservative cap.
export const DEFAULT_BUDGET_PER_CASE_USD = 0.5

// Recognized producing phases (the census records dev-story; create-story and
// code-review are admissible for completeness). Each maps to a dispatch taskType.
export const RECONSTRUCTABLE_PHASES = new Set(['create-story', 'dev-story', 'code-review'])

// Per-case outcome statuses.
export const CASE_RECONSTRUCTED = 'reconstructed'
export const CASE_SKIPPED = 'skipped'
export const CASE_BUDGET_EXCEEDED = 'budget-exceeded'
export const CASE_DISPATCH_ERROR = 'dispatch-error'

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse + shallow-validate a reconstruction corpus YAML document.
 * @returns {{ corpus_version: number, corpus_ceiling: number, cases: object[] }}
 * @throws if the document is not an object or `cases` is not an array.
 */
export function parseReconstructionCorpus(yamlContent) {
  const doc = yaml.load(yamlContent)
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('reconstruction corpus must be a YAML mapping')
  }
  if (!Array.isArray(doc.cases)) {
    throw new Error('reconstruction corpus must have a `cases:` list (got ' + typeof doc.cases + ')')
  }
  return {
    corpus_version: doc.corpus_version ?? 1,
    corpus_ceiling: doc.corpus_ceiling ?? doc.cases.length,
    cases: doc.cases,
  }
}

/**
 * Validate a single corpus triple for reconstructability.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateTriple(triple) {
  if (triple === null || typeof triple !== 'object') {
    return { ok: false, reason: 'triple is not an object' }
  }
  for (const field of ['repo', 'story_key', 'phase', 'commit_sha', 'parent_sha']) {
    if (typeof triple[field] !== 'string' || triple[field].length === 0) {
      return { ok: false, reason: `missing required field: ${field}` }
    }
  }
  if (!RECONSTRUCTABLE_PHASES.has(triple.phase)) {
    return { ok: false, reason: `unsupported phase: ${triple.phase}` }
  }
  // create-story / dev-story reconstruction needs the original story-file input.
  if ((triple.phase === 'dev-story' || triple.phase === 'code-review') && !triple.story_file) {
    return { ok: false, reason: `phase ${triple.phase} requires story_file input` }
  }
  return { ok: true }
}

/**
 * Partition corpus cases into reconstructable vs skipped (with reasons).
 * @returns {{ reconstructable: object[], skipped: Array<{ story_key: string, reason: string }> }}
 */
export function selectReconstructableCases(corpus) {
  const reconstructable = []
  const skipped = []
  for (const triple of corpus.cases) {
    const v = validateTriple(triple)
    if (v.ok) reconstructable.push(triple)
    else skipped.push({ story_key: triple?.story_key ?? '<unknown>', reason: v.reason })
  }
  return { reconstructable, skipped }
}

/**
 * Build the bare-dispatch request for a producing phase (panel decision A).
 * `storyContent` is the original story-file text recovered at the parent SHA;
 * it is the phase's primary input. `workingDirectory` is the isolated checkout.
 * @returns {{ taskType: string, storyKey: string, prompt: string, workingDirectory: string, timeout: number }}
 */
export function buildPhaseDispatch(triple, storyContent, checkoutDir, opts = {}) {
  const timeout = opts.timeout ?? 1_800_000 // 30 min — one phase, generous ceiling
  return {
    taskType: triple.phase,
    storyKey: triple.story_key,
    prompt: storyContent ?? '',
    workingDirectory: checkoutDir,
    timeout,
  }
}

/**
 * Estimate the USD cost of a dispatch result from its token estimate. A coarse
 * blended rate is fine — the budget cap is a runaway guard, not an invoice.
 * Overridable via opts.ratePerMTokUsd for tests / pricing changes.
 */
export function estimateCostUsd(result, opts = {}) {
  const rate = opts.ratePerMTokUsd ?? 9 // ~$9 / 1M blended tokens, conservative
  const tok = result?.tokenEstimate ?? {}
  const total = (tok.input ?? 0) + (tok.output ?? 0)
  return (total / 1_000_000) * rate
}

/**
 * Decide whether a measured cost is within the per-case budget.
 * @returns {{ within: boolean }}
 */
export function enforceBudget(costUsd, budgetUsd) {
  return { within: costUsd <= budgetUsd }
}

// ---------------------------------------------------------------------------
// Default I/O implementations (injectable; not unit-tested directly)
// ---------------------------------------------------------------------------

function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

/**
 * Check out `parentSha` in an isolated git worktree (never mutates the corpus
 * repo's working tree — AC1). Returns the worktree path.
 */
function defaultCheckoutParent(repo, parentSha, storyKey) {
  const wtDir = join(repo, '.substrate-worktrees', `reconstruct-${storyKey}-${Date.now()}`)
  git(repo, ['worktree', 'add', '--detach', wtDir, parentSha])
  return wtDir
}

/** Read the original story-file input at the checkout, if present. */
function defaultReadStoryFile(checkoutDir, storyFile) {
  if (!storyFile) return null
  const p = join(checkoutDir, storyFile)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

/**
 * Capture the set of files the reconstruction wrote/changed in the checkout,
 * relative to the parent SHA (the reconstructed artifact set — AC4).
 */
function defaultCaptureArtifacts(checkoutDir) {
  const out = git(checkoutDir, ['status', '--porcelain'])
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\S+\s+/, '')) // strip the porcelain status code
}

/** Remove the isolated worktree (AC4 cleanup). Best-effort — never throws. */
function defaultCleanup(repo, checkoutDir) {
  try {
    git(repo, ['worktree', 'remove', '--force', checkoutDir])
  } catch {
    try {
      rmSync(checkoutDir, { recursive: true, force: true })
    } catch {
      /* leave it for the operator; never abort the run on cleanup failure */
    }
  }
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct one corpus triple. Failure-tolerant: any error is captured as a
 * `dispatch-error` outcome rather than thrown (AC5). Always tears the checkout
 * down (AC4), even on error.
 *
 * @param {object} triple   a corpus case
 * @param {object} deps     injectable I/O: { dispatch, checkoutParent, readStoryFile, captureArtifacts, cleanup, costFn }
 * @param {object} opts     { budgetPerCaseUsd, timeout }
 * @returns {Promise<object>} per-case reconstruction record
 */
export async function reconstructCase(triple, deps, opts = {}) {
  const budgetPerCaseUsd = opts.budgetPerCaseUsd ?? DEFAULT_BUDGET_PER_CASE_USD
  const {
    dispatch,
    checkoutParent = (repo, sha, key) => defaultCheckoutParent(repo, sha, key),
    readStoryFile = defaultReadStoryFile,
    captureArtifacts = defaultCaptureArtifacts,
    cleanup = (repo, dir) => defaultCleanup(repo, dir),
    costFn = estimateCostUsd,
  } = deps

  const valid = validateTriple(triple)
  if (!valid.ok) {
    return { story_key: triple?.story_key ?? '<unknown>', status: CASE_SKIPPED, reason: valid.reason }
  }

  let checkoutDir = null
  try {
    checkoutDir = await checkoutParent(triple.repo, triple.parent_sha, triple.story_key)
    const storyContent = await readStoryFile(checkoutDir, triple.story_file)
    const request = buildPhaseDispatch(triple, storyContent, checkoutDir, opts)

    const result = await dispatch(request)
    const costUsd = costFn(result, opts)

    if (result?.status === 'failed' || result?.status === 'timeout') {
      return {
        story_key: triple.story_key,
        phase: triple.phase,
        status: CASE_DISPATCH_ERROR,
        reason: `dispatch ${result.status}`,
        cost_usd: costUsd,
      }
    }

    const { within } = enforceBudget(costUsd, budgetPerCaseUsd)
    if (!within) {
      return {
        story_key: triple.story_key,
        phase: triple.phase,
        status: CASE_BUDGET_EXCEEDED,
        cost_usd: costUsd,
        budget_usd: budgetPerCaseUsd,
      }
    }

    const reconstructedFiles = await captureArtifacts(checkoutDir)
    return {
      story_key: triple.story_key,
      phase: triple.phase,
      commit_sha: triple.commit_sha,
      parent_sha: triple.parent_sha,
      status: CASE_RECONSTRUCTED,
      reconstructed_files: reconstructedFiles,
      cost_usd: costUsd,
    }
  } catch (err) {
    return {
      story_key: triple.story_key,
      phase: triple.phase,
      status: CASE_DISPATCH_ERROR,
      reason: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (checkoutDir !== null) {
      await cleanup(triple.repo, checkoutDir)
    }
  }
}

/**
 * Run the harness over an entire corpus. Sequential by design — bounds
 * concurrent dispatch cost and keeps worktree churn serial.
 * @returns {Promise<{ reconstructions: object[], summary: object }>}
 */
export async function runHarness(corpus, deps, opts = {}) {
  const { reconstructable, skipped } = selectReconstructableCases(corpus)
  const reconstructions = []

  // Record up-front skips (bad triples) so the report is complete.
  for (const s of skipped) {
    reconstructions.push({ story_key: s.story_key, status: CASE_SKIPPED, reason: s.reason })
  }

  for (const triple of reconstructable) {
    reconstructions.push(await reconstructCase(triple, deps, opts))
  }

  const summary = {
    total: corpus.cases.length,
    reconstructed: reconstructions.filter((r) => r.status === CASE_RECONSTRUCTED).length,
    skipped: reconstructions.filter((r) => r.status === CASE_SKIPPED).length,
    budget_exceeded: reconstructions.filter((r) => r.status === CASE_BUDGET_EXCEEDED).length,
    dispatch_error: reconstructions.filter((r) => r.status === CASE_DISPATCH_ERROR).length,
  }
  return { reconstructions, summary }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { corpus: null, output: null, budgetPerCaseUsd: DEFAULT_BUDGET_PER_CASE_USD }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--corpus') args.corpus = argv[++i]
    else if (a === '--output') args.output = argv[++i]
    else if (a === '--budget-per-case-usd') args.budgetPerCaseUsd = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return args
}

function printHelp() {
  process.stdout.write(`harness.mjs — single-phase reconstruction harness (Story 77-8)

Usage: node scripts/eval-reconstruction/harness.mjs --corpus PATH [--budget-per-case-usd N] [--output PATH]

  --corpus               Reconstruction corpus YAML (default: the canonical reconstruction-corpus.yaml).
  --budget-per-case-usd  Per-case cost ceiling (default: ${DEFAULT_BUDGET_PER_CASE_USD}).
  --output               Reconstruction-results JSON path (default: _bmad-output/eval-results/reconstruction-<date>.json).

Capability-tier — informational, scheduled. NEVER an every-ship gate.
`)
}

async function main() {
  const args = parseArgs(process.argv)
  const corpusPath = args.corpus ? resolve(args.corpus) : DEFAULT_CORPUS_PATH

  if (!existsSync(corpusPath)) {
    process.stderr.write(`[reconstruction-harness] ERROR: corpus not found: ${corpusPath}\n`)
    process.exit(1)
  }

  let corpus
  try {
    corpus = parseReconstructionCorpus(readFileSync(corpusPath, 'utf8'))
  } catch (err) {
    process.stderr.write(`[reconstruction-harness] ERROR: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }

  const { reconstructable } = selectReconstructableCases(corpus)
  if (reconstructable.length === 0) {
    process.stdout.write(
      `[reconstruction-harness] corpus ceiling=${corpus.corpus_ceiling}; 0 reconstructable cases (forward-thin corpus). Nothing to dispatch.\n`,
    )
    process.exit(0)
  }

  // PRODUCTION DISPATCH WIRING IS DEFERRED (Story 77-8) — and we reach this
  // branch ONLY when there are real reconstructable cases, so fail loudly and
  // explicitly rather than crash on a missing export or emit a meaningless
  // report. The harness orchestration (selectReconstructableCases /
  // reconstructCase / runHarness) and the Story 77-9 grader are COMPLETE and
  // unit-tested with injected I/O; what is not yet built is the production
  // `dispatch` dep for a REAL reconstruction, which needs two things this CLI
  // does not assemble:
  //   1. A real Dispatcher. `createDispatcher` is exported from
  //      '@substrate-ai/core' (and src/modules/agent-dispatch/index.ts) — NOT
  //      from the top-level dist/index.js — together with its
  //      CreateDispatcherOptions (adapter, methodology pack, context compiler,
  //      token ceilings).
  //   2. Faithful phase-prompt assembly at the parent SHA. Panel decision A's
  //      "bare dispatch with original inputs" is more than the raw story file:
  //      it is the compiled create-story / dev-story prompt plus context.
  // Both are intentionally deferred until the corpus has real pairs (forward-
  // thin today — Story 77-6). To enable: build `deps.dispatch` from a real
  // dispatcher + phase-prompt assembly and call `runHarness(corpus, deps, ...)`.
  process.stderr.write(
    `[reconstruction-harness] ${reconstructable.length} reconstructable case(s) found, but production dispatch ` +
      `wiring is not implemented yet (deferred until the corpus has real pairs — Story 77-8). ` +
      `Wire a real dispatcher (createDispatcher from @substrate-ai/core) + faithful phase-prompt assembly into ` +
      `runHarness's deps.dispatch. See the comment in main().\n`,
  )
  process.exit(3)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
