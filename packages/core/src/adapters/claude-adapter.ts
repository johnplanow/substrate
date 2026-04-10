/**
 * Claude Code adapter
 *
 * Implements WorkerAdapter for the Claude Code CLI agent.
 * Binary: `claude`
 * Output format: JSON via `--output-format json`
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentId, BillingMode } from '../types.js'
import type { WorkerAdapter } from './worker-adapter.js'
import type {
  SpawnCommand,
  AdapterOptions,
  AdapterCapabilities,
  AdapterHealthResult,
  TaskResult,
  TokenEstimate,
  PlanRequest,
  PlanParseResult,
  PlannedTask,
} from './types.js'
import type { ILogger } from '../dispatch/types.js'

const execAsync = promisify(exec)

/** Default model used when none is specified */
const DEFAULT_MODEL = 'claude-sonnet-4-6'

/** Approximate characters per token for estimation */
const CHARS_PER_TOKEN = 3

/** Estimated output token multiplier relative to input */
const OUTPUT_RATIO = 0.5

/**
 * Base system prompt for all Claude Code invocations.
 * Replaces CLAUDE.md and auto-memory context so the subprocess does not
 * re-read the orchestrator's own CLAUDE.md instructions.
 */
const BASE_SYSTEM_PROMPT =
  `You are an autonomous coding agent implementing software requirements. ` +
  `Follow the task description precisely, write clean and maintainable code, ` +
  `and ensure all tests pass. Work methodically through each task in order.`

/** Strip markdown code fences from LLM output (e.g. ```json ... ```) */
function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

interface ClaudeJsonOutput {
  status?: string
  output?: string
  error?: string | null
  metadata?: {
    executionTime?: number
    tokensUsed?: { input?: number; output?: number }
  }
}

interface ClaudePlanTask {
  title?: string
  description?: string
  complexity?: number
  dependencies?: string[]
}

interface ClaudePlanOutput {
  tasks?: ClaudePlanTask[]
  error?: string | null
}

/**
 * Adapter for the Claude Code CLI agent.
 *
 * Capabilities: JSON output, streaming, both billing modes, plan generation.
 * Health check: runs `claude --version` to verify install.
 * Billing detection: detects subscription vs API via version output or env.
 */
export class ClaudeCodeAdapter implements WorkerAdapter {
  readonly id: AgentId = 'claude-code'
  readonly displayName = 'Claude Code'
  readonly adapterVersion = '1.0.0'

  private readonly _logger: ILogger

  constructor(logger?: ILogger) {
    // Default to console if no logger is injected
    this._logger = logger ?? console
  }

  /**
   * Verify the `claude` binary is installed and responsive.
   * Detects subscription vs API billing mode.
   */
  async healthCheck(): Promise<AdapterHealthResult> {
    try {
      const { stdout } = await execAsync('claude --version', { timeout: 10_000 })
      const output = stdout.trim()

      const detectedBillingModes = this._detectBillingModes(output)

      let cliPath: string | undefined
      try {
        const whichResult = await execAsync('which claude', { timeout: 5_000 })
        cliPath = whichResult.stdout.trim()
      } catch {
        // which is available on macOS and Linux (target platforms)
      }

      return {
        healthy: true,
        version: output,
        ...(cliPath !== undefined ? { cliPath } : {}),
        detectedBillingModes,
        supportsHeadless: true,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        healthy: false,
        error: `Claude CLI not available: ${message}`,
        supportsHeadless: false,
      }
    }
  }

  /**
   * Build spawn command for a coding task.
   * Uses: `claude -p --model <model> --dangerously-skip-permissions --system-prompt <minimal>`
   * Prompt is delivered via stdin (not CLI arg) to avoid E2BIG on large prompts.
   */
  buildCommand(prompt: string, options: AdapterOptions): SpawnCommand {
    const model = options.model ?? DEFAULT_MODEL
    // Do NOT use --output-format json: it wraps Claude's response in a JSON event
    // envelope (type/result/usage), which prevents extractYamlBlock from finding
    // the YAML result block in the raw stdout. Raw text output is required.
    //
    // --dangerously-skip-permissions: required for headless automated pipeline use.
    // Without this, Claude in -p mode refuses to write files, asking for permission.
    //
    // --system-prompt: replaces CLAUDE.md and auto-memory context so the subprocess
    // does not re-read the orchestrator's own CLAUDE.md instructions.
    const args = ['-p', '--model', model, '--dangerously-skip-permissions']

    if (options.maxTurns !== undefined) {
      args.push('--max-turns', String(options.maxTurns))
    }

    if (options.maxContextTokens !== undefined) {
      args.push('--max-context-tokens', String(options.maxContextTokens))
    }

    if (options.additionalFlags && options.additionalFlags.length > 0) {
      args.push(...options.additionalFlags)
    }

    // Build system prompt: base prompt + optional optimization directives
    const systemPromptParts: string[] = [BASE_SYSTEM_PROMPT]
    if (options.optimizationDirectives) {
      systemPromptParts.push(`\n\n## Optimization Directives\n${options.optimizationDirectives}`)
    }
    args.push('--system-prompt', systemPromptParts.join(''))

    // Build environment entries
    const envEntries: Record<string, string> = {}

    if (options.billingMode === 'api' && options.apiKey) {
      envEntries.ANTHROPIC_API_KEY = options.apiKey
    }

    if (options.otlpEndpoint) {
      envEntries.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
      envEntries.OTEL_LOGS_EXPORTER = 'otlp'
      envEntries.OTEL_METRICS_EXPORTER = 'otlp'
      envEntries.OTEL_LOG_TOOL_DETAILS = '1'
      envEntries.OTEL_METRIC_EXPORT_INTERVAL = '10000'
      envEntries.OTEL_EXPORTER_OTLP_TIMEOUT = '5000'
      envEntries.OTEL_EXPORTER_OTLP_ENDPOINT = options.otlpEndpoint
      envEntries.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json'
    }

    if (options.storyKey) {
      const existing = envEntries.OTEL_RESOURCE_ATTRIBUTES ?? ''
      const separator = existing.length > 0 ? ',' : ''
      envEntries.OTEL_RESOURCE_ATTRIBUTES = `${existing}${separator}substrate.story_key=${options.storyKey}`
    }

    if (options.taskType) {
      const existing = envEntries.OTEL_RESOURCE_ATTRIBUTES ?? ''
      const separator = existing.length > 0 ? ',' : ''
      envEntries.OTEL_RESOURCE_ATTRIBUTES = `${existing}${separator}substrate.task_type=${options.taskType}`
    }

    if (options.dispatchId) {
      const existing = envEntries.OTEL_RESOURCE_ATTRIBUTES ?? ''
      const separator = existing.length > 0 ? ',' : ''
      envEntries.OTEL_RESOURCE_ATTRIBUTES = `${existing}${separator}substrate.dispatch_id=${options.dispatchId}`
    }

    // Build unsetEnvKeys: always unset CLAUDECODE; also unset ANTHROPIC_API_KEY
    // when not in API billing mode to prevent accidental credential leaks.
    const unsetEnvKeys: string[] = ['CLAUDECODE']
    if (options.billingMode !== 'api') {
      unsetEnvKeys.push('ANTHROPIC_API_KEY')
    }

    return {
      binary: 'claude',
      args,
      env: envEntries,
      unsetEnvKeys,
      cwd: options.worktreePath,
      stdin: prompt,
    }
  }

  /**
   * Build spawn command for plan generation.
   */
  buildPlanningCommand(request: PlanRequest, options: AdapterOptions): SpawnCommand {
    const model = options.model ?? DEFAULT_MODEL
    const planningPrompt = this._buildPlanningPrompt(request)

    // Prompt delivered via stdin (not CLI args) to avoid E2BIG on large prompts.
    const args = ['-p', '--model', model, '--dangerously-skip-permissions']

    if (options.additionalFlags && options.additionalFlags.length > 0) {
      args.push(...options.additionalFlags)
    }

    const envEntries: Record<string, string> = {}
    if (options.billingMode === 'api' && options.apiKey) {
      envEntries.ANTHROPIC_API_KEY = options.apiKey
    }

    return {
      binary: 'claude',
      args,
      env: envEntries,
      cwd: options.worktreePath,
      stdin: planningPrompt,
    }
  }

  /**
   * Parse Claude Code JSON output into a TaskResult.
   */
  parseOutput(stdout: string, stderr: string, exitCode: number): TaskResult {
    if (exitCode !== 0) {
      return {
        success: false,
        output: stdout,
        error: stderr || `Process exited with code ${String(exitCode)}`,
        exitCode,
      }
    }

    // Guard against empty stdout — treat as non-JSON fallback
    if (stdout.trim() === '') {
      return {
        success: true,
        output: '',
        exitCode,
      }
    }

    try {
      const parsed = JSON.parse(stdout.trim()) as ClaudeJsonOutput
      const success =
        parsed.status === 'completed' ||
        parsed.status === 'success' ||
        (parsed.status === undefined && !parsed.error)

      const inputTokens = parsed.metadata?.tokensUsed?.input ?? 0
      const outputTokens = parsed.metadata?.tokensUsed?.output ?? 0

      const hasTokens = inputTokens > 0 || outputTokens > 0
      const tokensUsed = hasTokens
        ? { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens }
        : undefined

      const executionTime = parsed.metadata?.executionTime

      return {
        success: success && !parsed.error,
        output: parsed.output ?? stdout,
        ...(parsed.error ? { error: parsed.error } : {}),
        exitCode,
        metadata: {
          ...(executionTime !== undefined ? { executionTime } : {}),
          ...(tokensUsed !== undefined ? { tokensUsed } : {}),
        },
      }
    } catch {
      return {
        success: true,
        output: stdout,
        exitCode,
      }
    }
  }

  /**
   * Parse Claude plan generation output.
   */
  parsePlanOutput(stdout: string, stderr: string, exitCode: number): PlanParseResult {
    if (exitCode !== 0) {
      return {
        success: false,
        tasks: [],
        error: stderr || `Process exited with code ${String(exitCode)}`,
        rawOutput: stdout,
      }
    }

    if (stdout.trim() === '') {
      return {
        success: false,
        tasks: [],
        error: 'Empty output from plan generation',
        rawOutput: stdout,
      }
    }

    try {
      const parsed = JSON.parse(stripCodeFences(stdout)) as ClaudePlanOutput

      if (!Array.isArray(parsed.tasks)) {
        return {
          success: false,
          tasks: [],
          error: 'Plan output missing tasks array',
          rawOutput: stdout,
        }
      }

      const tasks: PlannedTask[] = parsed.tasks.map((t) => ({
        title: t.title ?? 'Untitled task',
        description: t.description ?? '',
        ...(t.complexity !== undefined ? { complexity: t.complexity } : {}),
        ...(t.dependencies !== undefined ? { dependencies: t.dependencies } : {}),
      }))

      return {
        success: true,
        tasks,
        rawOutput: stdout,
      }
    } catch {
      return {
        success: false,
        tasks: [],
        error: 'Failed to parse Claude plan output as JSON',
        rawOutput: stdout,
      }
    }
  }

  /**
   * Estimate token count using character-based heuristic.
   */
  estimateTokens(prompt: string): TokenEstimate {
    const input = Math.ceil(prompt.length / CHARS_PER_TOKEN)
    const output = Math.ceil(input * OUTPUT_RATIO)
    return {
      input,
      output,
      total: input + output,
    }
  }

  /**
   * Return Claude Code capabilities.
   */
  getCapabilities(): AdapterCapabilities {
    return {
      supportsJsonOutput: true,
      supportsStreaming: true,
      supportsSubscriptionBilling: true,
      supportsApiBilling: true,
      supportsPlanGeneration: true,
      maxContextTokens: 200_000,
      supportedTaskTypes: ['code', 'refactor', 'test', 'review', 'debug', 'document', 'analyze'],
      supportedLanguages: ['*'],
      supportsSystemPrompt: true,
      supportsOtlpExport: true,
      requiresYamlSuffix: false,
      defaultMaxReviewCycles: 2,
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _detectBillingModes(versionOutput: string): BillingMode[] {
    // 1. If ADT_BILLING_MODE is explicitly set, respect it
    const explicit = process.env.ADT_BILLING_MODE
    if (explicit === 'subscription' || explicit === 'api' || explicit === 'free') {
      return [explicit]
    }

    // 2. Detect available billing modes
    const modes: BillingMode[] = []

    if (process.env.ANTHROPIC_API_KEY) {
      modes.push('api')
    }

    if (versionOutput.toLowerCase().includes('subscription')) {
      modes.push('subscription')
    }

    // Claude supports both modes by default
    if (modes.length === 0) {
      return ['subscription', 'api']
    }

    return modes
  }

  private _buildPlanningPrompt(request: PlanRequest): string {
    const maxTasks = request.maxTasks ?? 10
    const contextSection = request.context ? `\n\nAdditional context:\n${request.context}` : ''

    return (
      `Generate a detailed task plan for the following goal:\n${request.goal}${contextSection}\n\n` +
      `Output a JSON object with a "tasks" array. Each task should have: ` +
      `"title" (string), "description" (string), "complexity" (1-10 integer), ` +
      `"dependencies" (array of task titles this depends on). ` +
      `Produce at most ${String(maxTasks)} tasks. ` +
      `Output ONLY raw valid JSON — no markdown, no code fences, no explanation. ` +
      `Start your response with { and end with }.`
    )
  }
}
