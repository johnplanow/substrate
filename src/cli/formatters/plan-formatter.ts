/**
 * plan-formatter.ts — Human-readable formatters for plan data.
 *
 * Used by the `substrate plan` CLI command to display generated plans,
 * plan lists, and plan details in a human-readable format.
 */

import type { PlanGenerateResult } from '../../modules/plan-generator/plan-generator.js'
import type { Plan } from '../../persistence/queries/plans.js'
import type { TaskGraphFile } from '../../modules/task-graph/schemas.js'

// ---------------------------------------------------------------------------
// formatPlanVersionForDisplay
// ---------------------------------------------------------------------------

/**
 * Format a plan version YAML + optional parsed task graph for human display.
 * Used by the refine and rollback commands.
 */
export function formatPlanVersionForDisplay(
  _yaml: string,
  taskGraph?: TaskGraphFile,
): string {
  const lines: string[] = []
  lines.push('=== Plan (current version) ===')

  if (taskGraph?.tasks) {
    lines.push(`Task count: ${String(Object.keys(taskGraph.tasks).length)}`)
    lines.push('')
    lines.push('Tasks:')

    const taskEntries = Object.entries(taskGraph.tasks)
    taskEntries.forEach(([taskId, task], index) => {
      const num = index + 1
      const taskType = task.type ?? 'coding'
      const budgetCap = task.budget_usd !== undefined ? `$${task.budget_usd.toFixed(2)}` : '$0.00'
      const agent = task.agent ?? 'policy-routed'
      const description = task.description ?? task.prompt ?? ''
      const truncatedDesc = description.length > 80 ? description.slice(0, 80) + '...' : description
      const deps = task.depends_on && task.depends_on.length > 0 ? task.depends_on.join(', ') : '(none)'

      lines.push(`  ${String(num)}. ${taskId.padEnd(24)}[${taskType}]${' '.repeat(Math.max(1, 10 - taskType.length))}${budgetCap.padEnd(8)}  agent: ${agent}`)
      lines.push(`     ${truncatedDesc}`)
      lines.push(`     depends_on: ${deps}`)
      lines.push('')
    })
  } else {
    lines.push('(No tasks to display)')
  }

  lines.push('======================')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// formatPlanForDisplay
// ---------------------------------------------------------------------------

/**
 * Format a generated plan result for human-readable display.
 *
 * Displays the task list with dependencies, agent assignments, and cost estimates.
 */
export function formatPlanForDisplay(
  planResult: PlanGenerateResult & {
    taskGraph?: TaskGraphFile
    planningAgent?: string
    estimatedExecutionCost?: number
    taskCount?: number
  },
): string {
  const lines: string[] = []
  lines.push('=== Generated Plan ===')

  const planningAgent = planResult.planningAgent ?? 'unknown'
  const taskCount = planResult.taskCount ?? 0
  const estimatedCost = planResult.estimatedExecutionCost ?? 0

  lines.push(`Planning agent: ${planningAgent}`)
  lines.push(`Task count:     ${String(taskCount)}`)
  lines.push(`Estimated cost: $${estimatedCost.toFixed(2)}`)
  lines.push('')
  lines.push('Tasks:')

  const taskGraph = planResult.taskGraph
  let hasSubscriptionTask = false

  if (taskGraph?.tasks) {
    const taskEntries = Object.entries(taskGraph.tasks)
    taskEntries.forEach(([taskId, task], index) => {
      const num = index + 1
      const taskType = task.type ?? 'coding'
      const budgetCap = task.budget_usd !== undefined ? `$${task.budget_usd.toFixed(2)}` : '$0.00'
      const agent = task.agent ?? 'policy-routed'
      const description = task.description ?? task.prompt ?? ''
      const truncatedDesc = description.length > 80 ? description.slice(0, 80) + '...' : description
      const deps = task.depends_on && task.depends_on.length > 0 ? task.depends_on.join(', ') : '(none)'

      // Check for subscription billing (agent field indicates subscription)
      if (task.agent && task.agent !== 'policy-routed') {
        hasSubscriptionTask = true
      }

      lines.push(`  ${String(num)}. ${taskId.padEnd(24)}[${taskType}]${' '.repeat(Math.max(1, 10 - taskType.length))}${budgetCap.padEnd(8)}  agent: ${agent}`)
      lines.push(`     ${truncatedDesc}`)
      lines.push(`     depends_on: ${deps}`)
      lines.push('')
    })
  }

  const subscriptionLabel = hasSubscriptionTask
    ? 'YES (at least one task eligible for subscription billing)'
    : 'NO (all tasks use API billing)'
  lines.push(`Subscription routing: ${subscriptionLabel}`)
  lines.push('======================')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// formatPlanList
// ---------------------------------------------------------------------------

/**
 * Format a list of plans for tabular display.
 */
export function formatPlanList(plans: Plan[]): string {
  if (plans.length === 0) {
    return 'No plans found.'
  }

  const lines: string[] = []
  const header = `${'ID'.padEnd(8)}  ${'DATE'.padEnd(10)}  ${'TASKS'.padEnd(5)}  ${'EST. COST'.padEnd(9)}  ${'STATUS'.padEnd(10)}  DESCRIPTION`
  lines.push(header)
  lines.push('-'.repeat(header.length))

  for (const plan of plans) {
    const id = plan.id.slice(0, 8)
    const date = plan.created_at.slice(0, 10)
    const taskCount = String(plan.task_count).padEnd(5)
    const cost = `$${plan.estimated_cost_usd.toFixed(2)}`.padEnd(9)
    const status = plan.status.padEnd(10)
    const description = plan.description.length > 60 ? plan.description.slice(0, 60) : plan.description

    lines.push(`${id}  ${date}  ${taskCount}  ${cost}  ${status}  ${description}`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// formatPlanDetail
// ---------------------------------------------------------------------------

/**
 * Format a single plan record for detailed display including full YAML.
 */
export function formatPlanDetail(plan: Plan): string {
  const lines: string[] = []
  lines.push('=== Plan Detail ===')
  lines.push(`ID:             ${plan.id}`)
  lines.push(`Status:         ${plan.status}`)
  lines.push(`Planning agent: ${plan.planning_agent}`)
  lines.push(`Task count:     ${String(plan.task_count)}`)
  lines.push(`Estimated cost: $${plan.estimated_cost_usd.toFixed(2)}`)
  lines.push(`Created at:     ${plan.created_at}`)
  lines.push(`Updated at:     ${plan.updated_at}`)
  lines.push(`Description:    ${plan.description}`)
  lines.push('')
  lines.push('--- Plan YAML ---')
  lines.push(plan.plan_yaml)
  lines.push('=================')

  return lines.join('\n')
}
