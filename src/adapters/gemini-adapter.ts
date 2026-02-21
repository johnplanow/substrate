/**
 * Gemini CLI adapter
 *
 * Implements WorkerAdapter for the Google Gemini CLI agent.
 * Binary: `gemini`
 * Output format: JSON via `--output-format json`
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
import type { AgentId, BillingMode } from '../core/types.js'
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

/** Default model used when none is specified */
const DEFAULT_MODEL = 'gemini-2.0-flash'

/** Approximate characters per token for estimation */
const CHARS_PER_TOKEN = 3

/** Estimated output token multiplier relative to input */
const OUTPUT_RATIO = 0.5

/**
 * Strip markdown code fences from LLM output.
 * LLMs often wrap JSON in ```json ... ``` despite being told not to.
 */
function stripCodeFences(raw: string): string {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  return stripped.trim()
}

interface GeminiJsonOutput {
  status?: string
  output?: string
  response?: string
  error?: string | null
  metadata?: {
    executionTime?: number
    tokensUsed?: { input?: number; output?: number }
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }
}

interface GeminiPlanTask {
  title?: string
  description?: string
  complexity?: number
  dependencies?: string[]
}

interface GeminiPlanOutput {
  tasks?: GeminiPlanTask[]
  error?: string | null
}

/**
 * Adapter for the Google Gemini CLI agent.
 *
 * Gemini CLI follows similar patterns to Claude Code: prompt via `-p` flag,
 * JSON output via `--output-format json`, and model via `--model`.
 */
export class GeminiCLIAdapter implements WorkerAdapter {
  readonly id: AgentId = 'gemini'
  readonly displayName = 'Gemini CLI'
  readonly adapterVersion = '1.0.0'

  /**
   * Verify the `gemini` binary is installed and responsive.
   * Detects subscription vs API billing mode.
   */
  async healthCheck(): Promise<AdapterHealthResult> {
    try {
      const { stdout } = await execAsync('gemini --version', { timeout: 10_000 })
      const output = stdout.trim()

      const detectedBillingModes = this._detectBillingModes(output)

      let cliPath: string | undefined
      try {
        const whichResult = await execAsync('which gemini', { timeout: 5_000 })
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
        error: `Gemini CLI not available: ${message}`,
        supportsHeadless: false,
      }
    }
  }

  /**
   * Build spawn command for a coding task.
   * Uses: `gemini -p <prompt> --output-format json --model <model>`
   */
  buildCommand(prompt: string, options: AdapterOptions): SpawnCommand {
    const model = options.model ?? DEFAULT_MODEL
    const args = ['-p', prompt, '--output-format', 'json', '--model', model]

    if (options.additionalFlags && options.additionalFlags.length > 0) {
      args.push(...options.additionalFlags)
    }

    const envEntries: Record<string, string> = {}
    if (options.billingMode === 'api' && options.apiKey) {
      envEntries.GEMINI_API_KEY = options.apiKey
    }

    const hasEnv = Object.keys(envEntries).length > 0

    return {
      binary: 'gemini',
      args,
      ...(hasEnv ? { env: envEntries } : {}),
      cwd: options.worktreePath,
    }
  }

  /**
   * Build spawn command for plan generation.
   */
  buildPlanningCommand(request: PlanRequest, options: AdapterOptions): SpawnCommand {
    const model = options.model ?? DEFAULT_MODEL
    const planningPrompt = this._buildPlanningPrompt(request)
    // Use positional prompt arg without --output-format json:
    // `gemini <prompt> --model <model>` outputs plain text to stdout.
    // `--output-format json` wraps the response in a {session_id,response,stats}
    // envelope which breaks JSON parsing of the plan output.
    const args = [
      planningPrompt,
      '--model',
      model,
    ]

    if (options.additionalFlags && options.additionalFlags.length > 0) {
      args.push(...options.additionalFlags)
    }

    const envEntries: Record<string, string> = {}
    if (options.billingMode === 'api' && options.apiKey) {
      envEntries.GEMINI_API_KEY = options.apiKey
    }

    const hasEnv = Object.keys(envEntries).length > 0

    return {
      binary: 'gemini',
      args,
      ...(hasEnv ? { env: envEntries } : {}),
      cwd: options.worktreePath,
    }
  }

  /**
   * Parse Gemini CLI JSON output into a TaskResult.
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
      const parsed = JSON.parse(stdout.trim()) as GeminiJsonOutput
      const success =
        parsed.status === 'completed' || parsed.status === undefined

      // Support both Substrate-standard token field and Gemini's native usageMetadata
      const usageMeta = parsed.metadata?.usageMetadata
      const inputTokens =
        parsed.metadata?.tokensUsed?.input ?? usageMeta?.promptTokenCount ?? 0
      const outputTokens =
        parsed.metadata?.tokensUsed?.output ??
        usageMeta?.candidatesTokenCount ??
        0

      const hasTokens = inputTokens > 0 || outputTokens > 0
      const tokensUsed = hasTokens
        ? {
            input: inputTokens,
            output: outputTokens,
            total: inputTokens + outputTokens,
          }
        : undefined

      const executionTime = parsed.metadata?.executionTime

      return {
        success: success && !parsed.error,
        output: parsed.output ?? parsed.response ?? stdout,
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
   * Parse Gemini plan generation output.
   */
  parsePlanOutput(
    stdout: string,
    stderr: string,
    exitCode: number
  ): PlanParseResult {
    if (exitCode !== 0) {
      return {
        success: false,
        tasks: [],
        error: stderr || `Process exited with code ${String(exitCode)}`,
        rawOutput: stdout,
      }
    }

    // Guard against empty stdout
    if (stdout.trim() === '') {
      return {
        success: false,
        tasks: [],
        error: 'Empty output from plan generation',
        rawOutput: stdout,
      }
    }

    try {
      const parsed = JSON.parse(stripCodeFences(stdout)) as GeminiPlanOutput
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
        error: 'Failed to parse Gemini plan output as JSON',
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
   * Return Gemini CLI capabilities.
   */
  getCapabilities(): AdapterCapabilities {
    return {
      supportsJsonOutput: true,
      supportsStreaming: true,
      supportsSubscriptionBilling: true,
      supportsApiBilling: true,
      supportsPlanGeneration: true,
      maxContextTokens: 1_000_000,
      supportedTaskTypes: [
        'code',
        'refactor',
        'test',
        'review',
        'debug',
        'document',
        'analyze',
      ],
      supportedLanguages: ['*'],
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

    if (process.env.GEMINI_API_KEY) {
      modes.push('api')
    }

    if (versionOutput.toLowerCase().includes('subscription')) {
      modes.push('subscription')
    }

    // Gemini supports both modes by default
    if (modes.length === 0) {
      return ['subscription', 'api']
    }

    return modes
  }

  private _buildPlanningPrompt(request: PlanRequest): string {
    const maxTasks = request.maxTasks ?? 10
    const contextSection = request.context
      ? `\n\nAdditional context:\n${request.context}`
      : ''

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
