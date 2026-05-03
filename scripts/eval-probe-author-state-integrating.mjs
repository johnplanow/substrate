#!/usr/bin/env node
/**
 * eval-probe-author-state-integrating — State-integrating defect eval harness (Story 65-3).
 *
 * Reads the pure-YAML state-integrating defect corpus, dispatches probe-author
 * against each entry's source AC, applies signature regex constraints to the
 * authored probes, computes catch rate, writes a structured report.
 *
 * Per-entry workflow:
 *   1. Load corpus from pure YAML file (not markdown-with-embedded-YAML like v1)
 *   2. For each applicable entry: dispatch probe-author with the entry's
 *      source_ac as input (or use mock_authored_probes in --dry-run mode)
 *   3. Apply each entry's `signature` (list of regexes) — an entry is
 *      "caught" when at least one authored probe's serialized JSON form
 *      matches ALL signature regexes
 *   4. Emit per-case NDJSON line to stdout
 *   5. Aggregate: catch rate = caught_entries / applicable_entries
 *   6. Write JSON report; print summary; exit 0 if rate >= threshold
 *
 * This script is a sibling to scripts/eval-probe-author.mjs (v1 A/B harness
 * from Story 60-14d). Do NOT modify that script — its 4/4 catch rate is
 * empirically validated under v0.20.39 and is a load-bearing baseline.
 *
 * Usage:
 *   node scripts/eval-probe-author-state-integrating.mjs [options]
 *
 * Options:
 *   --corpus <path>     Path to corpus YAML (default: packs/bmad/eval/...)
 *   --output <path>     Path to write JSON report (default: timestamped)
 *   --threshold <n>     Catch rate threshold for exit-0 (default: 0.5)
 *   --dry-run           Skip probe-author dispatch; use mock_authored_probes
 *   --list-cases        List all corpus case IDs and descriptions then exit
 *   --help / -h         Show this help
 *
 * Model pinning:
 *   The probe-author dispatch subcommand inherits the default model from the
 *   claude-code agent backend. There is currently no --model override on the
 *   dispatch subcommand. Update PINNED_MODEL below if the dispatch subcommand
 *   gains a --model flag in a future sprint.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import yaml from 'js-yaml'

import { evaluateSignature, computeCatchRate } from './eval-probe-author/lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * PINNED_MODEL: The probe-author dispatch subcommand currently inherits the
 * default claude-code agent backend model. The dispatch subcommand does not
 * expose a --model flag (as of v0.20.49). If a --model override is added to
 * `substrate probe-author dispatch`, update this constant and wire it into
 * dispatchProbeAuthor() via an additional CLI argument.
 *
 * The current default model used by the claude-code agent is:
 *   claude-sonnet-4-5 (or whichever model the claude CLI defaults to)
 *
 * Update this constant whenever the project rotates probe-author's model.
 */
const PINNED_MODEL = 'claude-sonnet-4-5'

/**
 * Token pricing for cost_usd computation (USD per million tokens).
 * These match anthropic's published rates for PINNED_MODEL.
 * Update alongside PINNED_MODEL when the model rotates.
 *
 * claude-sonnet-4-5: $3.00 / 1M input, $15.00 / 1M output
 */
const TOKEN_RATES = {
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = {
    corpus: null,
    output: null,
    threshold: 0.5,
    dryRun: false,
    listCases: false,
    help: false,
  }
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i]
    if (arg === '--corpus') args.corpus = process.argv[++i]
    else if (arg === '--output') args.output = process.argv[++i]
    else if (arg === '--threshold') args.threshold = Number.parseFloat(process.argv[++i])
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--list-cases') args.listCases = true
    else if (arg === '--help' || arg === '-h') {
      args.help = true
    }
  }
  args.corpus ??= join(
    repoRoot,
    'packs',
    'bmad',
    'eval',
    'probe-author-state-integrating-corpus.yaml',
  )
  args.output ??= join(repoRoot, `eval-si-${Date.now()}.json`)
  return args
}

function printHelpAndExit(code) {
  process.stdout.write(
    `eval-probe-author-state-integrating — State-integrating defect eval harness (Story 65-3)

Usage:
  node scripts/eval-probe-author-state-integrating.mjs [options]

Options:
  --corpus <path>     Path to corpus YAML (default: packs/bmad/eval/probe-author-state-integrating-corpus.yaml)
  --output <path>     Path to write JSON report (default: timestamped in repo root)
  --threshold <n>     Catch rate threshold for exit-0 (default: 0.5)
  --dry-run           Skip probe-author dispatch; use mock_authored_probes from corpus
                      (for eval-logic testing without LLM cost)
  --list-cases        Print each case id and description, then exit 0
  -h, --help          Show this help

Decision rubric (same as v1 harness):
  >= 0.5    GREEN — Phase 3 dispatch authorized (Epic 65 ships)
  0.3-0.5   YELLOW — Phase 3 paused for prompt iteration
  < 0.3     RED — Phase 3 aborted; reconsider approach

Pinned model: ${PINNED_MODEL}
`,
  )
  process.exit(code)
}

// ---------------------------------------------------------------------------
// Corpus loading and validation
// ---------------------------------------------------------------------------

/**
 * Parse the state-integrating corpus from a pure YAML file.
 *
 * Unlike v1's parseMachineCorpus() which extracts YAML from a markdown
 * fenced block, this function reads the YAML file directly.
 *
 * Validates required fields: id, source_ac, signature (non-empty array),
 * mock_authored_probes (array with ≥1 item).
 *
 * Returns { applicable_entries, excluded_entries }.
 */
export function parseStateIntegratingCorpus(yamlPath) {
  let raw
  try {
    raw = readFileSync(yamlPath, 'utf-8')
  } catch (err) {
    throw new Error(
      `parseStateIntegratingCorpus: failed to read corpus file ${yamlPath}: ${err.message ?? err}`,
    )
  }

  let parsed
  try {
    parsed = yaml.load(raw)
  } catch (err) {
    throw new Error(
      `parseStateIntegratingCorpus: YAML parse error in ${yamlPath}: ${err.message ?? err}`,
    )
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'parseStateIntegratingCorpus: corpus root must be a mapping with applicable_entries',
    )
  }

  const applicable = Array.isArray(parsed.applicable_entries)
    ? parsed.applicable_entries
    : []
  const excluded = Array.isArray(parsed.excluded_entries)
    ? parsed.excluded_entries
    : []

  for (const entry of applicable) {
    if (typeof entry.id !== 'string' || entry.id === '') {
      throw new Error('parseStateIntegratingCorpus: every applicable entry needs a non-empty id')
    }
    if (!entry.source_ac || typeof entry.source_ac !== 'string') {
      throw new Error(
        `parseStateIntegratingCorpus: entry ${entry.id} needs a non-empty source_ac string`,
      )
    }
    if (!Array.isArray(entry.signature) || entry.signature.length === 0) {
      throw new Error(
        `parseStateIntegratingCorpus: entry ${entry.id} needs a non-empty signature list`,
      )
    }
    for (const sig of entry.signature) {
      if (typeof sig !== 'string') {
        throw new Error(
          `parseStateIntegratingCorpus: entry ${entry.id} signature entries must be regex strings, got ${typeof sig}`,
        )
      }
    }
    if (!Array.isArray(entry.mock_authored_probes) || entry.mock_authored_probes.length === 0) {
      throw new Error(
        `parseStateIntegratingCorpus: entry ${entry.id} needs at least one mock_authored_probe`,
      )
    }
  }

  return { applicable_entries: applicable, excluded_entries: excluded }
}

// ---------------------------------------------------------------------------
// Cost computation
// ---------------------------------------------------------------------------

/**
 * Compute cost in USD from token usage.
 * Uses TOKEN_RATES constants for PINNED_MODEL.
 */
function computeCostUsd(tokenUsage) {
  if (!tokenUsage) return 0
  const inputTokens = tokenUsage.input ?? 0
  const outputTokens = tokenUsage.output ?? 0
  return (
    (inputTokens * TOKEN_RATES.inputPerMillion) / 1_000_000 +
    (outputTokens * TOKEN_RATES.outputPerMillion) / 1_000_000
  )
}

// ---------------------------------------------------------------------------
// Probe-author dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch probe-author against a single entry's source_ac.
 *
 * Replicates the pattern from scripts/eval-probe-author.mjs's
 * dispatchProbeAuthor() function. Writes a temp story file, invokes
 * `substrate probe-author dispatch --story-file ... --bypass-gates
 * --output-format json`, parses the JSON response.
 *
 * In --dry-run mode, returns the entry's mock_authored_probes directly
 * without any subprocess invocation.
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
  const entryTmpDir = mkdtempSync(join(tmpdir(), `eval-si-${entry.id}-`))
  const storyFile = join(entryTmpDir, 'story.md')

  // Frame the source AC as a minimal story-shaped artifact.
  // Probe-author's Gate 1 (event-driven detection) operates on epic content;
  // we pass the same content for both. Gate 2 (idempotency) reads the story
  // file for an existing ## Runtime Probes section — there isn't one, so the
  // dispatch proceeds. --bypass-gates skips both gates for this eval.
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
        '--bypass-gates',
      ],
      {
        encoding: 'utf-8',
        // Inherit stderr so probe-author's progress logs flow to terminal;
        // capture only stdout (the JSON payload).
        stdio: ['ignore', 'pipe', 'inherit'],
        // Long timeout — probe-author can take 2-5 min including retry budget.
        timeout: 600_000,
        env: {
          ...process.env,
          // Silence pino debug logs that would otherwise pollute stdout.
          LOG_LEVEL: 'silent',
        },
      },
    )
  } catch (err) {
    // Subcommand exited non-zero. Record as "missed" with empty probe set.
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
      `eval-si: failed to parse subcommand JSON for entry ${entry.id}\nraw stdout: ${stdout}\n`,
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

  if (args.help) {
    printHelpAndExit(0)
  }

  const corpus = parseStateIntegratingCorpus(args.corpus)

  // --list-cases: print each case id and description, then exit 0.
  // No dispatch, no dry-run overhead. Enables lightweight corpus verification in CI.
  if (args.listCases) {
    for (const entry of corpus.applicable_entries) {
      process.stdout.write(`${entry.id}: ${entry.description ?? '(no description)'}\n`)
    }
    process.exit(0)
  }

  process.stderr.write(
    `eval-si: corpus loaded — ${corpus.applicable_entries.length} applicable entries, ${corpus.excluded_entries.length} excluded\n`,
  )
  if (args.dryRun) {
    process.stderr.write('eval-si: --dry-run mode — using mock_authored_probes, no dispatch\n')
  }

  const perCase = []
  for (const entry of corpus.applicable_entries) {
    process.stderr.write(`  evaluating ${entry.id}...\n`)

    const dispatchStart = Date.now()
    let dispatchOutcome = {
      probes: [],
      result: 'unknown',
      tokenUsage: { input: 0, output: 0 },
      durationMs: 0,
    }
    let dispatchError = null

    try {
      dispatchOutcome = await dispatchProbeAuthor(entry, args)
    } catch (err) {
      dispatchError = err instanceof Error ? err.message : String(err)
    }

    if (dispatchOutcome.error !== undefined && dispatchError === null) {
      dispatchError = dispatchOutcome.error
    }

    const wallClockMs = args.dryRun ? 0 : (Date.now() - dispatchStart)
    const authoredProbes = dispatchOutcome.probes
    const evalResult = evaluateSignature(authoredProbes, entry.signature)
    const costUsd = computeCostUsd(dispatchOutcome.tokenUsage)

    // Build failure_reason when not caught
    let failureReason = undefined
    if (!evalResult.matched) {
      if (dispatchError !== null) {
        failureReason = dispatchError
      } else if (authoredProbes.length === 0) {
        failureReason = 'no probes authored'
      } else {
        // Find the first unmatched signature regex
        const compiled = entry.signature.map((s) => new RegExp(s))
        const firstUnmatched = entry.signature.find(
          (_, idx) =>
            !authoredProbes.some((probe) => compiled[idx].test(JSON.stringify(probe))),
        )
        failureReason = `no authored probe matched signature${firstUnmatched ? ' (first unmatched: ' + firstUnmatched + ')' : ''}`
      }
    }

    const caseResult = {
      case_id: entry.id,
      caught: evalResult.matched,
      cost_usd: costUsd,
      wall_clock_ms: wallClockMs,
      probe_count: authoredProbes.length,
      ...(failureReason !== undefined ? { failure_reason: failureReason } : {}),
    }

    // Emit per-case NDJSON line to stdout
    process.stdout.write(JSON.stringify(caseResult) + '\n')

    perCase.push(caseResult)
  }

  const { catchRate, caught, total } = computeCatchRate(
    perCase.map((c) => ({ caught: c.caught })),
  )
  const decision =
    catchRate >= 0.5 ? 'GREEN' : catchRate >= 0.3 ? 'YELLOW' : 'RED'

  const totalCostUsd = perCase.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0)
  const totalWallClockMs = perCase.reduce((sum, c) => sum + (c.wall_clock_ms ?? 0), 0)

  const report = {
    timestamp: new Date().toISOString(),
    substrate_version: readPackageVersion(),
    corpus_path: args.corpus,
    threshold: args.threshold,
    dry_run: args.dryRun,
    catch_rate: catchRate,
    total_cost_usd: totalCostUsd,
    total_wall_clock_ms: totalWallClockMs,
    per_case: perCase,
    decision,
    // Include top-level caught/total for readability
    caught,
    total,
  }

  writeFileSync(args.output, JSON.stringify(report, null, 2), 'utf-8')

  process.stderr.write(
    `\neval-si: catch rate ${(catchRate * 100).toFixed(1)}% (${caught}/${total}) — ${decision}\n`,
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

// Only run main() when this script is executed directly (not imported as a module).
// This guard is required because parseStateIntegratingCorpus is exported for unit
// tests — without it, importing the function would also invoke main() and trigger
// probe-author dispatch.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`eval-si: fatal error\n${err.stack ?? err}\n`)
    process.exit(2)
  })
}
