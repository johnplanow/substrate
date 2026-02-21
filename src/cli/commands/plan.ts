/**
 * `substrate plan` command
 *
 * Generates a structured TaskGraph file from a natural language goal.
 *
 * Usage:
 *   substrate plan "add authentication to my app"
 *   substrate plan "refactor auth module" --output my-plan.yaml
 *   substrate plan "add OAuth" --model claude-opus-4-5
 *   substrate plan "fix tests" --adapter codex
 *   substrate plan "add logging" --dry-run
 *   substrate plan "add feature" --output-format json
 *   substrate plan --codebase . --goal "Add authentication"
 *   substrate plan --codebase ./myapp --goal "Add JWT auth" --agent-count 3
 *   substrate plan "add feature" --auto-approve
 *   substrate plan list
 *   substrate plan show <plan-id>
 *
 * Exit codes:
 *   0   - Success or dry-run
 *   1   - Plan generation failed or unexpected error
 *   2   - Usage error (missing adapter, output dir does not exist, etc.)
 */

import type { Command } from 'commander'
import { join, dirname, isAbsolute } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import * as readline from 'readline'
import { randomUUID } from 'crypto'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { PlanGenerator, PlanError } from '../../modules/plan-generator/plan-generator.js'
import { scanCodebase, ScanError } from '../../modules/plan-generator/codebase-scanner.js'
import type { CodebaseContext } from '../../modules/plan-generator/codebase-scanner.js'
import type { AgentSummary } from '../../modules/plan-generator/planning-prompt.js'
import { emitEvent } from '../formatters/streaming.js'
import { formatPlanList, formatPlanDetail, formatPlanForDisplay } from '../formatters/plan-formatter.js'
import { DatabaseWrapper } from '../../persistence/database.js'
import { runMigrations } from '../../persistence/migrations/index.js'
import {
  createPlan,
  updatePlanStatus,
  listPlans,
  getPlanByPrefix,
} from '../../persistence/queries/plans.js'
import { createPlanVersion } from '../../persistence/queries/plan-versions.js'
import type { Plan } from '../../persistence/queries/plans.js'
import type { TaskGraphFile } from '../../modules/task-graph/schemas.js'
import { registerPlanRefineCommand } from './plan-refine.js'
import { registerPlanDiffCommand } from './plan-diff.js'
import { registerPlanRollbackCommand } from './plan-rollback.js'
import { createLogger } from '../../utils/logger.js'
import { validatePlan } from '../../modules/plan-generator/plan-validator.js'
import type { PlanValidationError, PlanValidationWarning } from '../../modules/plan-generator/plan-validator.js'
import { parseGraphFile, ParseError } from '../../modules/task-graph/task-parser.js'

const logger = createLogger('plan-cmd')

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const PLAN_EXIT_SUCCESS = 0
export const PLAN_EXIT_ERROR = 1
export const PLAN_EXIT_USAGE_ERROR = 2

// ---------------------------------------------------------------------------
// CLIJsonOutput envelope
// ---------------------------------------------------------------------------

export interface CLIJsonOutput<T = unknown> {
  success: boolean
  command: string
  timestamp: string
  data: T
  error?: { code: string; message: string; details?: unknown }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanActionOptions {
  goal: string
  outputPath: string
  model?: string
  adapterId?: string
  dryRun: boolean
  outputFormat: 'human' | 'json'
  projectRoot: string
  /** Path to codebase directory for codebase-aware planning (AC1) */
  codebasePath?: string
  /** Directory traversal depth for codebase scanning (AC2, default 2) */
  contextDepth: number
  /** Hint for number of parallel agents (AC3) */
  agentCount?: number
  /** Skip interactive review and automatically approve (AC3) */
  autoApprove?: boolean
}

export interface PlanListOptions {
  outputFormat: 'human' | 'json'
  projectRoot: string
}

export interface PlanShowOptions {
  outputFormat: 'human' | 'json'
  projectRoot: string
}

// ---------------------------------------------------------------------------
// promptApproval — interactive single-key prompt
// ---------------------------------------------------------------------------

/**
 * Prompt the user to approve or reject a generated plan.
 * Uses readline for interactive input. Recurses on invalid input.
 *
 * Returns 'approve' or 'reject'.
 */
export async function promptApproval(): Promise<'approve' | 'reject'> {
  // If stdin is not a TTY (e.g., piped CI), skip prompt
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'Error: stdin is not a TTY. Use --auto-approve for non-interactive environments.\n',
    )
    return 'reject'
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question('\nReview complete. [A]pprove / [R]eject: ', (answer) => {
      rl.close()
      if (answer.toLowerCase() === 'a') {
        resolve('approve')
      } else if (answer.toLowerCase() === 'r') {
        resolve('reject')
      } else {
        process.stdout.write('Invalid input. Enter A to approve or R to reject.\n')
        resolve(promptApproval())
      }
    })
  })
}

// ---------------------------------------------------------------------------
// runPlanAction — testable core logic
// ---------------------------------------------------------------------------

/**
 * Core action for the plan command.
 *
 * Returns exit code. Separated from Commander integration for testability.
 */
export async function runPlanAction(options: PlanActionOptions): Promise<number> {
  const {
    goal,
    model,
    adapterId,
    dryRun,
    outputFormat,
    projectRoot,
    codebasePath,
    contextDepth,
    agentCount,
    autoApprove = false,
  } = options

  // AC6: --goal is required when --codebase is specified
  if (codebasePath !== undefined && (!goal || goal.trim() === '')) {
    process.stderr.write('Error: --goal is required when --codebase is specified\n')
    return PLAN_EXIT_USAGE_ERROR
  }

  // Resolve output path
  const outputPath = isAbsolute(options.outputPath)
    ? options.outputPath
    : join(process.cwd(), options.outputPath)

  // AC2: Validate that the parent directory of outputPath exists (skip check in dry-run)
  if (!dryRun) {
    const outputDir = dirname(outputPath)
    if (!existsSync(outputDir)) {
      process.stderr.write(`Error: Output directory does not exist: ${outputDir}\n`)
      return PLAN_EXIT_USAGE_ERROR
    }
  }

  // Set up adapter registry
  const registry = new AdapterRegistry()
  try {
    await registry.discoverAndRegister()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'discoverAndRegister failed')
    return PLAN_EXIT_ERROR
  }

  // AC1/AC7: Scan codebase if --codebase is provided
  let codebaseContext: CodebaseContext | undefined
  if (codebasePath !== undefined) {
    try {
      codebaseContext = await scanCodebase(codebasePath, { contextDepth })
    } catch (err) {
      if (err instanceof ScanError) {
        process.stderr.write(`Error: ${err.message}\n`)
        return PLAN_EXIT_USAGE_ERROR
      }
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: ${message}\n`)
      return PLAN_EXIT_ERROR
    }

    // AC10: Print codebase context summary for human format
    if (outputFormat === 'human') {
      const fileCount = codebaseContext.keyFiles.length
      const stack = codebaseContext.techStack.map((s) => s.name).join(', ')
      process.stdout.write(`Codebase context extracted: ${String(fileCount)} files, tech stack: ${stack}\n`)
    }
  }

  // AC3/AC5: Build agent summaries from registry
  const registeredAdapters = registry.getAll()
  const availableAgents: AgentSummary[] = await buildAgentSummaries(registeredAdapters)

  // Instantiate generator
  const generator = new PlanGenerator({
    adapterRegistry: registry,
    projectRoot,
    ...(adapterId !== undefined ? { adapterId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(codebaseContext !== undefined ? { codebaseContext } : {}),
    ...(availableAgents.length > 0 ? { availableAgents } : {}),
    ...(agentCount !== undefined ? { agentCount } : {}),
  })

  // AC6: Print progress for human format
  if (outputFormat === 'human' && !dryRun) {
    process.stdout.write(`Generating plan for: "${goal}"...\n`)
  }

  // Generate plan
  let result
  try {
    result = await generator.generate({ goal, outputPath, dryRun })
  } catch (err) {
    // AC10: PlanError with no adapter → exit 2
    if (err instanceof PlanError) {
      const isUsageError =
        err.code === 'NO_PLANNING_ADAPTER' || err.code === 'ADAPTER_NOT_AVAILABLE'
      process.stderr.write(`Error: ${err.message}\n`)
      return isUsageError ? PLAN_EXIT_USAGE_ERROR : PLAN_EXIT_ERROR
    }
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runPlanAction failed')
    return PLAN_EXIT_ERROR
  }

  // AC8: Dry-run
  if (dryRun) {
    if (result.dryRunPrompt !== undefined) {
      process.stdout.write(result.dryRunPrompt + '\n')
    }
    if (outputFormat === 'human') {
      process.stdout.write('Dry run complete — no plan saved.\n')
    }
    return PLAN_EXIT_SUCCESS
  }

  // Handle errors from generate()
  if (!result.success) {
    const errorMessage = result.error ?? 'unknown error'

    // Detect usage errors from PlanError messages embedded in result
    const isUsageError =
      errorMessage.includes('is not available or does not support plan generation') ||
      errorMessage.includes('No planning-capable adapter is available')

    process.stderr.write(`Error: Plan generation failed: ${errorMessage}\n`)
    return isUsageError ? PLAN_EXIT_USAGE_ERROR : PLAN_EXIT_ERROR
  }

  // AC6: Output success
  const taskCount = result.taskCount ?? 0
  const resolvedOutputPath = result.outputPath ?? outputPath

  if (outputFormat === 'json') {
    const jsonData: Record<string, unknown> = {
      outputPath: resolvedOutputPath,
      taskCount,
    }
    // AC10: Include codebase_context in JSON output
    if (codebaseContext !== undefined) {
      jsonData['codebase_context'] = {
        rootPath: codebaseContext.rootPath,
        detectedLanguages: codebaseContext.detectedLanguages,
        techStack: codebaseContext.techStack.map((s) => s.name),
        fileCount: codebaseContext.keyFiles.length,
        topLevelDirs: codebaseContext.topLevelDirs,
      }
    }
    const envelope: CLIJsonOutput = {
      success: true,
      command: 'plan',
      timestamp: new Date().toISOString(),
      data: jsonData,
    }
    process.stdout.write(JSON.stringify(envelope) + '\n')
  } else {
    process.stdout.write(`Plan written to: ${resolvedOutputPath} (${String(taskCount)} tasks)\n`)
  }

  // AC3/AC5/AC6: If autoApprove is set, handle approval flow
  if (autoApprove) {
    const planId = randomUUID()
    process.stdout.write('Plan auto-approved (--auto-approve flag)\n')
    await savePlan({
      planId,
      goal,
      planningAgent: adapterId ?? 'policy-routed',
      estimatedExecutionCost: 0,
      taskCount,
      planYaml: '',
      projectRoot,
      status: 'approved',
    })
    emitEvent('plan:approved', { taskCount })
    process.stdout.write(`Plan approved. Saved to .substrate/plans/${planId}.yaml\n`)
    process.stdout.write(`To execute: substrate start --graph .substrate/plans/${planId}.yaml\n`)
  }

  return PLAN_EXIT_SUCCESS
}

// ---------------------------------------------------------------------------
// savePlan — helper to persist a plan record + YAML file
// ---------------------------------------------------------------------------

interface SavePlanInput {
  planId: string
  goal: string
  planningAgent: string
  estimatedExecutionCost: number
  taskCount: number
  planYaml: string
  projectRoot: string
  status: 'approved' | 'rejected'
}

async function savePlan(input: SavePlanInput): Promise<void> {
  const { planId, goal, planningAgent, estimatedExecutionCost, taskCount, planYaml, projectRoot, status } = input
  const dbPath = join(projectRoot, '.substrate', 'state.db')
  const dbWrapper = new DatabaseWrapper(dbPath)
  try {
    dbWrapper.open()
    runMigrations(dbWrapper.db)
    createPlan(dbWrapper.db, {
      id: planId,
      description: goal,
      task_count: taskCount,
      estimated_cost_usd: estimatedExecutionCost,
      planning_agent: planningAgent,
      plan_yaml: planYaml,
      status: 'draft',
    })
    createPlanVersion(dbWrapper.db, {
      plan_id: planId,
      version: 1,
      task_graph_yaml: planYaml,
      feedback_used: null,
      planning_cost_usd: estimatedExecutionCost,
    })
    updatePlanStatus(dbWrapper.db, planId, status)

    if (status === 'approved' && planYaml) {
      const plansDir = join(projectRoot, '.substrate', 'plans')
      mkdirSync(plansDir, { recursive: true })
      writeFileSync(join(plansDir, planId + '.yaml'), planYaml, 'utf-8')
    }
  } finally {
    dbWrapper.close()
  }
}

// ---------------------------------------------------------------------------
// runPlanReviewAction — plan generation + interactive review + DB persistence
// ---------------------------------------------------------------------------

/**
 * Extended plan action that includes the interactive review/approval flow.
 * This is the core of story 7-3.
 *
 * Flow:
 *   1. Set up adapter registry and scan codebase (if --codebase)
 *   2. Call PlanGenerator.generate() with all CLI options
 *   3. Display the generated plan using formatPlanForDisplay
 *   4. Prompt for approval (unless --auto-approve or --dry-run)
 *   5. On approval: save to DB, write plan YAML to file
 *   6. On rejection: save to DB with rejected status
 */
export async function runPlanReviewAction(options: PlanActionOptions): Promise<number> {
  const {
    goal,
    model,
    adapterId,
    dryRun,
    outputFormat,
    projectRoot,
    codebasePath,
    contextDepth,
    agentCount,
    autoApprove = false,
  } = options

  // AC6: --goal is required when --codebase is specified
  if (codebasePath !== undefined && (!goal || goal.trim() === '')) {
    process.stderr.write('Error: --goal is required when --codebase is specified\n')
    return PLAN_EXIT_USAGE_ERROR
  }

  // Resolve output path
  const outputPath = isAbsolute(options.outputPath)
    ? options.outputPath
    : join(process.cwd(), options.outputPath)

  // Validate that the parent directory of outputPath exists (skip check in dry-run)
  if (!dryRun) {
    const outputDir = dirname(outputPath)
    if (!existsSync(outputDir)) {
      process.stderr.write(`Error: Output directory does not exist: ${outputDir}\n`)
      return PLAN_EXIT_USAGE_ERROR
    }
  }

  // Set up adapter registry
  const registry = new AdapterRegistry()
  try {
    await registry.discoverAndRegister()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    return PLAN_EXIT_ERROR
  }

  // Scan codebase if --codebase is provided
  let codebaseContext: CodebaseContext | undefined
  if (codebasePath !== undefined) {
    try {
      codebaseContext = await scanCodebase(codebasePath, { contextDepth })
    } catch (err) {
      if (err instanceof ScanError) {
        process.stderr.write(`Error: ${err.message}\n`)
        return PLAN_EXIT_USAGE_ERROR
      }
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: ${message}\n`)
      return PLAN_EXIT_ERROR
    }

    if (outputFormat === 'human') {
      const fileCount = codebaseContext.keyFiles.length
      const stack = codebaseContext.techStack.map((s) => s.name).join(', ')
      process.stdout.write(`Codebase context extracted: ${String(fileCount)} files, tech stack: ${stack}\n`)
    }
  }

  // Build agent summaries from registry
  const registeredAdapters = registry.getAll()
  const availableAgents: AgentSummary[] = await buildAgentSummaries(registeredAdapters)

  // Instantiate generator
  const generator = new PlanGenerator({
    adapterRegistry: registry,
    projectRoot,
    ...(adapterId !== undefined ? { adapterId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(codebaseContext !== undefined ? { codebaseContext } : {}),
    ...(availableAgents.length > 0 ? { availableAgents } : {}),
    ...(agentCount !== undefined ? { agentCount } : {}),
  })

  // Print progress for human format
  if (outputFormat === 'human' && !dryRun) {
    process.stdout.write(`Generating plan for: "${goal}"...\n`)
  }

  // Generate plan via PlanGenerator
  let result
  try {
    result = await generator.generate({ goal, outputPath, dryRun })
  } catch (err) {
    if (err instanceof PlanError) {
      const isUsageError =
        err.code === 'NO_PLANNING_ADAPTER' || err.code === 'ADAPTER_NOT_AVAILABLE'
      process.stderr.write(`Error: ${err.message}\n`)
      return isUsageError ? PLAN_EXIT_USAGE_ERROR : PLAN_EXIT_ERROR
    }
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    logger.error({ err }, 'runPlanReviewAction failed')
    return PLAN_EXIT_ERROR
  }

  // Dry-run: display prompt and exit without approval or DB save
  if (dryRun) {
    if (result.dryRunPrompt !== undefined) {
      process.stdout.write(result.dryRunPrompt + '\n')
    }
    process.stdout.write('Dry run complete — no plan saved.\n')
    return PLAN_EXIT_SUCCESS
  }

  // Handle generation errors
  if (!result.success) {
    const errorMessage = result.error ?? 'unknown error'
    const isUsageError =
      errorMessage.includes('is not available or does not support plan generation') ||
      errorMessage.includes('No planning-capable adapter is available')
    process.stderr.write(`Error: Plan generation failed: ${errorMessage}\n`)
    return isUsageError ? PLAN_EXIT_USAGE_ERROR : PLAN_EXIT_ERROR
  }

  // Extract real data from generation result
  const taskCount = result.taskCount ?? 0
  const resolvedOutputPath = result.outputPath ?? outputPath
  // Use adapter ID if provided, otherwise 'policy-routed'
  const planningAgent = adapterId ?? 'policy-routed'
  const estimatedExecutionCost = 0.0

  // Read the generated plan YAML from the output file
  let planYaml = ''
  let taskGraph: TaskGraphFile | undefined
  try {
    planYaml = readFileSync(resolvedOutputPath, 'utf-8')
    // Parse the plan file into a TaskGraphFile for display
    const ext = resolvedOutputPath.toLowerCase()
    if (ext.endsWith('.yaml') || ext.endsWith('.yml')) {
      taskGraph = yamlLoad(planYaml) as TaskGraphFile
    } else {
      taskGraph = JSON.parse(planYaml) as TaskGraphFile
    }
  } catch {
    // If we cannot read back the plan file, use empty string
    logger.warn('Could not read generated plan file for DB storage')
  }

  // AC9: JSON output format — emit CLIJsonOutput envelope, skip interactive review
  if (outputFormat === 'json') {
    const envelope: CLIJsonOutput = {
      success: true,
      command: 'plan',
      timestamp: new Date().toISOString(),
      data: {
        outputPath: resolvedOutputPath,
        planningAgent,
        estimatedExecutionCost,
        taskCount,
        status: 'draft',
        ...(taskGraph !== undefined ? { taskGraph } : {}),
        ...(codebaseContext !== undefined
          ? {
              codebase_context: {
                rootPath: codebaseContext.rootPath,
                detectedLanguages: codebaseContext.detectedLanguages,
                techStack: codebaseContext.techStack.map((s) => s.name),
                fileCount: codebaseContext.keyFiles.length,
                topLevelDirs: codebaseContext.topLevelDirs,
              },
            }
          : {}),
      },
    }
    process.stdout.write(JSON.stringify(envelope) + '\n')
    return PLAN_EXIT_SUCCESS
  }

  // Human format: print success message
  process.stdout.write(`Plan written to: ${resolvedOutputPath} (${String(taskCount)} tasks)\n`)

  // AC8: Validate the plan before showing the approval prompt
  if (taskGraph !== undefined) {
    const validationResult = validatePlan(taskGraph, registry, { normalize: false })

    // Print any auto-fixes (normalization already ran inside PlanGenerator)
    for (const fix of validationResult.autoFixed) {
      process.stdout.write(`${fix}\n`)
    }

    if (validationResult.errors.length > 0) {
      // Validation errors block the approval prompt
      for (const err of validationResult.errors) {
        process.stderr.write(formatValidationError(err) + '\n')
      }
      process.stderr.write('Plan has validation errors and cannot be approved.\n')
      return PLAN_EXIT_USAGE_ERROR
    }

    // Print any warnings before the approval prompt
    for (const warn of validationResult.warnings) {
      process.stderr.write(formatValidationWarning(warn) + '\n')
    }
  }

  // AC1: Display the generated plan before asking for approval
  const displayText = formatPlanForDisplay({
    ...result,
    taskGraph,
    planningAgent,
    estimatedExecutionCost,
    taskCount,
  })
  process.stdout.write(displayText + '\n')

  // Get approval decision
  let decision: 'approve' | 'reject'
  if (autoApprove) {
    process.stdout.write('Plan auto-approved (--auto-approve flag)\n')
    decision = 'approve'
  } else {
    decision = await promptApproval()
  }

  const planId = randomUUID()

  if (decision === 'approve') {
    await savePlan({
      planId,
      goal,
      planningAgent,
      estimatedExecutionCost,
      taskCount,
      planYaml,
      projectRoot,
      status: 'approved',
    })

    process.stdout.write(`Plan approved. Saved to .substrate/plans/${planId}.yaml\n`)
    process.stdout.write(`To execute: substrate start --graph .substrate/plans/${planId}.yaml\n`)
    emitEvent('plan:approved', { taskCount })
  } else {
    await savePlan({
      planId,
      goal,
      planningAgent,
      estimatedExecutionCost,
      taskCount,
      planYaml,
      projectRoot,
      status: 'rejected',
    })

    process.stdout.write('Plan rejected — no session created.\n')
    emitEvent('plan:rejected', { reason: 'user_rejected' })
  }

  return PLAN_EXIT_SUCCESS
}

// ---------------------------------------------------------------------------
// runPlanListAction — list previously generated plans
// ---------------------------------------------------------------------------

/**
 * List all plans from the database.
 */
export async function runPlanListAction(options: PlanListOptions): Promise<number> {
  const { outputFormat, projectRoot } = options
  const dbPath = join(projectRoot, '.substrate', 'state.db')
  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
    runMigrations(dbWrapper.db)
    const plans: Plan[] = listPlans(dbWrapper.db)

    if (outputFormat === 'json') {
      const envelope: CLIJsonOutput<Plan[]> = {
        success: true,
        command: 'plan list',
        timestamp: new Date().toISOString(),
        data: plans,
      }
      process.stdout.write(JSON.stringify(envelope) + '\n')
    } else {
      process.stdout.write(formatPlanList(plans) + '\n')
    }

    return PLAN_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    return PLAN_EXIT_ERROR
  } finally {
    dbWrapper.close()
  }
}

// ---------------------------------------------------------------------------
// runPlanShowAction — show a specific plan
// ---------------------------------------------------------------------------

/**
 * Display a specific plan by ID (supports prefix matching).
 */
export async function runPlanShowAction(
  planId: string,
  options: PlanShowOptions,
): Promise<number> {
  const { outputFormat, projectRoot } = options
  const dbPath = join(projectRoot, '.substrate', 'state.db')
  const dbWrapper = new DatabaseWrapper(dbPath)

  try {
    dbWrapper.open()
    runMigrations(dbWrapper.db)
    const plan = getPlanByPrefix(dbWrapper.db, planId)

    if (plan === undefined) {
      process.stderr.write(`Error: No plan found matching ID prefix: ${planId}\n`)
      return PLAN_EXIT_USAGE_ERROR
    }

    if (outputFormat === 'json') {
      const envelope: CLIJsonOutput<Plan> = {
        success: true,
        command: 'plan show',
        timestamp: new Date().toISOString(),
        data: plan,
      }
      process.stdout.write(JSON.stringify(envelope) + '\n')
    } else {
      process.stdout.write(formatPlanDetail(plan) + '\n')
    }

    return PLAN_EXIT_SUCCESS
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    return PLAN_EXIT_ERROR
  } finally {
    dbWrapper.close()
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build AgentSummary[] from registered adapters by calling healthCheck.
 */
async function buildAgentSummaries(
  adapters: import('../../adapters/worker-adapter.js').WorkerAdapter[],
): Promise<AgentSummary[]> {
  const summaries: AgentSummary[] = []

  for (const adapter of adapters) {
    const capabilities = adapter.getCapabilities()
    let healthy = false
    try {
      const healthResult = await adapter.healthCheck()
      healthy = healthResult.healthy
    } catch {
      healthy = false
    }

    // Determine billing mode from capabilities
    let billingMode = 'api'
    if (capabilities.supportsSubscriptionBilling) {
      billingMode = 'subscription'
    }

    summaries.push({
      agentId: adapter.id,
      supportedTaskTypes: capabilities.supportedTaskTypes,
      billingMode,
      healthy,
    })
  }

  return summaries
}

// ---------------------------------------------------------------------------
// formatValidationErrors — shared human-readable error formatting
// ---------------------------------------------------------------------------

/**
 * Format a single PlanValidationError for human-readable output.
 */
export function formatValidationError(err: PlanValidationError): string {
  const field = err.field !== undefined ? `${err.field}: ` : ''
  let line = `Error [${err.code}] ${field}${err.message}`
  if (err.suggestion !== undefined) {
    line += `\n  Fix: ${err.suggestion}`
  }
  return line
}

/**
 * Format a single PlanValidationWarning for human-readable output.
 */
export function formatValidationWarning(warn: PlanValidationWarning): string {
  const field = warn.field !== undefined ? `${warn.field}: ` : ''
  let line = `Warning [${warn.code}] ${field}${warn.message}`
  if (warn.suggestion !== undefined) {
    line += `\n  Fix: ${warn.suggestion}`
  }
  return line
}

// ---------------------------------------------------------------------------
// PlanValidateActionOptions
// ---------------------------------------------------------------------------

export interface PlanValidateActionOptions {
  filePath: string
  outputFormat: 'human' | 'json'
  projectRoot?: string
}

// ---------------------------------------------------------------------------
// runPlanValidateAction — testable core logic for plan validate
// ---------------------------------------------------------------------------

/**
 * Core action for `plan validate <file>`.
 *
 * Returns exit code:
 *   0 — validation passed (or warnings only)
 *   2 — validation failed or file not found / parse error
 */
export async function runPlanValidateAction(
  options: PlanValidateActionOptions,
): Promise<number> {
  const { filePath, outputFormat } = options

  // Check file existence
  if (!existsSync(filePath)) {
    process.stderr.write(`Error: Plan file not found: ${filePath}\n`)
    return PLAN_EXIT_USAGE_ERROR
  }

  // Parse file
  let raw: unknown
  try {
    raw = parseGraphFile(filePath)
  } catch (err) {
    if (err instanceof ParseError) {
      process.stderr.write(
        `Error: Failed to parse plan file: ${filePath}\n${err.message}\n`,
      )
      return PLAN_EXIT_USAGE_ERROR
    }
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error: ${message}\n`)
    return PLAN_EXIT_USAGE_ERROR
  }

  // Set up adapter registry
  const registry = new AdapterRegistry()
  try {
    await registry.discoverAndRegister()
  } catch {
    // If adapter discovery fails, continue without agent validation
  }

  // Run validation
  const result = validatePlan(raw, registry, { normalize: true })

  if (outputFormat === 'json') {
    const jsonOut = {
      valid: result.valid,
      errors: result.errors,
      warnings: result.warnings,
      autoFixed: result.autoFixed,
    }
    process.stdout.write(JSON.stringify(jsonOut) + '\n')
    return result.valid ? PLAN_EXIT_SUCCESS : PLAN_EXIT_USAGE_ERROR
  }

  // Human format
  if (result.valid) {
    const taskCount = result.graph !== undefined ? Object.keys(result.graph.tasks).length : 0
    process.stdout.write(`Plan is valid: ${String(taskCount)} tasks, no errors\n`)
    for (const warn of result.warnings) {
      process.stderr.write(formatValidationWarning(warn) + '\n')
    }
    return PLAN_EXIT_SUCCESS
  }

  // Invalid — print errors
  for (const err of result.errors) {
    process.stderr.write(formatValidationError(err) + '\n')
  }
  if (result.warnings.length > 0) {
    process.stderr.write(`(${String(result.warnings.length)} warning(s) also found)\n`)
  }
  return PLAN_EXIT_USAGE_ERROR
}

// ---------------------------------------------------------------------------
// registerPlanValidateSubcommand
// ---------------------------------------------------------------------------

/**
 * Register the `plan validate <file>` subcommand under the given plan command.
 */
export function registerPlanValidateSubcommand(planCommand: import('commander').Command): void {
  planCommand
    .command('validate <file>')
    .description('Validate a plan YAML/JSON file against the task graph schema')
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .action(async (file: string, opts: { outputFormat: string }) => {
      const outputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
      const exitCode = await runPlanValidateAction({ filePath: file, outputFormat })
      process.exitCode = exitCode
    })
}

// ---------------------------------------------------------------------------
// registerPlanCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate plan` command with the CLI program.
 *
 * @param program     - Commander program instance
 * @param version     - Current Substrate package version
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerPlanCommand(
  program: Command,
  version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  void version // reserved for future use

  const planCmd = program
    .command('plan')
    .description('Generate a structured task plan from a natural language goal')
    .argument('[goal]', 'Natural language goal for plan generation')
    .option('--output <path>', 'Output file path (JSON or YAML by extension)', 'adt-plan.json')
    .option('--model <model>', 'Model identifier to use for plan generation')
    .option('--adapter <id>', 'Adapter ID to use for plan generation')
    .option('--dry-run', 'Print the planning prompt without invoking the adapter', false)
    .option(
      '--output-format <format>',
      'Output format: human (default) or json (NDJSON)',
      'human',
    )
    .option('--codebase <path>', 'Path to codebase directory for context-aware planning')
    .option(
      '--context-depth <n>',
      'Directory traversal depth for codebase scanning (default 2)',
      '2',
    )
    .option('--agent-count <n>', 'Hint for number of parallel agents')
    .option('--auto-approve', 'Skip interactive review and automatically approve the plan', false)
    .action(
      async (
        goal: string | undefined,
        opts: {
          output: string
          model?: string
          adapter?: string
          dryRun: boolean
          outputFormat: string
          codebase?: string
          contextDepth: string
          agentCount?: string
          autoApprove: boolean
        },
      ) => {
        if (!goal) {
          planCmd.help()
          return
        }

        const outputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
        const contextDepth = parseInt(opts.contextDepth, 10)
        const agentCount =
          opts.agentCount !== undefined ? parseInt(opts.agentCount, 10) : undefined

        const exitCode = await runPlanReviewAction({
          goal,
          outputPath: opts.output,
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.adapter !== undefined ? { adapterId: opts.adapter } : {}),
          dryRun: opts.dryRun,
          outputFormat,
          projectRoot,
          ...(opts.codebase !== undefined ? { codebasePath: opts.codebase } : {}),
          contextDepth: isNaN(contextDepth) ? 2 : contextDepth,
          ...(agentCount !== undefined && !isNaN(agentCount) ? { agentCount } : {}),
          autoApprove: opts.autoApprove,
        })

        process.exitCode = exitCode
      },
    )

  // ---------------------------------------------------------------------------
  // plan list subcommand
  // ---------------------------------------------------------------------------
  planCmd
    .command('list')
    .description('List previously generated plans')
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(async (opts: { outputFormat: string }) => {
      const outputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
      const exitCode = await runPlanListAction({ outputFormat, projectRoot })
      process.exitCode = exitCode
    })

  // ---------------------------------------------------------------------------
  // plan show subcommand
  // ---------------------------------------------------------------------------
  planCmd
    .command('show <planId>')
    .description('Show details of a specific plan by ID (supports prefix matching)')
    .option(
      '--output-format <format>',
      'Output format: human (default) or json',
      'human',
    )
    .action(async (planId: string, opts: { outputFormat: string }) => {
      const outputFormat = opts.outputFormat === 'json' ? 'json' : 'human'
      const exitCode = await runPlanShowAction(planId, { outputFormat, projectRoot })
      process.exitCode = exitCode
    })

  // ---------------------------------------------------------------------------
  // plan refine / diff / rollback / validate subcommands
  // ---------------------------------------------------------------------------
  registerPlanRefineCommand(planCmd, version, projectRoot)
  registerPlanDiffCommand(planCmd, version, projectRoot)
  registerPlanRollbackCommand(planCmd, version, projectRoot)
  registerPlanValidateSubcommand(planCmd)
}
