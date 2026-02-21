/**
 * PlanGenerator — core plan generation logic
 *
 * Orchestrates adapter selection, project context collection, adapter invocation,
 * and TaskGraphFile production. This is the "prompt → file" transformation layer.
 *
 * Architecture: ADR-001 (Modular Monolith), ADR-005 (child_process)
 */

import { execFile } from 'child_process'
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join, extname } from 'path'
import { dump as yamlDump } from 'js-yaml'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import type { WorkerAdapter } from '../../adapters/worker-adapter.js'
import type { PlanParseResult } from '../../adapters/types.js'
import type { TaskGraphFile, TaskDefinition } from '../../modules/task-graph/schemas.js'
import { createLogger } from '../../utils/logger.js'
import { buildPlanningPrompt } from './planning-prompt.js'
import type { CodebaseContext } from './codebase-scanner.js'
import type { AgentSummary } from './planning-prompt.js'

const logger = createLogger('plan-generator')

/**
 * Wrapper around execFile that immediately closes stdin on the child process.
 * Some CLI tools (e.g. Claude Code) wait for stdin to close before processing
 * even when a prompt is provided via -p flag. The standard promisified execFile
 * leaves stdin open as a pipe, causing indefinite hangs.
 */
function execFileCloseStdin(
  binary: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeout?: number
    maxBuffer?: number
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, options, (err, stdout, stderr) => {
      if (err) {
        const enriched = err as Error & { stdout?: string; stderr?: string; code?: number }
        enriched.stdout = stdout
        enriched.stderr = stderr
        reject(enriched)
      } else {
        resolve({ stdout, stderr })
      }
    })
    // Close stdin immediately so CLI tools don't wait for input
    child.stdin?.end()
  })
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Typed error for plan generation failures.
 */
export class PlanError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'PlanError'
  }
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface PlanGeneratorOptions {
  adapterRegistry: AdapterRegistry
  projectRoot: string
  adapterId?: string
  model?: string
  /** Codebase context from scanner (optional, for codebase-aware planning) */
  codebaseContext?: CodebaseContext
  /** Available agent summaries (optional, for multi-agent planning) */
  availableAgents?: AgentSummary[]
  /** Hint for number of parallel agents */
  agentCount?: number
}

export interface PlanGenerateRequest {
  goal: string
  outputPath: string
  dryRun?: boolean
}

export interface PlanGenerateResult {
  success: boolean
  outputPath?: string
  taskCount?: number
  error?: string
  dryRunPrompt?: string
}

// ---------------------------------------------------------------------------
// PlanGenerator class
// ---------------------------------------------------------------------------

export class PlanGenerator {
  constructor(private readonly options: PlanGeneratorOptions) {}

  /**
   * Generate a plan from a goal and write it to outputPath.
   */
  async generate(request: PlanGenerateRequest): Promise<PlanGenerateResult> {
    const { goal, outputPath, dryRun = false } = request

    // Select adapter
    let adapter: WorkerAdapter
    try {
      adapter = this.selectAdapter()
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return { success: false, error }
    }

    // Collect project context
    const baseContext = await this.collectProjectContext()

    // Build enriched context using planning prompt if codebase context is available
    const { codebaseContext, availableAgents, agentCount } = this.options
    let context: string
    if (codebaseContext !== undefined || (availableAgents !== undefined && availableAgents.length > 0)) {
      context = buildPlanningPrompt({
        goal,
        codebaseContext,
        availableAgents,
        agentCount,
      }) + '\n\n## Project Context\n' + baseContext
    } else {
      context = baseContext
    }

    // Build adapter options
    const adapterOptions = {
      worktreePath: this.options.projectRoot,
      billingMode: 'subscription' as const,
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
    }

    // Build plan request
    const planRequest = {
      goal,
      context,
    }

    // Dry-run: return the prompt that would be sent
    if (dryRun) {
      const spawnCmd = adapter.buildPlanningCommand(planRequest, adapterOptions)
      const dryRunPrompt = [spawnCmd.binary, ...spawnCmd.args].join(' ')
      return { success: true, dryRunPrompt }
    }

    // Invoke the adapter binary
    let stdout: string
    let stderr: string
    let exitCode: number

    try {
      const spawnCmd = adapter.buildPlanningCommand(planRequest, adapterOptions)
      const childEnv: Record<string, string | undefined> = { ...process.env, ...(spawnCmd.env ?? {}) }
      for (const key of spawnCmd.unsetEnvKeys ?? []) {
        delete childEnv[key]
      }
      const result = await execFileCloseStdin(spawnCmd.binary, spawnCmd.args, {
        cwd: spawnCmd.cwd,
        env: childEnv as NodeJS.ProcessEnv,
        timeout: spawnCmd.timeoutMs ?? 300_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      stdout = result.stdout
      stderr = result.stderr
      exitCode = 0
    } catch (err: unknown) {
      // Check for timeout
      if (
        err instanceof Error &&
        (err.message.includes('ETIMEDOUT') ||
          err.message.includes('timed out') ||
          (err as NodeJS.ErrnoException).code === 'ETIMEDOUT')
      ) {
        return {
          success: false,
          error: 'Plan generation timed out after 300 seconds',
        }
      }

      // Non-zero exit — extract stdout/stderr from the error
      const execErr = err as { stdout?: string; stderr?: string; code?: number }
      stdout = execErr.stdout ?? ''
      stderr = execErr.stderr ?? ''
      exitCode = typeof execErr.code === 'number' ? execErr.code : 1
    }

    // Parse plan output
    const planResult: PlanParseResult = adapter.parsePlanOutput(stdout, stderr, exitCode)

    if (!planResult.success) {
      return { success: false, error: planResult.error ?? 'Plan generation failed' }
    }

    // Convert to TaskGraphFile
    let taskGraph: TaskGraphFile
    try {
      taskGraph = this.convertToTaskGraph(planResult, goal)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return { success: false, error }
    }

    // Write atomically
    try {
      writeTaskGraph(taskGraph, outputPath)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return { success: false, error }
    }

    const taskCount = Object.keys(taskGraph.tasks).length
    return { success: true, outputPath, taskCount }
  }

  /**
   * Convert a PlanParseResult to a TaskGraphFile.
   */
  convertToTaskGraph(planResult: PlanParseResult, goal: string): TaskGraphFile {
    const tasks: Record<string, TaskDefinition> = {}
    const keySet = new Set<string>()
    // Map from original task title → slugified key, for depends_on resolution
    const titleToKey = new Map<string, string>()

    for (const planned of planResult.tasks) {
      let key = planned.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 64)

      if (!key) {
        key = `task-${Object.keys(tasks).length + 1}`
      }

      // Ensure uniqueness
      let uniqueKey = key
      let suffix = 2
      while (keySet.has(uniqueKey)) {
        uniqueKey = `${key}-${String(suffix)}`
        suffix++
      }
      keySet.add(uniqueKey)
      titleToKey.set(planned.title, uniqueKey)

      const prompt = planned.description || planned.title

      tasks[uniqueKey] = {
        name: planned.title,
        description: planned.description || undefined,
        prompt,
        type: 'coding',
        depends_on: planned.dependencies ?? [],
        ...(planned.complexity !== undefined
          ? { budget_usd: planned.complexity * 0.1 }
          : {}),
      }
    }

    // Resolve depends_on references: AI may return human-readable titles instead of
    // slugified keys. Try exact key match, then title→key lookup, then slugification.
    const taskKeys = new Set(Object.keys(tasks))
    for (const [taskKey, task] of Object.entries(tasks)) {
      const resolvedDeps: string[] = []
      for (const dep of task.depends_on) {
        if (taskKeys.has(dep)) {
          resolvedDeps.push(dep)
        } else {
          // Try resolving via original title
          const keyFromTitle = titleToKey.get(dep)
          if (keyFromTitle !== undefined) {
            resolvedDeps.push(keyFromTitle)
          } else {
            // Try slugifying the dep reference itself
            const slugified = dep
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')
              .slice(0, 64)
            if (taskKeys.has(slugified)) {
              resolvedDeps.push(slugified)
            } else {
              logger.warn({ taskKey, dep }, `depends_on reference '${dep}' not found in task keys; removing`)
            }
          }
        }
      }
      tasks[taskKey] = { ...task, depends_on: resolvedDeps }
    }

    return {
      version: '1',
      session: {
        name: goal.slice(0, 80),
      },
      tasks,
    }
  }

  /**
   * Select the adapter to use based on options.
   */
  private selectAdapter(): WorkerAdapter {
    const { adapterRegistry, adapterId } = this.options

    if (adapterId !== undefined) {
      const adapter = adapterRegistry.get(adapterId)
      if (!adapter || !adapter.getCapabilities().supportsPlanGeneration) {
        throw new PlanError(
          `Adapter '${adapterId}' is not available or does not support plan generation`,
          'ADAPTER_NOT_AVAILABLE',
        )
      }
      return adapter
    }

    const planningAdapters = adapterRegistry.getPlanningCapable()
    if (planningAdapters.length === 0) {
      throw new PlanError(
        "No planning-capable adapter is available. Run 'substrate adapters' to check adapter status.",
        'NO_PLANNING_ADAPTER',
      )
    }

    return planningAdapters[0]
  }

  /**
   * Collect project context summary (filesystem scan, extension detection, package name).
   * Never throws — wraps all IO in try/catch.
   */
  private async collectProjectContext(): Promise<string> {
    const lines: string[] = [`Project root: ${this.options.projectRoot}`]

    // Top-level directory listing (skip hidden and node_modules)
    try {
      const entries = readdirSync(this.options.projectRoot, { withFileTypes: true })
      const visible = entries
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .slice(0, 50)
      lines.push(
        'Top-level files/dirs: ' +
          visible.map((e) => e.name + (e.isDirectory() ? '/' : '')).join(', '),
      )
    } catch {
      // ignore
    }

    // Detect languages from file extensions in src/
    const extensions = new Set<string>()
    try {
      const files = readdirSync(join(this.options.projectRoot, 'src'), { recursive: true })
      for (const f of (files as string[]).slice(0, 500)) {
        const ext = extname(String(f)).toLowerCase()
        if (ext) extensions.add(ext)
      }
      if (extensions.size > 0) {
        lines.push('Detected languages/extensions: ' + [...extensions].join(', '))
      }
    } catch {
      // src/ may not exist
    }

    // Project name from package.json
    try {
      const pkg = JSON.parse(
        readFileSync(join(this.options.projectRoot, 'package.json'), 'utf-8'),
      ) as { name?: string }
      if (pkg.name) {
        lines.push(`Project name: ${pkg.name}`)
      }
    } catch {
      // ignore
    }

    return lines.join('\n')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a TaskGraphFile to disk atomically (temp file + rename).
 */
function writeTaskGraph(graph: TaskGraphFile, outputPath: string): void {
  const ext = extname(outputPath).toLowerCase()
  const content =
    ext === '.yaml' || ext === '.yml'
      ? yamlDump(graph)
      : JSON.stringify(graph, null, 2)

  const tmpPath = `${outputPath}.tmp.${String(Date.now())}`
  try {
    writeFileSync(tmpPath, content, 'utf-8')
    renameSync(tmpPath, outputPath)
  } catch (err) {
    // Attempt cleanup of tmp file
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore cleanup failure
    }
    throw err
  }
}
