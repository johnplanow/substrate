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
 *     twins
 *       templates         — list available built-in twin templates
 *       init --template   — initialize a twin definition file from a template
 *       start             — start all discovered twins via Docker Compose
 *       stop              — stop all running twins and clean up
 *       status            — show each twin's name, status, and port mappings
 *       list              — list all discovered twin definitions
 *
 * Story 44-8 (scenarios), Story 44-9 (factory run), Story 46-7 (validate),
 * Story 47-4 (twins init/templates), Story 47-5 (twins lifecycle).
 */

import type { Command } from 'commander'
import { readFile, mkdir, writeFile, access } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import yaml from 'js-yaml'
import { registerScenariosCommand } from './scenarios/cli-command.js'
import { getTwinTemplate, listTwinTemplates, createTwinRegistry } from './twins/index.js'
import { createTwinManager } from './twins/docker-compose.js'
import { readRunState, writeRunState, clearRunState } from './twins/run-state.js'
import { parseGraph } from './graph/parser.js'
import { createValidator } from './graph/validator.js'
import { createGraphExecutor } from './graph/executor.js'
import { createDefaultRegistry } from './handlers/index.js'
import { RunStateManager } from './graph/run-state.js'
import { loadFactoryConfig } from './config.js'
import { factorySchema } from './persistence/factory-schema.js'
import { TypedEventBusImpl, createDatabaseAdapter } from '@substrate-ai/core'
import type { DatabaseAdapter } from '@substrate-ai/core'
import type { FactoryEvents } from './events.js'
import type { ValidationDiagnostic } from './graph/types.js'

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
// Constants
// ---------------------------------------------------------------------------

/**
 * Total number of validation rules loaded by `createValidator()`.
 * 8 error rules + 5 warning rules = 13 total (stories 42-4, 42-5).
 * This is a fixed constant — the GraphValidator interface does not expose a rule count.
 */
const TOTAL_RULE_COUNT = 13

// ---------------------------------------------------------------------------
// registerFactoryCommand
// ---------------------------------------------------------------------------

/** Options for registerFactoryCommand — allows CLI composition root to inject dependencies. */
export interface FactoryCommandOptions {
  /** Optional adapter factory. When provided, used instead of core's createDatabaseAdapter
   *  to create a Dolt-capable adapter. The monolith CLI injects this with DoltClient. */
  createAdapter?: (basePath: string) => DatabaseAdapter
}

/**
 * Register the `factory` command group on the provided Commander program.
 *
 * Story 44-8: registers the `scenarios` subcommand.
 * Story 44-9: registers the `run` subcommand.
 * Story 46-7: registers the `validate` subcommand.
 */
export function registerFactoryCommand(program: Command, options?: FactoryCommandOptions): void {
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

        // Initialize persistence adapter and factory schema (story 46-3).
        // Uses auto-detection: Dolt if available, otherwise in-memory fallback.
        // factorySchema is idempotent — safe to call on every run.
        const adapter = options?.createAdapter
          ? options.createAdapter(projectDir)
          : createDatabaseAdapter({ backend: 'auto', basePath: projectDir })
        await factorySchema(adapter)

        const executor = createGraphExecutor()
        const result = await executor.run(graph, {
          runId,
          logsRoot,
          handlerRegistry: createDefaultRegistry(),
          eventBus,
          dotSource,
          adapter,
          /** wallClockCapMs derived from FactoryConfig.wall_clock_cap_seconds × 1000 (story 45-10) */
          wallClockCapMs: (factoryConfig.factory?.wall_clock_cap_seconds ?? 0) * 1000,
          /** pipelineBudgetCapUsd forwarded as-is from FactoryConfig.budget_cap_usd (story 45-10) */
          pipelineBudgetCapUsd: factoryConfig.factory?.budget_cap_usd ?? 0,
          /** plateauWindow forwarded as-is from FactoryConfig.plateau_window (story 45-10) */
          plateauWindow: factoryConfig.factory?.plateau_window ?? 3,
          /** plateauThreshold forwarded as-is from FactoryConfig.plateau_threshold (story 45-10) */
          plateauThreshold: factoryConfig.factory?.plateau_threshold ?? 0.05,
          /** satisfactionThreshold forwarded from FactoryConfig.satisfaction_threshold (story 46-6) */
          satisfactionThreshold: factoryConfig.factory?.satisfaction_threshold ?? 0.8,
          /** qualityMode forwarded from FactoryConfig.quality_mode (story 46-6) */
          qualityMode: factoryConfig.factory?.quality_mode ?? 'dual-signal',
        })

        if (result.status === 'SUCCESS') {
          process.stdout.write('Pipeline completed successfully.\n')
        } else {
          process.stderr.write('Pipeline failed: ' + (result.failureReason ?? result.status) + '\n')
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: ${msg}\n`)
        process.exit(1)
      }
    })

  // Story 46-7: factory validate
  factoryCmd
    .command('validate <graph-file>')
    .description('Parse and lint a DOT graph against all 13 validation rules')
    .option('--output-format <format>', 'Output format: json | text', 'text')
    .action(async (graphFile: string, opts: { outputFormat: string }) => {
      // Task 2: Read the file
      let source: string
      try {
        source = await readFile(graphFile, 'utf-8')
      } catch (err: unknown) {
        const isEnoent =
          err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
        if (isEnoent) {
          process.stderr.write(`Error: file not found: ${graphFile}\n`)
        } else {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`Error: file not found: ${graphFile} (${msg})\n`)
        }
        process.exit(2)
        return
      }

      // Task 2: Parse the DOT graph
      let graph: ReturnType<typeof parseGraph>
      try {
        graph = parseGraph(source)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: failed to parse graph: ${msg}\n`)
        process.exit(2)
        return
      }

      // Task 3: Run validation and compute statistics
      const diagnostics: ValidationDiagnostic[] = createValidator().validate(graph)
      const errors = diagnostics.filter((d) => d.severity === 'error')
      const warnings = diagnostics.filter((d) => d.severity === 'warning')
      const firedRuleIds = new Set(diagnostics.map((d) => d.ruleId))
      const passedCount = TOTAL_RULE_COUNT - firedRuleIds.size

      // Task 5: JSON output mode
      if (opts.outputFormat === 'json') {
        process.stdout.write(JSON.stringify(diagnostics, null, 2) + '\n')
        if (errors.length > 0) {
          process.exit(1)
        }
        return
      }

      // Task 4: Human-readable text output
      if (diagnostics.length > 0) {
        for (const d of diagnostics) {
          const nodeStr = d.nodeId ? ` [node: ${d.nodeId}]` : ''
          const edgeStr = d.edgeIndex !== undefined ? ` [edge: ${d.edgeIndex}]` : ''
          process.stdout.write(
            `  ${d.severity.padEnd(7)}  ${d.ruleId.padEnd(24)}  ${d.message}${nodeStr}${edgeStr}\n`,
          )
        }
        process.stdout.write('\n')
      }

      const errLabel = errors.length !== 1 ? 'errors' : 'error'
      const warnLabel = warnings.length !== 1 ? 'warnings' : 'warning'
      if (diagnostics.length === 0) {
        process.stdout.write(
          `✓ ${TOTAL_RULE_COUNT}/${TOTAL_RULE_COUNT} rules passed, 0 errors, 0 warnings\n`,
        )
      } else {
        process.stdout.write(
          `✗ ${passedCount}/${TOTAL_RULE_COUNT} rules passed, ${errors.length} ${errLabel}, ${warnings.length} ${warnLabel}\n`,
        )
      }

      // Task 6: Exit codes
      if (errors.length > 0) {
        process.exit(1)
      }
    })

  // Story 47-4: factory twins
  const twinsCmd = factoryCmd
    .command('twins')
    .description('Digital twin template management')

  twinsCmd
    .command('templates')
    .description('List available built-in twin templates')
    .action(() => {
      const templates = listTwinTemplates()
      for (const t of templates) {
        process.stdout.write(`  ${t.name.padEnd(16)}  ${t.description}\n`)
      }
    })

  twinsCmd
    .command('init')
    .description('Initialize a twin definition file from a built-in template')
    .requiredOption('--template <name>', 'Template name (e.g. localstack, wiremock)')
    .option('--force', 'Overwrite existing file if it already exists')
    .action(async (opts: { template: string; force?: boolean }) => {
      try {
        const entry = getTwinTemplate(opts.template)
        if (!entry) {
          const available = listTwinTemplates()
            .map((t) => t.name)
            .join(', ')
          process.stderr.write(
            `Error: Unknown template '${opts.template}'. Available: ${available}\n`,
          )
          process.exit(1)
          return
        }

        const targetPath = path.join(
          process.cwd(),
          '.substrate',
          'twins',
          `${opts.template}.yaml`,
        )

        if (!opts.force) {
          try {
            await access(targetPath)
            // File exists — error without --force
            process.stderr.write(
              `Error: File already exists: ${targetPath} — use --force to overwrite\n`,
            )
            process.exit(1)
            return
          } catch {
            // access() threw → file does not exist → proceed
          }
        }

        await mkdir(path.dirname(targetPath), { recursive: true })
        const yamlContent = yaml.dump(entry.definition)
        await writeFile(targetPath, yamlContent, 'utf-8')
        process.stdout.write(`Created ${targetPath}\n`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: ${msg}\n`)
        process.exit(1)
      }
    })

  // Story 47-5: twins start
  twinsCmd
    .command('start')
    .description('Start all discovered twin definitions via Docker Compose')
    .action(async () => {
      try {
        const projectDir = process.cwd()
        const twinsDir = path.join(projectDir, '.substrate', 'twins')

        const registry = createTwinRegistry()
        try {
          await registry.discover(twinsDir)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`Error: ${msg}\n`)
          process.exit(1)
          return
        }

        const twins = registry.list()
        if (twins.length === 0) {
          process.stderr.write('No twin definitions found in .substrate/twins/\n')
          process.exit(1)
          return
        }

        const eventBus = new TypedEventBusImpl<FactoryEvents>()
        eventBus.on('twin:started', (e) => {
          process.stdout.write(`  Started: ${e.twinName}\n`)
        })

        const manager = createTwinManager(eventBus)
        try {
          await manager.start(twins)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`Error: ${msg}\n`)
          process.exit(1)
          return
        }

        const composeDir = manager.getComposeDir()!
        await writeRunState(projectDir, {
          composeDir,
          twinNames: twins.map((t) => t.name),
          startedAt: new Date().toISOString(),
        })

        process.stdout.write('\nAll twins started successfully.\n')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: ${msg}\n`)
        process.exit(1)
      }
    })

  // Story 47-5: twins stop
  twinsCmd
    .command('stop')
    .description('Stop all running twins')
    .action(async () => {
      try {
        const projectDir = process.cwd()
        const state = await readRunState(projectDir)

        if (!state) {
          process.stderr.write('No twins are currently running\n')
          process.exit(1)
          return
        }

        try {
          execSync('docker compose down --remove-orphans', {
            cwd: state.composeDir,
            stdio: 'pipe',
          })
        } catch {
          // Best-effort shutdown; still proceed to cleanup
        }

        rmSync(state.composeDir, { recursive: true, force: true })
        await clearRunState(projectDir)

        process.stdout.write(`Stopped twins: ${state.twinNames.join(', ')}\n`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: ${msg}\n`)
        process.exit(1)
      }
    })

  // Story 47-5: twins status
  twinsCmd
    .command('status')
    .description('Show status of all discovered twins')
    .action(async () => {
      try {
        const projectDir = process.cwd()
        const state = await readRunState(projectDir)
        const runningNames = new Set(state?.twinNames ?? [])

        const registry = createTwinRegistry()
        let twins: ReturnType<typeof registry.list> = []
        try {
          await registry.discover(path.join(projectDir, '.substrate', 'twins'))
          twins = registry.list()
        } catch {
          // Discovery failure — show empty list with a message
        }

        if (twins.length === 0) {
          process.stdout.write('No twin definitions found in .substrate/twins/\n')
          return
        }

        for (const twin of twins) {
          const status = runningNames.has(twin.name) ? 'running' : 'stopped'
          const portsStr =
            twin.ports.length > 0
              ? twin.ports.map((p) => `${p.host}:${p.container}`).join(', ')
              : '—'
          process.stdout.write(
            `  ${twin.name.padEnd(20)}  ${status.padEnd(10)}  ${portsStr}\n`,
          )
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: ${msg}\n`)
        process.exit(1)
      }
    })

  // Story 47-5: twins list
  twinsCmd
    .command('list')
    .description('List all discovered twin definitions')
    .action(async () => {
      try {
        const projectDir = process.cwd()

        const registry = createTwinRegistry()
        let twins: ReturnType<typeof registry.list> = []
        try {
          await registry.discover(path.join(projectDir, '.substrate', 'twins'))
          twins = registry.list()
        } catch {
          // Discovery failure — treat as no twins found
        }

        if (twins.length === 0) {
          process.stdout.write('No twin definitions found in .substrate/twins/\n')
          return
        }

        process.stdout.write(
          '  NAME                 IMAGE                                  PORTS           HEALTHCHECK\n',
        )
        for (const twin of twins) {
          const ports =
            twin.ports.length > 0
              ? twin.ports.map((p) => `${p.host}:${p.container}`).join(', ')
              : '—'
          const healthcheck = twin.healthcheck?.url ?? '—'
          process.stdout.write(
            `  ${twin.name.padEnd(20)}  ${twin.image.padEnd(38)}  ${ports.padEnd(16)}  ${healthcheck}\n`,
          )
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: ${msg}\n`)
        process.exit(1)
      }
    })
}
