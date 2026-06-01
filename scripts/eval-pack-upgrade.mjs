#!/usr/bin/env node
/**
 * eval-pack-upgrade.mjs — Pack-upgrade evaluation CLI (Story 81-4).
 *
 * Drives 81-2's harness over the corpus, feeds envelopes into 81-3's grader,
 * and emits a three-format report (markdown, JSON, plain) with exit codes that
 * drive the pack-upgrade gate verdict.
 *
 * Usage:
 *   node scripts/eval-pack-upgrade.mjs \
 *     --pack-current packs/bmad \
 *     --pack-candidate packs/bmad-candidate \
 *     [options]
 *
 * Options:
 *   --pack-current PATH           Path to the current pack (required)
 *   --pack-candidate PATH         Path to the candidate pack (required)
 *   --corpus PATH                 Corpus YAML file (default: outcomes-corpus.yaml)
 *   --threshold AXIS:VAL,...      Per-axis warn thresholds (code-quality, cost-turns, verdict-tv, recovery-tv)
 *   --fail-threshold AXIS:VAL,... Per-axis fail thresholds (default: 2× warn)
 *   --format markdown|json|plain  Output format (default: plain)
 *   --output PATH                 Output file path (json default: timestamped in _bmad-output/)
 *   --budget-per-case-usd N       Per-dispatch cost ceiling (default: 2.00)
 *   --dry-run                     Validate packs + corpus without dispatching
 *   --judge-model MODEL           LLM judge model for gray-band code-quality scoring
 *   --help / -h                   Show this help
 *
 * Exit codes (AC6):
 *   0 — overall verdict GREEN
 *   1 — overall verdict YELLOW
 *   2 — overall verdict RED
 *   3 — fatal usage error (bad args, missing/unparseable corpus, unloadable pack)
 *   4 — internal exception (defensive)
 *
 * Pollution guard (AC9): only processes corpus entries explicitly listed.
 * Never enumerates .substrate/runs/ for additional cases.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import {
  parseThresholdString,
  buildGraderThresholds,
  resolveGroundTruth,
  inferPackIdentity,
  dryRunCorpus,
  formatMarkdownReport,
  formatJsonReport,
  formatPlainReport,
  defaultGitDiff,
  defaultGitRevParse,
} from './eval-pack-upgrade/cli-lib.mjs'

import { runPackUpgradeHarness, validatePackPath } from './eval-pack-upgrade/harness.mjs'
import { gradeAll } from './eval-pack-upgrade/grader.mjs'
import { parseOutcomesCorpus } from './eval-outcomes/lib.mjs'
import { parseOutcomesCorpusForPackUpgrade } from './eval-pack-upgrade/lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

/** Default corpus path (mirrors harness.mjs DEFAULT_CORPUS_PATH) */
const DEFAULT_CORPUS_PATH = join(
  repoRoot,
  '_bmad-output',
  'eval-results',
  'corpus',
  'outcomes-corpus.yaml',
)

/** Default per-dispatch budget (mirrors harness.mjs DEFAULT_BUDGET_PER_CASE_USD) */
const DEFAULT_BUDGET_PER_CASE_USD = 2.0

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    packCurrent: null,
    packCandidate: null,
    corpus: null,
    threshold: null,
    failThreshold: null,
    format: 'plain',
    output: null,
    budgetPerCaseUsd: DEFAULT_BUDGET_PER_CASE_USD,
    dryRun: false,
    judgeModel: null,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--pack-current') args.packCurrent = argv[++i]
    else if (a === '--pack-candidate') args.packCandidate = argv[++i]
    else if (a === '--corpus') args.corpus = argv[++i]
    else if (a === '--threshold') args.threshold = argv[++i]
    else if (a === '--fail-threshold') args.failThreshold = argv[++i]
    else if (a === '--format') args.format = argv[++i]
    else if (a === '--output') args.output = argv[++i]
    else if (a === '--budget-per-case-usd') args.budgetPerCaseUsd = Number(argv[++i])
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--judge-model') args.judgeModel = argv[++i]
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return args
}

function printHelp() {
  process.stdout.write(`eval-pack-upgrade.mjs — Pack-upgrade evaluation CLI (Story 81-4)

Usage:
  node scripts/eval-pack-upgrade.mjs \\
    --pack-current PATH --pack-candidate PATH [options]

Required:
  --pack-current PATH           Path to the currently-shipped pack directory
  --pack-candidate PATH         Path to the candidate pack directory

Options:
  --corpus PATH                 Corpus YAML file
                                (default: _bmad-output/eval-results/corpus/outcomes-corpus.yaml)
  --threshold AXIS:VAL,...      Per-axis warn thresholds
                                (e.g. code-quality:0.05,cost-turns:0.10,verdict-tv:0.10,recovery-tv:0.10)
  --fail-threshold AXIS:VAL,... Per-axis fail thresholds (default: 2x warn)
  --format markdown|json|plain  Output format (default: plain)
  --output PATH                 Output file path
                                (json default: _bmad-output/eval-results/pack-upgrade-<date>-<v>.json)
  --budget-per-case-usd N       Per-dispatch cost ceiling in USD (default: ${DEFAULT_BUDGET_PER_CASE_USD})
  --dry-run                     Validate packs + corpus without dispatching; exits 0 if clean
  --judge-model MODEL           LLM judge model for gray-band code-quality scoring
  --help / -h                   Show this help

Exit codes:
  0  GREEN verdict
  1  YELLOW verdict (warnings; does not block CI in report-only mode)
  2  RED verdict (threshold exceeded)
  3  Fatal usage error (bad args, missing corpus, unloadable pack)
  4  Internal exception (defensive)

Pollution guard: only processes corpus entries explicitly listed.
Never enumerates .substrate/runs/ for additional cases.
`)
}

// ---------------------------------------------------------------------------
// Default I/O implementations (for production use)
// ---------------------------------------------------------------------------

/** Default pack loader — uses validatePackPath from harness.mjs. */
async function defaultLoadPack(packPath) {
  await validatePackPath(packPath)
}

/** Default output writer. */
function defaultWriteOutput(outputPath, content) {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, content, 'utf8')
}

/** Default git rev-parse (wraps defaultGitRevParse from cli-lib.mjs) */
function defaultGitRevParseFn(packPath) {
  return defaultGitRevParse(packPath)
}

// ---------------------------------------------------------------------------
// Resolve default output path for JSON format (AC11)
// ---------------------------------------------------------------------------

function resolveJsonOutputPath(corpusVersion) {
  const isoDate = new Date().toISOString().slice(0, 10)
  const versionSafe = String(corpusVersion ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')
  return join(
    repoRoot,
    '_bmad-output',
    'eval-results',
    `pack-upgrade-${isoDate}-${versionSafe}.json`,
  )
}

// ---------------------------------------------------------------------------
// runPackUpgradeEval — orchestrator (Task 2, AC2)
// ---------------------------------------------------------------------------

/**
 * Run the pack-upgrade evaluation end-to-end.
 *
 * @param {object} params
 * @param {string} params.packCurrent — absolute path to current pack directory
 * @param {string} params.packCandidate — absolute path to candidate pack directory
 * @param {string} params.corpus — path to corpus YAML file
 * @param {object} params.options
 * @param {string} [params.options.format='plain'] — output format
 * @param {string|null} [params.options.output] — explicit output path
 * @param {number} [params.options.budgetPerCaseUsd] — per-dispatch cost ceiling
 * @param {object} [params.options.warnThresholds] — parsed warn threshold map
 * @param {object} [params.options.failThresholds] — parsed fail threshold map
 * @param {string|null} [params.options.judgeModel] — LLM judge model name
 * @param {object} [params.deps={}] — injectable I/O
 * @param {(path: string) => Promise<void>} [params.deps.loadPack] — pack validator
 * @param {(path: string) => string} [params.deps.readCorpus] — corpus reader
 * @param {Function} [params.deps.runHarness] — harness runner (injectable for tests)
 * @param {Function} [params.deps.gradeAll] — grader (injectable for tests)
 * @param {Function} [params.deps.gitDiff] — git diff implementation
 * @param {Function} [params.deps.gitRevParse] — git rev-parse implementation
 * @param {(path: string, content: string) => void} [params.deps.writeOutput] — output writer
 * @param {object} [params.deps.stdout] — stdout sink ({ write: (s) => void })
 * @returns {Promise<{ exitCode: number, gradeResult?: object, error?: string }>}
 */
export async function runPackUpgradeEval({ packCurrent, packCandidate, corpus: corpusPath, options = {}, deps = {} }) {
  const {
    loadPack = defaultLoadPack,
    readCorpus = (p) => readFileSync(p, 'utf8'),
    runHarness = runPackUpgradeHarness,
    gradeAll: gradeAllFn = gradeAll,
    gitDiff = defaultGitDiff,
    gitRevParse: gitRevParseFn = defaultGitRevParseFn,
    writeOutput = defaultWriteOutput,
    stdout = process.stdout,
  } = deps

  const format = options.format ?? 'plain'
  const budgetPerCaseUsd = options.budgetPerCaseUsd ?? DEFAULT_BUDGET_PER_CASE_USD

  // 1. Validate packs (AC2 — fatal exit 3 on failure)
  try {
    await loadPack(packCurrent)
  } catch (err) {
    const msg = `cannot load --pack-current "${packCurrent}": ${err instanceof Error ? err.message : String(err)}`
    stdout.write(`[eval-pack-upgrade] ERROR: ${msg}\n`)
    return { exitCode: 3, error: msg }
  }
  try {
    await loadPack(packCandidate)
  } catch (err) {
    const msg = `cannot load --pack-candidate "${packCandidate}": ${err instanceof Error ? err.message : String(err)}`
    stdout.write(`[eval-pack-upgrade] ERROR: ${msg}\n`)
    return { exitCode: 3, error: msg }
  }

  // 2. Read and parse corpus
  let rawCorpus
  try {
    rawCorpus = readCorpus(corpusPath)
  } catch (err) {
    const msg = `cannot read corpus at "${corpusPath}": ${err instanceof Error ? err.message : String(err)}`
    stdout.write(`[eval-pack-upgrade] ERROR: ${msg}\n`)
    return { exitCode: 3, error: msg }
  }

  let corpusData
  try {
    corpusData = parseOutcomesCorpus(rawCorpus)
  } catch (err) {
    const msg = `corpus parse error: ${err instanceof Error ? err.message : String(err)}`
    stdout.write(`[eval-pack-upgrade] ERROR: ${msg}\n`)
    return { exitCode: 3, error: msg }
  }

  // Also parse for pack-upgrade field extraction
  let packUpgradeCorpus
  try {
    packUpgradeCorpus = parseOutcomesCorpusForPackUpgrade(rawCorpus)
  } catch (err) {
    const msg = `corpus pack-upgrade parse error: ${err instanceof Error ? err.message : String(err)}`
    stdout.write(`[eval-pack-upgrade] ERROR: ${msg}\n`)
    return { exitCode: 3, error: msg }
  }

  // Build a lookup map from case_id → full corpus entry (for ground-truth resolution)
  const corpusEntryByCaseId = new Map()
  for (const entry of corpusData.cases ?? []) {
    const caseId = entry.id ?? entry.story_key
    if (caseId) corpusEntryByCaseId.set(caseId, entry)
  }

  stdout.write(
    `[eval-pack-upgrade] corpus: ${packUpgradeCorpus.cases.length} dispatchable case(s), ` +
      `${packUpgradeCorpus.skipped.length} skipped\n`,
  )

  // 3. Run harness to produce pair envelopes (AC2)
  let pairs
  try {
    pairs = await runHarness({
      corpus: packUpgradeCorpus,
      packCurrent,
      packCandidate,
      deps: {},
      budgetPerCaseUsd,
    })
  } catch (err) {
    const msg = `harness error: ${err instanceof Error ? err.message : String(err)}`
    stdout.write(`[eval-pack-upgrade] ERROR: ${msg}\n`)
    return { exitCode: 4, error: msg }
  }

  // 4. For each both-completed pair, resolve ground-truth diff (AC2, AC8)
  for (const pair of pairs) {
    if (pair.pair_outcome === 'both-completed' || pair.pair_outcome === 'one-completed') {
      const fullEntry = corpusEntryByCaseId.get(pair.case_id)
      if (fullEntry) {
        try {
          pair.ground_truth_diff = resolveGroundTruth(fullEntry, repoRoot, { gitDiff })
        } catch {
          // Non-fatal: ground_truth_diff stays absent; grader handles gracefully
          pair.ground_truth_diff = null
        }
      }
    }
  }

  // 5. Build grader options from CLI thresholds
  const graderThresholds = buildGraderThresholds(
    options.warnThresholds ?? {},
    options.failThresholds ?? {},
  )
  const gradeOptions = {
    ...(Object.keys(graderThresholds).length > 0 ? { thresholds: graderThresholds } : {}),
    ...(options.judgeModel ? { judgeFn: buildJudgeFn(options.judgeModel) } : {}),
  }

  // 6. Grade all pairs (AC2)
  let gradeResult
  try {
    gradeResult = await gradeAllFn(pairs, gradeOptions)
  } catch (err) {
    const msg = `grader error: ${err instanceof Error ? err.message : String(err)}`
    stdout.write(`[eval-pack-upgrade] ERROR: ${msg}\n`)
    return { exitCode: 4, error: msg }
  }

  // 7. Build identities and corpus info for report
  const packIdentities = {
    current: {
      path: packCurrent,
      ...inferPackIdentity(packCurrent, { gitRevParse: gitRevParseFn }),
    },
    candidate: {
      path: packCandidate,
      ...inferPackIdentity(packCandidate, { gitRevParse: gitRevParseFn }),
    },
  }

  const pairOutcomes = gradeResult.pair_outcomes ?? {}
  const corpusInfo = {
    path: corpusPath,
    version: corpusData.corpus_version ?? null,
    pairCount: pairs.length,
    completedBoth: pairOutcomes['both-completed'] ?? 0,
    ungradable: gradeResult.axes?.code_quality?.ungradable_count ?? 0,
  }

  // 8. Format report (AC3, AC4, AC5)
  let reportContent
  if (format === 'markdown') {
    reportContent = formatMarkdownReport(gradeResult, packIdentities, corpusInfo)
  } else if (format === 'json') {
    reportContent = JSON.stringify(
      formatJsonReport(gradeResult, packIdentities, corpusInfo),
      null,
      2,
    )
  } else {
    // plain (default)
    reportContent = formatPlainReport(gradeResult, packIdentities, corpusInfo)
  }

  // 9. Write output (AC11)
  if (format === 'json') {
    // JSON: default to timestamped file (AC11)
    const outputPath = options.output
      ? resolve(options.output)
      : resolveJsonOutputPath(corpusData.corpus_version)
    try {
      writeOutput(outputPath, reportContent)
      stdout.write(`[eval-pack-upgrade] JSON report written to ${outputPath}\n`)
    } catch (err) {
      const msg = `failed to write output to "${outputPath}": ${err instanceof Error ? err.message : String(err)}`
      stdout.write(`[eval-pack-upgrade] ERROR: ${msg}\n`)
      return { exitCode: 4, error: msg }
    }
  } else if (options.output) {
    // markdown/plain with explicit --output
    try {
      writeOutput(resolve(options.output), reportContent)
      stdout.write(`[eval-pack-upgrade] report written to ${options.output}\n`)
    } catch (err) {
      const msg = `failed to write output to "${options.output}": ${err instanceof Error ? err.message : String(err)}`
      stdout.write(`[eval-pack-upgrade] ERROR: ${msg}\n`)
      return { exitCode: 4, error: msg }
    }
  } else {
    // markdown/plain without --output: write to stdout (AC11)
    stdout.write(reportContent)
    stdout.write('\n')
  }

  // 10. Return exit code per verdict (AC6)
  const verdict = gradeResult.overall_verdict
  stdout.write(`[eval-pack-upgrade] Overall verdict: ${verdict}\n`)

  const exitCode = verdict === 'GREEN' ? 0 : verdict === 'YELLOW' ? 1 : verdict === 'RED' ? 2 : 4
  return { exitCode, gradeResult }
}

// ---------------------------------------------------------------------------
// Judge function builder (stub — wires a real LLM call when judgeModel is set)
// ---------------------------------------------------------------------------

/**
 * Build a judge function for gray-band code-quality scoring.
 * When judgeModel is null/absent, returns undefined (deterministic-only scoring).
 *
 * @param {string} judgeModel — model name (e.g. "claude-3-5-sonnet-20241022")
 * @returns {Function|undefined}
 */
function buildJudgeFn(judgeModel) {
  if (!judgeModel) return undefined
  // NOTE: LLM judge integration is a follow-on concern. For now, return a
  // no-op that keeps deterministic scoring (same as absent judgeFn).
  // Wire the actual judge call here when 81-3's LLM judge is ready.
  process.stderr.write(
    'WARNING: --judge-model is not yet wired; using deterministic-only scoring.\n',
  )
  return undefined
}

// ---------------------------------------------------------------------------
// Dry-run mode (AC7)
// ---------------------------------------------------------------------------

/**
 * Run the --dry-run validation path.
 *
 * Validates packs and corpus structure without dispatching.
 *
 * @param {object} args — parsed CLI args
 * @param {object} deps — injectable I/O (loadPack, readCorpus)
 * @returns {Promise<number>} exit code (0 = clean, 3 = errors)
 */
async function runDryRun(args, deps = {}) {
  const {
    loadPack = defaultLoadPack,
    readCorpus = (p) => readFileSync(p, 'utf8'),
    stdout = process.stdout,
  } = deps

  let hasErrors = false

  // Validate pack paths
  try {
    await loadPack(args.packCurrent)
    stdout.write(`[eval-pack-upgrade] dry-run: --pack-current OK: ${args.packCurrent}\n`)
  } catch (err) {
    stdout.write(
      `[eval-pack-upgrade] dry-run: ERROR --pack-current "${args.packCurrent}": ${err instanceof Error ? err.message : String(err)}\n`,
    )
    hasErrors = true
  }

  try {
    await loadPack(args.packCandidate)
    stdout.write(`[eval-pack-upgrade] dry-run: --pack-candidate OK: ${args.packCandidate}\n`)
  } catch (err) {
    stdout.write(
      `[eval-pack-upgrade] dry-run: ERROR --pack-candidate "${args.packCandidate}": ${err instanceof Error ? err.message : String(err)}\n`,
    )
    hasErrors = true
  }

  // Read and parse corpus
  let rawCorpus
  try {
    rawCorpus = readCorpus(args.corpus)
  } catch (err) {
    stdout.write(
      `[eval-pack-upgrade] dry-run: ERROR reading corpus "${args.corpus}": ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 3
  }

  let packUpgradeCorpus
  try {
    packUpgradeCorpus = parseOutcomesCorpusForPackUpgrade(rawCorpus)
  } catch (err) {
    stdout.write(
      `[eval-pack-upgrade] dry-run: ERROR parsing corpus: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 3
  }

  stdout.write(
    `[eval-pack-upgrade] dry-run: corpus parsed — ${packUpgradeCorpus.cases.length} dispatchable, ` +
      `${packUpgradeCorpus.skipped.length} skipped\n`,
  )

  // Per-pair validation (AC7)
  const { perPair } = dryRunCorpus(packUpgradeCorpus)
  let readyCount = 0
  let errorCount = 0
  for (const result of perPair) {
    if (result.status === 'ready') {
      readyCount++
      stdout.write(`  [ready] ${result.caseId}\n`)
    } else {
      errorCount++
      hasErrors = true
      stdout.write(`  [corpus-error] ${result.caseId}: ${result.error}\n`)
    }
  }

  stdout.write(
    `[eval-pack-upgrade] dry-run: ${readyCount} ready, ${errorCount} corpus-error(s)\n`,
  )

  if (hasErrors || errorCount > 0) {
    stdout.write('[eval-pack-upgrade] dry-run: corpus has errors — fix before dispatching\n')
    return 3
  }

  stdout.write('[eval-pack-upgrade] dry-run: all pairs ready\n')
  return 0
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv)

  // Validate required args
  if (!args.packCurrent) {
    process.stderr.write('[eval-pack-upgrade] ERROR: --pack-current is required\n')
    printHelp()
    process.exit(3)
  }
  if (!args.packCandidate) {
    process.stderr.write('[eval-pack-upgrade] ERROR: --pack-candidate is required\n')
    printHelp()
    process.exit(3)
  }

  // Validate format
  const validFormats = ['markdown', 'json', 'plain']
  if (!validFormats.includes(args.format)) {
    process.stderr.write(
      `[eval-pack-upgrade] ERROR: --format must be one of ${validFormats.join(', ')}, got "${args.format}"\n`,
    )
    process.exit(3)
  }

  // Resolve paths
  const packCurrent = resolve(args.packCurrent)
  const packCandidate = resolve(args.packCandidate)
  const corpusPath = args.corpus ? resolve(args.corpus) : DEFAULT_CORPUS_PATH

  // Validate corpus exists
  if (!existsSync(corpusPath)) {
    process.stderr.write(`[eval-pack-upgrade] ERROR: corpus not found: ${corpusPath}\n`)
    process.exit(3)
  }

  // Parse threshold strings (AC1)
  let warnThresholds = {}
  let failThresholds = {}
  if (args.threshold) {
    try {
      warnThresholds = parseThresholdString(args.threshold)
    } catch (err) {
      process.stderr.write(`[eval-pack-upgrade] ERROR: --threshold: ${err.message}\n`)
      process.exit(3)
    }
  }
  if (args.failThreshold) {
    try {
      failThresholds = parseThresholdString(args.failThreshold)
    } catch (err) {
      process.stderr.write(`[eval-pack-upgrade] ERROR: --fail-threshold: ${err.message}\n`)
      process.exit(3)
    }
  }

  // --dry-run mode (AC7)
  if (args.dryRun) {
    const exitCode = await runDryRun({
      packCurrent,
      packCandidate,
      corpus: corpusPath,
    })
    process.exit(exitCode)
  }

  // Full run
  let result
  try {
    result = await runPackUpgradeEval({
      packCurrent,
      packCandidate,
      corpus: corpusPath,
      options: {
        format: args.format,
        output: args.output,
        budgetPerCaseUsd: args.budgetPerCaseUsd,
        warnThresholds,
        failThresholds,
        judgeModel: args.judgeModel,
      },
    })
  } catch (err) {
    process.stderr.write(`[eval-pack-upgrade] FATAL: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(4)
  }

  process.exit(result.exitCode)
}

// Guard so tests can import without triggering execution
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    process.stderr.write(`[eval-pack-upgrade] FATAL: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(4)
  })
}
