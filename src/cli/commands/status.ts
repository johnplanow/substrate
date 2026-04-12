/**
 * `substrate status` command
 *
 * Shows the status of the most recent (or specified) pipeline run.
 *
 * Usage:
 *   substrate status                          Show latest pipeline run status
 *   substrate status --run-id <id>           Show status for a specific run
 *   substrate status --output-format json    JSON output
 *
 * Exit codes:
 *   0 - Success
 *   1 - Error
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import {
  getLatestRun,
  getPipelineRunById,
  getTokenUsageSummary,
} from '../../persistence/queries/decisions.js'
import type { PipelineRun } from '../../persistence/queries/decisions.js'
import { getStoryMetricsForRun } from '../../persistence/queries/metrics.js'
import { createLogger } from '../../utils/logger.js'
import type { OutputFormat } from './pipeline-shared.js'
import {
  formatOutput,
  formatTokenTelemetry,
  buildPipelineStatusOutput,
  formatPipelineStatusHuman,
  parseDbTimestampAsUtc,
} from './pipeline-shared.js'
import type { StateStore, StoryRecord } from '../../modules/state/index.js'
import { createStateStore, WorkGraphRepository } from '../../modules/state/index.js'
import { resolveRunManifest } from './manifest-read.js'
import type { PerStoryState } from '@substrate-ai/sdlc'

const logger = createLogger('status-cmd')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatusOptions {
  outputFormat: OutputFormat
  runId?: string
  projectRoot: string
  stateStore?: StateStore
  history?: boolean
}

// ---------------------------------------------------------------------------
// Work graph types (for status output)
// ---------------------------------------------------------------------------

interface WgBlockerInfo { key: string; title: string; status: string }
interface WgBlockedStory { key: string; title: string; blockers: WgBlockerInfo[] }
interface WgReadyStory { key: string; title: string }

/** Extended count shape used when building workGraph from manifest data (includes `failed`). */
type WorkGraphCounts = {
  ready: number
  blocked: number
  inProgress: number
  complete: number
  escalated: number
  failed: number
}

interface WorkGraphSummary {
  summary: { ready: number; blocked: number; inProgress: number; complete: number; escalated: number; failed?: number }
  readyStories: WgReadyStory[]
  blockedStories: WgBlockedStory[]
}

// ---------------------------------------------------------------------------
// Manifest → WorkGraphSummary helpers
// ---------------------------------------------------------------------------

/**
 * Map a manifest per-story status string to the appropriate WorkGraphCounts bucket.
 * Unknown strings are treated as `inProgress` (safe default).
 */
function manifestStatusToWorkGraphBucket(status: string): keyof WorkGraphCounts {
  switch (status) {
    case 'complete':            return 'complete'
    case 'escalated':           return 'escalated'
    case 'failed':
    case 'verification-failed': return 'failed'
    case 'dispatched':
    case 'in-review':
    case 'recovered':           return 'inProgress'
    case 'gated':
    case 'pending':             return 'ready'
    default:                    return 'inProgress'
  }
}

/**
 * Build a WorkGraphSummary from manifest `per_story_state`.
 * readyStories and blockedStories are left empty — manifest does not carry
 * dependency-graph detail (only status counts).
 */
function buildWorkGraphFromManifest(
  perStoryState: Record<string, PerStoryState>,
): WorkGraphSummary {
  const counts: WorkGraphCounts = { ready: 0, blocked: 0, inProgress: 0, complete: 0, escalated: 0, failed: 0 }
  for (const entry of Object.values(perStoryState)) {
    const bucket = manifestStatusToWorkGraphBucket(entry.status)
    counts[bucket]++
  }
  return {
    summary: {
      ready: counts.ready,
      blocked: counts.blocked,
      inProgress: counts.inProgress,
      complete: counts.complete,
      escalated: counts.escalated,
      failed: counts.failed,
    },
    readyStories: [],
    blockedStories: [],
  }
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function runStatusAction(options: StatusOptions): Promise<number> {
  const { outputFormat, runId, projectRoot, stateStore, history } = options

  // Task 3: --history flag — short-circuit before DB queries
  if (history === true) {
    if (!stateStore) {
      process.stdout.write('History not available with file backend. Use Dolt backend for state history.\n')
      return 0
    }
    try {
      const entries = await stateStore.getHistory(20)
      if (outputFormat === 'json') {
        process.stdout.write(JSON.stringify(entries, null, 2) + '\n')
        return 0
      }
      // Human format
      process.stdout.write('TIMESTAMP            HASH     MESSAGE\n')
      for (const entry of entries) {
        const ts = (entry.timestamp ?? '').padEnd(20)
        const hash = (entry.hash ?? '').padEnd(8)
        process.stdout.write(`${ts} ${hash} ${entry.message}\n`)
      }
      return 0
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
      } else {
        process.stderr.write(`Error: ${msg}\n`)
      }
      return 1
    }
  }

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbPath = join(dbRoot, '.substrate', 'substrate.db')

  const doltDir = join(dbRoot, '.substrate', 'state', '.dolt')
  if (!existsSync(dbPath) && !existsSync(doltDir)) {
    const errorMsg = `Decision store not initialized. Run 'substrate init' first.`
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  const adapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })

  try {
    await initSchema(adapter)

    // Query pipeline run first (run ID needed for manifest resolution)
    let run: PipelineRun | undefined
    if (runId !== undefined && runId !== '') {
      run = await getPipelineRunById(adapter, runId)
    } else {
      // Story 52-5: Prefer manifest for run ID resolution.
      // Resolution order: manifest → current-run-id file → getLatestRun()
      const { runId: manifestRunId } = await resolveRunManifest(dbRoot)
      if (manifestRunId) {
        run = await getPipelineRunById(adapter, manifestRunId)
      }
      if (run === undefined) {
        // Fallback: current-run-id file (pre-Phase-D compat, Story 39-3 AC2)
        try {
          const currentRunIdPath = join(dbRoot, '.substrate', 'current-run-id')
          const content = readFileSync(currentRunIdPath, 'utf-8').trim()
          const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          if (UUID_RE.test(content)) {
            run = await getPipelineRunById(adapter, content)
          }
        } catch {
          // File doesn't exist — fall through
        }
      }
      if (run === undefined) {
        // AC3: Final fallback to getLatestRun() for backward compatibility
        run = await getLatestRun(adapter)
      }
    }

    // ---------------------------------------------------------------------------
    // Work graph: prefer manifest per_story_state when available (AC1, AC4)
    // Falls back to wg_stories query for pre-Phase-D runs without a manifest.
    // ---------------------------------------------------------------------------
    let workGraph: WorkGraphSummary | undefined

    // Try to load run manifest (AC1, AC6)
    const { manifest: resolvedManifest } = await resolveRunManifest(dbRoot, run?.id)
    if (resolvedManifest !== null) {
      try {
        const manifestData = await resolvedManifest.read()
        workGraph = buildWorkGraphFromManifest(manifestData.per_story_state)
        logger.debug({ runId: run?.id }, 'status: workGraph built from manifest per_story_state')
      } catch {
        logger.debug({ runId: run?.id }, 'status: manifest read failed — falling back to wg_stories')
        // fall through to wg_stories query below
      }
    }

    // Fallback: query wg_stories when manifest not available (AC4)
    if (workGraph === undefined) {
      try {
        const wgRepo = new WorkGraphRepository(adapter)
        const allStories = await adapter.query<{ story_key: string; title: string | null; status: string }>(`SELECT story_key, title, status FROM wg_stories`)
        if (allStories.length > 0) {
          const readyStoriesRaw = await wgRepo.getReadyStories()
          const blockedStoriesRaw = await wgRepo.getBlockedStories()
          const readyKeys = new Set(readyStoriesRaw.map((s) => s.story_key))
          const blockedKeys = new Set(blockedStoriesRaw.map((b) => b.story.story_key))
          const inProgressCount = allStories.filter((s) => s.status === 'in_progress').length
          const completeCount = allStories.filter((s) => s.status === 'complete').length
          const escalatedCount = allStories.filter((s) => s.status === 'escalated').length
          workGraph = {
            summary: {
              ready: readyKeys.size,
              blocked: blockedKeys.size,
              inProgress: inProgressCount,
              complete: completeCount,
              escalated: escalatedCount,
            },
            readyStories: readyStoriesRaw.map((s) => ({ key: s.story_key, title: s.title ?? s.story_key })),
            blockedStories: blockedStoriesRaw.map((b) => ({
              key: b.story.story_key,
              title: b.story.title ?? b.story.story_key,
              blockers: b.blockers.map((bl) => ({ key: bl.key, title: bl.title, status: bl.status })),
            })),
          }
        }
      } catch (err) {
        logger.debug({ err }, 'Work graph query failed, continuing without work graph data')
      }
    }

    if (run === undefined) {
      // Check if a process is alive even without a DB run record
      const { inspectProcessTree } = await import('./health.js')
      const substrateDirPath = join(projectRoot, '.substrate')
      const processInfo = inspectProcessTree({ projectRoot, substrateDirPath })
      if (processInfo.orchestrator_pid !== null) {
        const syntheticStatus = {
          status: 'running' as const,
          message: 'Pipeline process detected (no DB state available)',
          process: processInfo,
        }
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput(syntheticStatus, 'json', true) + '\n')
        } else {
          process.stdout.write(`Pipeline is running (PID ${processInfo.orchestrator_pid}) but no DB state available.\n`)
        }
        return 0
      }

      const errorMsg =
        runId !== undefined
          ? `Pipeline run '${runId}' not found.`
          : 'No pipeline runs found. Run `substrate run --events` to start a pipeline first.'
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    // Get token usage summary
    const tokenSummary = await getTokenUsageSummary(adapter, run.id)

    // Count decisions and stories
    const decisionsCountRows = await adapter.query<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`,
      [run.id],
    )
    const decisionsCount = decisionsCountRows[0]?.cnt ?? 0

    const storiesCountRows = await adapter.query<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM requirements WHERE pipeline_run_id = ? AND source = 'solutioning-phase'`,
      [run.id],
    )
    const storiesCount = storiesCountRows[0]?.cnt ?? 0

    // Task 2: Query StateStore for story states (AC1, AC2)
    let storeStories: StoryRecord[] = []
    if (stateStore) {
      try {
        storeStories = await stateStore.queryStories({})
      } catch (err) {
        logger.debug({ err }, 'StateStore query failed, continuing without store data')
      }
    }

    if (outputFormat === 'json') {
      // AC5: output the exact schema defined in the story
      const statusOutput = buildPipelineStatusOutput(run, tokenSummary, decisionsCount, storiesCount)

      // Story 24-4 (AC5, AC6): augment with per-story metrics and pipeline summary
      const storyMetricsRows = await getStoryMetricsForRun(adapter, run.id)

      // Per-story v2 metrics (wall_clock_ms, phase_breakdown, tokens, review_cycles, dispatches)
      const storyMetricsV2 = storyMetricsRows.map((row) => {
        const phaseBreakdown: Record<string, number> = {}
        try {
          if (row.phase_durations_json) {
            const parsed = JSON.parse(row.phase_durations_json) as Record<string, number>
            for (const [phase, secs] of Object.entries(parsed)) {
              phaseBreakdown[phase] = Math.round(secs * 1000)
            }
          }
        } catch {
          // ignore malformed JSON
        }
        return {
          story_key: row.story_key,
          result: row.result,
          wall_clock_ms: Math.round((row.wall_clock_seconds ?? 0) * 1000),
          phase_breakdown: phaseBreakdown,
          tokens: { input: row.input_tokens ?? 0, output: row.output_tokens ?? 0 },
          review_cycles: row.review_cycles ?? 0,
          dispatches: row.dispatches ?? 0,
        }
      })

      // Pipeline-level wall-clock derived from run timestamps
      let pipelineWallClockMs = 0
      try {
        const createdAt = parseDbTimestampAsUtc(run.created_at ?? '')
        const endTimestamp =
          run.status === 'running' ? new Date() : parseDbTimestampAsUtc(run.updated_at ?? '')
        pipelineWallClockMs = Math.max(0, endTimestamp.getTime() - createdAt.getTime())
      } catch {
        // ignore invalid timestamps
      }

      const totalReviewCycles = storyMetricsRows.reduce((sum, r) => sum + (r.review_cycles ?? 0), 0)
      const totalInputTokens = storyMetricsRows.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0)
      const totalOutputTokens = storyMetricsRows.reduce((sum, r) => sum + (r.output_tokens ?? 0), 0)
      const completedCount = storyMetricsRows.filter((r) => r.result === 'success').length
      const storiesPerHour =
        pipelineWallClockMs > 0
          ? Math.round((completedCount / (pipelineWallClockMs / 3_600_000)) * 100) / 100
          : 0
      const totalCostUsd = storyMetricsRows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0)

      // Build enhanced output: existing fields first, new metrics appended,
      // cost_usd deprioritized (moved to end of pipeline_metrics per AC6)
      const enhancedOutput = {
        ...statusOutput,
        story_metrics: storyMetricsV2,
        pipeline_metrics: {
          total_wall_clock_ms: pipelineWallClockMs,
          total_review_cycles: totalReviewCycles,
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          stories_per_hour: storiesPerHour,
          cost_usd: totalCostUsd, // deprioritized per AC6
        },
        // Task 2 (AC1, AC2): StateStore story states from Dolt/file backend
        story_states: storeStories,
        // Story 31-5: work graph — blocked/ready stories and why
        workGraph: workGraph ?? null,
      }

      process.stdout.write(
        formatOutput(enhancedOutput, 'json', true) + '\n',
      )
    } else {
      // Check if this is a phase-level run (has phaseHistory) or legacy implementation-only run
      let hasPhaseHistory = false
      try {
        const config = JSON.parse(run.config_json ?? '{}') as { phaseHistory?: unknown[] }
        hasPhaseHistory = Array.isArray(config.phaseHistory) && config.phaseHistory.length > 0
      } catch {
        // ignore
      }

      if (hasPhaseHistory) {
        // Phase-level status display
        const statusOutput = buildPipelineStatusOutput(run, tokenSummary, decisionsCount, storiesCount)
        process.stdout.write(formatPipelineStatusHuman(statusOutput) + '\n')
      } else {
        // Legacy human-readable status (implementation-only)
        process.stdout.write(`Pipeline Run: ${run.id}\n`)
        process.stdout.write(`  Status:       ${run.status}\n`)
        process.stdout.write(`  Methodology:  ${run.methodology}\n`)
        process.stdout.write(`  Phase:        ${run.current_phase ?? 'N/A'}\n`)
        process.stdout.write(`  Created:      ${run.created_at}\n`)
        process.stdout.write(`  Updated:      ${run.updated_at}\n`)

        // Story breakdown if available
        let storyState: unknown = null
        try {
          if (run.token_usage_json !== null && run.token_usage_json !== undefined) {
            storyState = JSON.parse(run.token_usage_json)
          } else if (run.config_json !== null && run.config_json !== undefined) {
            storyState = JSON.parse(run.config_json)
          }
        } catch {
          // Ignore parse errors
        }

        if (
          storyState !== null &&
          typeof storyState === 'object' &&
          'stories' in (storyState as Record<string, unknown>)
        ) {
          const stories = (
            storyState as { stories: Record<string, { phase: string; reviewCycles: number }> }
          ).stories
          const storyEntries = Object.entries(stories)
          if (storyEntries.length > 0) {
            process.stdout.write('\nPer-Story Breakdown:\n')
            let completed = 0
            let pending = 0
            let escalated = 0
            for (const [key, s] of storyEntries) {
              process.stdout.write(`  ${key}: ${s.phase} (review cycles: ${s.reviewCycles})\n`)
              if (s.phase === 'COMPLETE') completed++
              else if (s.phase === 'ESCALATED') escalated++
              else pending++
            }
            process.stdout.write(
              `\nSummary: ${completed} completed, ${pending} pending, ${escalated} escalated\n`,
            )
          }
        }
      }

      // Task 2 (AC1, AC2): Show StateStore story states in human output
      if (storeStories.length > 0) {
        process.stdout.write('\nStateStore Story States:\n')
        for (const s of storeStories) {
          if (s.phase === 'CHECKPOINT') {
            const filesCount = s.checkpointFilesCount ?? 0
            process.stdout.write(`  ${s.storyKey}: ${s.phase} (${filesCount} files modified)\n`)
          } else {
            process.stdout.write(`  ${s.storyKey}: ${s.phase} (${s.reviewCycles} review cycles)\n`)
          }
        }
      }

      // Story 31-5: Work graph — blocked/ready stories and why
      if (workGraph !== undefined) {
        const { summary, readyStories, blockedStories } = workGraph
        process.stdout.write('\nWork Graph:\n')
        process.stdout.write(
          `  ${summary.inProgress} in progress, ${summary.ready} ready, ${summary.blocked} blocked, ${summary.complete} complete, ${summary.escalated} escalated\n`
        )
        if (readyStories.length > 0) {
          process.stdout.write('\n  Ready to dispatch:\n')
          for (const s of readyStories) {
            process.stdout.write(`    ${s.key}: ${s.title}\n`)
          }
        }
        if (blockedStories.length > 0) {
          process.stdout.write('\n  Blocked:\n')
          for (const b of blockedStories) {
            process.stdout.write(`    ${b.key}: ${b.title}\n`)
            for (const bl of b.blockers) {
              process.stdout.write(`      waiting on ${bl.key} (${bl.status}): ${bl.title}\n`)
            }
          }
        }
      }

      process.stdout.write('\n')
      process.stdout.write(formatTokenTelemetry(tokenSummary) + '\n')
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'status action failed')
    return 1
  } finally {
    try {
      await adapter.close()
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// registerStatusCommand
// ---------------------------------------------------------------------------

export function registerStatusCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('status')
    .description('Show status of the most recent (or specified) pipeline run')
    .option('--run-id <id>', 'Pipeline run ID to query (defaults to latest)')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .option('--history', 'Show Dolt commit history for the state store')
    .action(async (opts: { runId?: string; projectRoot: string; outputFormat: string; history?: boolean }) => {
      const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
      const root = opts.projectRoot

      // Task 5: Wire StateStore factory using Dolt path detection (same pattern as metrics.ts)
      let stateStore: StateStore | undefined
      const doltStatePath = join(root, '.substrate', 'state', '.dolt')
      if (existsSync(doltStatePath)) {
        try {
          stateStore = createStateStore({ backend: 'dolt', basePath: join(root, '.substrate', 'state') })
          await stateStore.initialize()
        } catch {
          stateStore = undefined
        }
      }

      try {
        const exitCode = await runStatusAction({
          outputFormat,
          runId: opts.runId,
          projectRoot: root,
          stateStore,
          history: opts.history,
        })
        process.exitCode = exitCode
      } finally {
        try { await stateStore?.close() } catch { /* ignore */ }
      }
    })
}
