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

import { readFileSync, writeFileSync } from 'node:fs'
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
 * Dispatch probe-author against a single entry's source_ac. In a future
 * iteration this will call substrate's runProbeAuthor() programmatically;
 * for now (Sprint 18 ship) the implementation is a placeholder that
 * returns mock_authored_probes from the entry, gated on --dry-run.
 *
 * Operators running the eval for real should --dry-run first to verify
 * the eval-logic, then implement the actual dispatch (substrate's
 * runProbeAuthor is in src/modules/implementation-orchestrator/
 * probe-author-integration.ts).
 */
async function dispatchProbeAuthor(entry, opts) {
  if (opts.dryRun) {
    return entry.mock_authored_probes ?? []
  }
  // Real dispatch — placeholder until programmatic invocation is wired.
  // Operator must extend this stub OR run probe-author from a substrate
  // session and capture the artifact, then re-run with --dry-run.
  throw new Error(
    `eval-probe-author: real dispatch not yet wired. Use --dry-run with
mock_authored_probes embedded in the corpus to validate eval logic, OR
extend dispatchProbeAuthor() in scripts/eval-probe-author.mjs to call
substrate's runProbeAuthor() programmatically.`,
  )
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
  for (const entry of corpus.applicable_entries) {
    process.stderr.write(`  evaluating ${entry.id}...\n`)
    let authoredProbes = []
    let dispatchError = null
    try {
      authoredProbes = await dispatchProbeAuthor(entry, args)
    } catch (err) {
      dispatchError = err instanceof Error ? err.message : String(err)
    }

    const evalResult = evaluateSignature(authoredProbes, entry.signature)
    perDefect.push({
      id: entry.id,
      story_key: entry.story_key,
      caught: evalResult.matched,
      matchingProbe: evalResult.matchingProbeName,
      authoredProbeCount: authoredProbes.length,
      authoredProbeNames: authoredProbes.map((p) => p.name),
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
    catchRate,
    caught,
    total,
    decision,
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
