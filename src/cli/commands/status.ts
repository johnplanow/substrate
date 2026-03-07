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
import { existsSync } from 'fs'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { DatabaseWrapper } from '../../persistence/database.js'
import {
  getLatestRun,
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

const logger = createLogger('status-cmd')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatusOptions {
  outputFormat: OutputFormat
  runId?: string
  projectRoot: string
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function runStatusAction(options: StatusOptions): Promise<number> {
  const { outputFormat, runId, projectRoot } = options

  const dbRoot = await resolveMainRepoRoot(projectRoot)
  const dbPath = join(dbRoot, '.substrate', 'substrate.db')

  if (!existsSync(dbPath)) {
    const errorMsg = `Decision store not initialized. Run 'substrate init' first.`
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
    } else {
      process.stderr.write(`Error: ${errorMsg}\n`)
    }
    return 1
  }

  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
    const db = dbWrapper.db

    // Query pipeline run
    let run: PipelineRun | undefined
    if (runId !== undefined && runId !== '') {
      run = db
        .prepare('SELECT * FROM pipeline_runs WHERE id = ?')
        .get(runId) as PipelineRun | undefined
    } else {
      run = getLatestRun(db)
    }

    if (run === undefined) {
      const errorMsg =
        runId !== undefined
          ? `Pipeline run '${runId}' not found.`
          : 'No pipeline runs found. Run `substrate run` first.'
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    // Get token usage summary
    const tokenSummary = getTokenUsageSummary(db, run.id)

    // Count decisions and stories
    const decisionsCount =
      (
        db
          .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`)
          .get(run.id) as { cnt: number } | undefined
      )?.cnt ?? 0

    const storiesCount =
      (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM requirements WHERE pipeline_run_id = ? AND source = 'solutioning-phase'`,
          )
          .get(run.id) as { cnt: number } | undefined
      )?.cnt ?? 0

    if (outputFormat === 'json') {
      // AC5: output the exact schema defined in the story
      const statusOutput = buildPipelineStatusOutput(run, tokenSummary, decisionsCount, storiesCount)

      // Story 24-4 (AC5, AC6): augment with per-story metrics and pipeline summary
      const storyMetricsRows = getStoryMetricsForRun(db, run.id)

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
        const createdAt = parseDbTimestampAsUtc(run.created_at)
        const endTimestamp =
          run.status === 'running' ? new Date() : parseDbTimestampAsUtc(run.updated_at)
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
      dbWrapper.close()
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
    .action(async (opts: { runId?: string; projectRoot: string; outputFormat: string }) => {
      const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
      const exitCode = await runStatusAction({
        outputFormat,
        runId: opts.runId,
        projectRoot: opts.projectRoot,
      })
      process.exitCode = exitCode
    })
}
