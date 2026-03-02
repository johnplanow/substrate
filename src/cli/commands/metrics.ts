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
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function runMetricsAction(options: MetricsOptions): Promise<number> {
  const { outputFormat, projectRoot, limit = 10, compare, tagBaseline, analysis } = options

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

    if (outputFormat === 'json') {
      process.stdout.write(formatOutput({ runs }, 'json', true) + '\n')
    } else {
      if (runs.length === 0) {
        process.stdout.write('No run metrics recorded yet. Run `substrate run` to generate metrics.\n')
        return 0
      }
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
    .action(
      async (opts: {
        projectRoot: string
        outputFormat: string
        limit: number
        compare?: string
        tagBaseline?: string
        analysis?: string
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
        })
        process.exitCode = exitCode
      },
    )
}
