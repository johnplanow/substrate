/**
 * Plan validator — plan-specific validation layer.
 *
 * Wraps and extends the generic `validateGraph()` from task-validator.ts
 * with plan-specific concerns:
 *   - Structured PlanValidationError / PlanValidationWarning types
 *   - Agent name normalization (AC7)
 *   - Empty-graph check (AC9)
 *   - Per-task budget warnings (AC9)
 *   - Structured field paths for all errors (AC6)
 *
 * This module does NOT re-implement detectCycle, validateDependencies, or
 * schema parsing — it composes them from task-graph primitives.
 */

import { TaskGraphFileSchema } from '../task-graph/schemas.js'
import type { TaskGraphFile } from '../task-graph/schemas.js'
import { detectCycle, validateDependencies } from '../task-graph/dependency-resolver.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'

// ---------------------------------------------------------------------------
// Agent name alias map (AC7)
// ---------------------------------------------------------------------------

export const AGENT_NAME_ALIASES: Record<string, string> = {
  claude: 'claude-code',
  'claude-cli': 'claude-code',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
  'gemini-code': 'gemini',
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlanValidationError {
  code: 'schema' | 'cycle' | 'dangling_ref' | 'empty_graph' | 'agent_unavailable'
  field?: string
  message: string
  suggestion?: string
}

export interface PlanValidationWarning {
  code: 'no_budget' | 'agent_unavailable'
  field?: string
  message: string
  suggestion?: string
}

export interface PlanValidationResult {
  valid: boolean
  errors: PlanValidationError[]
  warnings: PlanValidationWarning[]
  /** Descriptions of auto-fixes applied (AC7) */
  autoFixed: string[]
  /** Only present when valid === true */
  graph?: TaskGraphFile
}

// ---------------------------------------------------------------------------
// Zod suggestion lookup table
// ---------------------------------------------------------------------------

const ZOD_SUGGESTIONS: Record<string, string> = {
  too_small: 'Ensure the field is not empty',
  invalid_type: 'Check the field type matches the schema',
  invalid_enum_value: 'Use one of the allowed values',
  // Zod v4 uses 'invalid_value' for enum validation failures
  invalid_value: 'Use one of the allowed values',
  custom: 'Check the field value matches the requirements',
}

const TYPE_SUGGESTION =
  'Change the type field to one of the supported values: coding, testing, docs, debugging, refactoring'

// ---------------------------------------------------------------------------
// normalizeAgentName
// ---------------------------------------------------------------------------

/**
 * Normalize an agent name using the known alias map.
 *
 * @param agent - The raw agent string from the task definition
 * @returns `{ normalized, changed }` — normalized is the canonical ID,
 *          changed is true if the alias was resolved
 */
export function normalizeAgentName(agent: string): { normalized: string; changed: boolean } {
  const canonical = AGENT_NAME_ALIASES[agent]
  if (canonical !== undefined) {
    return { normalized: canonical, changed: true }
  }
  return { normalized: agent, changed: false }
}

// ---------------------------------------------------------------------------
// validatePlan
// ---------------------------------------------------------------------------

/**
 * Run the full plan validation pipeline on a raw (unknown) object.
 *
 * Pipeline steps:
 *   1. Agent name normalization (if options.normalize === true)
 *   2. Zod schema validation
 *   3. Empty-graph check
 *   4. Cycle detection
 *   5. Dependency reference validation
 *   6. Agent availability check (if adapterRegistry provided)
 *   7. Budget presence warnings
 *
 * @param raw            - Raw parsed object (output of parseGraphFile / parseGraphString)
 * @param adapterRegistry - Optional registry for agent availability checks (AC4)
 * @param options         - `normalize: true` enables agent alias normalization (AC7)
 * @returns PlanValidationResult — valid=true only when errors is empty
 */
export function validatePlan(
  raw: unknown,
  adapterRegistry?: AdapterRegistry,
  options?: { normalize?: boolean },
): PlanValidationResult {
  const errors: PlanValidationError[] = []
  const warnings: PlanValidationWarning[] = []
  const autoFixed: string[] = []
  const normalize = options?.normalize ?? false

  // Step 1: Agent name normalization (mutates raw in place when normalize=true)
  if (normalize && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const rawObj = raw as Record<string, unknown>
    const tasks = rawObj['tasks']
    if (tasks !== null && typeof tasks === 'object' && !Array.isArray(tasks)) {
      const tasksObj = tasks as Record<string, unknown>
      for (const [taskId, taskDef] of Object.entries(tasksObj)) {
        if (taskDef !== null && typeof taskDef === 'object' && !Array.isArray(taskDef)) {
          const taskDefObj = taskDef as Record<string, unknown>
          if (typeof taskDefObj['agent'] === 'string') {
            const { normalized, changed } = normalizeAgentName(taskDefObj['agent'])
            if (changed) {
              const original = taskDefObj['agent']
              taskDefObj['agent'] = normalized
              autoFixed.push(
                `Auto-fixed agent name in task '${taskId}': '${original}' -> '${normalized}'`,
              )
            }
          }
        }
      }
    }
  }

  // Step 2: Zod schema validation
  const parseResult = TaskGraphFileSchema.safeParse(raw)

  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      const field = issue.path.length > 0 ? issue.path.join('.') : undefined
      const isTypeField =
        issue.path.length > 0 &&
        String(issue.path[issue.path.length - 1]) === 'type'

      let suggestion: string | undefined
      if (isTypeField && (issue.code === 'invalid_enum_value' || issue.code === 'invalid_value')) {
        suggestion = TYPE_SUGGESTION
      } else {
        suggestion = ZOD_SUGGESTIONS[issue.code] ?? ZOD_SUGGESTIONS['custom']
      }

      errors.push({
        code: 'schema',
        field,
        message: issue.message,
        suggestion,
      })
    }
    return { valid: false, errors, warnings, autoFixed }
  }

  const graph = parseResult.data

  // Step 3: Empty-graph check
  if (Object.keys(graph.tasks).length === 0) {
    errors.push({
      code: 'empty_graph',
      field: 'tasks',
      message: 'Task graph is empty',
      suggestion: 'Add at least one task to the tasks map',
    })
  }

  // Step 4: Cycle detection
  const cycle = detectCycle(graph.tasks)
  if (cycle !== null) {
    const cyclePath = cycle.join(' -> ')
    const closingEdge =
      cycle.length >= 2
        ? `${cycle[cycle.length - 2] ?? ''} -> ${cycle[cycle.length - 1] ?? ''}`
        : cyclePath
    errors.push({
      code: 'cycle',
      field: 'tasks',
      message: `Circular dependency detected: ${cyclePath}`,
      suggestion: `Remove the dependency that creates the cycle: ${closingEdge}`,
    })
  }

  // Step 5: Dependency reference validation
  const depErrors = validateDependencies(graph.tasks)
  for (const errMsg of depErrors) {
    // Parse the message to extract taskId and bad ref
    // Format: Task "task-b" references unknown dependency "task-x"
    const match = errMsg.match(/^Task "([^"]+)" references unknown dependency "([^"]+)"$/)
    const taskId = match?.[1] ?? ''
    const badRef = match?.[2] ?? ''
    errors.push({
      code: 'dangling_ref',
      field: taskId ? `tasks.${taskId}.depends_on` : 'tasks',
      message: errMsg,
      suggestion: badRef
        ? `Check task IDs are spelled correctly and the referenced task "${badRef}" exists in the plan`
        : 'Check task IDs are spelled correctly and the referenced task exists',
    })
  }

  // Step 6: Agent availability check
  if (adapterRegistry !== undefined) {
    const adapters = adapterRegistry.getAll()
    const agentIds = adapters.map((a) => a.id as string)

    for (const [taskId, taskDef] of Object.entries(graph.tasks)) {
      if (taskDef.agent !== undefined) {
        if (!agentIds.includes(taskDef.agent)) {
          const available =
            agentIds.length > 0 ? agentIds.join(', ') : 'none'
          warnings.push({
            code: 'agent_unavailable',
            field: `tasks.${taskId}.agent`,
            message:
              `Task '${taskId}' references agent '${taskDef.agent}' which is not registered. ` +
              `Available agents: ${available}. Fallback routing will be used.`,
            suggestion: `Use one of the available agents: ${available}`,
          })
        }
      }
    }
  }

  // Step 7: Budget warnings
  for (const [taskId, taskDef] of Object.entries(graph.tasks)) {
    if (taskDef.budget_usd === undefined) {
      warnings.push({
        code: 'no_budget',
        field: `tasks.${taskId}.budget_usd`,
        message: `Task '${taskId}' has no budget_usd set`,
        suggestion: 'Set budget_usd to limit the maximum cost for this task',
      })
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings, autoFixed }
  }

  return { valid: true, errors, warnings, autoFixed, graph }
}
