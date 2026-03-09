/**
 * `substrate metrics` command
 *
 * Shows historical pipeline run metrics and cross-run comparison.
 *
 * Usage:
 *   substrate metrics                              List recent pipeline run metrics
 *   substrate metrics --limit 20                   Show last 20 runs
 *   substrate metrics --compare <id-a>,<id-b>     Compare two runs side-by-side
 *   substrate metrics --tag-baseline <id>         Mark a run as the performance baseline
 *   substrate metrics --output-format json         JSON output
 *
 * Exit codes:
 *   0 - Success
 *   1 - Error
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import {
  listRunMetrics,
  getRunMetrics,
  tagRunAsBaseline,
  compareRunMetrics,
} from '../../persistence/queries/metrics.js'
import type { RunMetricsRow } from '../../persistence/queries/metrics.js'
import { getDecisionsByCategory } from '../../persistence/queries/decisions.js'
import { STORY_METRICS } from '../../persistence/schemas/operational.js'
import { createStateStore } from '../../modules/state/index.js'
import type { MetricFilter, MetricRecord } from '../../modules/state/index.js'
import { createLogger } from '../../utils/logger.js'
import type { OutputFormat } from './pipeline-shared.js'
import { formatOutput } from './pipeline-shared.js'

const logger = createLogger('metrics-cmd')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricsOptions {
  outputFormat: OutputFormat
  projectRoot: string
  limit?: number
  compare?: [string, string]
  tagBaseline?: string
  /** When provided, read and output the analysis report for this run-id (AC5 of Story 17-3). */
  analysis?: string
  /** Filter metrics by sprint (e.g. "sprint-1") */
  sprint?: string
  /** Filter metrics by story key (e.g. "26-1") */
  story?: string
  /** Filter metrics by task type (e.g. "dev-story") */
  taskType?: string
  /** Only show records at or after this ISO timestamp */
  since?: string
  /** Aggregate results grouped by task_type */
  aggregate?: boolean
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function runMetricsAction(options: MetricsOptions): Promise<number> {
  const { outputFormat, projectRoot, limit = 10, compare, tagBaseline, analysis, sprint, story, taskType, since, aggregate } = options

  // Analysis mode (AC5 of Story 17-3): read and output the analysis report for a run-id
  if (analysis !== undefined) {
    const dbRoot = await resolveMainRepoRoot(projectRoot)
    const reportBase = join(dbRoot, '_bmad-output', 'supervisor-reports', `${analysis}-analysis`)
    const jsonPath = `${reportBase}.json`
    const mdPath = `${reportBase}.md`

    if (!existsSync(jsonPath)) {
      const msg = `Analysis report not found for run '${analysis}'. Run the supervisor first to generate it.`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
      } else {
        process.stderr.write(`Error: ${msg}\n`)
      }
      return 1
    }

    try {
      if (outputFormat === 'json') {
        const content = await readFile(jsonPath, 'utf-8')
        const parsed = JSON.parse(content)
        process.stdout.write(formatOutput(parsed, 'json', true) + '\n')
      } else {
        const content = await readFile(mdPath, 'utf-8').catch(() =>
          readFile(jsonPath, 'utf-8'),
        )
        process.stdout.write(content + '\n')
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

  if (!existsSync(dbPath)) {
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput({ runs: [], message: 'No metrics yet — no pipeline database found.' }, 'json', true) + '\n')
    } else {
      process.stdout.write('No metrics yet — no pipeline database found.\n')
    }
    return 0
  }

  const dbWrapper = new DatabaseWrapper(dbPath)
  try {
    dbWrapper.open()
    runMigrations(dbWrapper.db)
    const db = dbWrapper.db

    // Tag-baseline mode (AC4)
    if (tagBaseline !== undefined) {
      const row = getRunMetrics(db, tagBaseline)
      if (!row) {
        const msg = `Run '${tagBaseline}' not found in run_metrics.`
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
        } else {
          process.stderr.write(`Error: ${msg}\n`)
        }
        return 1
      }
      tagRunAsBaseline(db, tagBaseline)
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput({ tagged_baseline: tagBaseline }, 'json', true) + '\n')
      } else {
        process.stdout.write(`Baseline tagged: ${tagBaseline}\n`)
      }
      return 0
    }

    // Compare mode
    if (compare !== undefined) {
      const [idA, idB] = compare
      const delta = compareRunMetrics(db, idA, idB)
      if (delta === null) {
        const msg = `One or both run IDs not found in metrics: ${idA}, ${idB}`
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
        } else {
          process.stderr.write(`Error: ${msg}\n`)
        }
        return 1
      }

      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(delta, 'json', true) + '\n')
      } else {
        const sign = (n: number) => (n > 0 ? '+' : '')
        const fmtPct = (pct: number | null) => pct === null ? 'N/A' : `${sign(pct)}${pct}%`
        process.stdout.write(`\nMetrics Comparison: ${idA.slice(0, 8)} vs ${idB.slice(0, 8)}\n`)
        process.stdout.write(`  Input tokens:   ${sign(delta.token_input_delta)}${delta.token_input_delta.toLocaleString()} (${fmtPct(delta.token_input_pct)})\n`)
        process.stdout.write(`  Output tokens:  ${sign(delta.token_output_delta)}${delta.token_output_delta.toLocaleString()} (${fmtPct(delta.token_output_pct)})\n`)
        process.stdout.write(`  Wall clock:     ${sign(delta.wall_clock_delta_seconds)}${delta.wall_clock_delta_seconds}s (${fmtPct(delta.wall_clock_pct)})\n`)
        process.stdout.write(`  Review cycles:  ${sign(delta.review_cycles_delta)}${delta.review_cycles_delta} (${fmtPct(delta.review_cycles_pct)})\n`)
        process.stdout.write(`  Cost USD:       ${delta.cost_delta < 0 ? '-' : sign(delta.cost_delta)}$${Math.abs(delta.cost_delta).toFixed(4)} (${fmtPct(delta.cost_pct)})\n`)
      }
      return 0
    }

    // List mode
    const runs: RunMetricsRow[] = listRunMetrics(db, limit)

    // AC3/AC4/AC5 of Story 26-5: query StateStore if Dolt is present AND filter flags are used
    // Only activate the Dolt path when at least one new filter flag is provided or --aggregate is set.
    // A bare `substrate metrics` with no filter flags should not query Dolt unnecessarily.
    let doltMetrics: MetricRecord[] | undefined
    const doltStatePath = join(dbRoot, '.substrate', 'state', '.dolt')
    const hasDoltFilters = sprint !== undefined || story !== undefined || taskType !== undefined || since !== undefined || aggregate === true
    if (existsSync(doltStatePath) && hasDoltFilters) {
      try {
        const stateStore = createStateStore({ backend: 'dolt', basePath: join(dbRoot, '.substrate', 'state') })
        await stateStore.initialize()
        const doltFilter: MetricFilter = {}
        if (sprint !== undefined) doltFilter.sprint = sprint
        if (story !== undefined) doltFilter.storyKey = story
        if (taskType !== undefined) doltFilter.taskType = taskType
        if (since !== undefined) doltFilter.since = since
        if (aggregate !== undefined) doltFilter.aggregate = aggregate
        doltMetrics = await stateStore.queryMetrics(doltFilter)
        await stateStore.close()
      } catch (doltErr) {
        logger.warn({ err: doltErr }, 'StateStore query failed — falling back to SQLite metrics only')
      }
    }

    // AC6 of Story 21-1: query story-metrics decisions for per-story efficiency data
    const storyMetricDecisions = getDecisionsByCategory(db, STORY_METRICS)
    const storyMetrics: Array<{
      story_key: string
      run_id: string
      wall_clock_seconds: number
      input_tokens: number
      output_tokens: number
      review_cycles: number
      stalled: boolean
      cost_usd?: number
    }> = storyMetricDecisions.map((d) => {
      // Key format: "{storyKey}:{runId}"
      const colonIdx = d.key.indexOf(':')
      const storyKey = colonIdx !== -1 ? d.key.slice(0, colonIdx) : d.key
      const runId = colonIdx !== -1 ? d.key.slice(colonIdx + 1) : (d.pipeline_run_id ?? '')
      try {
        const v = JSON.parse(d.value) as {
          wall_clock_seconds?: number
          input_tokens?: number
          output_tokens?: number
          review_cycles?: number
          stalled?: boolean
          cost_usd?: number
        }
        return {
          story_key: storyKey,
          run_id: runId,
          wall_clock_seconds: v.wall_clock_seconds ?? 0,
          input_tokens: v.input_tokens ?? 0,
          output_tokens: v.output_tokens ?? 0,
          review_cycles: v.review_cycles ?? 0,
          stalled: v.stalled ?? false,
          ...(v.cost_usd !== undefined && v.cost_usd > 0 ? { cost_usd: v.cost_usd } : {}),
        }
      } catch {
        return {
          story_key: storyKey,
          run_id: runId,
          wall_clock_seconds: 0,
          input_tokens: 0,
          output_tokens: 0,
          review_cycles: 0,
          stalled: false,
        }
      }
    })

    if (outputFormat === 'json') {
      const jsonPayload: Record<string, unknown> = { runs, story_metrics: storyMetrics }
      if (doltMetrics !== undefined) {
        if (aggregate) {
          // Aggregate mode: output as properly-named AggregateMetricResult objects with totals
          const aggregateResults = doltMetrics.map((m) => ({
            task_type: m.taskType,
            count: m.count ?? 0,
            avg_cost_usd: m.costUsd ?? 0,
            sum_tokens_in: m.tokensIn ?? 0,
            sum_tokens_out: m.tokensOut ?? 0,
          }))
          const aggregateTotals = {
            total_count: aggregateResults.reduce((sum, r) => sum + r.count, 0),
            total_avg_cost_usd: aggregateResults.reduce((sum, r) => sum + r.avg_cost_usd, 0),
            total_tokens_in: aggregateResults.reduce((sum, r) => sum + r.sum_tokens_in, 0),
            total_tokens_out: aggregateResults.reduce((sum, r) => sum + r.sum_tokens_out, 0),
          }
          jsonPayload.aggregate_metrics = aggregateResults
          jsonPayload.aggregate_totals = aggregateTotals
        } else {
          jsonPayload.dolt_metrics = doltMetrics
        }
      }
      process.stdout.write(formatOutput(jsonPayload, 'json', true) + '\n')
    } else {
      if (runs.length === 0 && storyMetrics.length === 0 && (doltMetrics === undefined || doltMetrics.length === 0)) {
        process.stdout.write('No run metrics recorded yet. Run `substrate run` to generate metrics.\n')
        return 0
      }
      if (runs.length > 0) {
        process.stdout.write(`\nPipeline Run Metrics (last ${runs.length} runs)\n`)
        process.stdout.write('─'.repeat(80) + '\n')
        for (const run of runs) {
          const isBaseline = run.is_baseline ? ' [BASELINE]' : ''
          process.stdout.write(`\nRun: ${run.run_id}${isBaseline}\n`)
          process.stdout.write(`  Status:    ${run.status}  |  Methodology: ${run.methodology}\n`)
          process.stdout.write(`  Started:   ${run.started_at}\n`)
          if (run.completed_at) {
            process.stdout.write(`  Completed: ${run.completed_at}  (${run.wall_clock_seconds}s)\n`)
          }
          process.stdout.write(`  Stories:   attempted=${run.stories_attempted} succeeded=${run.stories_succeeded} failed=${run.stories_failed} escalated=${run.stories_escalated}\n`)
          process.stdout.write(`  Tokens:    ${(run.total_input_tokens ?? 0).toLocaleString()} in / ${(run.total_output_tokens ?? 0).toLocaleString()} out  $${(run.total_cost_usd ?? 0).toFixed(4)}\n`)
          process.stdout.write(`  Cycles:    ${run.total_review_cycles}  |  Dispatches: ${run.total_dispatches}  |  Concurrency: ${run.concurrency_setting}\n`)
        }
      }
      if (storyMetrics.length > 0) {
        process.stdout.write(`\nPer-Story Efficiency Metrics (${storyMetrics.length} stories)\n`)
        process.stdout.write('─'.repeat(80) + '\n')
        process.stdout.write(`  ${'Story'.padEnd(16)} ${'Run'.padEnd(12)} ${'Wall(s)'.padStart(8)} ${'Tokens In'.padStart(10)} ${'Tokens Out'.padStart(11)} ${'Cycles'.padStart(7)} ${'Stalled'.padStart(8)}\n`)
        process.stdout.write('  ' + '─'.repeat(76) + '\n')
        for (const sm of storyMetrics) {
          const runShort = sm.run_id.slice(0, 8)
          const stalledStr = sm.stalled ? 'yes' : 'no'
          const costStr = sm.cost_usd !== undefined && sm.cost_usd > 0 ? `  $${sm.cost_usd.toFixed(4)}` : ''
          process.stdout.write(
            `  ${sm.story_key.padEnd(16)} ${runShort.padEnd(12)} ${String(sm.wall_clock_seconds).padStart(8)} ${sm.input_tokens.toLocaleString().padStart(10)} ${sm.output_tokens.toLocaleString().padStart(11)} ${String(sm.review_cycles).padStart(7)} ${stalledStr.padStart(8)}${costStr}\n`,
          )
        }
      }
      if (doltMetrics !== undefined && doltMetrics.length > 0) {
        if (aggregate) {
          // Aggregate mode: display task_type | count | avg_cost_usd | sum_tokens_in | sum_tokens_out
          process.stdout.write(`\nStateStore Aggregate Metrics (by task type)\n`)
          process.stdout.write('─'.repeat(80) + '\n')
          process.stdout.write(`  ${'Task Type'.padEnd(20)} ${'Count'.padStart(8)} ${'Avg Cost'.padStart(12)} ${'Sum Tokens In'.padStart(14)} ${'Sum Tokens Out'.padStart(15)}\n`)
          process.stdout.write('  ' + '─'.repeat(72) + '\n')
          let totalCount = 0
          let totalCost = 0
          let totalTokensIn = 0
          let totalTokensOut = 0
          for (const m of doltMetrics) {
            const count = m.count ?? 0
            const avgCost = m.costUsd !== undefined ? `$${m.costUsd.toFixed(4)}` : '-'
            const sumIn = m.tokensIn !== undefined ? m.tokensIn.toLocaleString() : '-'
            const sumOut = m.tokensOut !== undefined ? m.tokensOut.toLocaleString() : '-'
            totalCount += count
            totalCost += m.costUsd ?? 0
            totalTokensIn += m.tokensIn ?? 0
            totalTokensOut += m.tokensOut ?? 0
            process.stdout.write(
              `  ${m.taskType.padEnd(20)} ${String(count).padStart(8)} ${avgCost.padStart(12)} ${sumIn.padStart(14)} ${sumOut.padStart(15)}\n`,
            )
          }
          // Overall totals row
          process.stdout.write('  ' + '─'.repeat(72) + '\n')
          process.stdout.write(
            `  ${'TOTAL'.padEnd(20)} ${String(totalCount).padStart(8)} ${`$${totalCost.toFixed(4)}`.padStart(12)} ${totalTokensIn.toLocaleString().padStart(14)} ${totalTokensOut.toLocaleString().padStart(15)}\n`,
          )
        } else {
          // Regular mode: display per-record details
          process.stdout.write(`\nStateStore Metrics (${doltMetrics.length} records)\n`)
          process.stdout.write('─'.repeat(80) + '\n')
          process.stdout.write(`  ${'Story'.padEnd(16)} ${'Task Type'.padEnd(16)} ${'Tokens In'.padStart(10)} ${'Tokens Out'.padStart(11)} ${'Wall(ms)'.padStart(10)} ${'Result'.padEnd(12)}\n`)
          process.stdout.write('  ' + '─'.repeat(76) + '\n')
          for (const m of doltMetrics) {
            const tokIn = m.tokensIn !== undefined ? m.tokensIn.toLocaleString() : '-'
            const tokOut = m.tokensOut !== undefined ? m.tokensOut.toLocaleString() : '-'
            const wall = m.wallClockMs !== undefined ? String(m.wallClockMs) : '-'
            const res = m.result ?? '-'
            process.stdout.write(
              `  ${m.storyKey.padEnd(16)} ${m.taskType.padEnd(16)} ${tokIn.padStart(10)} ${tokOut.padStart(11)} ${wall.padStart(10)} ${res.padEnd(12)}\n`,
            )
          }
        }
      }
    }
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'metrics action failed')
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
// registerMetricsCommand
// ---------------------------------------------------------------------------

export function registerMetricsCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('metrics')
    .description('Show historical pipeline run metrics and cross-run comparison')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .option('--limit <n>', 'Number of runs to show (default: 10)', (v: string) => parseInt(v, 10), 10)
    .option('--compare <run-id-a,run-id-b>', 'Compare two runs side-by-side (comma-separated IDs, e.g. abc123,def456)')
    .option('--tag-baseline <run-id>', 'Mark a run as the performance baseline')
    .option('--analysis <run-id>', 'Read and output the analysis report for the specified run (AC5 of Story 17-3)')
    .option('--sprint <sprint>', 'Filter StateStore metrics by sprint (e.g. sprint-1)')
    .option('--story <story-key>', 'Filter StateStore metrics by story key (e.g. 26-1)')
    .option('--task-type <type>', 'Filter StateStore metrics by task type (e.g. dev-story)')
    .option('--since <iso-date>', 'Filter StateStore metrics at or after this ISO timestamp')
    .option('--aggregate', 'Aggregate StateStore metrics grouped by task_type')
    .action(
      async (opts: {
        projectRoot: string
        outputFormat: string
        limit: number
        compare?: string
        tagBaseline?: string
        analysis?: string
        sprint?: string
        story?: string
        taskType?: string
        since?: string
        aggregate?: boolean
      }) => {
        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
        let compareIds: [string, string] | undefined
        if (opts.compare !== undefined) {
          const parts = opts.compare.split(',').map((s) => s.trim())
          if (parts.length === 2 && parts[0] && parts[1]) {
            compareIds = [parts[0], parts[1]]
          }
        }
        const exitCode = await runMetricsAction({
          outputFormat,
          projectRoot: opts.projectRoot,
          limit: opts.limit,
          compare: compareIds,
          tagBaseline: opts.tagBaseline,
          analysis: opts.analysis,
          sprint: opts.sprint,
          story: opts.story,
          taskType: opts.taskType,
          since: opts.since,
          aggregate: opts.aggregate,
        })
        process.exitCode = exitCode
      },
    )
}
