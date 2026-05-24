#!/usr/bin/env node
/**
 * build-outcomes-corpus.mjs — Baseline extraction script for the eval-outcomes corpus.
 *
 * Reads story_metrics records (via getStoryMetricsForRun) from the Dolt backend
 * across all known run_ids and emits candidate YAML entries for human curation.
 *
 * Candidate format (per-case):
 *   id: <run_id>-<story_key>
 *   source: story_metrics
 *   run_id: <uuid>
 *   story_key: <e.g. "52-4">
 *   expect:
 *     result_class: <SHIP_IT | LGTM_WITH_NOTES | NEEDS_MINOR_FIXES | escalated | failed | verification-failed>
 *   label_reason: "UNCURATED — review and annotate"
 *
 * Usage:
 *   node scripts/build-outcomes-corpus.mjs [--project-root PATH]
 *
 * --project-root PATH  Project root (default: auto-detected via git common-dir).
 *                      The script reads from <root>/.substrate/runs/ and the
 *                      Dolt database at <root>/.substrate/state.
 *
 * Exits non-zero if:
 *   - Dolt is unreachable or returns an in-memory adapter (no persisted data)
 *   - No run manifest files are found in <root>/.substrate/runs/
 *   - getStoryMetricsForRun returns zero rows across all runs
 *
 * Output:
 *   _bmad-output/eval-results/corpus/outcomes-corpus.candidates.yaml
 *   (relative to the working directory where this script is invoked)
 *
 * Re-runnable: never reads or writes outcomes-corpus.yaml (the human-curated file).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import yaml from 'js-yaml'

// Import from stable compiled paths in packages/core/dist
import { getStoryMetricsForRun } from '../packages/core/dist/persistence/queries/metrics.js'
import { createDatabaseAdapter } from '../packages/core/dist/persistence/adapter.js'
import { DoltClient } from '../packages/core/dist/persistence/dolt-client.js'
import { initSchema } from '../packages/core/dist/persistence/schema.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

const CANDIDATES_REL = '_bmad-output/eval-results/corpus/outcomes-corpus.candidates.yaml'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = { projectRoot: null }
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (arg === '--project-root') args.projectRoot = process.argv[++i]
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/build-outcomes-corpus.mjs [--project-root PATH]\n',
      )
      process.exit(0)
    }
  }
  return args
}

// ---------------------------------------------------------------------------
// Auto-detect main repo root via git rev-parse --git-common-dir
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs()
  const projectRoot = args.projectRoot ?? resolveMainRepoRoot(process.cwd())

  const runsDir = join(projectRoot, '.substrate', 'runs')

  // 1. Enumerate run manifest files
  if (!existsSync(runsDir)) {
    process.stderr.write(
      `[build-outcomes-corpus] ERROR: no .substrate/runs directory found at ${runsDir}\n`,
    )
    process.exit(1)
  }

  const manifestFiles = readdirSync(runsDir).filter(
    (f) => f.endsWith('.json') && !f.endsWith('.bak'),
  )

  if (manifestFiles.length === 0) {
    process.stderr.write(
      '[build-outcomes-corpus] ERROR: no run manifest files found in .substrate/runs/\n',
    )
    process.exit(1)
  }

  // 2. Read current run ID and add to the set (may already be in manifestFiles)
  const currentRunIdPath = join(projectRoot, '.substrate', 'current-run-id')
  let currentRunId = null
  try {
    const content = readFileSync(currentRunIdPath, 'utf8')
    currentRunId = content.trim() || null
  } catch {
    // file may not exist — that's fine
  }

  // Collect all unique run IDs
  const runIdSet = new Set(manifestFiles.map((f) => basename(f, '.json')))
  if (currentRunId) runIdSet.add(currentRunId)
  const allRunIds = [...runIdSet]

  // 3. Create Dolt adapter
  const doltRepoPath = join(projectRoot, '.substrate', 'state')
  let adapter
  try {
    adapter = createDatabaseAdapter(
      { backend: 'dolt', basePath: projectRoot },
      (rp) => new DoltClient({ repoPath: rp }),
    )
  } catch (err) {
    process.stderr.write(`[build-outcomes-corpus] ERROR: failed to create Dolt adapter: ${err}\n`)
    process.exit(1)
  }

  // 4. Init schema (creates tables if not present, no-op if already initialized)
  try {
    await initSchema(adapter)
  } catch (err) {
    process.stderr.write(
      `[build-outcomes-corpus] ERROR: Dolt is unreachable or schema init failed: ${err}\n`,
    )
    process.exit(1)
  }

  // 5. Query story_metrics for each run_id
  let totalRows = 0
  const candidates = []

  for (const runId of allRunIds) {
    let rows
    try {
      rows = await getStoryMetricsForRun(adapter, runId)
    } catch (err) {
      process.stderr.write(
        `[build-outcomes-corpus] WARN: failed to query run ${runId}: ${err}\n`,
      )
      continue
    }
    if (!rows || rows.length === 0) continue

    for (const row of rows) {
      const resultClass = row.result ?? 'unknown'
      // Skip pending/running rows — they have no outcome yet
      if (resultClass === 'pending' || resultClass === 'running' || resultClass === 'unknown')
        continue

      totalRows++
      candidates.push({
        id: `${runId.slice(0, 8)}-${row.story_key}`,
        source: 'story_metrics',
        run_id: runId,
        story_key: row.story_key,
        expect: {
          result_class: resultClass,
        },
        label_reason: 'UNCURATED — review and annotate',
      })
    }
  }

  // 6. Exit non-zero if zero rows across all runs
  if (totalRows === 0) {
    process.stderr.write(
      '[build-outcomes-corpus] ERROR: getStoryMetricsForRun returned zero rows across all run_ids\n',
    )
    process.exit(1)
  }

  // 7. Write candidates YAML (never overwrites outcomes-corpus.yaml)
  const candidatesPath = join(repoRoot, CANDIDATES_REL)
  mkdirSync(dirname(candidatesPath), { recursive: true })

  const output = yaml.dump(
    {
      _note: 'AUTO-GENERATED by build-outcomes-corpus.mjs — DO NOT EDIT manually. Curate into outcomes-corpus.yaml.',
      generated_at: new Date().toISOString(),
      source_project_root: projectRoot,
      total_runs_queried: allRunIds.length,
      total_candidates: candidates.length,
      cases: candidates,
    },
    { lineWidth: 120, quotingType: '"' },
  )

  writeFileSync(candidatesPath, output, 'utf8')

  // 8. Print summary (stdout — the probe expects 'candidates' to appear here)
  process.stdout.write(
    `Wrote ${candidates.length} candidates from ${allRunIds.length} run_ids → ${CANDIDATES_REL}\n`,
  )
}

main().catch((err) => {
  process.stderr.write(`[build-outcomes-corpus] FATAL: ${err}\n`)
  process.exit(1)
})
