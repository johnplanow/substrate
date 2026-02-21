/**
 * `substrate graph` command
 *
 * Visualizes a task graph YAML/JSON file as ASCII art showing tasks and their
 * dependencies (FR39).
 *
 * Usage:
 *   substrate graph tasks.yaml                         Render ASCII visualization
 *   substrate graph tasks.yaml --output-format json    Emit JSON adjacency list
 *
 * Exit codes:
 *   0  — success
 *   1  — unexpected system error
 *   2  — file not found, parse error, or validation error (cycle/dangling ref)
 */

import type { Command } from 'commander'
import { existsSync } from 'node:fs'
import { ParseError, parseGraphFile } from '../../modules/task-graph/task-parser.js'
import { validateGraph } from '../../modules/task-graph/task-validator.js'
import { AdapterRegistry } from '../../adapters/adapter-registry.js'
import type { TaskGraphFile } from '../../modules/task-graph/schemas.js'

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const GRAPH_EXIT_SUCCESS = 0
export const GRAPH_EXIT_ERROR = 1
export const GRAPH_EXIT_USAGE_ERROR = 2

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for the graph action.
 */
export interface GraphActionOptions {
  filePath: string
  outputFormat: 'human' | 'json'
  projectRoot?: string
}

// ---------------------------------------------------------------------------
// Adjacency helpers
// ---------------------------------------------------------------------------

interface AdjacencyInfo {
  dependents: Record<string, string[]>
  rootTasks: string[]
  leafTasks: string[]
  maxDepth: number
}

/**
 * Build an adjacency list (reverse edges = dependents) and compute root/leaf
 * task sets as well as the max dependency chain depth.
 */
export function buildAdjacencyList(graph: TaskGraphFile): AdjacencyInfo {
  const taskIds = Object.keys(graph.tasks)
  const dependents: Record<string, string[]> = {}

  // Initialise all entries
  for (const id of taskIds) {
    dependents[id] = []
  }

  // Populate dependents (reverse edges)
  for (const [id, task] of Object.entries(graph.tasks)) {
    for (const dep of task.depends_on) {
      const existing = dependents[dep]
      if (existing !== undefined) {
        existing.push(id)
      }
    }
  }

  const rootTasks = taskIds.filter(
    (id) => (graph.tasks[id]?.depends_on ?? []).length === 0,
  )

  const leafTasks = taskIds.filter((id) => (dependents[id]?.length ?? 0) === 0)

  // Compute max depth by processing tasks in topological order
  const sorted = topoSort(graph)
  const depths: Record<string, number> = {}
  for (const id of taskIds) {
    depths[id] = 0
  }
  for (const id of sorted) {
    const task = graph.tasks[id]
    if (task === undefined) continue
    for (const dep of task.depends_on) {
      const depDepth = depths[dep] ?? 0
      const current = depths[id] ?? 0
      depths[id] = Math.max(current, depDepth + 1)
    }
  }

  const depthValues = taskIds.map((id) => depths[id] ?? 0)
  const maxDepth = depthValues.length === 0 ? 0 : Math.max(...depthValues)

  return { dependents, rootTasks, leafTasks, maxDepth }
}

// ---------------------------------------------------------------------------
// Topological sort (Kahn's algorithm)
// ---------------------------------------------------------------------------

/**
 * Return task IDs in topological order (dependencies before dependents).
 * Assumes no cycles (call after validateGraph).
 */
export function topoSort(graph: TaskGraphFile): string[] {
  const taskIds = Object.keys(graph.tasks)
  const inDegree: Record<string, number> = {}
  const adj: Record<string, string[]> = {}

  for (const id of taskIds) {
    inDegree[id] = graph.tasks[id]?.depends_on.length ?? 0
    adj[id] = []
  }

  // Build forward adjacency (dep -> dependents)
  for (const [id, task] of Object.entries(graph.tasks)) {
    for (const dep of task.depends_on) {
      const list = adj[dep]
      if (list !== undefined) {
        list.push(id)
      }
    }
  }

  const queue: string[] = taskIds.filter((id) => (inDegree[id] ?? 0) === 0).sort()
  const result: string[] = []

  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) break
    result.push(id)
    const neighbors = adj[id] ?? []
    for (const dependent of [...neighbors].sort()) {
      const current = inDegree[dependent] ?? 0
      inDegree[dependent] = current - 1
      if ((inDegree[dependent] ?? 0) === 0) {
        queue.push(dependent)
        queue.sort()
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// ASCII renderer
// ---------------------------------------------------------------------------

/**
 * Render the task graph as human-readable ASCII art.
 */
export function renderAscii(graph: TaskGraphFile, sorted: string[]): string {
  const lines: string[] = []

  for (const id of sorted) {
    const task = graph.tasks[id]
    if (task === undefined) continue

    const type = task.type
    const agent = task.agent !== undefined ? ` agent:${task.agent}` : ''

    // Task box
    let taskLine = `[ ${id} (${type})${agent} ]`

    // Append truncated description
    if (task.description !== undefined) {
      const truncated =
        task.description.length > 60
          ? `${task.description.slice(0, 57)}...`
          : task.description
      taskLine += ` "${truncated}"`
    }

    // Root label
    const deps = task.depends_on
    if (deps.length === 0) {
      taskLine += ' [root]'
    }

    lines.push(taskLine)

    // Dependency arrows under the task
    for (const dep of deps) {
      lines.push(`  --> depends on: ${dep}`)
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// JSON renderer
// ---------------------------------------------------------------------------

interface JsonTask {
  id: string
  name: string
  type: string
  agent: string | null
  description: string | null
  depends_on: string[]
  dependents: string[]
}

interface JsonOutput {
  version: string
  session: { name: string; budget_usd: number | null }
  tasks: Record<string, JsonTask>
  rootTasks: string[]
  leafTasks: string[]
  summary: string
}

/**
 * Render the task graph as a JSON adjacency list.
 */
export function renderJson(graph: TaskGraphFile): string {
  const { dependents, rootTasks, leafTasks, maxDepth } = buildAdjacencyList(graph)
  const taskCount = Object.keys(graph.tasks).length
  const summary = `${taskCount} tasks, ${rootTasks.length} root(s), ${leafTasks.length} leaf(s), max depth ${maxDepth}`

  const tasks: Record<string, JsonTask> = {}
  for (const [id, task] of Object.entries(graph.tasks)) {
    tasks[id] = {
      id,
      name: task.name,
      type: task.type,
      agent: task.agent ?? null,
      description: task.description ?? null,
      depends_on: task.depends_on,
      dependents: dependents[id] ?? [],
    }
  }

  const output: JsonOutput = {
    version: graph.version,
    session: {
      name: graph.session.name,
      budget_usd: graph.session.budget_usd ?? null,
    },
    tasks,
    rootTasks,
    leafTasks,
    summary,
  }

  return JSON.stringify(output, null, 2)
}

// ---------------------------------------------------------------------------
// runGraphAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the graph command.
 *
 * Returns an exit code. Separated from Commander integration for testability.
 */
export async function runGraphAction(options: GraphActionOptions): Promise<number> {
  const { filePath, outputFormat } = options

  // AC6: Check file existence
  if (!existsSync(filePath)) {
    process.stderr.write(`Error: Graph file not found: ${filePath}\n`)
    return GRAPH_EXIT_USAGE_ERROR
  }

  // AC6: Parse file
  let raw: ReturnType<typeof parseGraphFile>
  try {
    raw = parseGraphFile(filePath)
  } catch (err) {
    if (err instanceof ParseError) {
      process.stderr.write(
        `Error: Failed to parse graph file: ${filePath}\n${err.message}\n`,
      )
      return GRAPH_EXIT_USAGE_ERROR
    }
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    return GRAPH_EXIT_ERROR
  }

  // AC4, AC5, AC8: Validate (cycle, dangling ref, and agent availability detection)
  // Use an empty AdapterRegistry so that any agent references in the graph are
  // flagged as warnings when they are not registered in the current environment.
  const emptyRegistry = new AdapterRegistry()
  const result = validateGraph(raw, emptyRegistry)

  if (!result.valid) {
    for (const error of result.errors) {
      // AC4: Cycle error format — convert Unicode arrows to ASCII arrows
      if (error.startsWith('Circular dependency detected:')) {
        const formatted = error.replace(/ → /g, ' --> ')
        process.stderr.write(`Error: ${formatted}\n`)
      } else if (error.includes('references unknown dependency')) {
        // AC5: Dangling reference — strip leading "Task " and lowercase "task"
        // Input:  Task "task-b" references unknown dependency "task-x"
        // Output: Error: task "task-b" references unknown dependency "task-x"
        const normalized = error.replace(/^Task /, 'task ')
        process.stderr.write(`Error: ${normalized}\n`)
      } else {
        process.stderr.write(`Error: ${error}\n`)
      }
    }
    return GRAPH_EXIT_USAGE_ERROR
  }

  const graph = result.graph!

  // AC8: Warn about unknown agents
  for (const warning of result.warnings) {
    // Extract taskId and agent from the warning message
    // Format: Task "taskId" references agent "agentName" which is not registered...
    const match = warning.match(/Task "([^"]+)" references agent "([^"]+)"/)
    if (match !== null) {
      const taskId = match[1] ?? ''
      const agent = match[2] ?? ''
      process.stderr.write(`Warning: Task "${taskId}" references unregistered agent "${agent}"\n`)
    } else {
      process.stderr.write(`Warning: ${warning}\n`)
    }
  }

  // Compute summary for human output
  const { rootTasks, leafTasks, maxDepth } = buildAdjacencyList(graph)
  const taskCount = Object.keys(graph.tasks).length
  const summary = `${taskCount} tasks, ${rootTasks.length} root(s), ${leafTasks.length} leaf(s), max depth ${maxDepth}`

  if (outputFormat === 'json') {
    // AC3: JSON adjacency list output
    process.stdout.write(renderJson(graph) + '\n')
  } else {
    // AC1, AC2: ASCII art output
    const sorted = topoSort(graph)
    const ascii = renderAscii(graph, sorted)
    process.stdout.write(ascii + '\n')
    // AC7: Summary line to stdout
    process.stdout.write(`\n${summary}\n`)
  }

  return GRAPH_EXIT_SUCCESS
}

// ---------------------------------------------------------------------------
// registerGraphCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate graph` command with the CLI program.
 *
 * @param program - Commander program instance
 * @param _version - Current Substrate package version (unused)
 */
export function registerGraphCommand(
  program: Command,
  _version = '0.0.0',
): void {
  program
    .command('graph <file>')
    .description('Visualize a task graph YAML/JSON file as ASCII art')
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(async (file: string, opts: { outputFormat: string }) => {
      const outputFormat = opts.outputFormat === 'json' ? 'json' : 'human'

      const exitCode = await runGraphAction({
        filePath: file,
        outputFormat,
      })

      process.exitCode = exitCode
    })
}
