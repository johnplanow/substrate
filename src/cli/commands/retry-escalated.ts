/**
 * `substrate retry-escalated` command
 *
 * Automatically retries escalated stories that the escalation-diagnosis
 * flagged as retry-targeted.
 *
 *   substrate retry-escalated [--run-id <id>] [--dry-run] [--concurrency 3]
 *                              [--pack bmad] [--project-root .] [--output-format json]
 *
 * Architecture (ADR-001: Modular Monolith):
 *   CLI is a thin wiring layer — all query/business logic lives in modules.
 *
 * Database:
 *   Uses createDatabaseAdapter() from src/persistence/adapter.ts for all DB access.
 */

import type { Command } from 'commander'
import { join } from 'path'
import { existsSync } from 'fs'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createEventBus } from '../../core/event-bus.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { initSchema } from '../../persistence/schema.js'
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { createContextCompiler } from '../../modules/context-compiler/index.js'
import { createDispatcher } from '../../modules/agent-dispatch/index.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { createImplementationOrchestrator } from '../../modules/implementation-orchestrator/index.js'
import { createPipelineRun, addTokenUsage } from '../../persistence/queries/decisions.js'
import { getRetryableEscalations } from '../../persistence/queries/retry-escalated.js'
import { createLogger } from '../../utils/logger.js'
import { type OutputFormat, formatOutput } from './pipeline-shared.js'

const logger = createLogger('retry-escalated-cmd')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryEscalatedOptions {
  runId?: string
  dryRun: boolean
  outputFormat: OutputFormat
  projectRoot: string
  concurrency: number
  pack: string
  /** Optional pre-initialized registry; if omitted, a new registry is created and discovered */
  registry?: AdapterRegistry
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function runRetryEscalatedAction(options: RetryEscalatedOptions): Promise<number> {
  const { runId, dryRun, outputFormat, projectRoot, concurrency, pack: packName, registry: injectedRegistry } = options

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

    // Query retryable escalations from the decision store
    const { retryable, skipped } = await getRetryableEscalations(adapter, runId)

    // AC4: No retryable escalations → output message and exit 0
    if (retryable.length === 0) {
      if (outputFormat === 'json') {
        process.stdout.write(
          formatOutput({ retryKeys: [], skippedKeys: skipped }, 'json', true) + '\n',
        )
      } else {
        process.stdout.write('No retry-targeted escalations found.\n')
      }
      return 0
    }

    // AC3 + AC7: Dry-run mode — print plan and exit without invoking orchestrator
    if (dryRun) {
      if (outputFormat === 'json') {
        process.stdout.write(
          formatOutput({ retryKeys: retryable, skippedKeys: skipped }, 'json', true) + '\n',
        )
      } else {
        const count = retryable.length
        process.stdout.write(
          `Retrying: ${count} ${count === 1 ? 'story' : 'stories'} — ${retryable.join(', ')}\n`,
        )
        for (const s of skipped) {
          process.stdout.write(`Skipping: ${s.key} (${s.reason})\n`)
        }
      }
      return 0
    }

    // AC6: Live retry — invoke the orchestrator with retryable keys
    const packPath = join(dbRoot, 'packs', packName)
    const packLoader = createPackLoader()
    let pack
    try {
      pack = await packLoader.load(packPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMsg = `Methodology pack '${packName}' not found. Run 'substrate init' first.\n${msg}`
      if (outputFormat === 'json') {
        process.stdout.write(formatOutput(null, 'json', false, errorMsg) + '\n')
      } else {
        process.stderr.write(`Error: ${errorMsg}\n`)
      }
      return 1
    }

    if (outputFormat === 'human') {
      const count = retryable.length
      process.stdout.write(
        `Retrying: ${count} ${count === 1 ? 'story' : 'stories'} — ${retryable.join(', ')}\n`,
      )
      for (const s of skipped) {
        process.stdout.write(`Skipping: ${s.key} (${s.reason})\n`)
      }
    }

    // Create a new pipeline run for this retry (AC6: start_phase = 'implementation')
    const pipelineRun = await createPipelineRun(adapter, {
      methodology: pack.manifest.name,
      start_phase: 'implementation',
      config_json: JSON.stringify({ storyKeys: retryable, concurrency, retryRun: true }),
    })

    const eventBus = createEventBus()
    const contextCompiler = createContextCompiler({ db: adapter })
    if (!injectedRegistry) {
      throw new Error('AdapterRegistry is required — must be initialized at CLI startup')
    }
    const dispatcher = createDispatcher({ eventBus, adapterRegistry: injectedRegistry })

    const orchestrator = createImplementationOrchestrator({
      db: adapter,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config: {
        maxConcurrency: concurrency,
        maxReviewCycles: 2,
        pipelineRunId: pipelineRun.id,
      },
      projectRoot,
    })

    // Record token usage per phase
    eventBus.on('orchestrator:story-phase-complete', (payload) => {
      try {
        const result = payload.result as { tokenUsage?: { input: number; output: number } }
        if (result?.tokenUsage !== undefined) {
          const { input, output } = result.tokenUsage
          const costUsd = (input * 3 + output * 15) / 1_000_000
          addTokenUsage(adapter, pipelineRun.id, {
            phase: payload.phase,
            agent: 'claude-code',
            input_tokens: input,
            output_tokens: output,
            cost_usd: costUsd,
          }).catch((err) => {
            logger.warn({ err }, 'Failed to record token usage')
          })
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to record token usage')
      }
    })

    // AC6: Wire story-complete / story-escalated events to stdout (human mode)
    if (outputFormat === 'human') {
      eventBus.on('orchestrator:story-complete', (payload) => {
        process.stdout.write(
          `  [COMPLETE] ${payload.storyKey} (${payload.reviewCycles} review cycle(s))\n`,
        )
      })
      eventBus.on('orchestrator:story-escalated', (payload) => {
        process.stdout.write(`  [ESCALATED] ${payload.storyKey}: ${payload.lastVerdict}\n`)
      })
    }

    await orchestrator.run(retryable)

    if (outputFormat === 'json') {
      process.stdout.write(
        formatOutput({ retryKeys: retryable, skippedKeys: skipped }, 'json', true) + '\n',
      )
    } else {
      process.stdout.write('[RETRY] Complete\n')
    }

    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (outputFormat === 'json') {
      process.stdout.write(formatOutput(null, 'json', false, msg) + '\n')
    } else {
      process.stderr.write(`Error: ${msg}\n`)
    }
    logger.error({ err }, 'retry-escalated failed')
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
// Command registration
// ---------------------------------------------------------------------------

export function registerRetryEscalatedCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
  registry?: AdapterRegistry,
): void {
  program
    .command('retry-escalated')
    .description('Retry escalated stories flagged as retry-targeted by escalation diagnosis')
    .option('--run-id <id>', 'Scope to a specific pipeline run ID (defaults to latest run with escalations)')
    .option('--dry-run', 'Print retryable and skipped stories without invoking the orchestrator')
    .option(
      '--concurrency <n>',
      'Maximum parallel story executions',
      (v: string) => {
        const n = parseInt(v, 10)
        if (isNaN(n) || n < 1) {
          throw new Error(`--concurrency must be a positive integer, got: ${v}`)
        }
        return n
      },
      3,
    )
    .option('--pack <name>', 'Methodology pack name', 'bmad')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .action(
      async (opts: {
        runId?: string
        dryRun?: boolean
        concurrency: number
        pack: string
        projectRoot: string
        outputFormat: string
      }) => {
        const outputFormat: OutputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
        const exitCode = await runRetryEscalatedAction({
          runId: opts.runId,
          dryRun: opts.dryRun === true,
          outputFormat,
          projectRoot: opts.projectRoot,
          concurrency: opts.concurrency,
          pack: opts.pack,
          registry,
        })
        process.exitCode = exitCode
      },
    )
}
