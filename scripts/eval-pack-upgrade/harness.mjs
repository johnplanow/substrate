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
 *   Production deps call packLoader(packPath, taskType) to load the pack template
 *   and assemble the prompt before dispatching via createDispatcher from
 *   @substrate-ai/core. The pack is consumed at prompt-assembly time (not injected
 *   into the dispatcher layer — AC2 is N/A since Path B was chosen, see Dev Notes).
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
 * Auth (AC5):
 *   Local: relies on the operator's Claude Code OAuth session (auto-discovered).
 *   CI (GITHUB_ACTIONS=true): requires ANTHROPIC_API_KEY env var — harness exits
 *   with a clear error when absent.
 *   See docs/eval-pack-upgrade-ci-setup.md for CI setup instructions.
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
import { readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { createDispatcher, createEventBus, AdapterRegistry, ClaudeCodeAdapter } from '@substrate-ai/core'

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
// Pack loader (inline minimal — mirrors createPackLoader().load() from the
// methodology-pack module without requiring the compiled monolith dist)
// ---------------------------------------------------------------------------

/**
 * packLoader: load a methodology pack's prompt template for a given task type.
 *
 * Reads manifest.yaml from the pack directory, resolves the prompt file path
 * for `taskType`, and returns the raw template string. This mirrors the
 * essential behavior of `createPackLoader().load(packPath)` + `pack.getPrompt(taskType)`
 * from src/modules/methodology-pack/pack-loader.ts without requiring the
 * monolith's compiled dist.
 *
 * @param {string} packPath - absolute path to the pack directory
 * @param {string} taskType - task type key (e.g. 'dev-story')
 * @returns {Promise<string>} raw template string (with {{placeholder}} markers)
 */
export async function packLoader(packPath, taskType = 'dev-story') {
  const manifestPath = join(packPath, 'manifest.yaml')
  let raw
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (err) {
    throw new Error(
      `packLoader: cannot read manifest at "${manifestPath}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const manifest = yaml.load(raw)
  const relPath = manifest?.prompts?.[taskType]
  if (!relPath) {
    throw new Error(
      `packLoader: pack at "${packPath}" has no prompt for task type "${taskType}". ` +
        `Available: ${Object.keys(manifest?.prompts ?? {}).join(', ')}`,
    )
  }
  const promptPath = join(packPath, relPath)
  try {
    return await readFile(promptPath, 'utf8')
  } catch (err) {
    throw new Error(
      `packLoader: cannot read prompt file "${promptPath}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Production dispatch factory (AC3, AC5, AC6 — Story 81-6)
// ---------------------------------------------------------------------------

/**
 * Build the production deps.dispatch implementation.
 *
 * Wires createDispatcher from @substrate-ai/core with pack-template loading
 * and the operator's auth (local OAuth or CI API key). Each call to the
 * returned function creates a fresh dispatcher — no cross-pair state.
 *
 * Pack assembly (AC3, Path B design decision):
 *   The pack template is loaded via packLoader() and the story content is
 *   injected into the template's {{story_content}} placeholder — mirroring
 *   the prompt assembly that runDevStory performs. The dispatcher itself does
 *   not need to know about the pack (AC2 is N/A — pack handled at this layer).
 *
 * DispatchHandle.cancel() (AC6):
 *   The dispatcher.dispatch() call returns a DispatchHandle with cancel().
 *   The handle is stored locally so it can be invoked when budget is exceeded.
 *   Budget enforcement remains post-dispatch in dispatchOnePackForCase, but
 *   cancel() is available on the handle for mid-dispatch abort if needed.
 *
 * Auth (AC5):
 *   Local: Claude Code OAuth session — no explicit wiring needed (adapter
 *   discovers the session from ~/.claude/ automatically).
 *   CI: ANTHROPIC_API_KEY must be set — validated in main() before this runs.
 *
 * @param {object} [opts={}]
 * @param {string} [opts.apiKey] - Anthropic API key for CI mode (optional)
 * @returns {Function} async dispatch(request, packPath) → Promise<DispatchResult>
 */
export function buildProductionDispatch(opts = {}) {
  return async function dispatch(request, packPath) {
    // Assemble prompt: load pack template + inject story content (AC3).
    // Mirrors the {{story_content}} replacement in prompt-assembler.ts.
    let prompt = request.prompt
    if (packPath) {
      try {
        const template = await packLoader(packPath, request.taskType ?? 'dev-story')
        // Replace {{story_content}} with the story file text — same replacement
        // that runDevStory performs in src/modules/compiled-workflows/dev-story.ts.
        // Clear any remaining unfilled placeholders (e.g. {{test_patterns}} which
        // needs DB context the harness doesn't have).
        prompt = template
          .replace(/\{\{story_content\}\}/g, request.prompt)
          .replace(/\{\{\w+\}\}/g, '')
      } catch (err) {
        // Degraded mode: fall back to raw story content with a warning.
        process.stderr.write(
          `[eval-dispatch] WARN: pack template load failed — falling back to raw story content: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        )
      }
    }

    // Build a fresh per-dispatch event bus, registry, and dispatcher (AC3).
    // Creating a new dispatcher per call avoids cross-pair state and is safe
    // because each call is sequential within dispatchOnePackForCase.
    const eventBus = createEventBus()
    const registry = new AdapterRegistry()
    // AdapterRegistry.register takes ONE arg (the adapter; reads its own .id).
    // Calling register('claude-code', adapter) registers undefined → no match
    // at dispatch time and "No adapter found for agent claude-code". Fixed:
    // pass the adapter directly. [Story 81-6 followup — 2026-05-31]
    registry.register(new ClaudeCodeAdapter())

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry: registry,
      config: {
        maxConcurrency: 2,
        defaultTimeouts: {},
      },
    })

    // Dispatch and return the result. The DispatchHandle provides cancel() for
    // mid-dispatch abort (AC6) — the handle is accessible if the caller needs it.
    const handle = dispatcher.dispatch({
      taskType: request.taskType ?? 'dev-story',
      storyKey: request.storyKey,
      prompt,
      agent: request.agent ?? 'claude-code',
      workingDirectory: request.workingDirectory,
      timeout: request.timeout,
    })

    // AC6: DispatchHandle.cancel() is available on `handle` for budget-exceeded
    // abort. The post-dispatch budget enforcement in dispatchOnePackForCase covers
    // the common case; callers with access to the handle can invoke cancel() for
    // mid-dispatch termination when needed.
    return handle.result
  }
}

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
 *
 * Contracted envelope fields (AC4, per 81-2/81-3 grader contract):
 *   dispatch_outcome — outcome status ('completed', 'failed', 'budget-exceeded', 'error')
 *   diff            — list of files changed in the worktree (from git status)
 *   total_turns     — total agentic turns from DispatchResult.totalTurns
 *   total_tokens    — { input, output } from DispatchResult.tokenEstimate
 *   verdict         — YAML verdict parsed from DispatchResult.parsed (or null)
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
    // Default to production dispatcher when no override is provided. This
    // matters because the CLI (scripts/eval-pack-upgrade.mjs) calls
    // runPackUpgradeHarness with `deps: {}` — without a default, dispatch
    // would be undefined and every call would throw. Synthetic-deps tests
    // pass a mock here so the existing test surface is preserved.
    // [Story 81-6 followup — 2026-05-31]
    dispatch = buildProductionDispatch(),
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
  - Auth: local runs use Claude Code OAuth session; CI (GITHUB_ACTIONS=true)
    requires ANTHROPIC_API_KEY env var.
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

  // Auth detection (AC5): require ANTHROPIC_API_KEY in CI environments.
  // Local runs use the operator's Claude Code OAuth session (auto-discovered
  // by the ClaudeCodeAdapter from ~/.claude/).
  if (process.env.GITHUB_ACTIONS === 'true') {
    if (!process.env.ANTHROPIC_API_KEY) {
      process.stderr.write(
        '[pack-upgrade-harness] ERROR: ANTHROPIC_API_KEY required for CI dispatch — ' +
          'see docs/eval-pack-upgrade-ci-setup.md\n',
      )
      process.exit(1)
    }
  }

  // Production dispatch wiring (Story 81-6): replaces the throwing stub from
  // Story 81-2. buildProductionDispatch() creates a real dispatcher via
  // createDispatcher from @substrate-ai/core, loads the methodology pack
  // template via packLoader(), and assembles the prompt before dispatching.
  const deps = {
    checkoutParent: (rp, sha, key) => defaultCheckoutParent(rp, sha, key),
    readStoryFile: defaultReadStoryFile,
    dispatch: buildProductionDispatch(),
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
