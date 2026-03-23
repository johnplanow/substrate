/**
 * Register the `factory` command group on the provided Commander program.
 *
 * Subcommand tree:
 *   factory
 *     scenarios
 *       list              — list discovered scenario files with SHA-256 checksums
 *       run [--format]    — execute all scenarios; text summary or JSON output
 *     run
 *       --graph <path>    — execute a DOT graph pipeline
 *       --events          — emit NDJSON events to stdout
 *       --config <path>   — path to config.yaml (default: auto-detect)
 *
 * Story 44-8 (scenarios), Story 44-9 (factory run).
 */

import type { Command } from 'commander'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { registerScenariosCommand } from './scenarios/cli-command.js'
import { parseGraph } from './graph/parser.js'
import { createValidator } from './graph/validator.js'
import { createGraphExecutor } from './graph/executor.js'
import { createDefaultRegistry } from './handlers/index.js'
import { RunStateManager } from './graph/run-state.js'
import { loadFactoryConfig } from './config.js'
import { TypedEventBusImpl } from '@substrate-ai/core'
import type { FactoryEvents } from './events.js'

// ---------------------------------------------------------------------------
// resolveGraphPath
// ---------------------------------------------------------------------------

/**
 * Resolve the DOT graph file path from CLI options or config.
 *
 * Resolution order (architecture Section 11.3):
 *   1. `--graph <path>` CLI flag (explicit override)
 *   2. `factory.graph` key in resolved config
 *   3. `pipeline.dot` auto-detect in `projectDir`
 *   4. Returns `null` if none found
 *
 * @param opts - Parsed CLI options (may include `graph` and `config` fields).
 * @param projectDir - Absolute path to the project root directory.
 * @returns Resolved graph file path or `null` if none found.
 */
async function resolveGraphPath(
  opts: { graph?: string; config?: string },
  projectDir: string,
): Promise<string | null> {
  // 1. --graph CLI flag takes priority
  if (opts.graph) {
    return opts.graph
  }

  // 2. factory.graph key in resolved config
  const config = await loadFactoryConfig(projectDir, opts.config)
  if (config.factory?.graph) {
    return config.factory.graph
  }

  // 3. pipeline.dot auto-detect fallback
  const autoDotPath = path.join(projectDir, 'pipeline.dot')
  try {
    await readFile(autoDotPath, 'utf-8')
    return autoDotPath
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
    // File not found — continue to null
  }

  return null
}

// ---------------------------------------------------------------------------
// registerFactoryCommand
// ---------------------------------------------------------------------------

/**
 * Register the `factory` command group on the provided Commander program.
 *
 * Story 44-8: registers the `scenarios` subcommand.
 * Story 44-9: registers the `run` subcommand.
 */
export function registerFactoryCommand(program: Command): void {
  const factoryCmd = program
    .command('factory')
    .description('Factory pipeline and scenario management commands')

  registerScenariosCommand(factoryCmd) // story 44-8 — unchanged

  // Story 44-9: factory run
  factoryCmd
    .command('run')
    .description('Execute a DOT graph pipeline')
    .option('--graph <path>', 'Path to DOT graph file')
    .option('--config <path>', 'Path to config.yaml (default: auto-detect)')
    .option('--events', 'Emit NDJSON events to stdout')
    .action(async (opts) => {
      try {
        const projectDir = process.cwd()

        // Resolve graph file path from opts, config, or auto-detect
        const graphPath = await resolveGraphPath(opts, projectDir)

        if (!graphPath) {
          process.stderr.write('Error: No graph file specified\n')
          process.exit(1)
          return
        }

        // Read and parse the DOT graph file
        const dotSource = await readFile(graphPath, 'utf-8')
        const graph = parseGraph(dotSource)

        // Validate the graph (raises on error-severity diagnostics)
        const validator = createValidator()
        validator.validateOrRaise(graph)

        // Set up the event bus for NDJSON event emission
        const eventBus = new TypedEventBusImpl<FactoryEvents>()

        if (opts.events) {
          const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + '\n')
          eventBus.on('graph:node-started', (e) => emit({ type: 'graph:node-started', ...e }))
          eventBus.on('graph:node-completed', (e) => emit({ type: 'graph:node-completed', ...e }))
          eventBus.on('graph:started', (e) => emit({ type: 'graph:started', ...e }))
          eventBus.on('graph:completed', (e) => emit({ type: 'graph:completed', ...e }))
        }

        // Print start confirmation
        process.stdout.write(`Running graph pipeline from ${graphPath}\n`)

        // Wire up executor and run
        const runId = randomUUID()
        const logsRoot = path.join(projectDir, '.substrate', 'runs', runId)

        // Initialize run directory and persist graph.dot before execution starts (story 44-7)
        const stateManager = new RunStateManager({ runDir: logsRoot })
        await stateManager.initRun(dotSource)

        // Load factory config for convergence budget and plateau configuration (story 45-10).
        // Called here separately from resolveGraphPath so config loading stays idempotent —
        // resolveGraphPath already loaded config for graph-path resolution; loading again here
        // is acceptable since loadFactoryConfig is a pure read with no side effects.
        /** wallClockCapMs: FactoryConfig.wall_clock_cap_seconds × 1000 (story 45-10) */
        const factoryConfig = await loadFactoryConfig(projectDir, opts.config)

        const executor = createGraphExecutor()
        await executor.run(graph, {
          runId,
          logsRoot,
          handlerRegistry: createDefaultRegistry(),
          eventBus,
          dotSource,
          /** wallClockCapMs derived from FactoryConfig.wall_clock_cap_seconds × 1000 (story 45-10) */
          wallClockCapMs: (factoryConfig.factory?.wall_clock_cap_seconds ?? 0) * 1000,
          /** pipelineBudgetCapUsd forwarded as-is from FactoryConfig.budget_cap_usd (story 45-10) */
          pipelineBudgetCapUsd: factoryConfig.factory?.budget_cap_usd ?? 0,
          /** plateauWindow forwarded as-is from FactoryConfig.plateau_window (story 45-10) */
          plateauWindow: factoryConfig.factory?.plateau_window ?? 3,
          /** plateauThreshold forwarded as-is from FactoryConfig.plateau_threshold (story 45-10) */
          plateauThreshold: factoryConfig.factory?.plateau_threshold ?? 0.05,
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: ${msg}\n`)
        process.exit(1)
      }
    })
}
