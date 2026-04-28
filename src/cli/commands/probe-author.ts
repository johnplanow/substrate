/**
 * substrate probe-author — operator + eval-harness CLI for the
 * probe-author phase (Story 60-14e).
 *
 * Currently exposes a single subcommand:
 *
 *   substrate probe-author dispatch --story-file <path> [options]
 *
 * Wires the minimum-viable WorkflowDeps (AdapterRegistry, EventBus,
 * DatabaseAdapter, MethodologyPack, ContextCompiler, Dispatcher) and
 * calls `runProbeAuthor` against the supplied story-file + epic
 * content. Outputs the authored probes as JSON (default) so the
 * A/B validation harness eval script can consume them
 * deterministically per corpus entry.
 *
 * --output-format=append leaves the story file with the appended
 * `## Runtime Probes` section in place so an operator can inspect
 * the full artifact.
 *
 * Closes the open thread on Story 60-14d's `dispatchProbeAuthor()`
 * stub (Sprint 18) by giving the eval script a real entry point
 * that exercises the full probe-author phase.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Command } from 'commander'

import { parseRuntimeProbes } from '@substrate-ai/sdlc'

import { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { createEventBus } from '../../core/event-bus.js'
import { createDispatcher } from '../../modules/agent-dispatch/index.js'
import { createContextCompiler } from '../../modules/context-compiler/index.js'
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { runProbeAuthor } from '../../modules/implementation-orchestrator/probe-author-integration.js'
import { InMemoryDatabaseAdapter } from '../../persistence/memory-adapter.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('cli:probe-author')

/**
 * A minimum-viable logger that routes everything to stderr. Used by the
 * subcommand to keep stdout reserved for the JSON result payload.
 * Pino's default pino()-without-destination writes to stdout; we need
 * the inverse here.
 */
function makeStderrLogger(): { debug: (...args: unknown[]) => void; info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void } {
  const emit = (level: string, args: unknown[]): void => {
    const payload = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    process.stderr.write(`[${level}] ${payload}\n`)
  }
  return {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
  }
}

interface ProbeAuthorDispatchOptions {
  storyFile: string
  epicFile?: string
  storyKey: string
  agent: string
  pack: string
  outputFormat: string
  workingDir?: string
  bypassGates?: boolean
}

export function registerProbeAuthorCommand(
  program: Command,
  _version: string,
  projectRoot: string,
  registry: AdapterRegistry,
): void {
  const probeAuthor = program
    .command('probe-author')
    .description('probe-author phase utilities (Story 60-14)')

  probeAuthor
    .command('dispatch')
    .description(
      'Dispatch the probe-author phase against a single story file. ' +
        'Reads the story artifact + epic content, calls the probe-author ' +
        'agent, outputs the authored probes as JSON. Powers the A/B ' +
        'validation harness eval (scripts/eval-probe-author.mjs) and ' +
        'serves as a manual operator inspection tool.',
    )
    .requiredOption('--story-file <path>', 'Path to the story artifact (.md). Receives the appended ## Runtime Probes section.')
    .option('--epic-file <path>', 'Path to source epic content (default: same as --story-file)')
    .option('--story-key <key>', 'Story key for telemetry / event payloads', 'probe-author-cli')
    .option('--agent <id>', 'Agent backend (default: claude-code)', 'claude-code')
    .option('--pack <name>', 'Methodology pack name (default: bmad)', 'bmad')
    .option(
      '--output-format <format>',
      'Output format: json (default; print authored probes as JSON to stdout) or append (leave story-file with appended Runtime Probes section)',
      'json',
    )
    .option('--working-dir <path>', 'Working directory for the dispatcher (default: --story-file directory)')
    .option(
      '--bypass-gates',
      'Skip the event-driven AC + idempotency gates inside runProbeAuthor. ' +
        'Use ONLY for operator invocations / A/B eval-harness runs that need ' +
        'to test authoring quality across non-event-driven AC. Production ' +
        'pipelines should never set this — the gates are load-bearing for ' +
        'the orchestrator path.',
      false,
    )
    .action(async (opts: ProbeAuthorDispatchOptions) => {
      const exitCode = await runProbeAuthorDispatch(opts, projectRoot, registry)
      process.exitCode = exitCode
    })
}

/**
 * Core entry point for `substrate probe-author dispatch`. Returns the
 * exit code (0 on probe-author success, 1 on failure or skip).
 */
export async function runProbeAuthorDispatch(
  opts: ProbeAuthorDispatchOptions,
  projectRoot: string,
  registry: AdapterRegistry,
): Promise<number> {
  const storyFilePath = resolve(opts.storyFile)
  const epicFilePath = opts.epicFile !== undefined ? resolve(opts.epicFile) : storyFilePath

  let epicContent: string
  try {
    epicContent = readFileSync(epicFilePath, 'utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`probe-author: failed to read epic file ${epicFilePath}: ${msg}\n`)
    return 1
  }

  // Snapshot the story file content BEFORE dispatch so we can recover
  // it on output-format=json (we want the file to be unmodified by the
  // eval; only --output-format=append mutates the artifact in place).
  let originalStoryContent: string
  try {
    originalStoryContent = readFileSync(storyFilePath, 'utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`probe-author: failed to read story file ${storyFilePath}: ${msg}\n`)
    return 1
  }

  // ------------------------------------------------------------------
  // Set up minimum-viable WorkflowDeps
  // ------------------------------------------------------------------

  const eventBus = createEventBus()
  const adapter = new InMemoryDatabaseAdapter()

  const packLoader = createPackLoader()
  const packPath = `${projectRoot}/packs/${opts.pack}`
  let pack
  try {
    pack = await packLoader.load(packPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`probe-author: failed to load methodology pack '${opts.pack}' from ${packPath}: ${msg}\n`)
    return 1
  }

  const contextCompiler = createContextCompiler({ db: adapter })
  // CLI subcommand reserves stdout for the structured JSON output; route the
  // dispatcher's progress logs to stderr so JSON consumers (the eval harness
  // shelling in via child_process) parse stdout cleanly.
  const stderrLogger = makeStderrLogger()
  const dispatcher = createDispatcher({ eventBus, adapterRegistry: registry, logger: stderrLogger })

  const workingDir = opts.workingDir !== undefined ? resolve(opts.workingDir) : resolve(storyFilePath, '..')

  // ------------------------------------------------------------------
  // Dispatch
  // ------------------------------------------------------------------

  logger.info(
    { storyKey: opts.storyKey, storyFile: storyFilePath, epicFile: epicFilePath, agent: opts.agent, pack: opts.pack },
    'probe-author dispatch starting',
  )

  const result = await runProbeAuthor(
    {
      db: adapter,
      pack,
      contextCompiler,
      dispatcher,
      projectRoot: workingDir,
      agentId: opts.agent,
    },
    {
      storyKey: opts.storyKey,
      storyFilePath,
      pipelineRunId: `probe-author-cli-${Date.now()}`,
      sourceAcContent: epicContent,
      epicContent,
      ...(opts.bypassGates === true ? { bypassGates: true } : {}),
    },
  )

  // ------------------------------------------------------------------
  // Output
  // ------------------------------------------------------------------

  // Read the (possibly-mutated) story file to extract the appended probes.
  let postDispatchContent = originalStoryContent
  try {
    postDispatchContent = readFileSync(storyFilePath, 'utf-8')
  } catch {
    // already-read content is fine on read failure
  }

  const parseResult = parseRuntimeProbes(postDispatchContent)
  const probes = parseResult.kind === 'parsed' ? parseResult.probes : []

  if (opts.outputFormat === 'json') {
    // Restore the original story-file so the eval doesn't accumulate
    // probes across entries (each entry needs a clean dispatch).
    if (postDispatchContent !== originalStoryContent) {
      try {
        writeFileSync(storyFilePath, originalStoryContent, 'utf-8')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`probe-author: warning — failed to restore story file: ${msg}\n`)
      }
    }
    process.stdout.write(
      JSON.stringify(
        {
          success: result.result === 'success',
          result: result.result,
          error: result.error,
          probesAuthoredCount: result.probesAuthoredCount,
          probes,
          tokenUsage: result.tokenUsage,
          durationMs: result.durationMs,
        },
        null,
        2,
      ) + '\n',
    )
  } else if (opts.outputFormat === 'append') {
    process.stderr.write(
      `probe-author: ${result.result} — ${result.probesAuthoredCount} probe(s) authored. Story file at ${storyFilePath}\n`,
    )
  } else {
    process.stderr.write(`probe-author: invalid --output-format '${opts.outputFormat}'. Valid: json | append\n`)
    return 1
  }

  return result.result === 'success' ? 0 : 1
}
