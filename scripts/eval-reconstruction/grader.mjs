#!/usr/bin/env node
/**
 * grader.mjs — Reconstruction grader, two-signal / ambiguous-only-LLM (Story 77-9).
 *
 * Grades each reconstruction (produced by the Story 77-8 harness) against the
 * ACTUAL commit, with a deterministic-first, LLM-only-when-ambiguous rubric
 * (bmad-party-mode panel decision 2026-05-25):
 *
 *   1. Deterministic signal (ALWAYS): file-set overlap (Jaccard of changed
 *      paths) + test-pass overlap. Cheap, reproducible, no model call.
 *   2. LLM pairwise judge (AMBIGUOUS ONLY): invoked ONLY when the deterministic
 *      score lands in a configurable gray band (default 0.4–0.8). Clear pass and
 *      clear fail skip the judge entirely — this is what bounds the cost.
 *   3. Per-case verdict combines both signals into a reconstruction-quality
 *      score; the rollup joins the eval-results sink under the GREEN/YELLOW/RED
 *      rubric, tagged `tier=1 capability`.
 *
 * CAPABILITY-TIER — informational. This grader is NEVER part of the `/ship` gate
 * (77-3 Step 4.7); it runs on-demand / scheduled only. `ReconstructionGraderCheck`
 * implements the `VerificationCheck` interface (Design Principle 2) so it COULD be
 * registered, but it must not be wired into the every-ship pipeline.
 *
 * The LLM judge is injected (`opts.judgeFn`) so the gray-band path is unit-tested
 * without a real model. Production wires the injectable pairwise judge from
 * packages/factory/src/graph/llm-evaluator.ts.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { computeRubric } from '../eval-outcomes/lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')

// Gray band: deterministic scores in [low, high] are ambiguous → invoke the LLM
// judge. Outside the band, the deterministic signal is decisive (judge skipped).
export const DEFAULT_GRAY_BAND = { low: 0.4, high: 0.8 }

// A case passes (informational) when its combined quality score meets this.
export const DEFAULT_PASS_THRESHOLD = 0.7

// Weights for blending the two deterministic sub-signals into one score.
const FILE_WEIGHT = 0.5
const TEST_WEIGHT = 0.5

// When the judge runs, blend its score with the deterministic score.
const JUDGE_BLEND = 0.5

// ---------------------------------------------------------------------------
// Pure scoring helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Jaccard similarity of two iterables-as-sets: |A∩B| / |A∪B|. Empty∩Empty = 1. */
export function jaccard(a, b) {
  const setA = new Set(a ?? [])
  const setB = new Set(b ?? [])
  if (setA.size === 0 && setB.size === 0) return 1
  let inter = 0
  for (const x of setA) if (setB.has(x)) inter++
  const union = setA.size + setB.size - inter
  return union === 0 ? 1 : inter / union
}

/**
 * Test-pass overlap: of the tests the ACTUAL commit touched/passed, what fraction
 * also pass in the reconstruction. Modeled as Jaccard of the two pass-sets so it
 * degrades symmetrically (missing AND spurious tests both cost). Empty actual
 * test-set ⇒ neutral 1 (no test signal to disagree on).
 */
export function testOverlap(reconstructedPass, actualPass) {
  const actual = new Set(actualPass ?? [])
  if (actual.size === 0) return 1
  return jaccard(reconstructedPass, actualPass)
}

/**
 * Deterministic signal for one case: blended file-set Jaccard + test overlap.
 * @returns {{ fileJaccard: number, testOverlap: number, detScore: number }}
 */
export function deterministicSignal(reconstruction, actual) {
  const fileJaccard = jaccard(reconstruction?.reconstructed_files, actual?.changed_files)
  const tOverlap = testOverlap(reconstruction?.passing_tests, actual?.passing_tests)
  const detScore = FILE_WEIGHT * fileJaccard + TEST_WEIGHT * tOverlap
  return { fileJaccard, testOverlap: tOverlap, detScore }
}

/** True when a deterministic score is in the (inclusive) gray band → judge it. */
export function isGrayBand(score, band = DEFAULT_GRAY_BAND) {
  return score >= band.low && score <= band.high
}

/**
 * Combine the deterministic score with an optional judge score into the final
 * reconstruction-quality score. When the judge did not run, the deterministic
 * score IS the final score (clear pass/fail).
 */
export function combineScore(detScore, judgeScore) {
  if (typeof judgeScore !== 'number') return detScore
  return (1 - JUDGE_BLEND) * detScore + JUDGE_BLEND * judgeScore
}

/** Informational per-case verdict from the combined quality score. */
export function caseVerdict(score, passThreshold = DEFAULT_PASS_THRESHOLD) {
  return score >= passThreshold ? 'pass' : 'fail'
}

// ---------------------------------------------------------------------------
// Case + corpus grading
// ---------------------------------------------------------------------------

/**
 * Grade a single reconstruction against the actual commit's ground truth.
 * The LLM judge (`deps.judgeFn`) is invoked ONLY when the deterministic score
 * is in the gray band AND a judgeFn is provided (AC2 — bounds cost).
 *
 * @param {object} reconstruction  a Story 77-8 per-case record (must be 'reconstructed')
 * @param {object} actual          ground truth: { changed_files[], passing_tests[] }
 * @param {object} deps            { judgeFn? } — async (reconstruction, actual) => { score, rationale? }
 * @param {object} opts            { grayBand, passThreshold }
 * @returns {Promise<object>} per-case grade
 */
export async function gradeCase(reconstruction, actual, deps = {}, opts = {}) {
  const grayBand = opts.grayBand ?? DEFAULT_GRAY_BAND
  const passThreshold = opts.passThreshold ?? DEFAULT_PASS_THRESHOLD

  const { fileJaccard, testOverlap: tOverlap, detScore } = deterministicSignal(reconstruction, actual)

  let judgeInvoked = false
  let judgeScore
  let judgeRationale
  if (isGrayBand(detScore, grayBand) && typeof deps.judgeFn === 'function') {
    judgeInvoked = true
    const judged = await deps.judgeFn(reconstruction, actual)
    judgeScore = judged?.score
    judgeRationale = judged?.rationale
  }

  const score = combineScore(detScore, judgeScore)
  return {
    story_key: reconstruction?.story_key ?? '<unknown>',
    phase: reconstruction?.phase,
    file_jaccard: fileJaccard,
    test_overlap: tOverlap,
    det_score: detScore,
    judge_invoked: judgeInvoked,
    ...(judgeInvoked ? { judge_score: judgeScore, judge_rationale: judgeRationale } : {}),
    score,
    verdict: caseVerdict(score, passThreshold),
  }
}

/**
 * Grade every reconstructed case and roll up under the GREEN/YELLOW/RED rubric.
 * Only cases the harness marked `reconstructed` are gradable; skipped /
 * budget-exceeded / errored cases are reported but excluded from the denominator
 * (so an empty/degenerate run is YELLOW-by-absence, never a false GREEN/RED).
 *
 * @param {object[]} reconstructions  Story 77-8 harness output
 * @param {Map<string,object>|object} actuals  ground truth keyed by story_key
 * @returns {Promise<object>} { rubric, pass_rate, graded, passed, per_case, tier }
 */
export async function gradeAll(reconstructions, actuals, deps = {}, opts = {}) {
  const threshold = opts.threshold ?? 0.95
  const lookup = actuals instanceof Map ? actuals : new Map(Object.entries(actuals ?? {}))

  const perCase = []
  let passed = 0
  let graded = 0
  let ungradable = 0

  for (const r of reconstructions ?? []) {
    if (r?.status !== 'reconstructed') {
      perCase.push({ story_key: r?.story_key ?? '<unknown>', status: r?.status, gradable: false })
      ungradable++
      continue
    }
    const actual = lookup.get(r.story_key) ?? {}
    const grade = await gradeCase(r, actual, deps, opts)
    perCase.push({ ...grade, gradable: true })
    graded++
    if (grade.verdict === 'pass') passed++
  }

  const rubric = graded === 0 ? 'YELLOW' : computeRubric(passed, graded, threshold)
  return {
    tier: '1 capability',
    every_ship_gate: false,
    rubric,
    pass_rate: graded === 0 ? 0 : passed / graded,
    graded,
    passed,
    ungradable,
    per_case: perCase,
  }
}

// ---------------------------------------------------------------------------
// VerificationCheck implementation (Design Principle 2)
// ---------------------------------------------------------------------------

/**
 * VerificationCheck that grades phase reconstructions. Capability-tier:
 * tier 'B' and `everyShipGate = false` — it implements the interface so it CAN
 * be registered for on-demand/scheduled runs, but it must NEVER be added to the
 * `/ship` every-ship pipeline (77-3 Step 4.7).
 */
export class ReconstructionGraderCheck {
  name = 'reconstruction-grader'
  tier = 'B'
  // Explicit, machine-checkable marker so a ship-gate wiring audit can assert
  // this check is excluded. Belt-and-suspenders for AC4.
  everyShipGate = false

  #reconstructions
  #actuals
  #deps
  #opts

  constructor(options = {}) {
    this.#reconstructions = options.reconstructions ?? []
    this.#actuals = options.actuals ?? new Map()
    this.#deps = options.deps ?? {}
    this.#opts = options.opts ?? {}
  }

  /** @returns {Promise<{status:'pass'|'warn'|'fail', details:string, duration_ms:number}>} */
  async run() {
    const startTime = Date.now()
    const report = await gradeAll(this.#reconstructions, this.#actuals, this.#deps, this.#opts)
    const status = report.graded === 0 ? 'warn' : report.rubric === 'GREEN' ? 'pass' : report.rubric === 'YELLOW' ? 'warn' : 'fail'
    return {
      status,
      details: `reconstruction-grader [tier=1 capability, informational]: ${report.rubric} — ${report.passed}/${report.graded} reconstructed cases at quality threshold (${report.ungradable} ungradable)`,
      duration_ms: Date.now() - startTime,
      report,
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { reconstructions: null, actuals: null, grayBandLow: null, grayBandHigh: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--reconstructions') args.reconstructions = argv[++i]
    else if (a === '--actuals') args.actuals = argv[++i]
    else if (a === '--gray-band-low') args.grayBandLow = Number(argv[++i])
    else if (a === '--gray-band-high') args.grayBandHigh = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return args
}

function printHelp() {
  process.stdout.write(`grader.mjs — reconstruction grader, two-signal / ambiguous-only-LLM (Story 77-9)

Usage: node scripts/eval-reconstruction/grader.mjs --reconstructions PATH --actuals PATH [--gray-band-low 0.4 --gray-band-high 0.8]

  --reconstructions  JSON output from the Story 77-8 harness.
  --actuals          JSON ground-truth map { story_key: { changed_files[], passing_tests[] } }.
  --gray-band-low    Lower gray-band bound (default ${DEFAULT_GRAY_BAND.low}).
  --gray-band-high   Upper gray-band bound (default ${DEFAULT_GRAY_BAND.high}).

CAPABILITY-TIER — informational. NEVER part of the /ship gate.
`)
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.reconstructions || !existsSync(resolve(args.reconstructions))) {
    process.stderr.write('[reconstruction-grader] ERROR: --reconstructions JSON is required\n')
    process.exit(1)
  }
  const harnessOut = JSON.parse(readFileSync(resolve(args.reconstructions), 'utf8'))
  const reconstructions = harnessOut.reconstructions ?? harnessOut
  const actuals = args.actuals && existsSync(resolve(args.actuals))
    ? JSON.parse(readFileSync(resolve(args.actuals), 'utf8'))
    : {}

  const grayBand = {
    low: args.grayBandLow ?? DEFAULT_GRAY_BAND.low,
    high: args.grayBandHigh ?? DEFAULT_GRAY_BAND.high,
  }
  // No judgeFn wired at the CLI yet — the production pairwise judge attaches
  // when the corpus has real gray-band cases. Deterministic-only until then.
  const report = await gradeAll(reconstructions, actuals, {}, { grayBand })

  process.stdout.write(
    `[reconstruction-grader] ${report.rubric} (tier=1 capability, NOT a ship gate): ` +
      `${report.passed}/${report.graded} pass, ${report.ungradable} ungradable\n`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
