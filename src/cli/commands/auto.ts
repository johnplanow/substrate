/**
 * `substrate auto` command group
 *
 * Provides the autonomous implementation pipeline CLI interface:
 *   substrate auto init [--pack bmad] [--project-root .]
 *   substrate auto run [--pack bmad] [--stories 10-1,10-2] [--concurrency 3] [--output-format json]
 *   substrate auto status [--output-format json] [--run-id <id>]
 *
 * Architecture (ADR-001: Modular Monolith):
 *   CLI is a thin wiring layer — all business logic lives in modules.
 *
 * Database (ADR-003: SQLite WAL):
 *   Uses DatabaseWrapper from src/persistence/database.ts for all DB access.
 */

import type { Command } from 'commander'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { createEventBus } from '../../core/event-bus.js'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { createContextCompiler } from '../../modules/context-compiler/index.js'
import { createDispatcher } from '../../modules/agent-dispatch/index.js'
import { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { createImplementationOrchestrator } from '../../modules/implementation-orchestrator/index.js'
import {
  createPipelineRun,
  getLatestRun,
  addTokenUsage,
  getTokenUsageSummary,
} from '../../persistence/queries/decisions.js'
import type { PipelineRun, TokenUsageSummary } from '../../persistence/queries/decisions.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('auto-cmd')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** BMAD baseline token total for create+dev+review comparison */
const BMAD_BASELINE_TOKENS = 23_800

/** Story key pattern: <epic>-<story> e.g. "10-1" */
const STORY_KEY_PATTERN = /^\d+-\d+$/

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

type OutputFormat = 'human' | 'json'

/**
 * Format output according to the requested format.
 */
export function formatOutput(
  data: unknown,
  format: OutputFormat,
  success = true,
  errorMessage?: string,
): string {
  if (format === 'json') {
    if (!success) {
      return JSON.stringify({ success: false, error: errorMessage ?? 'Unknown error' })
    }
    return JSON.stringify({ success: true, data })
  }
  // Human format: return data as-is if string, otherwise pretty-print
  if (typeof data === 'string') return data
  return JSON.stringify(data, null, 2)
}

/**
 * Build a human-readable token telemetry display from summary rows.
 */
export function formatTokenTelemetry(summary: TokenUsageSummary[]): string {
  if (summary.length === 0) {
    return 'No token usage recorded.'
  }

  let totalInput = 0
  let totalOutput = 0
  let totalCost = 0

  const lines: string[] = ['Pipeline Token Usage:']
  for (const row of summary) {
    totalInput += row.total_input_tokens
    totalOutput += row.total_output_tokens
    totalCost += row.total_cost_usd
    const cost = `$${row.total_cost_usd.toFixed(4)}`
    lines.push(
      `  ${row.phase} (${row.agent}): ${row.total_input_tokens.toLocaleString()} input / ${row.total_output_tokens.toLocaleString()} output (${cost})`,
    )
  }
  lines.push('  ' + '─'.repeat(55))

  const costDisplay = `$${totalCost.toFixed(4)}`
  lines.push(
    `  Total:  ${totalInput.toLocaleString()} input / ${totalOutput.toLocaleString()} output (${costDisplay})`,
  )

  const totalTokens = totalInput + totalOutput
  const savingsPct =
    BMAD_BASELINE_TOKENS > 0
      ? Math.round(((BMAD_BASELINE_TOKENS - totalTokens) / BMAD_BASELINE_TOKENS) * 100)
      : 0
  const savingsLabel =
    savingsPct >= 0
      ? `Savings: ${savingsPct}%`
      : `Overhead: +${Math.abs(savingsPct)}%`
  lines.push(
    `  BMAD Baseline: ${BMAD_BASELINE_TOKENS.toLocaleString()} tokens → ${savingsLabel}`,
  )

  return lines.join('\n')
}

/**
 * Validate a story key has the expected format: <epic>-<story> (e.g., "10-1").
 */
export function validateStoryKey(key: string): boolean {
  return STORY_KEY_PATTERN.test(key)
}

// ---------------------------------------------------------------------------
// auto init action
// ---------------------------------------------------------------------------

export interface AutoInitOptions {
  pack: string
  projectRoot: string
  outputFormat: OutputFormat
}

export async function runAutoInit(options: AutoInitOptions): Promise<number> {
  const { pack: packName, projectRoot, outputFormat } = options

  const packPath = join(projectRoot, 'packs', packName)
  const dbDir = join(projectRoot, '.substrate')
  const dbPath = join(dbDir, 'substrate.db')

  try {
    // Step 1: Validate the pack
    const packLoader = createPackLoader()
    try {
      await packLoader.load(packPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Methodology pack '${packName}' not found. Run 'substrate auto init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    // Step 2: Initialize database and run migrations
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    const dbWrapper = new DatabaseWrapper(dbPath)
    dbWrapper.open()
    runMigrations(dbWrapper.db)
    dbWrapper.close()

    // Step 3: Output success
    const successMsg = `Pack '${packName}' and database initialized successfully at ${dbPath}`
    if (outputFormat === 'json') {
      process.stdout.write(
        formatOutput({ pack: packName, dbPath }, 'json', true) + '\n',
      )
    } else {
      process.stdout.write(`${successMsg}\n`)
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'auto init failed')
    return 1
  }
}

// ---------------------------------------------------------------------------
// auto run action
// ---------------------------------------------------------------------------

export interface AutoRunOptions {
  pack: string
  stories?: string
  concurrency: number
  outputFormat: OutputFormat
  projectRoot: string
}

export async function runAutoRun(options: AutoRunOptions): Promise<number> {
  const { pack: packName, stories: storiesArg, concurrency, outputFormat, projectRoot } = options

  const packPath = join(projectRoot, 'packs', packName)
  const dbDir = join(projectRoot, '.substrate')
  const dbPath = join(dbDir, 'substrate.db')

  // Parse story keys
  let storyKeys: string[] = []
  if (storiesArg !== undefined && storiesArg !== '') {
    storyKeys = storiesArg
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0)

    // Validate story key format
    for (const key of storyKeys) {
      if (!validateStoryKey(key)) {
        const errorMsg = `Story key '${key}' is not a valid format. Expected: <epic>-<story> (e.g., 10-1)`
        if (outputFormat === 'json') {
          process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
        } else {
          process.stderr.write(`Error: ${errorMsg}\n`)
        }
        return 1
      }
    }
  }

  // Ensure database directory
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  // Open database
  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    try {
      dbWrapper.open()
      runMigrations(dbWrapper.db)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Decision store not initialized. Run 'substrate auto init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    const db = dbWrapper.db

    // Load methodology pack
    const packLoader = createPackLoader()
    let pack
    try {
      pack = await packLoader.load(packPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Methodology pack '${packName}' not found. Run 'substrate auto init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    // Discover story keys from DB if not provided
    if (storyKeys.length === 0) {
      // Query requirements table for active stories
      const activeReqs = db
        .prepare(`SELECT description FROM requirements WHERE status = 'active' AND type = 'story'`)
        .all() as Array<{ description: string }>

      for (const req of activeReqs) {
        const match = STORY_KEY_PATTERN.exec(req.description.trim())
        if (match !== null) {
          storyKeys.push(match[0])
        }
      }

      // AC8: filter out stories already completed in previous pipeline runs
      if (storyKeys.length > 0) {
        const completedStoryKeys = new Set<string>()
        try {
          const completedRuns = db
            .prepare(
              `SELECT token_usage_json FROM pipeline_runs WHERE status = 'completed' AND token_usage_json IS NOT NULL`,
            )
            .all() as Array<{ token_usage_json: string }>

          for (const row of completedRuns) {
            try {
              const state = JSON.parse(row.token_usage_json) as {
                stories?: Record<string, { phase: string }>
              }
              if (state.stories !== undefined) {
                for (const [key, s] of Object.entries(state.stories)) {
                  if (s.phase === 'COMPLETE') {
                    completedStoryKeys.add(key)
                  }
                }
              }
            } catch {
              // ignore parse errors
            }
          }
        } catch {
          // ignore query errors — proceed with all discovered stories
        }

        storyKeys = storyKeys.filter((k) => !completedStoryKeys.has(k))
      }

      if (storyKeys.length === 0) {
        if (outputFormat === 'human') {
          process.stdout.write('No pending stories found in decision store.\n')
        } else {
          process.stdout.write(
            formatOutput({ storyKeys: [], message: 'No pending stories found.' }, 'json', true) +
              '\n',
          )
        }
        return 0
      }
    }

    // Create pipeline run record
    const pipelineRun = createPipelineRun(db, {
      methodology: pack.manifest.name,
      start_phase: 'implementation',
      config_json: JSON.stringify({ storyKeys, concurrency }),
    })

    // Create dependencies
    const eventBus = createEventBus()
    const contextCompiler = createContextCompiler({ db })
    const adapterRegistry = new AdapterRegistry()
    await adapterRegistry.discoverAndRegister()

    const dispatcher = createDispatcher({
      eventBus,
      adapterRegistry,
    })

    // AC5: Subscribe to phase-complete events to record token usage
    eventBus.on('orchestrator:story-phase-complete', (payload) => {
      try {
        const result = payload.result as {
          tokenUsage?: { input: number; output: number }
        }
        if (result?.tokenUsage !== undefined) {
          const { input, output } = result.tokenUsage
          // Estimate cost: $3/1M input + $15/1M output (Claude pricing)
          const costUsd = (input * 3 + output * 15) / 1_000_000
          addTokenUsage(db, pipelineRun.id, {
            phase: payload.phase,
            agent: 'claude-code',
            input_tokens: input,
            output_tokens: output,
            cost_usd: costUsd,
          })
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to record token usage for phase')
      }

      if (outputFormat === 'human') {
        process.stdout.write(
          `  [${payload.phase}] ${payload.storyKey} — phase complete\n`,
        )
      }
    })

    // Subscribe to progress events
    if (outputFormat === 'human') {
      eventBus.on('orchestrator:story-complete', (payload) => {
        process.stdout.write(
          `  [COMPLETE] ${payload.storyKey} (${payload.reviewCycles} review cycle(s))\n`,
        )
      })
      eventBus.on('orchestrator:story-escalated', (payload) => {
        process.stdout.write(
          `  [ESCALATED] ${payload.storyKey}: ${payload.lastVerdict}\n`,
        )
      })
    }

    // Create orchestrator
    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config: {
        maxConcurrency: concurrency,
        maxReviewCycles: 3,
        pipelineRunId: pipelineRun.id,
      },
    })

    if (outputFormat === 'human') {
      process.stdout.write(
        `Starting pipeline: ${storyKeys.length} story/stories, concurrency=${concurrency}\n`,
      )
      process.stdout.write(`Pipeline run ID: ${pipelineRun.id}\n`)
      process.stdout.write(`Stories: ${storyKeys.join(', ')}\n`)
    }

    // Run the orchestrator
    const status = await orchestrator.run(storyKeys)

    // Record final token usage for the run
    const tokenSummary = getTokenUsageSummary(db, pipelineRun.id)

    // Output results
    if (outputFormat === 'json') {
      process.stdout.write(
        formatOutput(
          {
            pipelineRunId: pipelineRun.id,
            status,
            tokenSummary,
          },
          'json',
          true,
        ) + '\n',
      )
    } else {
      process.stdout.write('\n')
      // Count story outcomes
      let completed = 0
      let escalated = 0
      for (const s of Object.values(status.stories)) {
        if (s.phase === 'COMPLETE') completed++
        else if (s.phase === 'ESCALATED') escalated++
      }
      process.stdout.write(
        `Pipeline complete: ${completed}/${storyKeys.length} stories completed, ${escalated} escalated\n`,
      )
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
    logger.error({ err }, 'auto run failed')
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
// auto status action
// ---------------------------------------------------------------------------

export interface AutoStatusOptions {
  outputFormat: OutputFormat
  runId?: string
  projectRoot: string
}

export async function runAutoStatus(options: AutoStatusOptions): Promise<number> {
  const { outputFormat, runId, projectRoot } = options

  const dbPath = join(projectRoot, '.substrate', 'substrate.db')

  if (!existsSync(dbPath)) {
    const errorMsg = `Decision store not initialized. Run 'substrate auto init' first.`
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
          : 'No pipeline runs found. Run `substrate auto run` first.'
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    // Get token usage summary
    const tokenSummary = getTokenUsageSummary(db, run.id)

    // Parse story state from config_json or token_usage_json
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

    if (outputFormat === 'json') {
      process.stdout.write(
        formatOutput(
          {
            run,
            storyState,
            tokenSummary,
          },
          'json',
          true,
        ) + '\n',
      )
    } else {
      // Human-readable status
      process.stdout.write(`Pipeline Run: ${run.id}\n`)
      process.stdout.write(`  Status:       ${run.status}\n`)
      process.stdout.write(`  Methodology:  ${run.methodology}\n`)
      process.stdout.write(`  Phase:        ${run.current_phase ?? 'N/A'}\n`)
      process.stdout.write(`  Created:      ${run.created_at}\n`)
      process.stdout.write(`  Updated:      ${run.updated_at}\n`)

      // Story breakdown if available
      if (
        storyState !== null &&
        typeof storyState === 'object' &&
        'stories' in (storyState as Record<string, unknown>)
      ) {
        const stories = (storyState as { stories: Record<string, { phase: string; reviewCycles: number }> }).stories
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
    logger.error({ err }, 'auto status failed')
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
// registerAutoCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate auto` command group with the CLI program.
 *
 * Registers subcommands: init, run, status.
 *
 * @param program     - Commander program instance
 * @param version     - Current Substrate package version (unused currently, reserved)
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerAutoCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  const auto = program
    .command('auto')
    .description('Autonomous implementation pipeline')

  // ----------- auto init -----------
  auto
    .command('init')
    .description('Initialize a methodology pack and decision store for autonomous pipeline')
    .option('--pack <name>', 'Methodology pack name', 'bmad')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(async (opts: { pack: string; projectRoot: string; outputFormat: string }) => {
      const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
      const exitCode = await runAutoInit({
        pack: opts.pack,
        projectRoot: opts.projectRoot,
        outputFormat,
      })
      process.exitCode = exitCode
    })

  // ----------- auto run -----------
  auto
    .command('run')
    .description('Run the autonomous create-story → dev-story → code-review pipeline')
    .option('--pack <name>', 'Methodology pack name', 'bmad')
    .option('--stories <keys>', 'Comma-separated story keys (e.g., 10-1,10-2)')
    .option('--concurrency <n>', 'Maximum parallel conflict groups', (v) => parseInt(v, 10), 3)
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(
      async (opts: {
        pack: string
        stories?: string
        concurrency: number
        projectRoot: string
        outputFormat: string
      }) => {
        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
        const exitCode = await runAutoRun({
          pack: opts.pack,
          stories: opts.stories,
          concurrency: opts.concurrency,
          outputFormat,
          projectRoot: opts.projectRoot,
        })
        process.exitCode = exitCode
      },
    )

  // ----------- auto status -----------
  auto
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
      const exitCode = await runAutoStatus({
        outputFormat,
        runId: opts.runId,
        projectRoot: opts.projectRoot,
      })
      process.exitCode = exitCode
    })
}
