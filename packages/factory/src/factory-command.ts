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
import { rmSync, watchFile, unwatchFile } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import yaml from 'js-yaml'
import { registerScenariosCommand } from './scenarios/cli-command.js'
import { registerContextCommand } from './context/cli-command.js'
import { listPipelineTemplates, getPipelineTemplate } from './templates/index.js'
import { getTwinTemplate, listTwinTemplates, createTwinRegistry } from './twins/index.js'
import { createTwinManager } from './twins/docker-compose.js'
import { readRunState, writeRunState, clearRunState } from './twins/run-state.js'
import { parseGraph } from './graph/parser.js'
import { createValidator } from './graph/validator.js'
import { createGraphExecutor } from './graph/executor.js'
import { createDefaultRegistry } from './handlers/index.js'
import { RunStateManager } from './graph/run-state.js'
import { loadFactoryConfig, resolveConfigPath } from './config.js'
import { factorySchema } from './persistence/factory-schema.js'
import { bootstrapDirectBackend } from './backend/direct-bootstrap.js'
import { EventKind } from './agent/types.js'
import type { SessionEvent } from './agent/types.js'
import type { DirectCodergenBackend } from './backend/direct-backend.js'
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
  projectDir: string
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
    .option('--backend <mode>', 'Backend: cli | direct (overrides config factory.backend)')
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
          eventBus.on('factory:config-reloaded', (e) =>
            emit({ type: 'factory:config-reloaded', ...e })
          )
          eventBus.on('agent:tool-call', (e) => emit({ type: 'agent:tool-call', ...e }))
          eventBus.on('agent:loop-detected', (e) => emit({ type: 'agent:loop-detected', ...e }))
          eventBus.on('agent:steering-injected', (e) =>
            emit({ type: 'agent:steering-injected', ...e })
          )
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

        // Resolve effective backend: CLI flag > config > 'cli' default (story 48-12 AC1)
        const effectiveBackend = (opts.backend ?? factoryConfig.factory?.backend ?? 'cli') as
          | 'cli'
          | 'direct'

        // Story 48-12 AC2, AC3, AC4: Bootstrap direct backend if requested
        let directBackend: DirectCodergenBackend | undefined

        if (effectiveBackend === 'direct') {
          // Track current node for event correlation
          let currentNodeId = ''
          eventBus.on('graph:node-started', (e) => {
            currentNodeId = e.nodeId
          })

          // Build the event forwarding callback
          const toolCallNameMap = new Map<string, string>() // call_id → tool_name
          const onDirectEvent = (event: SessionEvent) => {
            if (event.kind === EventKind.TOOL_CALL_START) {
              const toolName = (event.data['tool_name'] as string) ?? ''
              const callId = (event.data['call_id'] as string) ?? ''
              toolCallNameMap.set(callId, toolName)
              eventBus.emit('agent:tool-call', {
                runId,
                nodeId: currentNodeId,
                toolName,
                direction: 'call',
              })
            } else if (event.kind === EventKind.TOOL_CALL_END) {
              const callId = (event.data['call_id'] as string) ?? ''
              const toolName = toolCallNameMap.get(callId) ?? ''
              toolCallNameMap.delete(callId)
              eventBus.emit('agent:tool-call', {
                runId,
                nodeId: currentNodeId,
                toolName,
                direction: 'result',
              })
            } else if (event.kind === EventKind.LOOP_DETECTION) {
              eventBus.emit('agent:loop-detected', {
                runId,
                nodeId: currentNodeId,
                windowSize: (event.data['windowSize'] as number) ?? 0,
                pattern: (event.data['pattern'] as string[]) ?? [],
              })
            } else if (event.kind === EventKind.STEERING_INJECTED) {
              eventBus.emit('agent:steering-injected', {
                runId,
                nodeId: currentNodeId,
                message: (event.data['content'] as string) ?? '',
              })
            }
          }

          // Bootstrap the direct backend — fail fast if API key is missing
          try {
            const directBackendCfg = factoryConfig.factory?.direct_backend
            directBackend = bootstrapDirectBackend({
              provider: directBackendCfg?.provider ?? 'anthropic',
              model: directBackendCfg?.model ?? 'claude-3-5-sonnet-20241022',
              maxTurns: directBackendCfg?.max_turns ?? 20,
              projectDir,
              onEvent: onDirectEvent,
            })
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            process.stderr.write(`Error: ${msg}\n`)
            process.exit(1)
            return
          }
        }

        // Initialize persistence adapter and factory schema (story 46-3).
        // Uses auto-detection: Dolt if available, otherwise in-memory fallback.
        // factorySchema is idempotent — safe to call on every run.
        const adapter = options?.createAdapter
          ? options.createAdapter(projectDir)
          : createDatabaseAdapter({ backend: 'auto', basePath: projectDir })
        await factorySchema(adapter)

        const executor = createGraphExecutor()
        const executorConfig = {
          runId,
          logsRoot,
          handlerRegistry: createDefaultRegistry(directBackend ? { directBackend } : undefined),
          eventBus,
          dotSource,
          adapter,
          wallClockCapMs: (factoryConfig.factory?.wall_clock_cap_seconds ?? 0) * 1000,
          pipelineBudgetCapUsd: factoryConfig.factory?.budget_cap_usd ?? 0,
          plateauWindow: factoryConfig.factory?.plateau_window ?? 3,
          plateauThreshold: factoryConfig.factory?.plateau_threshold ?? 0.05,
          satisfactionThreshold: factoryConfig.factory?.satisfaction_threshold ?? 0.8,
          qualityMode: factoryConfig.factory?.quality_mode ?? 'dual-signal',
        }

        // Story 46-2 AC4: Hot-reload satisfaction threshold from config file.
        // Watches the config file every 2 seconds and updates executorConfig.satisfactionThreshold
        // when the value changes. The executor reads the threshold from the config object by
        // reference on every convergence iteration, so mutations take effect immediately.
        const configPath = resolveConfigPath(projectDir, opts.config)
        let watchingConfig = false
        if (configPath) {
          try {
            watchFile(configPath, { interval: 2000 }, async () => {
              try {
                const updated = await loadFactoryConfig(projectDir, opts.config)
                const newThreshold = updated.factory?.satisfaction_threshold ?? 0.8
                if (newThreshold !== executorConfig.satisfactionThreshold) {
                  const oldThreshold = executorConfig.satisfactionThreshold
                  executorConfig.satisfactionThreshold = newThreshold
                  process.stderr.write(
                    `[hot-reload] satisfaction_threshold changed: ${oldThreshold} → ${newThreshold}\n`
                  )
                  // Emit as a factory event for NDJSON consumers
                  eventBus.emit('factory:config-reloaded', {
                    key: 'satisfaction_threshold',
                    oldValue: oldThreshold,
                    newValue: newThreshold,
                  })
                }
              } catch {
                // Ignore parse errors during hot-reload — keep the previous threshold
              }
            })
            watchingConfig = true
          } catch {
            // watchFile may fail if path doesn't exist — skip hot-reload
          }
        }

        let result
        try {
          result = await executor.run(graph, executorConfig)
        } finally {
          // Always stop watching regardless of success/failure
          if (watchingConfig && configPath) {
            try {
              unwatchFile(configPath)
            } catch {
              /* ignore */
            }
          }
        }

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
        const isEnoent = err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
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
            `  ${d.severity.padEnd(7)}  ${d.ruleId.padEnd(24)}  ${d.message}${nodeStr}${edgeStr}\n`
          )
        }
        process.stdout.write('\n')
      }

      const errLabel = errors.length !== 1 ? 'errors' : 'error'
      const warnLabel = warnings.length !== 1 ? 'warnings' : 'warning'
      if (diagnostics.length === 0) {
        process.stdout.write(
          `✓ ${TOTAL_RULE_COUNT}/${TOTAL_RULE_COUNT} rules passed, 0 errors, 0 warnings\n`
        )
      } else {
        process.stdout.write(
          `✗ ${passedCount}/${TOTAL_RULE_COUNT} rules passed, ${errors.length} ${errLabel}, ${warnings.length} ${warnLabel}\n`
        )
      }

      // Task 6: Exit codes
      if (errors.length > 0) {
        process.exit(1)
      }
    })

  // Story 49-7: factory context
  registerContextCommand(factoryCmd, '0.0.0')

  // Story 47-4: factory twins
  const twinsCmd = factoryCmd.command('twins').description('Digital twin template management')

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
            `Error: Unknown template '${opts.template}'. Available: ${available}\n`
          )
          process.exit(1)
          return
        }

        const targetPath = path.join(process.cwd(), '.substrate', 'twins', `${opts.template}.yaml`)

        if (!opts.force) {
          try {
            await access(targetPath)
            // File exists — error without --force
            process.stderr.write(
              `Error: File already exists: ${targetPath} — use --force to overwrite\n`
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
          process.stdout.write(`  ${twin.name.padEnd(20)}  ${status.padEnd(10)}  ${portsStr}\n`)
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
          '  NAME                 IMAGE                                  PORTS           HEALTHCHECK\n'
        )
        for (const twin of twins) {
          const ports =
            twin.ports.length > 0
              ? twin.ports.map((p) => `${p.host}:${p.container}`).join(', ')
              : '—'
          const healthcheck = twin.healthcheck?.url ?? '—'
          process.stdout.write(
            `  ${twin.name.padEnd(20)}  ${twin.image.padEnd(38)}  ${ports.padEnd(16)}  ${healthcheck}\n`
          )
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: ${msg}\n`)
        process.exit(1)
      }
    })

  // Story 50-10: factory templates
  const templatesCmd = factoryCmd
    .command('templates')
    .description('Manage reusable DOT graph pipeline templates')

  templatesCmd
    .command('list')
    .description('List available pipeline templates')
    .action(() => {
      const templates = listPipelineTemplates()
      for (const t of templates) {
        process.stdout.write(`  ${t.name.padEnd(24)}  ${t.description}\n`)
      }
    })

  templatesCmd
    .command('init')
    .description('Create a pipeline.dot from a template')
    .requiredOption('--template <name>', 'Template name (see: factory templates list)')
    .option('--output <path>', 'Output file path (default: pipeline.dot)', 'pipeline.dot')
    .action(async (opts: { template: string; output: string }) => {
      const entry = getPipelineTemplate(opts.template)
      if (!entry) {
        const available = listPipelineTemplates()
          .map((t) => t.name)
          .join(', ')
        process.stderr.write(
          `Error: Unknown template '${opts.template}'. Available: ${available}\n`
        )
        process.exit(1)
        return
      }
      try {
        await writeFile(opts.output, entry.dotContent, 'utf-8')
        process.stdout.write(`Created ${opts.output} from template '${entry.name}'\n`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: ${msg}\n`)
        process.exit(1)
      }
    })
}
