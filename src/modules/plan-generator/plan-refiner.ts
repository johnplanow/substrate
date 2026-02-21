/**
 * PlanRefiner — orchestrates iterative plan refinement.
 *
 * Loads plan version history, builds a refinement prompt that includes all
 * prior feedback rounds, invokes PlanGenerator, persists the new version,
 * and emits lifecycle events.
 *
 * Architecture: ADR-001 (Modular Monolith)
 * - DB is passed as a dependency (not imported directly from persistence).
 * - Events are emitted OUTSIDE of DB writes per transaction isolation rule.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync, readFileSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import { getPlan, updatePlan } from '../../persistence/queries/plans.js'
import {
  createPlanVersion,
  getPlanVersionHistory,
  getLatestPlanVersion,
} from '../../persistence/queries/plan-versions.js'
import { PlanGenerator, PlanError } from './plan-generator.js'
import { buildRefinementPrompt } from './planning-prompt.js'
import type { TaskGraphFile } from '../task-graph/schemas.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('plan-refiner')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanRefinerOptions {
  db: BetterSqlite3Database
  planGenerator: PlanGenerator
  availableAgents?: string[]
  /** Temp directory for writing intermediate plan files */
  tempDir?: string
}

export interface RefineResult {
  updatedYaml: string
  newVersion: number
  taskCount: number
}

// ---------------------------------------------------------------------------
// PlanRefiner class
// ---------------------------------------------------------------------------

export class PlanRefiner {
  private readonly db: BetterSqlite3Database
  private readonly planGenerator: PlanGenerator
  private readonly availableAgents: string[]
  private readonly tempDir: string

  constructor(options: PlanRefinerOptions) {
    this.db = options.db
    this.planGenerator = options.planGenerator
    this.availableAgents = options.availableAgents ?? []
    this.tempDir = options.tempDir ?? '/tmp'
  }

  /**
   * Refine a plan by applying the given feedback.
   *
   * Loads the plan and its version history from the DB, calls the planning
   * agent with a refinement prompt that includes all prior feedback rounds,
   * persists the new version, and returns the result.
   *
   * Returns the updated YAML and the new version number.
   * Throws PlanError if the planning agent fails.
   * Throws Error if the plan is not found.
   */
  async refine(
    planId: string,
    feedback: string,
    onEvent?: (event: string, payload: Record<string, unknown>) => void,
  ): Promise<RefineResult> {
    // Load plan record
    const plan = getPlan(this.db, planId)
    if (plan === undefined) {
      throw new Error(`Plan not found: ${planId}`)
    }

    const currentVersion = plan.current_version ?? 1

    // Emit plan:refining event
    onEvent?.('plan:refining', { planId, feedback, currentVersion })

    // Load version history to reconstruct feedbackHistory
    const history = getPlanVersionHistory(this.db, planId)
    // feedbackHistory includes all prior feedback strings (excluding null/initial)
    const feedbackHistory = history
      .map((v) => v.feedback_used)
      .filter((f): f is string => f !== null && f !== undefined)

    // Load the latest YAML
    const latestVersion = getLatestPlanVersion(this.db, planId)
    if (latestVersion === undefined) {
      throw new Error(`No versions found for plan: ${planId}`)
    }

    const currentYaml = latestVersion.task_graph_yaml

    // Build the refinement prompt
    const refinementPrompt = buildRefinementPrompt({
      currentYaml,
      feedbackHistory,
      newFeedback: feedback,
      availableAgents: this.availableAgents,
    })

    logger.info({ planId, currentVersion, feedbackRounds: feedbackHistory.length }, 'Refining plan')

    // Generate the refined plan using PlanGenerator with the refinement prompt as goal
    // Write output to a temp file, then read it back
    const tmpId = randomUUID()
    const tmpPath = join(this.tempDir, `substrate-refine-${tmpId}.yaml`)

    let updatedYaml: string
    let taskCount: number

    try {
      mkdirSync(this.tempDir, { recursive: true })
      const result = await this.planGenerator.generate({
        goal: refinementPrompt,
        outputPath: tmpPath,
        dryRun: false,
      })

      if (!result.success) {
        throw new PlanError(result.error ?? 'Plan refinement failed')
      }

      // Read the generated YAML back
      updatedYaml = readFileSync(tmpPath, 'utf-8')
      taskCount = result.taskCount ?? countTasksInYaml(updatedYaml)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)

      onEvent?.('plan:refinement-failed', {
        planId,
        currentVersion,
        error: errorMessage,
      })

      if (err instanceof PlanError) {
        throw err
      }
      throw new PlanError(`Refinement failed: ${errorMessage}`)
    } finally {
      // Clean up temp file
      try {
        unlinkSync(tmpPath)
      } catch {
        // ignore cleanup errors
      }
    }

    // Persist the new version (DB writes before events per transaction isolation rule)
    const newVersion = currentVersion + 1

    createPlanVersion(this.db, {
      plan_id: planId,
      version: newVersion,
      task_graph_yaml: updatedYaml,
      feedback_used: feedback,
      planning_cost_usd: 0.0,
    })

    updatePlan(this.db, planId, {
      current_version: newVersion,
    })

    // Emit plan:refined event
    onEvent?.('plan:refined', { planId, newVersion, taskCount })

    logger.info({ planId, newVersion, taskCount }, 'Plan refined successfully')

    return { updatedYaml, newVersion, taskCount }
  }
}

// ---------------------------------------------------------------------------
// Helper to count tasks in a YAML string
// ---------------------------------------------------------------------------

export function countTasksInYaml(yaml: string): number {
  try {
    const parsed = yamlLoad(yaml) as TaskGraphFile | null
    if (parsed !== null && typeof parsed === 'object' && parsed.tasks) {
      return Object.keys(parsed.tasks).length
    }
  } catch {
    // ignore parse errors
  }
  return 0
}

// ---------------------------------------------------------------------------
// Helper to compute diff between two plan YAML strings
// ---------------------------------------------------------------------------

export interface FieldChange {
  field: string
  from: unknown
  to: unknown
}

export interface PlanDiffResult {
  added: string[]
  removed: string[]
  modified: { taskId: string; changes: FieldChange[] }[]
}

const DIFF_FIELDS = ['name', 'description', 'agent', 'budget_usd', 'depends_on'] as const

/**
 * Compute a structured diff between two plan YAML strings.
 * Returns added task IDs, removed task IDs, and modified tasks with field-level changes.
 */
export function computePlanDiff(fromYaml: string, toYaml: string): PlanDiffResult {
  const fromGraph = parseTaskGraph(fromYaml)
  const toGraph = parseTaskGraph(toYaml)

  const fromTasks = fromGraph?.tasks ?? {}
  const toTasks = toGraph?.tasks ?? {}

  const fromIds = new Set(Object.keys(fromTasks))
  const toIds = new Set(Object.keys(toTasks))

  const added = [...toIds].filter((id) => !fromIds.has(id))
  const removed = [...fromIds].filter((id) => !toIds.has(id))

  const modified: { taskId: string; changes: FieldChange[] }[] = []

  for (const taskId of [...fromIds]) {
    if (!toIds.has(taskId)) continue
    const fromTask = fromTasks[taskId]
    const toTask = toTasks[taskId]
    const changes: FieldChange[] = []

    for (const field of DIFF_FIELDS) {
      const fromVal = fromTask[field as keyof typeof fromTask]
      const toVal = toTask[field as keyof typeof toTask]

      const fromStr = normalizeForDiff(fromVal)
      const toStr = normalizeForDiff(toVal)

      if (fromStr !== toStr) {
        changes.push({ field, from: fromVal, to: toVal })
      }
    }

    if (changes.length > 0) {
      modified.push({ taskId, changes })
    }
  }

  return { added, removed, modified }
}

function parseTaskGraph(yaml: string): TaskGraphFile | null {
  try {
    return yamlLoad(yaml) as TaskGraphFile
  } catch {
    return null
  }
}

function normalizeForDiff(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify([...value].sort())
  }
  if (value === undefined || value === null) {
    return ''
  }
  return String(value)
}
