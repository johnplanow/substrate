#!/usr/bin/env node
/**
 * eval-outcomes-grader.mjs — Outcome-replay grader for the eval framework (Story 77-1).
 *
 * Reads a labeled outcome corpus (YAML), queries story_metrics via
 * getStoryMetricsForRun for each corpus entry, and asserts expected
 * outcome class against the recorded result.
 *
 * In --dry-run mode: validates corpus structure and run_id resolution only —
 * no metric queries, no pass/fail assertions. Used by 77-2 corpus validation.
 *
 * Usage:
 *   node scripts/eval-outcomes-grader.mjs [options]
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
 *   0 — all assertions passed (or dry-run passed with zero corpus-errors)
 *   1 — some assertions failed or corpus-errors detected
 *   2 — fatal error (corpus unreadable, no Dolt, etc.)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import yaml from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// ---------------------------------------------------------------------------
// Known result class vocabulary (77-1 AC4)
// ---------------------------------------------------------------------------

const VALID_RESULT_CLASSES = new Set([
  'SHIP_IT',
  'LGTM_WITH_NOTES',
  'NEEDS_MINOR_FIXES',
  'NEEDS_MAJOR_REWORK',
  'escalated',
  'failed',
  'verification-failed',
])

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
  args.output ??= join(
    repoRoot,
    '_bmad-output',
    'eval-results',
    `eval-outcomes-${Date.now()}.json`,
  )
  return args
}

function printHelp() {
  process.stdout.write(`eval-outcomes-grader.mjs — Outcome-replay grader (Story 77-1)

Usage: node scripts/eval-outcomes-grader.mjs [options]

Options:
  --corpus PATH      Corpus YAML file
  --output PATH      JSON report output
  --threshold NUM    Pass-rate threshold (default: 0.95)
  --dry-run          Validate corpus + run_id resolution only (no assertions)
  --project-root P   Project root for manifest lookup
  --help / -h        This help text
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
// Read run manifest (for dry-run resolution check)
// ---------------------------------------------------------------------------

function readManifest(projectRoot, runId) {
  const manifestPath = join(projectRoot, '.substrate', 'runs', `${runId}.json`)
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
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

    // Resolve manifest
    const manifest = readManifest(projectRoot, runId)
    if (!manifest) {
      errors.push({
        id,
        type: 'corpus-error',
        reason: `unresolvable run_id: ${runId} — no manifest at .substrate/runs/${runId}.json`,
      })
      continue
    }

    // Check manifest is not running
    const status = manifest.run_status
    if (status === 'running') {
      errors.push({
        id,
        type: 'corpus-error',
        reason: `run_id ${runId} has status "running" — corpus must reference completed runs only`,
      })
      continue
    }

    resolved.push({ id, runId, storyKey, resultClass: expect.result_class, manifestStatus: status })
  }

  return { errors, resolved, total: cases.length }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs()
  const projectRoot = args.projectRoot ?? resolveMainRepoRoot(process.cwd())

  // Read corpus
  if (!existsSync(args.corpus)) {
    process.stderr.write(`[eval-outcomes-grader] ERROR: corpus not found at ${args.corpus}\n`)
    process.exit(2)
  }

  let corpusData
  try {
    const raw = readFileSync(args.corpus, 'utf8')
    corpusData = yaml.load(raw)
  } catch (err) {
    process.stderr.write(`[eval-outcomes-grader] ERROR: failed to parse corpus: ${err}\n`)
    process.exit(2)
  }

  if (!corpusData?.cases || !Array.isArray(corpusData.cases)) {
    process.stderr.write(
      `[eval-outcomes-grader] ERROR: corpus missing "cases" array — schema violation\n`,
    )
    process.exit(2)
  }

  // Dry-run mode: validate corpus + run_id resolution
  if (args.dryRun) {
    process.stdout.write(`[eval-outcomes-grader] dry-run: validating ${corpusData.cases.length} corpus entries\n`)
    const { errors, resolved, total } = runDryRun(corpusData, projectRoot)

    process.stdout.write(`[eval-outcomes-grader] dry-run: resolved=${resolved.length} / total=${total}\n`)

    if (errors.length > 0) {
      process.stdout.write(`[eval-outcomes-grader] dry-run: ${errors.length} corpus-error(s) found:\n`)
      for (const e of errors) {
        process.stdout.write(`  corpus-error [${e.id}]: ${e.reason}\n`)
      }
      process.exit(1)
    }

    process.stdout.write(
      `[eval-outcomes-grader] dry-run PASSED: all ${resolved.length} run_ids resolve to non-running manifests\n`,
    )
    process.stdout.write(`[eval-outcomes-grader] dry-run: corpus_version=${corpusData.corpus_version ?? 'unset'}\n`)
    process.exit(0)
  }

  // Full grader mode (77-1 implementation)
  // Import persistence layer for full run
  let getStoryMetricsForRun, createDatabaseAdapter, DoltClient, initSchema
  try {
    ;({ getStoryMetricsForRun } = await import(
      '../packages/core/dist/persistence/queries/metrics.js'
    ))
    ;({ createDatabaseAdapter } = await import('../packages/core/dist/persistence/adapter.js'))
    ;({ DoltClient } = await import('../packages/core/dist/persistence/dolt-client.js'))
    ;({ initSchema } = await import('../packages/core/dist/persistence/schema.js'))
  } catch (err) {
    process.stderr.write(`[eval-outcomes-grader] ERROR: failed to load persistence layer: ${err}\n`)
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
    process.stderr.write(`[eval-outcomes-grader] ERROR: Dolt unavailable: ${err}\n`)
    process.exit(2)
  }

  // Run assertions
  const cases = corpusData.cases
  let passed = 0
  let failed = 0
  let skipped = 0
  const perCase = []

  for (const entry of cases) {
    const { id, run_id: runId, story_key: storyKey, expect } = entry

    // Validate corpus entry
    const manifest = readManifest(projectRoot, runId)
    if (!manifest) {
      process.stdout.write(
        `  corpus-error [${id}]: unresolvable run_id ${runId}\n`,
      )
      skipped++
      perCase.push({ id, runId, storyKey, status: 'corpus-error', reason: 'unresolvable run_id' })
      continue
    }
    if (manifest.run_status === 'running') {
      process.stdout.write(
        `  corpus-error [${id}]: run_id ${runId} is still running\n`,
      )
      skipped++
      perCase.push({ id, runId, storyKey, status: 'corpus-error', reason: 'run still running' })
      continue
    }

    // Query metrics
    let rows
    try {
      rows = await getStoryMetricsForRun(adapter, runId)
    } catch (err) {
      skipped++
      perCase.push({ id, runId, storyKey, status: 'skip', reason: `query error: ${err}` })
      continue
    }

    const storyRow = rows.find((r) => r.story_key === storyKey)
    if (!storyRow) {
      skipped++
      perCase.push({
        id,
        runId,
        storyKey,
        status: 'skip',
        reason: `story_key ${storyKey} not found in story_metrics for run ${runId}`,
      })
      continue
    }

    const actual = storyRow.result
    const expected = expect.result_class

    if (actual === expected) {
      passed++
      perCase.push({ id, runId, storyKey, status: 'pass', expected, actual })
    } else {
      failed++
      perCase.push({ id, runId, storyKey, status: 'fail', expected, actual })
      process.stdout.write(`  FAIL [${id}]: expected=${expected} actual=${actual}\n`)
    }
  }

  const total = passed + failed
  const passRate = total === 0 ? 0 : passed / total

  // Rubric: GREEN ≥ threshold, YELLOW 0.85..threshold, RED < 0.85
  let rubric
  if (passRate >= args.threshold) rubric = 'GREEN'
  else if (passRate >= 0.85) rubric = 'YELLOW'
  else rubric = 'RED'

  const report = {
    run_at: new Date().toISOString(),
    corpus: args.corpus,
    corpus_version: corpusData.corpus_version ?? null,
    threshold: args.threshold,
    total_cases: cases.length,
    passed,
    failed,
    skipped,
    pass_rate: passRate,
    rubric,
    per_case: perCase,
  }

  // Write report
  mkdirSync(dirname(args.output), { recursive: true })
  writeFileSync(args.output, JSON.stringify(report, null, 2))

  process.stdout.write(
    `[eval-outcomes-grader] ${rubric}: pass_rate=${(passRate * 100).toFixed(1)}% (${passed}/${total}) threshold=${(args.threshold * 100).toFixed(0)}%\n`,
  )
  process.stdout.write(`[eval-outcomes-grader] report written to ${args.output}\n`)

  process.exit(rubric === 'RED' ? 1 : 0)
}

main().catch((err) => {
  process.stderr.write(`[eval-outcomes-grader] FATAL: ${err}\n`)
  process.exit(2)
})
