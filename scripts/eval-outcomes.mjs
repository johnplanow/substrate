#!/usr/bin/env node
/**
 * eval-outcomes.mjs — Outcome-replay grader for the eval framework (Story 77-1).
 *
 * Canonical CLI entry point. Reads a labeled outcome corpus (YAML), queries
 * story_metrics via getStoryMetricsForRun for each corpus entry, and asserts
 * expected outcome class against the recorded result.
 *
 * In --dry-run mode: validates corpus structure and run_id resolution only —
 * no metric queries, no pass/fail assertions. Corpus-errors are printed and
 * cause exit code 1; clean corpus exits 0.
 *
 * Usage:
 *   node scripts/eval-outcomes.mjs [options]
 *
 * Options:
 *   --corpus PATH      Corpus YAML file (default: _bmad-output/eval-results/corpus/outcomes-corpus.yaml)
 *   --output PATH      JSON report output path (default: timestamped in _bmad-output/eval-results/)
 *   --threshold NUM    Pass-rate threshold for GREEN verdict (default: 0.95)
 *   --dry-run          Validate corpus structure and run_id resolution only
 *   --project-root P   Project root for manifest lookup (default: git common-dir)
 *   --help / -h        Show this help
 *
 * Exit codes:
 *   0 — GREEN or YELLOW rubric (all assertions passed, or dry-run with zero corpus-errors)
 *   1 — RED rubric, assertion failures, or corpus-errors detected
 *   2 — fatal error (corpus unreadable, Dolt unavailable, etc.)
 *
 * Pollution guard (AC8): the grader operates ONLY on curated corpus entries;
 * it NEVER enumerates .substrate/runs/. Cases with missing/incomplete run_ids
 * are reported as corpus-errors (not pass/fail).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  VALID_RESULT_CLASSES,
  parseOutcomesCorpus,
  assertOutcomeCase,
  computeRubric,
  computePassCaretK,
  caseCategory,
  CATEGORY_CAPABILITY,
  readManifest,
  hasDecisionExpectations,
  assertDecisionCase,
} from './eval-outcomes/lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = {
    corpus: null,
    output: null,
    threshold: 0.95,
    dryRun: false,
    projectRoot: null,
  }
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (arg === '--corpus') args.corpus = process.argv[++i]
    else if (arg === '--output') args.output = process.argv[++i]
    else if (arg === '--threshold') args.threshold = Number.parseFloat(process.argv[++i])
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--project-root') args.projectRoot = process.argv[++i]
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  args.corpus ??= join(
    repoRoot,
    '_bmad-output',
    'eval-results',
    'corpus',
    'outcomes-corpus.yaml',
  )
  return args
}

function printHelp() {
  process.stdout.write(`eval-outcomes.mjs — Outcome-replay grader (Story 77-1)

Usage: node scripts/eval-outcomes.mjs [options]

Options:
  --corpus PATH      Corpus YAML file
                     (default: _bmad-output/eval-results/corpus/outcomes-corpus.yaml)
  --output PATH      JSON report output path (default: timestamped in _bmad-output/eval-results/)
  --threshold NUM    Pass-rate threshold for GREEN verdict (default: 0.95)
  --dry-run          Validate corpus structure and run_id resolution only; no report written
  --project-root P   Project root for manifest lookup (default: git common-dir)
  --help / -h        Show this help

Rubric (AC5):
  pass_rate >= threshold   GREEN  — exit 0
  0.85 <= rate < threshold YELLOW — exit 0
  pass_rate < 0.85         RED    — exit 1

Pollution guard: the grader operates ONLY on curated corpus entries.
It NEVER enumerates .substrate/runs/. Corpus cases with unresolvable
or incomplete run_ids are reported as corpus-errors (not pass/fail).
`)
}

// ---------------------------------------------------------------------------
// Resolve main repo root from git worktree
// ---------------------------------------------------------------------------

function resolveMainRepoRoot(cwd) {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0 || !result.stdout) return cwd
  const commonDir = result.stdout.trim()
  return dirname(resolve(cwd, commonDir))
}

// ---------------------------------------------------------------------------
// Dry-run validation
// ---------------------------------------------------------------------------

function runDryRun(corpusData, projectRoot) {
  const cases = corpusData.cases ?? []
  const errors = []
  const resolved = []

  for (const entry of cases) {
    const { id, run_id: runId, story_key: storyKey, expect } = entry

    // Validate required fields
    if (!runId) {
      errors.push({ id, type: 'corpus-error', reason: 'missing run_id field' })
      continue
    }
    if (!storyKey) {
      errors.push({ id, type: 'corpus-error', reason: 'missing story_key field' })
      continue
    }
    if (!expect?.result_class) {
      errors.push({ id, type: 'corpus-error', reason: 'missing expect.result_class field' })
      continue
    }
    if (!VALID_RESULT_CLASSES.has(expect.result_class)) {
      errors.push({
        id,
        type: 'corpus-error',
        reason: `unknown result_class: "${expect.result_class}" — must be one of: ${[...VALID_RESULT_CLASSES].join(', ')}`,
      })
      continue
    }

    // Resolve manifest (AC8 pollution guard: only look up explicitly-listed run_id)
    const manifest = readManifest(projectRoot, runId)
    if (!manifest) {
      errors.push({
        id,
        type: 'corpus-error',
        reason: `unresolvable run_id: ${runId} — no manifest at .substrate/runs/${runId}.json`,
      })
      continue
    }

    // Check manifest is not incomplete
    const runStatus = manifest.run_status ?? manifest.status
    if (runStatus === 'running' || runStatus === 'dispatched') {
      errors.push({
        id,
        type: 'corpus-error',
        reason: `run_id ${runId} has status "${runStatus}" — corpus must reference completed runs only`,
      })
      continue
    }

    resolved.push({ id, runId, storyKey, resultClass: expect.result_class, manifestStatus: runStatus })
  }

  return { errors, resolved, total: cases.length }
}

// ---------------------------------------------------------------------------
// Full grader run
// ---------------------------------------------------------------------------

async function runFullGrader(corpusData, projectRoot, args) {
  // Import persistence layer
  let getStoryMetricsForRun, createDatabaseAdapter, DoltClient, initSchema
  try {
    ;({ getStoryMetricsForRun } = await import(
      '../packages/core/dist/persistence/queries/metrics.js'
    ))
    ;({ createDatabaseAdapter } = await import('../packages/core/dist/persistence/adapter.js'))
    ;({ DoltClient } = await import('../packages/core/dist/persistence/dolt-client.js'))
    ;({ initSchema } = await import('../packages/core/dist/persistence/schema.js'))
  } catch (err) {
    process.stderr.write(`[eval-outcomes] ERROR: failed to load persistence layer: ${err}\n`)
    process.exit(2)
  }

  // Create adapter
  let adapter
  try {
    adapter = createDatabaseAdapter(
      { backend: 'dolt', basePath: projectRoot },
      (rp) => new DoltClient({ repoPath: rp }),
    )
    await initSchema(adapter)
  } catch (err) {
    process.stderr.write(`[eval-outcomes] ERROR: Dolt unavailable: ${err}\n`)
    process.exit(2)
  }

  // Grade cases. 77-3 AC4: regression cases gate the build; capability cases
  // are informational (Tier 2a replays immutable records and can't validate a
  // post-fix outcome — that needs a fresh Tier 1 run).
  const cases = corpusData.cases
  let passed = 0          // regression only
  let failed = 0          // regression only
  let corpusErrorCount = 0
  const perCase = []
  const regressionGraded = [] // {entry, status} for pass^k
  const capability = { total: 0, matched: 0, mismatched: 0, cases: [] }
  // Decision-replay (77-5) — folded into the regression rubric, reported separately.
  const decision = { graded: 0, passed: 0, failed: 0, provenance_missing: 0, cases: [] }

  for (const entry of cases) {
    const { id, run_id: runId, story_key: storyKey, expect } = entry
    const category = caseCategory(entry)

    // Validate corpus entry (applies to both categories)
    if (!runId) {
      corpusErrorCount++
      process.stdout.write(`  corpus-error [${id}]: missing run_id field\n`)
      perCase.push({ id, runId, storyKey, category, status: 'corpus-error', reason: 'missing run_id field' })
      continue
    }
    if (!storyKey) {
      corpusErrorCount++
      process.stdout.write(`  corpus-error [${id}]: missing story_key field\n`)
      perCase.push({ id, runId, storyKey, category, status: 'corpus-error', reason: 'missing story_key field' })
      continue
    }
    if (!expect?.result_class) {
      corpusErrorCount++
      process.stdout.write(`  corpus-error [${id}]: missing expect.result_class field\n`)
      perCase.push({ id, runId, storyKey, category, status: 'corpus-error', reason: 'missing expect.result_class field' })
      continue
    }
    if (!VALID_RESULT_CLASSES.has(expect.result_class)) {
      corpusErrorCount++
      process.stdout.write(`  corpus-error [${id}]: unknown result_class "${expect.result_class}"\n`)
      perCase.push({ id, runId, storyKey, category, status: 'corpus-error', reason: `unknown result_class: "${expect.result_class}"` })
      continue
    }

    // Pollution guard: only resolve explicitly-listed run_id
    const manifest = readManifest(projectRoot, runId)
    if (!manifest) {
      corpusErrorCount++
      process.stdout.write(`  corpus-error [${id}]: unresolvable run_id ${runId}\n`)
      perCase.push({ id, runId, storyKey, category, status: 'corpus-error', reason: `unresolvable run_id: ${runId}` })
      continue
    }
    const runStatus = manifest.run_status ?? manifest.status
    if (runStatus === 'running' || runStatus === 'dispatched') {
      corpusErrorCount++
      process.stdout.write(`  corpus-error [${id}]: run_id ${runId} is still "${runStatus}"\n`)
      perCase.push({ id, runId, storyKey, category, status: 'corpus-error', reason: `run still ${runStatus}` })
      continue
    }

    // Query metrics
    let rows
    try {
      rows = await getStoryMetricsForRun(adapter, runId)
    } catch (err) {
      corpusErrorCount++
      perCase.push({ id, runId, storyKey, category, status: 'corpus-error', reason: `query error: ${err}` })
      continue
    }

    const storyRow = rows.find((r) => r.story_key === storyKey)
    if (!storyRow) {
      corpusErrorCount++
      perCase.push({
        id,
        runId,
        storyKey,
        category,
        status: 'corpus-error',
        reason: `story_key ${storyKey} not found in story_metrics for run ${runId}`,
      })
      continue
    }

    // Assert outcome (77-1) and, when declared, decision-replay (77-5).
    const result = assertOutcomeCase(entry, storyRow)
    const dec = hasDecisionExpectations(entry)
      ? assertDecisionCase(entry, storyRow, manifest, storyKey)
      : null

    if (category === CATEGORY_CAPABILITY) {
      // Informational only — never gates. A "mismatch" is EXPECTED for known
      // false-escalation cases (the recorded class differs from the post-fix
      // class), so we report rather than fail.
      capability.total++
      if (result.status === 'pass') capability.matched++
      else capability.mismatched++
      capability.cases.push({ id, storyKey, expected: result.expected, actual: result.actual, matched: result.status === 'pass' })
      perCase.push({ id, runId, storyKey, category, status: 'informational', expected: result.expected, actual: result.actual, ...(dec ? { decision: dec } : {}) })
      continue
    }

    // 77-5 AC4: a declared decision field with null/absent recorded value is a
    // corpus-error for the whole case — flags pre-77-4 provenance, never a silent pass.
    if (dec && dec.status === 'corpus-error') {
      corpusErrorCount++
      decision.provenance_missing++
      process.stdout.write(`  corpus-error [decision ${id}]: ${dec.reason}\n`)
      perCase.push({ id, runId, storyKey, category, status: 'corpus-error', reason: dec.reason, decision: dec })
      continue
    }

    // 77-5 AC3: case fails if EITHER outcome class OR a declared decision assertion fails.
    if (dec) {
      decision.graded++
      decision.cases.push({ id, storyKey, field: dec.field, status: dec.status, expected: dec.expected, actual: dec.actual })
    }
    const decisionFailed = dec?.status === 'fail'
    if (result.status === 'pass' && !decisionFailed) {
      passed++
      if (dec) decision.passed++
      regressionGraded.push({ entry, status: 'pass' })
      perCase.push({ id, runId, storyKey, category, ...result, ...(dec ? { decision: dec } : {}) })
    } else {
      failed++
      if (decisionFailed) decision.failed++
      const reasons = []
      if (result.status === 'fail') reasons.push(result.reason)
      if (decisionFailed) reasons.push(dec.reason)
      process.stdout.write(`  FAIL [regression ${id}]: ${reasons.join(' | ')}\n`)
      regressionGraded.push({ entry, status: 'fail' })
      perCase.push({ id, runId, storyKey, category, status: 'fail', expected: result.expected, actual: result.actual, reason: reasons.join(' | '), ...(dec ? { decision: dec } : {}) })
    }
  }

  // Rubric is computed on REGRESSION cases only (corpus-errors excluded from denominator)
  const totalGraded = passed + failed
  const passRate = totalGraded === 0 ? 0 : passed / totalGraded
  const rubric = computeRubric(passed, totalGraded, args.threshold)
  const passCaretK = computePassCaretK(regressionGraded)

  // Build report filename: eval-outcomes-<ISO-date>-<corpus_version>.json (AC6)
  const corpusVersion = String(corpusData.corpus_version ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')
  const isoDate = new Date().toISOString().slice(0, 10)
  const defaultOutput = join(
    repoRoot,
    '_bmad-output',
    'eval-results',
    `eval-outcomes-${isoDate}-${corpusVersion}.json`,
  )
  const outputPath = args.output ?? defaultOutput

  const report = {
    run_at: new Date().toISOString(),
    corpus: args.corpus,
    corpus_version: corpusData.corpus_version ?? null,
    threshold: args.threshold,
    total_cases: cases.length,
    // Regression block (gates the build)
    regression: { passed, failed, total_graded: totalGraded, pass_rate: passRate, rubric },
    // Capability block (informational — never gates; deferred to Tier 1 fresh runs)
    capability,
    // Decision-replay block (77-5 Tier 2b — folded into the regression rubric above)
    decision_replay: decision,
    corpus_errors: corpusErrorCount,
    pass_caret_k: passCaretK,
    per_case: perCase,
  }

  // Write report (AC6)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(report, null, 2))

  process.stdout.write(
    `[eval-outcomes] REGRESSION ${rubric}: pass_rate=${(passRate * 100).toFixed(1)}% (${passed}/${totalGraded}) ` +
    `corpus_errors=${corpusErrorCount} threshold=${(args.threshold * 100).toFixed(0)}%\n`,
  )
  if (capability.total > 0) {
    process.stdout.write(
      `[eval-outcomes] CAPABILITY (informational, not replay-gradable — deferred to Tier 1): ` +
      `${capability.matched}/${capability.total} match recorded; ${capability.mismatched} await fresh-run validation\n`,
    )
  }
  if (decision.graded > 0 || decision.provenance_missing > 0) {
    process.stdout.write(
      `[eval-outcomes] DECISION-REPLAY (Tier 2b, folded into regression rubric): ` +
      `${decision.passed}/${decision.graded} pass` +
      `${decision.provenance_missing > 0 ? `; ${decision.provenance_missing} provenance-missing (pre-77-4 run → corpus-error)` : ''}\n`,
    )
  }
  if (passCaretK.groups.length > 0) {
    const reliable = passCaretK.groups.filter((g) => g.all_passed).length
    process.stdout.write(`[eval-outcomes] pass^k: ${reliable}/${passCaretK.groups.length} logical cases reliable across all trials\n`)
  }
  process.stdout.write(`[eval-outcomes] report written to ${outputPath}\n`)

  // Gate on REGRESSION only: exit 1 on RED or any corpus errors (AC7).
  // Capability mismatches NEVER fail the build.
  if (rubric === 'RED' || corpusErrorCount > 0) {
    process.exit(1)
  }
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs()
  const projectRoot = args.projectRoot ?? resolveMainRepoRoot(process.cwd())

  // Read corpus
  if (!existsSync(args.corpus)) {
    process.stderr.write(`[eval-outcomes] ERROR: corpus not found at ${args.corpus}\n`)
    process.exit(2)
  }

  let corpusData
  try {
    const raw = readFileSync(args.corpus, 'utf8')
    corpusData = parseOutcomesCorpus(raw)
  } catch (err) {
    process.stderr.write(`[eval-outcomes] ERROR: failed to parse corpus: ${err}\n`)
    process.exit(2)
  }

  // Dry-run mode: validate corpus + run_id resolution only (AC7, AC8)
  if (args.dryRun) {
    process.stdout.write(
      `[eval-outcomes] dry-run: validating ${corpusData.cases.length} corpus entries\n`,
    )
    const { errors, resolved, total } = runDryRun(corpusData, projectRoot)

    process.stdout.write(
      `[eval-outcomes] dry-run: resolved=${resolved.length} / total=${total}\n`,
    )

    if (errors.length > 0) {
      process.stdout.write(
        `[eval-outcomes] dry-run: ${errors.length} corpus-error(s) found:\n`,
      )
      for (const e of errors) {
        process.stdout.write(`  corpus-error [${e.id}]: ${e.reason}\n`)
      }
      process.exit(1)
    }

    process.stdout.write(
      `[eval-outcomes] dry-run PASSED: all ${resolved.length} run_ids resolve to non-running manifests\n`,
    )
    process.stdout.write(
      `[eval-outcomes] dry-run: corpus_version=${corpusData.corpus_version ?? 'unset'}\n`,
    )
    process.exit(0)
  }

  // Full grader mode
  await runFullGrader(corpusData, projectRoot, args)
}

main().catch((err) => {
  process.stderr.write(`[eval-outcomes] FATAL: ${err}\n`)
  process.exit(2)
})
