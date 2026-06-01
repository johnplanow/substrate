#!/usr/bin/env node
/**
 * harness.mjs — Pack-upgrade A/B harness (Story 81-2).
 *
 * Takes a corpus pair (parent SHA + story-file input), spawns two isolated
 * worktrees at the parent SHA, dispatches the same story under both
 * --pack-current and --pack-candidate, and captures the full dispatch envelope
 * from each — producing side-by-side results for Epic 81's grader (81-3) and
 * CLI (81-4).
 *
 * Design notes:
 *   - Reuses estimateCostUsd + enforceBudget from scripts/eval-reconstruction/harness.mjs (AC2).
 *   - Per-case budget cap ($2.00 default): a dispatch whose estimated cost exceeds
 *     the cap records dispatch_outcome='budget-exceeded' and the partial envelope is
 *     written — never silently overspends (AC5).
 *   - Failure-tolerant per pair: a dispatch error on one side is recorded as
 *     dispatch_outcome='error'; the run continues (AC6). Only fatal usage errors
 *     (invalid CLI args, unloadable pack, missing corpus) abort.
 *   - A/B is SEQUENTIAL by design (not parallel) — bounds cost and keeps
 *     worktree churn serial (AC3).
 *   - I/O (checkoutParent, dispatch, readStoryFile, captureEnvelope, cleanup, costFn)
 *     is injected via deps for unit testability without a real repo or LLM (AC8).
 *
 * Pack-override contract (AC3 dev notes):
 *   Pack selection passes pack.path to deps.dispatch(request, packPath).
 *   Production deps would call createPackLoader().load(packPath) inside the
 *   dispatch wrapper — NEVER mutating packs/bmad/ in-place. Production dispatch
 *   wiring is deferred (same as reconstruction harness Story 77-8) until the
 *   corpus has entries with parent_sha + story_file_input_path populated.
 *
 * Reconstruction harness primitives reused by import (AC2):
 *   estimateCostUsd, enforceBudget, defaultCheckoutParent, defaultCleanup are
 *   imported by name — NOT copy-pasted. defaultCheckoutParent gained an additive
 *   optional `prefix` parameter so the pack-upgrade harness can stamp its own
 *   worktree directories ('pack-upgrade') without forking the function. The dispatch
 *   dep signature is extended to accept (request, packPath) as a second parameter —
 *   an additive change backward-compatible with the reconstruction harness.
 *   [Story 81-2 additive extension — 2026-05-31]
 *
 * Usage:
 *   node scripts/eval-pack-upgrade/harness.mjs \
 *     --pack-current PATH --pack-candidate PATH \
 *     [--corpus PATH] [--budget-per-case-usd N] [--output PATH]
 *
 * Exit codes:
 *   0 — completed (even with per-pair errors; outputs the pair JSON)
 *   1 — fatal usage error (bad CLI args, missing corpus, unloadable pack)
 *   2 — internal harness exception
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import yaml from 'js-yaml'

// Reuse reconstruction harness primitives by name (AC2).
// checkoutParent and defaultCleanup are imported — not copy-pasted — per AC2.
// defaultCheckoutParent gained an additive `prefix` parameter (Story 81-2, backward-compatible).
// [Story 81-2: additive imports — 2026-05-31]
import {
  estimateCostUsd,
  enforceBudget,
  defaultCheckoutParent as reconstructionCheckoutParent,
  defaultCleanup as reconstructionCleanup,
} from '../eval-reconstruction/harness.mjs'
import {
  parseOutcomesCorpusForPackUpgrade,
  classifyPairOutcome,
  normalizeDispatchEnvelope,
} from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')

/** Default corpus path: Epic 77 outcomes corpus (AC1). */
export const DEFAULT_CORPUS_PATH = join(
  repoRoot,
  '_bmad-output',
  'eval-results',
  'corpus',
  'outcomes-corpus.yaml',
)

/** Default per-dispatch budget cap in USD (AC1, AC5). */
export const DEFAULT_BUDGET_PER_CASE_USD = 2.0

// ---------------------------------------------------------------------------
// Pack validation
// ---------------------------------------------------------------------------

/**
 * Validate that a pack path is loadable (manifest.yaml present + valid YAML).
 * Mimics the essential checks of createPackLoader().load() for CLI validation.
 * The full schema validation (PackManifestSchema) is deferred to dispatch time
 * when production deps wire createPackLoader.
 *
 * @param {string} packPath — absolute path to the pack directory
 * @throws if the path is missing, manifest.yaml is absent, or YAML is invalid
 */
export async function validatePackPath(packPath) {
  if (!existsSync(packPath)) {
    throw new Error(`Pack directory not found: "${packPath}"`)
  }
  const manifestPath = join(packPath, 'manifest.yaml')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Cannot load methodology pack at "${packPath}": manifest.yaml not found or unreadable.`,
    )
  }
  let raw
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch (err) {
    throw new Error(
      `Cannot load methodology pack at "${packPath}": manifest.yaml not found or unreadable. ${err.message ?? err}`,
    )
  }
  try {
    yaml.load(raw)
  } catch (err) {
    throw new Error(
      `Cannot load methodology pack at "${packPath}": manifest.yaml contains invalid YAML. ${err.message ?? err}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Default I/O implementations (injectable; not unit-tested directly)
// ---------------------------------------------------------------------------

// git() helper is used only by defaultCaptureEnvelope and defaultReadStoryFile below.
function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

// checkoutParent and cleanup are imported from the reconstruction harness (AC2).
// The pack-upgrade prefix is passed via the additive `prefix` parameter added
// to defaultCheckoutParent in eval-reconstruction/harness.mjs (Story 81-2).
/** @type {(repo: string, sha: string, key: string) => string} */
const defaultCheckoutParent = (repo, sha, key) =>
  reconstructionCheckoutParent(repo, sha, key, 'pack-upgrade')

/** @type {(repo: string, dir: string) => void} */
const defaultCleanup = reconstructionCleanup

/**
 * Read the original story-file input.
 * Prefers the manifest-captured sidecar at story_file_input_path (obs_027).
 * [Mirrors defaultReadStoryFile pattern from reconstruction harness — AC2]
 */
function defaultReadStoryFile(checkoutDir, caseEntry) {
  const p = caseEntry.story_file_input_path
  if (p && existsSync(p)) {
    return readFileSync(p, 'utf8')
  }
  return null
}

/**
 * Capture the dispatch result as an AC4 envelope.
 * Gets the working-tree diff via git status; normalizes via lib.mjs.
 */
function defaultCaptureEnvelope(dispatchResult, checkoutDir, packIdentifier, packPath, opts = {}) {
  let diff = null
  try {
    const out = git(checkoutDir, ['status', '--porcelain'])
    diff = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^\S+\s+/, ''))
  } catch {
    diff = null
  }
  return normalizeDispatchEnvelope(dispatchResult, packIdentifier, packPath, {
    ...opts,
    diff,
  })
}

// ---------------------------------------------------------------------------
// Per-side dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch one corpus case under a specific pack.
 *
 * Failure-tolerant: any error returns an error envelope; worktree is always
 * cleaned up via finally (AC4 always-cleanup pattern — mirrors reconstructCase).
 *
 * Pack override: deps.dispatch(request, packPath) receives the pack path as
 * a second argument — additive extension of the reconstruction harness's
 * dispatch dep interface. [Story 81-2 — 2026-05-31]
 *
 * @param {object} caseEntry — { case_id, parent_sha, story_key, story_file_input_path }
 * @param {{ path: string, identifier: 'current'|'candidate' }} pack
 * @param {object} deps — { checkoutParent, dispatch, readStoryFile, captureEnvelope, cleanup, costFn }
 * @param {object} [opts={}] — { budgetPerCaseUsd }
 * @returns {Promise<object>} AC4 envelope
 */
export async function dispatchOnePackForCase(caseEntry, pack, deps, opts = {}) {
  const budgetPerCaseUsd = opts.budgetPerCaseUsd ?? DEFAULT_BUDGET_PER_CASE_USD
  const {
    checkoutParent = (rp, sha, key) => defaultCheckoutParent(rp, sha, key),
    readStoryFile = defaultReadStoryFile,
    dispatch,
    captureEnvelope = defaultCaptureEnvelope,
    cleanup = (rp, dir) => defaultCleanup(rp, dir),
    costFn = estimateCostUsd,
  } = deps

  let checkoutDir = null
  const startMs = Date.now()

  try {
    checkoutDir = await checkoutParent(repoRoot, caseEntry.parent_sha, caseEntry.story_key)
    const storyContent = await readStoryFile(checkoutDir, caseEntry)

    const request = {
      taskType: 'dev-story',
      storyKey: caseEntry.story_key,
      prompt: storyContent ?? '',
      workingDirectory: checkoutDir,
    }

    // Pack path passed as second arg — additive extension of reconstruction harness dispatch dep.
    const result = await dispatch(request, pack.path)
    const durationMs = Date.now() - startMs
    const costUsd = costFn(result)

    // AC5 note: budget enforcement is POST-dispatch, not mid-dispatch. The
    // infrastructure (enforceBudget from reconstruction harness) applies the
    // ceiling after the result arrives — there is no in-flight abort mechanism.
    // The "never silently overspends" invariant IS met: a budget-exceeded
    // envelope is recorded and captureEnvelope is skipped. The gap between
    // AC5's literal "aborted mid-dispatch" and the post-dispatch check is an
    // accepted deviation, infrastructure-constrained (same as reconstruction
    // harness). Acknowledged in the 81-2 code-review record.
    const { within } = enforceBudget(costUsd, budgetPerCaseUsd)
    if (!within) {
      // Budget exceeded: record partial envelope, skip captureEnvelope (AC5).
      return normalizeDispatchEnvelope(result, pack.identifier, pack.path, {
        costUsd,
        durationMs,
        budgetExceeded: true,
      })
    }

    return await captureEnvelope(result, checkoutDir, pack.identifier, pack.path, {
      costUsd,
      durationMs,
    })
  } catch (err) {
    const durationMs = Date.now() - startMs
    return normalizeDispatchEnvelope(null, pack.identifier, pack.path, {
      errorDetail: err instanceof Error ? err.message : String(err),
      durationMs,
    })
  } finally {
    // Always tear down the worktree (AC3 always-cleanup-via-finally).
    if (checkoutDir !== null) {
      await cleanup(repoRoot, checkoutDir)
    }
  }
}

// ---------------------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the pack-upgrade A/B harness over a parsed corpus.
 *
 * Sequential by design — A then B per pair, pairs in order. No parallelism.
 * Failure-tolerant: dispatch errors on one side or one pair do not abort the
 * run (AC6). Only fatal usage errors abort.
 *
 * @param {object} options
 * @param {{ cases: object[], skipped: object[] }} options.corpus — from parseOutcomesCorpusForPackUpgrade
 * @param {string} options.packCurrent — absolute path to the current pack directory
 * @param {string} options.packCandidate — absolute path to the candidate pack directory
 * @param {object} options.deps — injectable I/O (AC8): { checkoutParent, dispatch, readStoryFile, captureEnvelope, cleanup, costFn }
 * @param {number} [options.budgetPerCaseUsd=DEFAULT_BUDGET_PER_CASE_USD] — per-dispatch USD cap
 * @returns {Promise<object[]>} array of pair records (AC7 shape)
 */
export async function runPackUpgradeHarness({
  corpus,
  packCurrent,
  packCandidate,
  deps,
  budgetPerCaseUsd = DEFAULT_BUDGET_PER_CASE_USD,
}) {
  const results = []
  const dispatchOpts = { budgetPerCaseUsd }

  // Record skipped corpus entries (missing parent_sha / story_file_input_path)
  // as pair-skipped records so the output is complete (AC6, AC11).
  for (const s of corpus.skipped ?? []) {
    results.push({
      case_id: s.case_id,
      parent_sha: null,
      story_key: null,
      story_file_input_path: null,
      current: null,
      candidate: null,
      pair_outcome: 'pair-skipped',
    })
  }

  // Dispatch each case pair sequentially (A=current, then B=candidate).
  for (const caseEntry of corpus.cases ?? []) {
    const currentEnvelope = await dispatchOnePackForCase(
      caseEntry,
      { path: packCurrent, identifier: 'current' },
      deps,
      dispatchOpts,
    )
    const candidateEnvelope = await dispatchOnePackForCase(
      caseEntry,
      { path: packCandidate, identifier: 'candidate' },
      deps,
      dispatchOpts,
    )

    results.push({
      case_id: caseEntry.case_id,
      parent_sha: caseEntry.parent_sha,
      story_key: caseEntry.story_key,
      story_file_input_path: caseEntry.story_file_input_path,
      current: currentEnvelope,
      candidate: candidateEnvelope,
      pair_outcome: classifyPairOutcome(currentEnvelope, candidateEnvelope),
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    packCurrent: null,
    packCandidate: null,
    corpus: null,
    budgetPerCaseUsd: DEFAULT_BUDGET_PER_CASE_USD,
    output: null,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--pack-current') args.packCurrent = argv[++i]
    else if (a === '--pack-candidate') args.packCandidate = argv[++i]
    else if (a === '--corpus') args.corpus = argv[++i]
    else if (a === '--budget-per-case-usd') args.budgetPerCaseUsd = Number(argv[++i])
    else if (a === '--output') args.output = argv[++i]
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return args
}

function printHelp() {
  process.stdout.write(`harness.mjs — pack-upgrade A/B harness (Story 81-2)

Usage:
  node scripts/eval-pack-upgrade/harness.mjs \\
    --pack-current PATH --pack-candidate PATH \\
    [--corpus PATH] [--budget-per-case-usd N] [--output PATH]

Options:
  --pack-current        Absolute path to the current pack (must contain manifest.yaml).
  --pack-candidate      Absolute path to the candidate pack (must contain manifest.yaml).
  --corpus              Outcomes corpus YAML (default: _bmad-output/eval-results/corpus/outcomes-corpus.yaml).
  --budget-per-case-usd Per-dispatch cost ceiling in USD (default: ${DEFAULT_BUDGET_PER_CASE_USD}).
  --output              Output JSON path (default: _bmad-output/eval-results/pack-upgrade-harness-<ISO-date>.json).

Exit codes:
  0 — completed (even with per-pair errors)
  1 — fatal usage error (bad args, missing corpus, unloadable pack)
  2 — internal harness exception

Notes:
  - Production dispatch wiring is deferred (corpus currently lacks parent_sha
    and story_file_input_path). See comment in main() for wiring instructions.
  - Capability-tier — informational, scheduled. Never an every-ship gate.
`)
}

async function main() {
  const args = parseArgs(process.argv)

  // Validate required CLI args (AC1).
  if (!args.packCurrent || !args.packCandidate) {
    process.stderr.write(
      '[pack-upgrade-harness] ERROR: --pack-current and --pack-candidate are required\n',
    )
    process.exit(1)
  }

  const packCurrentPath = resolve(args.packCurrent)
  const packCandidatePath = resolve(args.packCandidate)

  // Validate pack paths — invalid pack → fatal exit (AC1).
  try {
    await validatePackPath(packCurrentPath)
  } catch (err) {
    process.stderr.write(
      `[pack-upgrade-harness] ERROR (--pack-current): ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(1)
  }
  try {
    await validatePackPath(packCandidatePath)
  } catch (err) {
    process.stderr.write(
      `[pack-upgrade-harness] ERROR (--pack-candidate): ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(1)
  }

  // Resolve + validate corpus path.
  const corpusPath = args.corpus ? resolve(args.corpus) : DEFAULT_CORPUS_PATH
  if (!existsSync(corpusPath)) {
    process.stderr.write(`[pack-upgrade-harness] ERROR: corpus not found: ${corpusPath}\n`)
    process.exit(1)
  }

  let corpus
  try {
    corpus = parseOutcomesCorpusForPackUpgrade(readFileSync(corpusPath, 'utf8'))
  } catch (err) {
    process.stderr.write(
      `[pack-upgrade-harness] ERROR: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(1)
  }

  process.stdout.write(
    `[pack-upgrade-harness] corpus: ${corpus.cases.length} dispatchable case(s), ` +
      `${corpus.skipped.length} skipped (missing parent_sha/story_file_input_path)\n`,
  )

  // PRODUCTION DISPATCH WIRING IS DEFERRED (Story 81-2): identical pattern to
  // the reconstruction harness (Story 77-8). Building the actual dispatch dep
  // requires wiring createDispatcher from @substrate-ai/core with a pack-path
  // override (createPackLoader().load(packPath) injected into the dispatcher's
  // methodology-pack slot). This is deferred until the corpus has entries with
  // parent_sha + story_file_input_path populated. Story 81-4's CLI will surface
  // this to operators once the corpus is ready.
  //
  // To wire for a real dispatch:
  //   1. Import createDispatcher from @substrate-ai/core (compiled dist)
  //   2. Build deps.dispatch = async (request, packPath) => {
  //        const pack = await createPackLoader().load(packPath)
  //        const dispatcher = createDispatcher({ pack, ... })
  //        return await dispatcher.dispatch(request)
  //      }
  //   3. Remove the throw below
  const deps = {
    checkoutParent: (rp, sha, key) => defaultCheckoutParent(rp, sha, key),
    readStoryFile: defaultReadStoryFile,
    dispatch: async () => {
      throw new Error(
        'Production dispatch wiring is not implemented yet (deferred — Story 81-2). ' +
          'Wire a real dispatcher with pack override into deps.dispatch. ' +
          'See the comment in main() for instructions.',
      )
    },
    captureEnvelope: defaultCaptureEnvelope,
    cleanup: (rp, dir) => defaultCleanup(rp, dir),
    costFn: estimateCostUsd,
  }

  if (corpus.cases.length === 0) {
    process.stdout.write(
      '[pack-upgrade-harness] 0 dispatchable cases — nothing to dispatch. Exiting.\n',
    )
    const isoDate = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const outputPath = args.output
      ? resolve(args.output)
      : join(repoRoot, '_bmad-output', 'eval-results', `pack-upgrade-harness-${isoDate}.json`)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, JSON.stringify([], null, 2), 'utf8')
    process.stdout.write(`[pack-upgrade-harness] wrote 0 pairs → ${outputPath}\n`)
    process.exit(0)
  }

  // Resolve output path.
  const isoDate = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outputPath = args.output
    ? resolve(args.output)
    : join(repoRoot, '_bmad-output', 'eval-results', `pack-upgrade-harness-${isoDate}.json`)

  let results
  try {
    results = await runPackUpgradeHarness({
      corpus,
      packCurrent: packCurrentPath,
      packCandidate: packCandidatePath,
      deps,
      budgetPerCaseUsd: args.budgetPerCaseUsd,
    })
  } catch (err) {
    process.stderr.write(
      `[pack-upgrade-harness] INTERNAL ERROR: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(2)
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf8')
  process.stdout.write(`[pack-upgrade-harness] wrote ${results.length} pair(s) → ${outputPath}\n`)
  process.exit(0)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    process.stderr.write(
      `[pack-upgrade-harness] FATAL: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(2)
  })
}
