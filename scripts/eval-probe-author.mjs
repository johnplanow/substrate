#!/usr/bin/env node
/**
 * eval-probe-author — A/B validation harness oracle (Story 60-14d).
 *
 * Reads the defect-replay corpus, dispatches probe-author against each
 * entry's source AC, applies the signature regex constraints to the
 * authored probes, computes catch rate, writes a structured report.
 *
 * Per-entry workflow:
 *   1. Extract the YAML "Machine corpus" block from the corpus markdown
 *   2. For each applicable entry: dispatch probe-author with the entry's
 *      source_ac as input, capture the resulting probe set
 *   3. Apply each entry's `signature` (list of regexes) — an entry is
 *      "caught" when at least one authored probe's serialized JSON form
 *      matches ALL signature regexes
 *   4. Aggregate: catch rate = caught_entries / applicable_entries
 *   5. Write JSON report; print summary; exit 0 if rate ≥ threshold
 *
 * Usage:
 *   node scripts/eval-probe-author.mjs [--corpus PATH] [--output PATH]
 *                                       [--threshold 0.5] [--dry-run]
 *
 * --dry-run skips the actual probe-author dispatch (use the embedded
 * `mock_authored_probes` field on each entry for testing the eval logic
 * without burning LLM cost).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import yaml from 'js-yaml'

import {
  parseMachineCorpus,
  evaluateSignature,
  computeCatchRate,
} from './eval-probe-author/lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = { corpus: null, output: null, threshold: 0.5, dryRun: false }
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i]
    if (arg === '--corpus') args.corpus = process.argv[++i]
    else if (arg === '--output') args.output = process.argv[++i]
    else if (arg === '--threshold') args.threshold = Number.parseFloat(process.argv[++i])
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0)
    }
  }
  args.corpus ??= join(
    repoRoot,
    '_bmad-output',
    'planning-artifacts',
    'probe-author-defect-corpus.md',
  )
  args.output ??= join(repoRoot, `eval-probe-author-${Date.now()}.json`)
  return args
}

function printHelpAndExit(code) {
  process.stdout.write(
    `eval-probe-author — A/B validation harness oracle (Story 60-14d)

Usage:
  node scripts/eval-probe-author.mjs [options]

Options:
  --corpus <path>     Path to corpus markdown (default: planning-artifacts)
  --output <path>     Path to write JSON report (default: timestamped)
  --threshold <n>     Catch rate threshold for exit-0 (default: 0.5)
  --dry-run           Skip probe-author dispatch; use mock probes
                      embedded in the corpus (for eval-logic testing)
  -h, --help          Show this help

Decision rubric per probe-author-validation-protocol.md:
  >= 0.5    GREEN — Phase 2 continues (60-15, 60-16 ship)
  0.3-0.5   YELLOW — Phase 2 paused for prompt iteration
  < 0.3     RED — Phase 2 aborted; Phase 3 alternatives considered
`,
  )
  process.exit(code)
}

// ---------------------------------------------------------------------------
// Probe-author dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch probe-author against a single entry's source_ac. Per-entry
 * workflow:
 *   1. Write a temp story-file containing the entry's source AC framed
 *      as a story body (probe-author's Gate 1 reads `epicContent` for
 *      event-driven detection — we pass the source_ac as both the
 *      story body and the epic content).
 *   2. Shell out to `substrate probe-author dispatch --story-file
 *      <temp> --output-format json` (Story 60-14e). The subcommand
 *      sets up the full WorkflowDeps + runs probe-author + parses the
 *      authored probes from the resulting artifact.
 *   3. Parse the subcommand's stdout JSON, return the probes array.
 *
 * --dry-run still reads `mock_authored_probes` from the entry for
 * eval-logic validation without LLM cost.
 */
async function dispatchProbeAuthor(entry, opts) {
  if (opts.dryRun) {
    return {
      probes: entry.mock_authored_probes ?? [],
      result: 'success',
      tokenUsage: { input: 0, output: 0 },
      durationMs: 0,
    }
  }

  // Per-entry temp dir so each dispatch is isolated.
  const entryTmpDir = mkdtempSync(join(tmpdir(), `eval-probe-author-${entry.id}-`))
  const storyFile = join(entryTmpDir, 'story.md')

  // Frame the source AC as a minimal story-shaped artifact. Probe-author's
  // Gate 1 (event-driven detection) operates on the epic content; we pass
  // the same content for both. Gate 2 (idempotency) reads the story file
  // for an existing ## Runtime Probes section — there isn't one, so the
  // dispatch proceeds.
  const storyContent = `# Eval entry ${entry.id}\n\n## Story\n\n${entry.source_ac}\n\n## Acceptance Criteria\n\n${entry.source_ac}\n`
  writeFileSync(storyFile, storyContent, 'utf-8')

  let stdout
  try {
    stdout = execFileSync(
      'node',
      [
        join(repoRoot, 'dist/cli/index.js'),
        'probe-author',
        'dispatch',
        '--story-file',
        storyFile,
        '--story-key',
        entry.id,
        '--output-format',
        'json',
        // The eval measures authoring quality across all defect classes,
        // not the production dispatch gating. Bypass Gate 1 (event-driven
        // detection) so non-event-driven entries (obs_011 tool count,
        // obs_012 error envelope) get probe-author dispatched against
        // them too. The corpus signature predicates do the actual
        // assessment of probe quality.
        '--bypass-gates',
      ],
      {
        encoding: 'utf-8',
        // Inherit stderr so probe-author's progress logs flow to the
        // terminal; capture only stdout (the JSON payload).
        stdio: ['ignore', 'pipe', 'inherit'],
        // Long timeout — probe-author can take 2-5 min including retry budget.
        timeout: 600_000,
        env: {
          ...process.env,
          // Silence pino debug logs that would otherwise pollute the
          // subcommand's stdout. The dispatcher's "Agent dispatched" /
          // "Agent completed" debug logs go to stdout under pino's
          // default destination — without this they'd be interleaved
          // with the JSON payload and break JSON.parse downstream.
          LOG_LEVEL: 'silent',
        },
      },
    )
  } catch (err) {
    // Subcommand exited non-zero (skip / failed). The eval still wants
    // to record this as a "missed" outcome for the entry, with the
    // empty probe set; rethrow only on truly catastrophic errors (e.g.,
    // node binary missing).
    if (err.stdout) {
      stdout = err.stdout.toString()
    } else {
      try { rmSync(entryTmpDir, { recursive: true, force: true }) } catch {}
      throw err
    }
  }

  try { rmSync(entryTmpDir, { recursive: true, force: true }) } catch {}

  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (parseErr) {
    process.stderr.write(
      `eval-probe-author: failed to parse subcommand JSON for entry ${entry.id}\nraw stdout: ${stdout}\n`,
    )
    return { probes: [], result: 'parse-error', tokenUsage: { input: 0, output: 0 }, durationMs: 0 }
  }

  return {
    probes: Array.isArray(parsed.probes) ? parsed.probes : [],
    result: parsed.result ?? 'unknown',
    error: parsed.error,
    tokenUsage: parsed.tokenUsage ?? { input: 0, output: 0 },
    durationMs: parsed.durationMs ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs()

  const corpusContent = readFileSync(args.corpus, 'utf-8')
  const corpus = parseMachineCorpus(corpusContent)

  process.stderr.write(
    `eval-probe-author: corpus loaded — ${corpus.applicable_entries.length} applicable entries, ${corpus.excluded_entries.length} excluded\n`,
  )

  const perDefect = []
  let aggregateTokenUsage = { input: 0, output: 0 }
  let aggregateDurationMs = 0
  for (const entry of corpus.applicable_entries) {
    process.stderr.write(`  evaluating ${entry.id}...\n`)
    let dispatchOutcome = { probes: [], result: 'unknown', tokenUsage: { input: 0, output: 0 }, durationMs: 0 }
    let dispatchError = null
    try {
      dispatchOutcome = await dispatchProbeAuthor(entry, args)
    } catch (err) {
      dispatchError = err instanceof Error ? err.message : String(err)
    }
    if (dispatchOutcome.error !== undefined && dispatchError === null) {
      dispatchError = dispatchOutcome.error
    }

    const authoredProbes = dispatchOutcome.probes
    const evalResult = evaluateSignature(authoredProbes, entry.signature)
    aggregateTokenUsage.input += dispatchOutcome.tokenUsage?.input ?? 0
    aggregateTokenUsage.output += dispatchOutcome.tokenUsage?.output ?? 0
    aggregateDurationMs += dispatchOutcome.durationMs ?? 0

    perDefect.push({
      id: entry.id,
      story_key: entry.story_key,
      caught: evalResult.matched,
      matchingProbe: evalResult.matchingProbeName,
      authoredProbeCount: authoredProbes.length,
      authoredProbeNames: authoredProbes.map((p) => p.name),
      dispatchResult: dispatchOutcome.result,
      dispatchTokenUsage: dispatchOutcome.tokenUsage,
      dispatchDurationMs: dispatchOutcome.durationMs,
      dispatchError,
    })
  }

  const { catchRate, caught, total } = computeCatchRate(perDefect)
  const decision =
    catchRate >= 0.5 ? 'GREEN' : catchRate >= 0.3 ? 'YELLOW' : 'RED'

  const report = {
    timestamp: new Date().toISOString(),
    substrate_version: readPackageVersion(),
    corpus_path: args.corpus,
    threshold: args.threshold,
    dry_run: args.dryRun,
    catchRate,
    caught,
    total,
    decision,
    aggregate_token_usage: aggregateTokenUsage,
    aggregate_duration_ms: aggregateDurationMs,
    perDefect,
  }

  writeFileSync(args.output, JSON.stringify(report, null, 2), 'utf-8')

  process.stderr.write(
    `\neval-probe-author: catch rate ${(catchRate * 100).toFixed(1)}% (${caught}/${total}) — ${decision}\n`,
  )
  process.stderr.write(`report written to: ${args.output}\n`)

  process.exit(catchRate >= args.threshold ? 0 : 1)
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))
    return pkg.version
  } catch {
    return 'unknown'
  }
}

main().catch((err) => {
  process.stderr.write(`eval-probe-author: fatal error\n${err.stack ?? err}\n`)
  process.exit(2)
})
