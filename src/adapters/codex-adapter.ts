/**
 * Codex CLI adapter
 *
 * Implements WorkerAdapter for the OpenAI Codex CLI agent.
 * Binary: `codex`
 * Execution: `codex exec --json` with task prompt on stdin
 * Billing: API-only (OpenAI API key required)
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

/** Approximate characters per token for estimation */
const CHARS_PER_TOKEN = 3

/** Estimated output token multiplier relative to input */
const OUTPUT_RATIO = 0.5

/** Codex billing mode is API-only */
const CODEX_BILLING_MODE: BillingMode = 'api'

interface CodexJsonOutput {
  status?: 'success' | 'error' | 'completed' | 'failed'
  output?: string
  result?: string
  error?: string | null
  executionTime?: number
  tokens?: { input?: number; output?: number; total?: number }
}

interface CodexPlanTask {
  title?: string
  description?: string
  complexity?: number
  deps?: string[]
  dependencies?: string[]
}

interface CodexPlanOutput {
  plan?: CodexPlanTask[]
  tasks?: CodexPlanTask[]
  error?: string | null
}

/**
 * Adapter for the OpenAI Codex CLI agent.
 *
 * Codex CLI uses stdin for the prompt and outputs JSON when --json flag is used.
 * Codex is API-only — no subscription mode is supported.
 */
export class CodexCLIAdapter implements WorkerAdapter {
  readonly id: AgentId = 'codex'
  readonly displayName = 'Codex CLI'
  readonly adapterVersion = '1.0.0'

  /**
   * Verify the `codex` binary is installed and responsive.
   */
  async healthCheck(): Promise<AdapterHealthResult> {
    try {
      const { stdout } = await execAsync('codex --version', { timeout: 10_000 })
      const output = stdout.trim()

      let cliPath: string | undefined
      try {
        const whichResult = await execAsync('which codex', { timeout: 5_000 })
        cliPath = whichResult.stdout.trim()
      } catch {
        // which is available on macOS and Linux (target platforms)
      }

      return {
        healthy: true,
        version: output,
        ...(cliPath !== undefined ? { cliPath } : {}),
        detectedBillingModes: [CODEX_BILLING_MODE],
        supportsHeadless: true,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        healthy: false,
        error: `Codex CLI not available: ${message}`,
        supportsHeadless: false,
      }
    }
  }

  /**
   * Build spawn command for a coding task.
   * Uses: `codex exec --json` with prompt delivered via stdin.
   */
  buildCommand(prompt: string, options: AdapterOptions): SpawnCommand {
    const args = ['exec', '--json']

    if (options.additionalFlags && options.additionalFlags.length > 0) {
      args.push(...options.additionalFlags)
    }

    const envEntries: Record<string, string> = {}
    if (options.apiKey) {
      envEntries.OPENAI_API_KEY = options.apiKey
    }

    const hasEnv = Object.keys(envEntries).length > 0

    return {
      binary: 'codex',
      args,
      ...(hasEnv ? { env: envEntries } : {}),
      cwd: options.worktreePath,
      stdin: prompt,
    }
  }

  /**
   * Build spawn command for plan generation.
   * Uses codex exec with a JSON plan generation prompt via stdin.
   */
  buildPlanningCommand(request: PlanRequest, options: AdapterOptions): SpawnCommand {
    const planningPrompt = this._buildPlanningPrompt(request)
    const args = ['exec', '--json']

    if (options.additionalFlags && options.additionalFlags.length > 0) {
      args.push(...options.additionalFlags)
    }

    const envEntries: Record<string, string> = {}
    if (options.apiKey) {
      envEntries.OPENAI_API_KEY = options.apiKey
    }

    const hasEnv = Object.keys(envEntries).length > 0

    return {
      binary: 'codex',
      args,
      ...(hasEnv ? { env: envEntries } : {}),
      cwd: options.worktreePath,
      stdin: planningPrompt,
    }
  }

  /**
   * Parse Codex CLI JSON output into a TaskResult.
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
      const parsed = JSON.parse(stdout.trim()) as CodexJsonOutput
      const success =
        parsed.status === 'success' ||
        parsed.status === 'completed' ||
        (parsed.status === undefined && !parsed.error)

      const inputTokens = parsed.tokens?.input ?? 0
      const outputTokens = parsed.tokens?.output ?? 0
      const totalTokens = parsed.tokens?.total ?? inputTokens + outputTokens

      const hasTokens = inputTokens > 0 || outputTokens > 0
      const tokensUsed = hasTokens
        ? { input: inputTokens, output: outputTokens, total: totalTokens }
        : undefined

      const executionTime = parsed.executionTime

      return {
        success: success && !parsed.error,
        output: parsed.output ?? parsed.result ?? stdout,
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
   * Parse Codex plan generation output.
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
      const parsed = JSON.parse(stdout.trim()) as CodexPlanOutput

      // Require at least one of "tasks" or "plan" to be present
      if (parsed.tasks === undefined && parsed.plan === undefined) {
        return {
          success: false,
          tasks: [],
          error: 'Plan output missing tasks array',
          rawOutput: stdout,
        }
      }

      const rawTasks = parsed.tasks ?? parsed.plan ?? []

      if (!Array.isArray(rawTasks)) {
        return {
          success: false,
          tasks: [],
          error: 'Plan output missing tasks array',
          rawOutput: stdout,
        }
      }

      const tasks: PlannedTask[] = rawTasks.map((t) => {
        // Support both "dependencies" and legacy "deps" field names
        const deps = 'dependencies' in t ? t.dependencies : t.deps
        return {
          title: t.title ?? 'Untitled task',
          description: t.description ?? '',
          ...(t.complexity !== undefined ? { complexity: t.complexity } : {}),
          ...(deps !== undefined ? { dependencies: deps } : {}),
        }
      })

      return {
        success: true,
        tasks,
        rawOutput: stdout,
      }
    } catch {
      return {
        success: false,
        tasks: [],
        error: 'Failed to parse Codex plan output as JSON',
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
   * Return Codex CLI capabilities.
   */
  getCapabilities(): AdapterCapabilities {
    return {
      supportsJsonOutput: true,
      supportsStreaming: false,
      supportsSubscriptionBilling: false,
      supportsApiBilling: true,
      supportsPlanGeneration: true,
      maxContextTokens: 128_000,
      supportedTaskTypes: [
        'code',
        'refactor',
        'test',
        'debug',
        'analyze',
      ],
      supportedLanguages: ['*'],
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

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
      `Produce at most ${String(maxTasks)} tasks. Output ONLY valid JSON.`
    )
  }
}
