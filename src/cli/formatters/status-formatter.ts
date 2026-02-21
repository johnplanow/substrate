/**
 * Human-readable status formatter for the `substrate status` command.
 *
 * Renders a StatusSnapshot as a formatted text report and optionally
 * renders the task dependency graph in ASCII tree format (AC5, AC8).
 */

import type { StatusSnapshot, TaskNode } from '../types/status.js'

// ---------------------------------------------------------------------------
// renderStatusHuman
// ---------------------------------------------------------------------------

/**
 * Render a full human-readable status report from a snapshot.
 *
 * Output sections:
 *  - Header: Session <id>  Status: <status>  Elapsed: <Xs>
 *  - Task counts table: Pending | Running | Completed | Failed | Total
 *  - Running tasks list with aligned columns
 *  - Footer: Total cost: $<X.XX>
 */
export function renderStatusHuman(snapshot: StatusSnapshot): string {
  const lines: string[] = []

  const elapsedSec = (snapshot.elapsedMs / 1000).toFixed(1)
  lines.push(`Session ${snapshot.sessionId}  Status: ${snapshot.status}  Elapsed: ${elapsedSec}s`)
  lines.push('')

  // Task counts table header
  const headers = ['Pending', 'Running', 'Completed', 'Failed', 'Total']
  const values = [
    String(snapshot.taskCounts.pending),
    String(snapshot.taskCounts.running),
    String(snapshot.taskCounts.completed),
    String(snapshot.taskCounts.failed),
    String(snapshot.taskCounts.total),
  ]

  // Compute column widths
  const colWidths = headers.map((h, i) => Math.max(h.length, values[i].length))
  const headerRow = headers.map((h, i) => h.padEnd(colWidths[i])).join('  ')
  const valueRow = values.map((v, i) => v.padEnd(colWidths[i])).join('  ')
  const separator = colWidths.map((w) => '-'.repeat(w)).join('  ')

  lines.push(headerRow)
  lines.push(separator)
  lines.push(valueRow)

  // Running tasks list
  if (snapshot.runningTasks.length > 0) {
    lines.push('')
    lines.push('Running tasks:')
    for (const task of snapshot.runningTasks) {
      const taskElapsed = (task.elapsedMs / 1000).toFixed(1)
      lines.push(`  → [running] ${task.taskId}  agent: ${task.agent}  elapsed: ${taskElapsed}s`)
    }
  }

  // Footer
  lines.push('')
  lines.push(`Total cost: $${snapshot.totalCostUsd.toFixed(2)}`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// renderTaskGraph
// ---------------------------------------------------------------------------

/**
 * Render the task dependency graph in ASCII tree format.
 *
 * Status symbols:
 *   [ ]  pending
 *   [>]  running
 *   [x]  complete
 *   [!]  failed
 *
 * Uses ASCII tree characters: ├─, └─, │
 */
export function renderTaskGraph(snapshot: StatusSnapshot, tasks: TaskNode[]): string {
  if (tasks.length === 0) {
    return 'No tasks in graph.'
  }

  const lines: string[] = []
  lines.push(`Task Graph (Session ${snapshot.sessionId}):`)
  lines.push('')

  // Build a map from task id to TaskNode
  const taskMap = new Map<string, TaskNode>()
  for (const task of tasks) {
    taskMap.set(task.id, task)
  }

  // Find root tasks (tasks with no dependencies)
  const rootTasks = tasks.filter((t) => t.dependencies.length === 0)

  // Build children map
  const childrenMap = new Map<string, string[]>()
  for (const task of tasks) {
    if (!childrenMap.has(task.id)) {
      childrenMap.set(task.id, [])
    }
    for (const dep of task.dependencies) {
      if (!childrenMap.has(dep)) {
        childrenMap.set(dep, [])
      }
      childrenMap.get(dep)!.push(task.id)
    }
  }

  function getStatusSymbol(status: string): string {
    switch (status) {
      case 'pending': return '[ ]'
      case 'running': return '[>]'
      case 'completed': return '[x]'
      case 'failed': return '[!]'
      default: return '[ ]'
    }
  }

  // Track visited to avoid infinite loops in case of circular deps
  const visited = new Set<string>()

  function renderNode(taskId: string, prefix: string, isLast: boolean): void {
    if (visited.has(taskId)) return
    visited.add(taskId)

    const task = taskMap.get(taskId)
    if (!task) return

    const symbol = getStatusSymbol(task.status)
    const connector = isLast ? '└─' : '├─'
    lines.push(`${prefix}${connector} ${symbol} ${task.id}: ${task.name}`)

    const children = childrenMap.get(taskId) ?? []
    const newPrefix = prefix + (isLast ? '   ' : '│  ')
    for (let i = 0; i < children.length; i++) {
      renderNode(children[i], newPrefix, i === children.length - 1)
    }
  }

  for (let i = 0; i < rootTasks.length; i++) {
    renderNode(rootTasks[i].id, '', i === rootTasks.length - 1)
  }

  // Render any tasks not yet visited (disconnected subgraphs)
  for (const task of tasks) {
    if (!visited.has(task.id)) {
      const symbol = getStatusSymbol(task.status)
      lines.push(`└─ ${symbol} ${task.id}: ${task.name}`)
      visited.add(task.id)
    }
  }

  return lines.join('\n')
}
