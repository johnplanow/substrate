/**
 * `substrate reconcile-from-disk` command — Story 69-1.
 *
 * Reconciles wg_stories.status against actual working-tree and git history state.
 * Provides automated recovery from Path A incidents (orchestrator-death mid-dispatch)
 * without requiring manual Dolt row updates or re-running already-completed work.
 *
 * Motivating incidents:
 *   - Epic 66 (run a832487a): orchestrator died mid-dispatch, 7 stories completed
 *     but status not persisted to Dolt. Manual 7-step recovery procedure required.
 *   - Epic 67 (run a59e4c96): cross-story-interaction concurrent dispatch race
 *     caused false pipeline failure verdicts. Manual Path A reconciliation needed.
 *   - Epic 68 (run a59e4c96-13e0-4727-8f46-6aa95a7e134c): same Path A class —
 *     working-tree files durable, pipeline failure verdicts misleading after race.
 *
 * This command is the foundation primitive for Epic 70 / 73 automated recovery.
 * Per Story 60-4/60-10 header comment convention.
 *
 * Usage:
 *   substrate reconcile-from-disk [--run-id <id>] [--dry-run] [--yes]
 *                                  [--output-format <human|json>]
 *                                  [--project-root <path>]
 */

import type { Command } from 'commander'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { spawnSync } from 'node:child_process'
import * as readline from 'node:readline'
import { EventEmitter } from 'node:events'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import { readCurrentRunId, resolveRunManifest } from './manifest-read.js'
import { swallowDebug } from '@substrate-ai/core'
import { getLatestRun } from '../../persistence/queries/decisions.js'
import { createLogger } from '../../utils/logger.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'

const logger = createLogger('reconcile-from-disk')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Pattern for detecting auto-committed story work in git log.
 * Matches commits like "feat(story-69-1): ..." following substrate's dev-story
 * auto-commit convention (Story 66 / 67 auto-commit observations).
 */
export const FEAT_COMMIT_PATTERN = /^feat\(story-([0-9]+-[0-9]+)\)/m

/** 64KB tail window for capturing subprocess stderr/stdout (Story 66-5 pattern). */
const MAX_OUTPUT_BYTES = 64 * 1024

/**
 * Gate chain definition — each gate runs in order. On any failure the chain
 * halts and emits pipeline:reconcile-gate-failed before exiting with code 1.
 */
const GATE_CHAIN = [
  { name: 'build', cmd: 'npm', args: ['run', 'build'], timeoutMs: 180_000 },
  { name: 'check:circular', cmd: 'npm', args: ['run', 'check:circular'], timeoutMs: 60_000 },
  { name: 'typecheck:gate', cmd: 'npm', args: ['run', 'typecheck:gate'], timeoutMs: 120_000 },
  { name: 'test:fast', cmd: 'npm', args: ['run', 'test:fast'], timeoutMs: 300_000 },
] as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-story entry as reconstructed from the production per-run manifest format
 * `.substrate/runs/<run-id>.json` (RunManifestData.per_story_state). This is
 * the canonical shape consumed by the discovery phase.
 *
 * Hot-fix Story 69-2 note: Story 69-1's original draft used an invented
 * aggregate-manifest format (`.substrate/runs/manifest.json`) that does NOT
 * exist in production. Removed in 69-2; canonical run-discovery now uses
 * the same chain as status.ts/health.ts.
 */
export interface ReconcileRunStory {
  storyKey: string
  status: string
  /** Files declared as targets for this story's implementation (when known) */
  targetFiles?: string[]
}

/** Per-run entry materialized from `.substrate/runs/<run-id>.json` */
export interface ReconcileRunEntry {
  runId: string
  started_at: string
  stories: ReconcileRunStory[]
}

/** Per-story diff record built during the discovery phase (AC3) */
export interface StoryDiffRecord {
  storyKey: string
  autoCommittedSha?: string
  modifiedFiles: string[]
  reconcilable: boolean
}

/** Result from executing a single validation gate */
export interface GateResult {
  gate: string
  passed: boolean
  exitCode: number
  durationMs: number
  stderrTail?: string
  stdoutTail?: string
}

/** Structured JSON output for --output-format json (AC8) */
export interface ReconcileOutput {
  runId: string
  candidates: StoryDiffRecord[]
  gateResults: GateResult[]
  reconciled: boolean
  affectedStoryKeys: string[]
}

/** Options for the reconcile action handler */
export interface ReconcileFromDiskOptions {
  runId?: string
  dryRun?: boolean
  yes?: boolean
  outputFormat: 'human' | 'json'
  projectRoot: string
  /**
   * @internal For unit-testing only — bypasses `resolveMainRepoRoot` so tests
   * can inject a known dbRoot without spawning git. Set this to the desired
   * dbRoot value in tests; production callers must omit it.
   */
  _dbRoot?: string
  /**
   * @internal For integration-testing only — skips the gate chain (build/typecheck/test)
   * so tests that exercise discovery + Dolt write path don't need a real package.json
   * in the fixture directory. Production callers must omit this.
   */
  _skipGates?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string to the last N bytes (tail-window pattern from Story 66-5).
 * Preserves the END of the string, which contains the most recent diagnostic output.
 */
export function tailWindow(s: string, maxBytes: number = MAX_OUTPUT_BYTES): string {
  if (!s) return ''
  if (Buffer.byteLength(s, 'utf-8') <= maxBytes) return s
  const buf = Buffer.from(s, 'utf-8')
  return buf.slice(buf.length - maxBytes).toString('utf-8')
}

/**
 * Materialize a ReconcileRunEntry from a per-run manifest at
 * `.substrate/runs/<run-id>.json`. Returns null if the manifest is absent or
 * malformed.
 */
export async function readRunEntry(
  dbRoot: string,
  resolvedRunId: string,
): Promise<ReconcileRunEntry | null> {
  const { manifest: fullManifest } = await resolveRunManifest(dbRoot, resolvedRunId)
  if (!fullManifest) return null
  try {
    const data = await fullManifest.read()
    const stories: ReconcileRunStory[] = Object.entries(data.per_story_state).map(
      ([key, state]) => ({
        storyKey: key,
        status: state.status,
      }),
    )
    return {
      runId: resolvedRunId,
      started_at: data.created_at,
      stories,
    }
  } catch {
    logger.debug({ runId: resolvedRunId }, 'failed to read individual run manifest')
    return null
  }
}

/**
 * Detect an auto-committed SHA for a story using git log.
 *
 * Searches commits matching `feat(story-<storyKey>)` since started_at using
 * git's --grep filter. Returns the first matching SHA, or undefined if none found.
 *
 * Git operations use `cwd: projectRoot` (not process.cwd()) to avoid the
 * bash-session-drift footgun documented in obs_025.
 */
export function detectAutoCommit(
  storyKey: string,
  startedAt: string,
  projectRoot: string,
): string | undefined {
  const grepPattern = `feat(story-${storyKey})`
  const result = spawnSync(
    'git',
    ['log', '--oneline', `--since=${startedAt}`, `--grep=${grepPattern}`],
    { cwd: projectRoot, encoding: 'utf-8', timeout: 10_000 },
  )
  if (result.status !== 0 || !result.stdout?.trim()) return undefined

  const lines = result.stdout.trim().split('\n').filter(Boolean)
  for (const line of lines) {
    // git log --oneline format: "<sha> <message>"
    const sha = line.split(' ')[0]
    if (sha) return sha
  }
  return undefined
}

/**
 * Detect working-tree changes for files declared in targetFiles.
 *
 * Runs `git status --porcelain` and cross-references with targetFiles.
 * Returns the list of matching modified/added/deleted paths.
 */
export function detectWorkingTreeChanges(
  targetFiles: string[],
  projectRoot: string,
): string[] {
  if (targetFiles.length === 0) return []

  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: 10_000,
  })
  if (result.status !== 0 || !result.stdout?.trim()) return []

  const modifiedPaths: string[] = []
  // Do NOT trim the full stdout — git status lines may start with a space (e.g. " M path")
  // which is part of the 2-char XY status code. Trimming the whole string would corrupt
  // lines like " M src/foo.ts" → "M src/foo.ts" making slice(3) cut the first char of path.
  const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0)
  for (const line of lines) {
    // git status --porcelain format: "XY path" (XY = 2-char status codes, then space, then path)
    // The XY codes are exactly 2 characters, followed by a space, so path starts at index 3.
    const path = line.length > 3 ? line.slice(3).trim() : line.trim()
    for (const tf of targetFiles) {
      if (path === tf || path.endsWith(`/${tf}`) || tf.endsWith(`/${path}`) || path.endsWith(tf) || tf.endsWith(path)) {
        modifiedPaths.push(path)
        break
      }
    }
  }
  return modifiedPaths
}

/**
 * Run the validation gate chain: build → check:circular → typecheck:gate → test:fast.
 *
 * Each gate uses child_process.spawnSync with an explicit timeout. On any gate
 * failure, stderr/stdout are captured with a 64KB tail-window (Story 66-5 pattern)
 * and the chain halts.
 */
export function runGateChain(projectRoot: string): { passed: boolean; gateResults: GateResult[] } {
  const gateResults: GateResult[] = []

  for (const gate of GATE_CHAIN) {
    const startMs = Date.now()
    const result = spawnSync(gate.cmd, gate.args, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: gate.timeoutMs,
    })
    const durationMs = Date.now() - startMs

    const stderrTail = tailWindow(result.stderr ?? '')
    const stdoutTail = tailWindow(result.stdout ?? '')
    const exitCode = result.status ?? (result.signal ? 128 : -1)
    const passed = result.status === 0 && !result.signal

    gateResults.push({
      gate: gate.name,
      passed,
      exitCode,
      durationMs,
      ...(stderrTail ? { stderrTail } : {}),
      ...(stdoutTail ? { stdoutTail } : {}),
    })

    if (!passed) {
      return { passed: false, gateResults }
    }
  }

  return { passed: true, gateResults }
}

/**
 * Prompt the operator for confirmation before making Dolt writes.
 * Returns true if the operator responds 'y' or 'Y'.
 */
async function promptOperator(storyCount: number): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    rl.question(`Reconcile ${storyCount} stories to status='complete'? [y/N] `, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'y')
    })
  })
}

// ---------------------------------------------------------------------------
// Main action handler
// ---------------------------------------------------------------------------

/**
 * Run the reconcile-from-disk action.
 * Returns exit code: 0 = success/no-op, 1 = error/gate-failure.
 */
export async function runReconcileFromDiskAction(
  options: ReconcileFromDiskOptions,
): Promise<number> {
  const { runId, dryRun = false, yes = false, outputFormat, projectRoot, _dbRoot, _skipGates = false } = options
  const startMs = Date.now()

  // Resolve project root via git root detection (avoids bash-session-drift footgun).
  // _dbRoot is an internal override for unit tests — production callers must omit it.
  const dbRoot = _dbRoot ?? (await resolveMainRepoRoot(projectRoot))

  // ---------------------------------------------------------------------------
  // Run-id resolution (AC2) — Story 69-2 hot-fix.
  //
  // Canonical chain (matches status.ts + health.ts per Story 39-3):
  //   1. Explicit `--run-id` argument
  //   2. `.substrate/current-run-id` file
  //   3. `getLatestRun(adapter)` Dolt fallback
  //
  // Story 69-1's original draft used an invented aggregate-manifest format
  // (`.substrate/runs/manifest.json`) that does NOT exist in production —
  // resulted in "No runs found" against real workstation state. Hot-fix
  // 69-2 replaces with the canonical chain.
  // ---------------------------------------------------------------------------

  let resolvedRunId: string | null = runId ?? null
  if (!resolvedRunId) {
    resolvedRunId = await readCurrentRunId(dbRoot)
  }
  if (!resolvedRunId) {
    // Dolt fallback — temporary adapter just for run-id discovery.
    const probeAdapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
    try {
      await initSchema(probeAdapter)
      const latestRun = await getLatestRun(probeAdapter)
      if (latestRun?.id) resolvedRunId = latestRun.id
    } catch {
      logger.debug('Dolt fallback failed during run-id resolution')
    } finally {
      await probeAdapter.close().catch(swallowDebug('reconcile-probe-close'))
    }
  }

  if (!resolvedRunId) {
    const errorMsg =
      'No runs found. Use `substrate metrics --output-format json` for run history.'
    if (outputFormat === 'json') {
      process.stdout.write(JSON.stringify({ error: errorMsg }) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  // Materialize per-run manifest at .substrate/runs/<run-id>.json (production format).
  const runEntry: ReconcileRunEntry | null = await readRunEntry(dbRoot, resolvedRunId)

  if (!runEntry) {
    const errorMsg = runId
      ? `Run '${runId}' not found. Use \`substrate metrics --output-format json\` for run history.`
      : 'No runs found. Use `substrate metrics --output-format json` for run history.'
    if (outputFormat === 'json') {
      process.stdout.write(JSON.stringify({ error: errorMsg }) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  // ---------------------------------------------------------------------------
  // Idempotency + Discovery phase (AC3, AC9)
  // ---------------------------------------------------------------------------

  // Filter to non-complete, non-cancelled stories
  const candidateStories = runEntry.stories.filter(
    (s) => s.status !== 'complete' && s.status !== 'cancelled',
  )

  // Idempotency: if no candidates, early exit (AC9)
  if (candidateStories.length === 0) {
    const output: ReconcileOutput = {
      runId: resolvedRunId,
      candidates: [],
      gateResults: [],
      reconciled: false,
      affectedStoryKeys: [],
    }
    if (outputFormat === 'json') {
      process.stdout.write(JSON.stringify(output) + '\n')
    } else {
      process.stdout.write(
        `All stories already complete or cancelled for run ${resolvedRunId}.\n`,
      )
    }
    return 0
  }

  // Build per-story diff records
  const diffRecords: StoryDiffRecord[] = []
  for (const story of candidateStories) {
    const autoCommittedSha = detectAutoCommit(
      story.storyKey,
      runEntry.started_at,
      projectRoot,
    )
    const modifiedFiles = detectWorkingTreeChanges(story.targetFiles ?? [], projectRoot)
    const reconcilable = !!(autoCommittedSha || modifiedFiles.length > 0)
    diffRecords.push({
      storyKey: story.storyKey,
      autoCommittedSha,
      modifiedFiles,
      reconcilable,
    })
  }

  // ---------------------------------------------------------------------------
  // Dry-run path (AC6)
  // ---------------------------------------------------------------------------

  if (dryRun) {
    const output: ReconcileOutput = {
      runId: resolvedRunId,
      candidates: diffRecords,
      gateResults: [], // no gates in dry-run
      reconciled: false,
      affectedStoryKeys: [],
    }
    if (outputFormat === 'json') {
      process.stdout.write(JSON.stringify(output) + '\n')
    } else {
      process.stdout.write(`[DRY RUN] Run: ${resolvedRunId}\n`)
      process.stdout.write(
        `Would run gates: ${GATE_CHAIN.map((g) => g.name).join(' → ')}\n`,
      )
      const reconcilable = diffRecords.filter((r) => r.reconcilable)
      process.stdout.write(
        `Would reconcile ${reconcilable.length} of ${diffRecords.length} candidate stories\n`,
      )
      for (const r of diffRecords) {
        const status = r.reconcilable ? '✓ reconcilable' : '✗ not reconcilable'
        const detail = r.autoCommittedSha ? ` (commit: ${r.autoCommittedSha})` : ''
        process.stdout.write(`  ${r.storyKey}: ${status}${detail}\n`)
      }
    }
    return 0
  }

  // ---------------------------------------------------------------------------
  // Validation gate chain (AC4)
  // Note: gates run even when --yes is passed (AC7).
  // _skipGates is an internal testing escape hatch — integration tests that
  // fixture a real git repo but not a full npm project use this to bypass gates.
  // ---------------------------------------------------------------------------

  const { passed, gateResults } = _skipGates
    ? { passed: true, gateResults: [] as GateResult[] }
    : runGateChain(projectRoot)

  if (!passed) {
    const failedGateResult = gateResults.find((g) => !g.passed)
    const failedGateName = failedGateResult?.gate ?? 'unknown'
    const durationMs = Date.now() - startMs

    // Emit pipeline:reconcile-gate-failed event (AC10)
    const localBus = new EventEmitter()
    localBus.emit('pipeline:reconcile-gate-failed', {
      runId: resolvedRunId,
      failedGate: failedGateName,
      stderrTail: failedGateResult?.stderrTail,
      stdoutTail: failedGateResult?.stdoutTail,
      durationMs,
    })

    logger.info(
      {
        runId: resolvedRunId,
        failedGate: failedGateName,
        exitCode: failedGateResult?.exitCode,
      },
      'reconcile-from-disk gate failed',
    )

    const output: ReconcileOutput = {
      runId: resolvedRunId,
      candidates: diffRecords,
      gateResults,
      reconciled: false,
      affectedStoryKeys: [],
    }
    if (outputFormat === 'json') {
      process.stdout.write(JSON.stringify(output) + '\n')
    } else {
      process.stderr.write(
        `Gate '${failedGateName}' failed (exit ${failedGateResult?.exitCode ?? -1}). No Dolt changes made.\n`,
      )
      if (failedGateResult?.stderrTail) {
        process.stderr.write(`--- stderr ---\n${failedGateResult.stderrTail}\n`)
      }
    }
    return 1
  }

  // ---------------------------------------------------------------------------
  // Reconciliation phase (AC5)
  // ---------------------------------------------------------------------------

  const reconcilableRecords = diffRecords.filter((r) => r.reconcilable)

  // Present plan to operator; prompt unless --yes (AC7)
  if (!yes) {
    if (outputFormat === 'human') {
      process.stdout.write(`\nRun: ${resolvedRunId}\n`)
      process.stdout.write(`Stories to reconcile (${reconcilableRecords.length}):\n`)
      for (const r of reconcilableRecords) {
        const detail = r.autoCommittedSha ? ` (commit: ${r.autoCommittedSha})` : ''
        process.stdout.write(`  ${r.storyKey}${detail}\n`)
      }
      process.stdout.write('\n')
    }

    const confirmed = await promptOperator(reconcilableRecords.length)
    if (!confirmed) {
      const output: ReconcileOutput = {
        runId: resolvedRunId,
        candidates: diffRecords,
        gateResults,
        reconciled: false,
        affectedStoryKeys: [],
      }
      if (outputFormat === 'json') {
        process.stdout.write(JSON.stringify(output) + '\n')
      } else {
        process.stdout.write('Reconciliation declined.\n')
      }
      return 0
    }
  }

  // Write to Dolt: update all candidate stories' status to 'complete' (AC5)
  const adapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
  try {
    await initSchema(adapter)
    const now = new Date().toISOString()
    await adapter.transaction(async (tx) => {
      for (const record of reconcilableRecords) {
        await tx.query(
          "UPDATE wg_stories SET status='complete', updated_at=? WHERE story_key=? AND run_id=?",
          [now, record.storyKey, resolvedRunId],
        )
      }
    })
    logger.info(
      { runId: resolvedRunId, affectedStories: reconcilableRecords.map((r) => r.storyKey) },
      'reconcile-from-disk: Dolt update complete',
    )
  } finally {
    await adapter.close().catch(swallowDebug('reconcile-adapter-close'))
  }

  const durationMs = Date.now() - startMs
  const affectedStoryKeys = reconcilableRecords.map((r) => r.storyKey)

  // Emit pipeline:reconcile-from-disk event (AC10)
  const localBus = new EventEmitter()
  localBus.emit('pipeline:reconcile-from-disk', {
    runId: resolvedRunId,
    affectedStories: affectedStoryKeys,
    gatesPassed: true,
    operatorConfirmed: !yes,
    durationMs,
  })

  const output: ReconcileOutput = {
    runId: resolvedRunId,
    candidates: diffRecords,
    gateResults,
    reconciled: true,
    affectedStoryKeys,
  }

  if (outputFormat === 'json') {
    process.stdout.write(JSON.stringify(output) + '\n')
  } else {
    process.stdout.write(
      `Reconciled ${affectedStoryKeys.length} stories to 'complete' in ${durationMs}ms.\n`,
    )
    for (const key of affectedStoryKeys) {
      process.stdout.write(`  ✓ ${key}\n`)
    }
  }

  return 0
}

// ---------------------------------------------------------------------------
// Commander subcommand registration (AC1)
// ---------------------------------------------------------------------------

/**
 * Register the `reconcile-from-disk` subcommand with the CLI program.
 *
 * Command shape:
 *   substrate reconcile-from-disk [--run-id <id>] [--dry-run] [--yes]
 *                                  [--output-format <human|json>]
 *                                  [--project-root <path>]
 */
export function registerReconcileFromDiskCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
  _registry?: AdapterRegistry,
): void {
  program
    .command('reconcile-from-disk')
    .description(
      'Reconcile wg_stories.status against working-tree and git history (Path A recovery)',
    )
    .option(
      '--run-id <id>',
      'Pipeline run ID to reconcile (defaults to .substrate/current-run-id, then getLatestRun Dolt fallback per Story 69-2 canonical chain)',
    )
    .option(
      '--dry-run',
      'Print discovery output and would-update list without running gates or writing Dolt',
    )
    .option(
      '--yes',
      'Skip operator confirmation prompt (gates still run; gate failure still aborts)',
    )
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .action(
      async (opts: {
        runId?: string
        dryRun?: boolean
        yes?: boolean
        outputFormat: string
        projectRoot: string
      }) => {
        const outputFormat: 'human' | 'json' =
          opts.outputFormat === 'json' ? 'json' : 'human'
        const exitCode = await runReconcileFromDiskAction({
          runId: opts.runId,
          dryRun: opts.dryRun,
          yes: opts.yes,
          outputFormat,
          projectRoot: opts.projectRoot,
        })
        process.exitCode = exitCode
      },
    )
}
