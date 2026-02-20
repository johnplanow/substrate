/**
 * Dependency resolver for task graphs.
 *
 * Provides:
 *  - Cycle detection using DFS with visited/inStack sets (FR55a)
 *  - Dangling reference detection for missing dependency task IDs (FR55b)
 */

import type { TaskDefinition } from './schemas.js'

// ---------------------------------------------------------------------------
// detectCycle
// ---------------------------------------------------------------------------

/**
 * Detect a cycle in the task dependency graph using depth-first search.
 *
 * @param tasks - Map of task ID to task definition
 * @returns The cycle path as an array of task IDs (e.g. ['a', 'b', 'a']),
 *          or null if no cycle is detected
 */
export function detectCycle(tasks: Record<string, TaskDefinition>): string[] | null {
  const visited = new Set<string>()
  const inStack = new Set<string>()

  function dfs(nodeId: string, path: string[]): string[] | null {
    visited.add(nodeId)
    inStack.add(nodeId)

    for (const dep of (tasks[nodeId]?.depends_on ?? [])) {
      if (inStack.has(dep)) {
        // Found cycle — return the cycle path
        const cycleStart = path.indexOf(dep)
        return [...path.slice(cycleStart), dep]
      }
      if (!visited.has(dep)) {
        const cycle = dfs(dep, [...path, dep])
        if (cycle) return cycle
      }
    }

    inStack.delete(nodeId)
    return null
  }

  for (const id of Object.keys(tasks)) {
    if (!visited.has(id)) {
      const cycle = dfs(id, [id])
      if (cycle) return cycle
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// validateDependencies
// ---------------------------------------------------------------------------

/**
 * Validate that all dependency references in a task graph point to existing tasks.
 *
 * @param tasks - Map of task ID to task definition
 * @returns Array of error messages for missing dependencies (empty if all valid)
 */
export function validateDependencies(tasks: Record<string, TaskDefinition>): string[] {
  const errors: string[] = []
  const taskIds = new Set(Object.keys(tasks))

  for (const [taskId, taskDef] of Object.entries(tasks)) {
    for (const dep of taskDef.depends_on ?? []) {
      if (!taskIds.has(dep)) {
        errors.push(`Task "${taskId}" references unknown dependency "${dep}"`)
      }
    }
  }

  return errors
}
