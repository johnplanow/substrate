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
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import {
  listRunMetrics,
  getRunMetrics,
  tagRunAsBaseline,
  compareRunMetrics,
} from '../../persistence/queries/metrics.js'
import type { RunMetricsRow } from '../../persistence/queries/metrics.js'
import { getDecisionsByCategory } from '../../persistence/queries/decisions.js'
import { STORY_METRICS } from '../../persistence/schemas/operational.js'
import { createStateStore, FileStateStore } from '../../modules/state/index.js'
import type { MetricFilter, MetricRecord } from '../../modules/state/index.js'
import type { PhaseTokenBreakdown } from '../../modules/routing/index.js'
import { RoutingRecommender } from '../../modules/routing/index.js'
import { createLogger } from '../../utils/logger.js'
import type { OutputFormat } from './pipeline-shared.js'
import { formatOutput } from './pipeline-shared.js'
import { AdapterTelemetryPersistence } from '../../modules/telemetry/index.js'
import type {
  EfficiencyScore,
  Recommendation,
  TurnAnalysis,
  CategoryStats,
  ConsumerStats,
} from '../../modules/telemetry/index.js'
import {
  getFactoryRunSummaries,
  getScenarioResultsForRun,
  listGraphRuns,
  getTwinRunsForRun,
} from '@substrate-ai/factory'
import type { FactoryRunSummary, ScenarioResultRow, PortMapping } from '@substrate-ai/factory'

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
  // -- Telemetry modes (story 27-8) --
  /** Show efficiency scores for recent stories */
  efficiency?: boolean
  /** Show all recommendations across stories */
  recommendations?: boolean
  /** Show per-turn analysis for a specific story */
  turns?: string
  /** Show consumer stats for a specific story */
  consumers?: string
  /** Show category stats (optionally scoped to a story via --story) */
  categories?: boolean
  /** Compare efficiency scores of two stories side-by-side */
  compareStories?: [string, string]
  /** Show routing recommendations derived from phase token breakdown history */
  routingRecommendations?: boolean
  /** Show per-iteration score history for a specific factory run (full run_id or unique prefix) */
  run?: string
  /** Show only factory graph run metrics (excludes SDLC runs) */
  factory?: boolean
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Telemetry helper: open adapter-backed DB for telemetry queries
// ---------------------------------------------------------------------------

async function openTelemetryAdapter(
  basePath: string
): Promise<{ persistence: AdapterTelemetryPersistence; close: () => Promise<void> } | null> {
  try {
    const adapter = createDatabaseAdapter({ backend: 'auto', basePath })
    const persistence = new AdapterTelemetryPersistence(adapter)
    return { persistence, close: () => adapter.close() }
  } catch {
    return null
  }
}

function rowsToEfficiencyScore(rows: EfficiencyScore[]): EfficiencyScore[] {
  return rows
}

// ---------------------------------------------------------------------------
// Telemetry text formatters
// ---------------------------------------------------------------------------

function printEfficiencyTable(
  scores: EfficiencyScore[],
  dispatchScoresByStory: Map<string, EfficiencyScore[]> = new Map()
): void {
  process.stdout.write(`\nEfficiency Scores (${scores.length} records)\n`)
  process.stdout.write('─'.repeat(80) + '\n')
  process.stdout.write(
    `  ${'Story Key'.padEnd(14)} ${'Score'.padStart(6)} ${'Cache Hit%'.padStart(11)} ${'I/O Ratio'.padStart(10)} ${'Ctx Mgmt'.padStart(9)} Model\n`
  )
  process.stdout.write('  ' + '─'.repeat(76) + '\n')
  for (const s of scores) {
    const cacheHitPct = s.totalTurns > 0 ? `${(s.avgCacheHitRate * 100).toFixed(1)}%` : '0.0%'
    const ioRatio = s.avgIoRatio.toFixed(2)
    const ctxMgmt = String(Math.round(s.contextManagementSubScore))
    const model =
      s.perModelBreakdown.length > 0 ? (s.perModelBreakdown[0]?.model ?? 'unknown') : 'unknown'
    process.stdout.write(
      `  ${s.storyKey.padEnd(14)} ${String(s.compositeScore).padStart(6)} ${cacheHitPct.padStart(11)} ${ioRatio.padStart(10)} ${ctxMgmt.padStart(9)} ${model}\n`
    )
    // Print per-dispatch rows (at most 5) indented under the story row
    const dispatchScores = dispatchScoresByStory.get(s.storyKey)
    if (dispatchScores !== undefined && dispatchScores.length > 0) {
      const rows = dispatchScores.slice(0, 5)
      for (const ds of rows) {
        const taskType = ds.taskType ?? 'unknown'
        const phase = ds.phase ?? 'unknown'
        const dsCacheHitPct =
          ds.totalTurns > 0 ? `${(ds.avgCacheHitRate * 100).toFixed(1)}%` : '0.0%'
        process.stdout.write(
          `    ↳ ${taskType}/${phase} score=${ds.compositeScore} cache=${dsCacheHitPct} turns=${ds.totalTurns}\n`
        )
      }
    }
  }
}

function printRecommendationTable(recs: Recommendation[]): void {
  process.stdout.write(`\nRecommendations (${recs.length} records)\n`)
  process.stdout.write('─'.repeat(80) + '\n')
  process.stdout.write(
    `  ${'Story'.padEnd(12)} ${'Severity'.padEnd(10)} ${'Rule'.padEnd(24)} ${'Savings Tokens'.padStart(15)}\n`
  )
  process.stdout.write('  ' + '─'.repeat(64) + '\n')
  for (const r of recs) {
    const savings = r.potentialSavingsTokens !== undefined ? String(r.potentialSavingsTokens) : '-'
    process.stdout.write(
      `  ${r.storyKey.padEnd(12)} ${r.severity.padEnd(10)} ${r.ruleId.padEnd(24)} ${savings.padStart(15)}\n`
    )
    process.stdout.write(`    ${r.title}\n`)
  }
}

function printTurnTable(turns: TurnAnalysis[], storyKey: string): void {
  process.stdout.write(`\nTurn Analysis: ${storyKey} (${turns.length} turns)\n`)
  process.stdout.write('─'.repeat(100) + '\n')
  process.stdout.write(
    `  ${'#'.padStart(4)} ${'Tokens In'.padStart(10)} ${'Tok Out'.padStart(8)} ${'Cache Hit%'.padStart(11)} ${'Ctx Size'.padStart(9)} ${'Task Type'.padEnd(16)} ${'Phase'.padEnd(16)} Spike\n`
  )
  process.stdout.write('  ' + '─'.repeat(86) + '\n')
  for (const t of turns) {
    const cacheHitPct = t.inputTokens > 0 ? `${(t.cacheHitRate * 100).toFixed(1)}%` : '0.0%'
    const spike = t.isContextSpike ? ' ⚠' : ''
    const taskType = (t.taskType ?? '-').padEnd(16)
    const phase = (t.phase ?? '-').padEnd(16)
    process.stdout.write(
      `  ${String(t.turnNumber).padStart(4)} ${t.inputTokens.toLocaleString().padStart(10)} ${t.outputTokens.toLocaleString().padStart(8)} ${cacheHitPct.padStart(11)} ${t.contextSize.toLocaleString().padStart(9)} ${taskType} ${phase}${spike}\n`
    )
  }
}

function printConsumerTable(consumers: ConsumerStats[], storyKey: string): void {
  process.stdout.write(`\nConsumer Stats: ${storyKey} (${consumers.length} consumers)\n`)
  process.stdout.write('─'.repeat(80) + '\n')
  process.stdout.write(
    `  ${'Consumer Key'.padEnd(36)} ${'Category'.padEnd(20)} ${'Tokens'.padStart(10)} ${'%'.padStart(7)}\n`
  )
  process.stdout.write('  ' + '─'.repeat(76) + '\n')
  for (const c of consumers) {
    const key = c.consumerKey.slice(0, 34)
    const pct = `${c.percentage.toFixed(1)}%`
    process.stdout.write(
      `  ${key.padEnd(36)} ${c.category.padEnd(20)} ${c.totalTokens.toLocaleString().padStart(10)} ${pct.padStart(7)}\n`
    )
  }
}

function printCategoryTable(stats: CategoryStats[], label: string): void {
  process.stdout.write(`\nCategory Stats${label} (${stats.length} categories)\n`)
  process.stdout.write('─'.repeat(80) + '\n')
  process.stdout.write(
    `  ${'Category'.padEnd(22)} ${'Tokens'.padStart(12)} ${'%'.padStart(8)} ${'Events'.padStart(8)} ${'Avg/Event'.padStart(10)} Trend\n`
  )
  process.stdout.write('  ' + '─'.repeat(70) + '\n')
  const sorted = [...stats].sort((a, b) => b.totalTokens - a.totalTokens)
  for (const c of sorted) {
    const pct = `${c.percentage.toFixed(1)}%`
    const avg = c.avgTokensPerEvent.toFixed(0)
    process.stdout.write(
      `  ${c.category.padEnd(22)} ${c.totalTokens.toLocaleString().padStart(12)} ${pct.padStart(8)} ${String(c.eventCount).padStart(8)} ${avg.padStart(10)} ${c.trend}\n`
    )
  }
}

// ---------------------------------------------------------------------------
// Factory run table printer
// ---------------------------------------------------------------------------

function printFactoryRunTable(runs: FactoryRunSummary[]): void {
  process.stdout.write(`\nFactory Runs (${runs.length} records)\n`)
  process.stdout.write('─'.repeat(80) + '\n')
  process.stdout.write(
    `  ${'run_id'.padEnd(10)} ${'score'.padStart(7)} ${'passes'.padStart(7)} ${'started_at'.padEnd(20)} ${'cost_usd'.padStart(10)} ${'status'.padEnd(16)}\n`
  )
  process.stdout.write('  ' + '─'.repeat(74) + '\n')
  for (const run of runs) {
    const scoreStr =
      run.satisfaction_score !== null ? `${(run.satisfaction_score * 100).toFixed(1)}%` : '—'
    const passesStr = run.passes !== null ? (run.passes ? '✓' : '✗') : '—'
    const startedAt = run.started_at.slice(0, 19)
    const costStr = `$${run.total_cost_usd.toFixed(4)}`
    const statusStr = run.convergence_status ?? '—'
    process.stdout.write(
      `  ${run.run_id.slice(0, 8).padEnd(10)} ${scoreStr.padStart(7)} ${passesStr.padStart(7)} ${startedAt.padEnd(20)} ${costStr.padStart(10)} ${statusStr.padEnd(16)}\n`
    )
  }
}

export async function runMetricsAction(options: MetricsOptions): Promise<number> {
  const {
    outputFormat,
    projectRoot,
    limit = 10,
    compare,
    tagBaseline,
    analysis,
    sprint,
    story,
    taskType,
    since,
    aggregate,
    efficiency,
    recommendations,
    turns,
    consumers,
    categories,
    compareStories,
    routingRecommendations,
    run,
    factory,
  } = options

  // ---------------------------------------------------------------------------
  // Flag conflict detection for telemetry modes
  // ---------------------------------------------------------------------------
  const telemetryModes = [
    efficiency,
    recommendations,
    turns,
    consumers,
    categories,
    compareStories,
  ].filter(Boolean)
  if (telemetryModes.length > 1) {
    process.stderr.write(
      'Error: --efficiency, --recommendations, --turns, --consumers, --categories, and --compare-stories are mutually exclusive\n'
    )
    return 1
  }
  // Telemetry modes are mutually exclusive with existing exclusive modes
  const hasTelemetryMode = telemetryModes.length > 0
  if (
    hasTelemetryMode &&
    (compare !== undefined || tagBaseline !== undefined || analysis !== undefined)
  ) {
    process.stderr.write(
      'Error: telemetry modes (--efficiency, --recommendations, --turns, --consumers, --categories, --compare-stories) cannot be combined with --compare, --tag-baseline, or --analysis\n'
    )
    return 1
  }

  // ---------------------------------------------------------------------------
  // Telemetry modes — open adapter (Dolt or in-memory) for telemetry queries
  // ---------------------------------------------------------------------------
  if (hasTelemetryMode) {
    const dbRoot = await resolveMainRepoRoot(projectRoot)
    const doltStatePath = join(dbRoot, '.substrate', 'state', '.dolt')
    const doltExists = existsSync(doltStatePath)

    // For story-scoped modes (turns, consumers): always require data; exit 1 if empty
    // For aggregate modes (efficiency, recommendations, categories): allow graceful no-data message

    if (!doltExists) {
      const msg =
        'No telemetry data yet — run a pipeline with Dolt initialized and `telemetry.enabled: true`'
      if (turns !== undefined || consumers !== undefined) {
        // Story-scoped modes exit 1 when not found
        process.stderr.write(`Error: ${msg}\n`)
        return 1
      }
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput({ message: msg }, 'json', true) + '\n')
      } else {
        process.stdout.write(msg + '\n')
      }
      return 0
    }

    const telemetryHandle = await openTelemetryAdapter(dbRoot)
    if (telemetryHandle === null) {
      const msg = 'No telemetry data yet — run a pipeline with `telemetry.enabled: true`'
      if (turns !== undefined || consumers !== undefined) {
        process.stderr.write(`Error: ${msg}\n`)
        return 1
      }
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput({ message: msg }, 'json', true) + '\n')
      } else {
        process.stdout.write(msg + '\n')
      }
      return 0
    }

    const telemetryPersistence = telemetryHandle.persistence
    try {
      // -- efficiency mode --
      if (efficiency === true) {
        const scores = await telemetryPersistence.getEfficiencyScores(20)
        // Fetch dispatch scores for each unique story key
        const storyKeys = [...new Set(scores.map((s) => s.storyKey))]
        const dispatchScoresByStory = new Map<string, EfficiencyScore[]>()
        await Promise.all(
          storyKeys.map(async (sk) => {
            const ds = await telemetryPersistence.getDispatchEfficiencyScores(sk)
            if (ds.length > 0) {
              dispatchScoresByStory.set(sk, ds)
            }
          })
        )
        if (outputFormat === 'json') {
          const efficiencyWithDispatch = scores.map((s) => ({
            ...rowsToEfficiencyScore([s])[0],
            dispatchScores: dispatchScoresByStory.get(s.storyKey) ?? [],
          }))
          process.stdout.write(
            formatOutput({ efficiency: efficiencyWithDispatch }, 'json', true) + '\n'
          )
        } else {
          printEfficiencyTable(scores, dispatchScoresByStory)
        }
        return 0
      }

      // -- recommendations mode --
      if (recommendations === true) {
        const recs =
          story !== undefined
            ? await telemetryPersistence.getRecommendations(story)
            : await telemetryPersistence.getAllRecommendations(50)
        if (outputFormat === 'json') {
          process.stdout.write(
            formatOutput(
              { recommendations: recs, ...(story !== undefined && { storyKey: story }) },
              'json',
              true
            ) + '\n'
          )
        } else {
          if (recs.length === 0) {
            const msg =
              story !== undefined
                ? `No recommendations found for story '${story}'`
                : 'No recommendations yet — run a pipeline with `telemetry.enabled: true`'
            process.stdout.write(msg + '\n')
          } else {
            printRecommendationTable(recs)
          }
        }
        return 0
      }

      // -- turns <storyKey> mode --
      if (turns !== undefined) {
        const turnData = await telemetryPersistence.getTurnAnalysis(turns)
        if (turnData.length === 0) {
          const msg = `No turn analysis data found for story '${turns}'`
          if (outputFormat === 'json') {
            process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
          } else {
            process.stderr.write(`Error: ${msg}\n`)
          }
          return 1
        }
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput({ turns: turnData }, 'json', true) + '\n')
        } else {
          printTurnTable(turnData, turns)
        }
        return 0
      }

      // -- consumers <storyKey> mode --
      if (consumers !== undefined) {
        const consumerData = await telemetryPersistence.getConsumerStats(consumers)
        if (consumerData.length === 0) {
          const msg = `No consumer stats found for story '${consumers}'`
          if (outputFormat === 'json') {
            process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
          } else {
            process.stderr.write(`Error: ${msg}\n`)
          }
          return 1
        }
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput({ consumers: consumerData }, 'json', true) + '\n')
        } else {
          printConsumerTable(consumerData, consumers)
        }
        return 0
      }

      // -- categories mode (optionally scoped by --story) --
      if (categories === true) {
        const storyKey = story
        const categoryData = await telemetryPersistence.getCategoryStats(storyKey ?? '')
        const label = storyKey !== undefined ? `: ${storyKey}` : ''
        if (outputFormat === 'json') {
          process.stdout.write(
            formatOutput({ categories: categoryData, storyKey }, 'json', true) + '\n'
          )
        } else {
          printCategoryTable(categoryData, label)
        }
        return 0
      }

      // -- compare-stories mode --
      if (compareStories !== undefined) {
        const [keyA, keyB] = compareStories
        const [scoreA, scoreB] = await Promise.all([
          telemetryPersistence.getEfficiencyScore(keyA),
          telemetryPersistence.getEfficiencyScore(keyB),
        ])
        if (scoreA === null || scoreB === null) {
          const missing = [scoreA === null ? keyA : null, scoreB === null ? keyB : null]
            .filter(Boolean)
            .join(', ')
          const msg = `No efficiency score found for story: ${missing}`
          if (outputFormat === 'json') {
            process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
          } else {
            process.stderr.write(`Error: ${msg}\n`)
          }
          return 1
        }
        const delta = {
          compositeScore: scoreB.compositeScore - scoreA.compositeScore,
          cacheHitSubScore: scoreB.cacheHitSubScore - scoreA.cacheHitSubScore,
          ioRatioSubScore: scoreB.ioRatioSubScore - scoreA.ioRatioSubScore,
          contextManagementSubScore:
            scoreB.contextManagementSubScore - scoreA.contextManagementSubScore,
          tokenDensitySubScore:
            (scoreB.tokenDensitySubScore ?? 0) - (scoreA.tokenDensitySubScore ?? 0),
        }
        if (outputFormat === 'json') {
          process.stdout.write(
            formatOutput({ storyA: scoreA, storyB: scoreB, delta }, 'json', true) + '\n'
          )
        } else {
          const sign = (n: number) => (n > 0 ? '+' : '')
          process.stdout.write(`\nEfficiency Comparison: ${keyA} vs ${keyB}\n`)
          process.stdout.write('─'.repeat(80) + '\n')
          process.stdout.write(
            `  ${'Metric'.padEnd(30)} ${keyA.padStart(12)} ${keyB.padStart(12)} ${'Delta'.padStart(10)}\n`
          )
          process.stdout.write('  ' + '─'.repeat(66) + '\n')
          process.stdout.write(
            `  ${'Composite Score'.padEnd(30)} ${String(scoreA.compositeScore).padStart(12)} ${String(scoreB.compositeScore).padStart(12)} ${`${sign(delta.compositeScore)}${delta.compositeScore}`.padStart(10)}\n`
          )
          process.stdout.write(
            `  ${'Cache Hit Sub-Score'.padEnd(30)} ${scoreA.cacheHitSubScore.toFixed(1).padStart(12)} ${scoreB.cacheHitSubScore.toFixed(1).padStart(12)} ${`${sign(delta.cacheHitSubScore)}${delta.cacheHitSubScore.toFixed(1)}`.padStart(10)}\n`
          )
          process.stdout.write(
            `  ${'I/O Ratio Sub-Score'.padEnd(30)} ${scoreA.ioRatioSubScore.toFixed(1).padStart(12)} ${scoreB.ioRatioSubScore.toFixed(1).padStart(12)} ${`${sign(delta.ioRatioSubScore)}${delta.ioRatioSubScore.toFixed(1)}`.padStart(10)}\n`
          )
          process.stdout.write(
            `  ${'Context Mgmt Sub-Score'.padEnd(30)} ${scoreA.contextManagementSubScore.toFixed(1).padStart(12)} ${scoreB.contextManagementSubScore.toFixed(1).padStart(12)} ${`${sign(delta.contextManagementSubScore)}${delta.contextManagementSubScore.toFixed(1)}`.padStart(10)}\n`
          )
          process.stdout.write(
            `  ${'Token Density Sub-Score'.padEnd(30)} ${(scoreA.tokenDensitySubScore ?? 0).toFixed(1).padStart(12)} ${(scoreB.tokenDensitySubScore ?? 0).toFixed(1).padStart(12)} ${`${sign(delta.tokenDensitySubScore)}${delta.tokenDensitySubScore.toFixed(1)}`.padStart(10)}\n`
          )
        }
        return 0
      }
    } finally {
      try {
        await telemetryHandle.close()
      } catch {
        /* ignore */
      }
    }
  }

  // Routing recommendations mode (Story 28-8)
  if (routingRecommendations === true) {
    const dbRoot = await resolveMainRepoRoot(projectRoot)
    const dbDir = join(dbRoot, '.substrate')
    const doltStatePath = join(dbDir, 'state', '.dolt')
    const doltExists = existsSync(doltStatePath)
    const stateBackend = doltExists ? 'dolt' : 'file'
    const stateBasePath = join(dbDir, 'state')

    const stateStore = createStateStore({ backend: stateBackend, basePath: stateBasePath })
    await stateStore.initialize()

    try {
      // Load the run index
      const runIndexRaw = await stateStore.getMetric('__global__', 'phase_token_breakdown_runs')
      const runIds: string[] = Array.isArray(runIndexRaw) ? (runIndexRaw as string[]) : []
      const recentRunIds = runIds.slice(-20)

      const breakdowns: PhaseTokenBreakdown[] = []
      for (const runId of recentRunIds) {
        try {
          const raw = await stateStore.getMetric(runId, 'phase_token_breakdown')
          if (raw !== undefined && raw !== null) {
            const parsed: PhaseTokenBreakdown =
              typeof raw === 'string'
                ? (JSON.parse(raw) as PhaseTokenBreakdown)
                : (raw as PhaseTokenBreakdown)
            breakdowns.push(parsed)
          }
        } catch {
          // skip bad entries
        }
      }

      // We need a routing config to know current models per phase.
      // Use a minimal stub if no config is available.
      const routingConfigPath = join(dbDir, 'routing.yml')
      let routingConfig: import('../../modules/routing/index.js').ModelRoutingConfig | null = null
      if (existsSync(routingConfigPath)) {
        try {
          const { loadModelRoutingConfig } = await import('../../modules/routing/index.js')
          routingConfig = loadModelRoutingConfig(routingConfigPath)
        } catch {
          // ignore
        }
      }

      if (routingConfig === null) {
        routingConfig = {
          version: 1,
          phases: {},
          baseline_model: 'claude-sonnet',
        }
      }

      const recommender = new RoutingRecommender(createLogger('routing:recommender'))
      const analysis = recommender.analyze(breakdowns, routingConfig)

      if (outputFormat === 'json') {
        process.stdout.write(
          formatOutput(
            {
              recommendations: analysis.recommendations,
              analysisRuns: analysis.analysisRuns,
              insufficientData: analysis.insufficientData,
            },
            'json',
            true
          ) + '\n'
        )
      } else {
        process.stdout.write(`Routing Recommendations:\n`)
        if (analysis.insufficientData) {
          process.stdout.write(`No recommendations yet — need at least 3 pipeline runs\n`)
        } else if (analysis.recommendations.length === 0) {
          process.stdout.write(`  No recommendations — all phases are in the neutral zone\n`)
        } else {
          for (const rec of analysis.recommendations) {
            process.stdout.write(
              `  ${rec.phase} | ${rec.currentModel} → ${rec.suggestedModel} | est. savings: ${Math.round(rec.estimatedSavingsPct)}%\n`
            )
          }
        }
      }
    } finally {
      await stateStore.close().catch(() => {
        /* ignore */
      })
    }
    return 0
  }

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
        const content = await readFile(mdPath, 'utf-8').catch(() => readFile(jsonPath, 'utf-8'))
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
  const doltStateDir = join(dbRoot, '.substrate', 'state', '.dolt')

  // When --factory or --run is specified, bypass the dolt-state check and try to open
  // the adapter directly for factory queries (factory tables may exist even without SDLC Dolt state).
  if (!existsSync(doltStateDir) && factory !== true && run === undefined) {
    if (outputFormat === 'json') {
      process.stdout.write(
        formatOutput(
          {
            runs: [],
            message:
              'No metrics yet — no pipeline database found. Initialize Dolt with `substrate init`.',
          },
          'json',
          true
        ) + '\n'
      )
    } else {
      process.stdout.write(
        'No metrics yet — no pipeline database found. Initialize Dolt with `substrate init`.\n'
      )
    }
    return 0
  }

  const adapter = createDatabaseAdapter({ backend: 'auto', basePath: dbRoot })
  try {
    await initSchema(adapter)

    // --run mode: show per-iteration score history for a specific factory run (AC3)
    if (run !== undefined) {
      let rows: ScenarioResultRow[] = []
      let resolvedRunId = run
      try {
        rows = await getScenarioResultsForRun(adapter, run)
        // If exact match found nothing and the input looks like a prefix, try prefix matching
        if (rows.length === 0 && run.length < 36) {
          const allRuns = await listGraphRuns(adapter, 100)
          const matching = allRuns.filter((r) => r.id.startsWith(run))
          if (matching.length === 1 && matching[0] !== undefined) {
            resolvedRunId = matching[0].id
            rows = await getScenarioResultsForRun(adapter, resolvedRunId)
          }
        }
      } catch (err) {
        logger.debug({ err }, 'getScenarioResultsForRun failed')
      }
      if (rows.length === 0) {
        const msg = `No factory run found with id: ${run}`
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput({ message: msg }, 'json', true) + '\n')
        } else {
          process.stderr.write(`Error: ${msg}\n`)
        }
        return 1
      }
      if (outputFormat === 'json') {
        process.stdout.write(
          formatOutput({ run_id: resolvedRunId, type: 'factory', iterations: rows }, 'json', true) +
            '\n'
        )
      } else {
        process.stdout.write(`\nFactory Run: ${resolvedRunId}\n`)
        process.stdout.write('─'.repeat(80) + '\n')
        process.stdout.write(
          `  ${'#'.padStart(3)} ${'score'.padStart(7)} ${'passes'.padStart(7)} ${'passed/total'.padStart(13)} ${'executed_at'.padEnd(20)}\n`
        )
        process.stdout.write('  ' + '─'.repeat(54) + '\n')
        for (const r of rows) {
          const scoreStr = `${(r.satisfaction_score * 100).toFixed(1)}%`
          const passesStr = r.passes ? '✓' : '✗'
          const passedTotal = `${r.passed}/${r.total_scenarios}`
          const execAt = String(r.executed_at).slice(0, 19)
          process.stdout.write(
            `  ${String(r.iteration).padStart(3)} ${scoreStr.padStart(7)} ${passesStr.padStart(7)} ${passedTotal.padStart(13)} ${execAt.padEnd(20)}\n`
          )
        }
        // Display twin lifecycle info for this run (story 47-7)
        try {
          const twinRuns = await getTwinRunsForRun(adapter, resolvedRunId)
          if (twinRuns.length > 0) {
            process.stdout.write('\nTwins:\n')
            for (const twin of twinRuns) {
              const ports = twin.ports
                .map((p: PortMapping) => `${p.host}:${p.container}`)
                .join(', ')
              const stoppedAt = twin.stopped_at ?? 'still running'
              process.stdout.write(
                `  ${twin.twin_name} [${twin.status}] ports: ${ports || 'none'} ` +
                  `started: ${twin.started_at} stopped: ${stoppedAt} ` +
                  `health failures: ${twin.health_failure_count}\n`
              )
            }
          }
        } catch (err) {
          logger.debug({ err }, 'getTwinRunsForRun failed — twin_runs table may not exist yet')
        }
      }
      return 0
    }

    // --factory mode: show only factory graph run metrics (AC7)
    if (factory === true) {
      let factoryRuns: FactoryRunSummary[] = []
      try {
        factoryRuns = await getFactoryRunSummaries(adapter, limit)
      } catch (err) {
        logger.debug({ err }, 'getFactoryRunSummaries failed in factory-only mode')
      }
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput({ graph_runs: factoryRuns }, 'json', true) + '\n')
      } else {
        if (factoryRuns.length === 0) {
          process.stdout.write('No factory runs recorded yet.\n')
        } else {
          printFactoryRunTable(factoryRuns)
        }
      }
      return 0
    }

    // Tag-baseline mode (AC4)
    if (tagBaseline !== undefined) {
      const row = await getRunMetrics(adapter, tagBaseline)
      if (!row) {
        const msg = `Run '${tagBaseline}' not found in run_metrics.`
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
        } else {
          process.stderr.write(`Error: ${msg}\n`)
        }
        return 1
      }
      await tagRunAsBaseline(adapter, tagBaseline)
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
      const delta = await compareRunMetrics(adapter, idA, idB)
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
        const fmtPct = (pct: number | null) => (pct === null ? 'N/A' : `${sign(pct)}${pct}%`)
        process.stdout.write(`\nMetrics Comparison: ${idA.slice(0, 8)} vs ${idB.slice(0, 8)}\n`)
        process.stdout.write(
          `  Input tokens:   ${sign(delta.token_input_delta)}${delta.token_input_delta.toLocaleString()} (${fmtPct(delta.token_input_pct)})\n`
        )
        process.stdout.write(
          `  Output tokens:  ${sign(delta.token_output_delta)}${delta.token_output_delta.toLocaleString()} (${fmtPct(delta.token_output_pct)})\n`
        )
        process.stdout.write(
          `  Wall clock:     ${sign(delta.wall_clock_delta_seconds)}${delta.wall_clock_delta_seconds}s (${fmtPct(delta.wall_clock_pct)})\n`
        )
        process.stdout.write(
          `  Review cycles:  ${sign(delta.review_cycles_delta)}${delta.review_cycles_delta} (${fmtPct(delta.review_cycles_pct)})\n`
        )
        process.stdout.write(
          `  Cost USD:       ${delta.cost_delta < 0 ? '-' : sign(delta.cost_delta)}$${Math.abs(delta.cost_delta).toFixed(4)} (${fmtPct(delta.cost_pct)})\n`
        )
      }
      return 0
    }

    // List mode
    const runs: RunMetricsRow[] = await listRunMetrics(adapter, limit)

    // AC3/AC4/AC5 of Story 26-5: query StateStore if Dolt is present AND filter flags are used
    // Only activate the Dolt path when at least one new filter flag is provided or --aggregate is set.
    // A bare `substrate metrics` with no filter flags should not query Dolt unnecessarily.
    let doltMetrics: MetricRecord[] | undefined
    const doltStatePath = join(dbRoot, '.substrate', 'state', '.dolt')
    const hasDoltFilters =
      sprint !== undefined ||
      story !== undefined ||
      taskType !== undefined ||
      since !== undefined ||
      aggregate === true
    if (existsSync(doltStatePath) && hasDoltFilters) {
      try {
        const stateStore = createStateStore({
          backend: 'dolt',
          basePath: join(dbRoot, '.substrate', 'state'),
        })
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
        logger.warn(
          { err: doltErr },
          'StateStore query failed — falling back to SQLite metrics only'
        )
      }
    }

    // AC6 of Story 21-1: query story-metrics decisions for per-story efficiency data
    const storyMetricDecisions = await getDecisionsByCategory(adapter, STORY_METRICS)
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

    // Story 28-6: Fetch phase_token_breakdown for each run from FileStateStore (kv-metrics.json).
    // Returns null when no breakdown was stored (no routing config, or different backend).
    const phaseBreakdownMap: Record<string, PhaseTokenBreakdown | null> = {}
    try {
      const kvStore = new FileStateStore({ basePath: join(dbRoot, '.substrate') })
      for (const run of runs) {
        const raw = await kvStore.getMetric(run.run_id, 'phase_token_breakdown')
        phaseBreakdownMap[run.run_id] = (
          raw !== undefined ? raw : null
        ) as PhaseTokenBreakdown | null
      }
    } catch {
      // Non-fatal: fall back to null for all runs
    }

    // Story 46-4: Fetch factory run summaries to include in metrics output
    let factoryRuns: FactoryRunSummary[] = []
    try {
      factoryRuns = await getFactoryRunSummaries(adapter, limit)
    } catch (err) {
      logger.debug(
        { err },
        'getFactoryRunSummaries failed — table may not exist in older databases'
      )
    }

    if (outputFormat === 'json') {
      // Enrich each run with its phase_token_breakdown field; add type discriminator
      const runsWithBreakdown = runs.map((run) => ({
        ...run,
        type: 'sdlc' as const,
        phase_token_breakdown: phaseBreakdownMap[run.run_id] ?? null,
      }))
      const jsonPayload: Record<string, unknown> = {
        runs: runsWithBreakdown,
        graph_runs: factoryRuns,
        story_metrics: storyMetrics,
      }
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
      if (
        runs.length === 0 &&
        storyMetrics.length === 0 &&
        (doltMetrics === undefined || doltMetrics.length === 0) &&
        factoryRuns.length === 0
      ) {
        process.stdout.write(
          'No run metrics recorded yet. Run `substrate run` to generate metrics.\n'
        )
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
          process.stdout.write(
            `  Stories:   attempted=${run.stories_attempted} succeeded=${run.stories_succeeded} failed=${run.stories_failed} escalated=${run.stories_escalated}\n`
          )
          process.stdout.write(
            `  Tokens:    ${(run.total_input_tokens ?? 0).toLocaleString()} in / ${(run.total_output_tokens ?? 0).toLocaleString()} out  $${(run.total_cost_usd ?? 0).toFixed(4)}\n`
          )
          process.stdout.write(
            `  Cycles:    ${run.total_review_cycles}  |  Dispatches: ${run.total_dispatches}  |  Concurrency: ${run.concurrency_setting}\n`
          )
          // Story 28-6: Print phase token breakdown table if present
          const breakdown = phaseBreakdownMap[run.run_id]
          if (breakdown !== null && breakdown !== undefined && breakdown.entries.length > 0) {
            process.stdout.write('  Phase Token Breakdown:\n')
            for (const entry of breakdown.entries) {
              process.stdout.write(
                `    ${entry.phase.padEnd(10)} | ${entry.model.padEnd(30)} | in: ${entry.inputTokens} | out: ${entry.outputTokens} | dispatches: ${entry.dispatchCount}\n`
              )
            }
          }
        }
      }
      if (storyMetrics.length > 0) {
        process.stdout.write(`\nPer-Story Efficiency Metrics (${storyMetrics.length} stories)\n`)
        process.stdout.write('─'.repeat(80) + '\n')
        process.stdout.write(
          `  ${'Story'.padEnd(16)} ${'Run'.padEnd(12)} ${'Wall(s)'.padStart(8)} ${'Tokens In'.padStart(10)} ${'Tokens Out'.padStart(11)} ${'Cycles'.padStart(7)} ${'Stalled'.padStart(8)}\n`
        )
        process.stdout.write('  ' + '─'.repeat(76) + '\n')
        for (const sm of storyMetrics) {
          const runShort = sm.run_id.slice(0, 8)
          const stalledStr = sm.stalled ? 'yes' : 'no'
          const costStr =
            sm.cost_usd !== undefined && sm.cost_usd > 0 ? `  $${sm.cost_usd.toFixed(4)}` : ''
          process.stdout.write(
            `  ${sm.story_key.padEnd(16)} ${runShort.padEnd(12)} ${String(sm.wall_clock_seconds).padStart(8)} ${sm.input_tokens.toLocaleString().padStart(10)} ${sm.output_tokens.toLocaleString().padStart(11)} ${String(sm.review_cycles).padStart(7)} ${stalledStr.padStart(8)}${costStr}\n`
          )
        }
      }
      if (doltMetrics !== undefined && doltMetrics.length > 0) {
        if (aggregate) {
          // Aggregate mode: display task_type | count | avg_cost_usd | sum_tokens_in | sum_tokens_out
          process.stdout.write(`\nStateStore Aggregate Metrics (by task type)\n`)
          process.stdout.write('─'.repeat(80) + '\n')
          process.stdout.write(
            `  ${'Task Type'.padEnd(20)} ${'Count'.padStart(8)} ${'Avg Cost'.padStart(12)} ${'Sum Tokens In'.padStart(14)} ${'Sum Tokens Out'.padStart(15)}\n`
          )
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
              `  ${m.taskType.padEnd(20)} ${String(count).padStart(8)} ${avgCost.padStart(12)} ${sumIn.padStart(14)} ${sumOut.padStart(15)}\n`
            )
          }
          // Overall totals row
          process.stdout.write('  ' + '─'.repeat(72) + '\n')
          process.stdout.write(
            `  ${'TOTAL'.padEnd(20)} ${String(totalCount).padStart(8)} ${`$${totalCost.toFixed(4)}`.padStart(12)} ${totalTokensIn.toLocaleString().padStart(14)} ${totalTokensOut.toLocaleString().padStart(15)}\n`
          )
        } else {
          // Regular mode: display per-record details
          process.stdout.write(`\nStateStore Metrics (${doltMetrics.length} records)\n`)
          process.stdout.write('─'.repeat(80) + '\n')
          process.stdout.write(
            `  ${'Story'.padEnd(16)} ${'Task Type'.padEnd(16)} ${'Tokens In'.padStart(10)} ${'Tokens Out'.padStart(11)} ${'Wall(ms)'.padStart(10)} ${'Result'.padEnd(12)}\n`
          )
          process.stdout.write('  ' + '─'.repeat(76) + '\n')
          for (const m of doltMetrics) {
            const tokIn = m.tokensIn !== undefined ? m.tokensIn.toLocaleString() : '-'
            const tokOut = m.tokensOut !== undefined ? m.tokensOut.toLocaleString() : '-'
            const wall = m.wallClockMs !== undefined ? String(m.wallClockMs) : '-'
            const res = m.result ?? '-'
            process.stdout.write(
              `  ${m.storyKey.padEnd(16)} ${m.taskType.padEnd(16)} ${tokIn.padStart(10)} ${tokOut.padStart(11)} ${wall.padStart(10)} ${res.padEnd(12)}\n`
            )
          }
        }
      }
      // Story 46-4: Print factory run table if any factory runs exist
      if (factoryRuns.length > 0) {
        printFactoryRunTable(factoryRuns)
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
      await adapter.close()
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
  projectRoot = process.cwd()
): void {
  program
    .command('metrics')
    .description('Show historical pipeline run metrics and cross-run comparison')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .option(
      '--limit <n>',
      'Number of runs to show (default: 10)',
      (v: string) => parseInt(v, 10),
      10
    )
    .option(
      '--compare <run-id-a,run-id-b>',
      'Compare two runs side-by-side (comma-separated IDs, e.g. abc123,def456)'
    )
    .option('--tag-baseline <run-id>', 'Mark a run as the performance baseline')
    .option(
      '--analysis <run-id>',
      'Read and output the analysis report for the specified run (AC5 of Story 17-3)'
    )
    .option('--sprint <sprint>', 'Filter StateStore metrics by sprint (e.g. sprint-1)')
    .option('--story <story-key>', 'Filter StateStore metrics by story key (e.g. 26-1)')
    .option('--task-type <type>', 'Filter StateStore metrics by task type (e.g. dev-story)')
    .option('--since <iso-date>', 'Filter StateStore metrics at or after this ISO timestamp')
    .option('--aggregate', 'Aggregate StateStore metrics grouped by task_type')
    .option('--efficiency', 'Show telemetry efficiency scores for recent stories')
    .option('--recommendations', 'Show all telemetry recommendations across stories')
    .option('--turns <storyKey>', 'Show per-turn analysis for a specific story')
    .option('--consumers <storyKey>', 'Show consumer stats for a specific story')
    .option('--categories', 'Show category stats (optionally scoped by --story <storyKey>)')
    .option(
      '--compare-stories <storyA,storyB>',
      'Compare efficiency scores of two stories side-by-side (comma-separated keys)'
    )
    .option(
      '--routing-recommendations',
      'Show routing recommendations derived from phase token breakdown history'
    )
    .option('--run <run-id>', 'Show per-iteration score history for a specific factory run')
    .option('--factory', 'Show only factory graph run metrics (excludes SDLC runs)')
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
        efficiency?: boolean
        recommendations?: boolean
        turns?: string
        consumers?: string
        categories?: boolean
        compareStories?: string
        routingRecommendations?: boolean
        run?: string
        factory?: boolean
      }) => {
        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
        let compareIds: [string, string] | undefined
        if (opts.compare !== undefined) {
          const parts = opts.compare.split(',').map((s) => s.trim())
          if (parts.length === 2 && parts[0] && parts[1]) {
            compareIds = [parts[0], parts[1]]
          }
        }
        let compareStoriesIds: [string, string] | undefined
        if (opts.compareStories !== undefined) {
          const parts = opts.compareStories.split(',').map((s) => s.trim())
          if (parts.length === 2 && parts[0] && parts[1]) {
            compareStoriesIds = [parts[0], parts[1]]
          } else {
            process.stderr.write(
              'Error: --compare-stories requires exactly two comma-separated story keys\n'
            )
            process.exitCode = 1
            return
          }
        }
        const metricsOpts: MetricsOptions = {
          outputFormat,
          projectRoot: opts.projectRoot,
          limit: opts.limit,
          ...(compareIds !== undefined && { compare: compareIds }),
          ...(opts.tagBaseline !== undefined && { tagBaseline: opts.tagBaseline }),
          ...(opts.analysis !== undefined && { analysis: opts.analysis }),
          ...(opts.sprint !== undefined && { sprint: opts.sprint }),
          ...(opts.story !== undefined && { story: opts.story }),
          ...(opts.taskType !== undefined && { taskType: opts.taskType }),
          ...(opts.since !== undefined && { since: opts.since }),
          ...(opts.aggregate !== undefined && { aggregate: opts.aggregate }),
          ...(opts.efficiency !== undefined && { efficiency: opts.efficiency }),
          ...(opts.recommendations !== undefined && { recommendations: opts.recommendations }),
          ...(opts.turns !== undefined && { turns: opts.turns }),
          ...(opts.consumers !== undefined && { consumers: opts.consumers }),
          ...(opts.categories !== undefined && { categories: opts.categories }),
          ...(compareStoriesIds !== undefined && { compareStories: compareStoriesIds }),
          ...(opts.routingRecommendations !== undefined && {
            routingRecommendations: opts.routingRecommendations,
          }),
          ...(opts.run !== undefined && { run: opts.run }),
          ...(opts.factory !== undefined && { factory: opts.factory }),
        }
        const exitCode = await runMetricsAction(metricsOpts)
        process.exitCode = exitCode
      }
    )
}
