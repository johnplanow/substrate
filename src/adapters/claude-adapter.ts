/**
 * Claude Code adapter
 *
 * Implements WorkerAdapter for the Claude Code CLI agent.
 * Binary: `claude`
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
const DEFAULT_MODEL = 'claude-sonnet-4-6'

/** Approximate characters per token for estimation */
const CHARS_PER_TOKEN = 3

/** Estimated output token multiplier relative to input */
const OUTPUT_RATIO = 0.5

/** Strip markdown code fences from LLM output (e.g. ```json ... ```) */
function stripCodeFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
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
   * Uses: `claude -p <prompt> --model <model> --dangerously-skip-permissions --system-prompt <minimal>`
   */
  buildCommand(prompt: string, options: AdapterOptions): SpawnCommand {
    const model = options.model ?? DEFAULT_MODEL
    // Do NOT use --output-format json: it wraps Claude's response in a JSON event
    // envelope (type/result/usage), which prevents extractYamlBlock from finding
    // the YAML result block in the raw stdout. Raw text output is required.
    // See buildPlanningCommand for the same pattern with explanation.
    //
    // --dangerously-skip-permissions: required for headless automated pipeline use.
    // Without this, Claude in -p mode refuses to write files, asking for permission.
    //
    // --system-prompt: replaces CLAUDE.md and auto-memory context so the subprocess
    // does not respond to the parent session's "Next Up" / memory notes instead of
    // the actual workflow task. Without this, the child claude reads MEMORY.md and
    // answers about the wrong story.
    const systemPrompt =
      'You are an autonomous coding agent executing a single pipeline task. ' +
      'Ignore all session startup context, memory notes, and "Next Up" indicators. ' +
      'Follow the instructions in the user message exactly. ' +
      'Emit ONLY the YAML output specified in the Output Contract — no other text.'
    const args = [
      '-p', prompt,
      '--model', model,
      '--dangerously-skip-permissions',
      '--system-prompt', systemPrompt,
    ]

    if (options.maxTurns !== undefined) {
      args.push('--max-turns', String(options.maxTurns))
    }

    if (options.additionalFlags && options.additionalFlags.length > 0) {
      args.push(...options.additionalFlags)
    }

    const envEntries: Record<string, string> = {}
    // When using API billing, explicitly set the key. Otherwise, unset any
    // inherited ANTHROPIC_API_KEY so the child uses the Max subscription.
    const unsetKeys = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']
    if (options.billingMode === 'api' && options.apiKey) {
      envEntries.ANTHROPIC_API_KEY = options.apiKey
    } else {
      unsetKeys.push('ANTHROPIC_API_KEY')
    }

    return {
      binary: 'claude',
      args,
      env: envEntries,
      unsetEnvKeys: unsetKeys,
      cwd: options.worktreePath,
    }
  }

  /**
   * Build spawn command for plan generation.
   * Appends a structured planning directive to the prompt.
   */
  buildPlanningCommand(request: PlanRequest, options: AdapterOptions): SpawnCommand {
    const model = options.model ?? DEFAULT_MODEL
    const planningPrompt = this._buildPlanningPrompt(request)
    // Use -p without --output-format json:
    // `claude -p <prompt>` outputs the model's raw text to stdout.
    // `--output-format json` wraps the response in a Claude event envelope
    // (type/result/usage) which breaks JSON parsing of the plan output.
    const args = [
      '-p',
      planningPrompt,
      '--model',
      model,
    ]

    if (options.additionalFlags && options.additionalFlags.length > 0) {
      args.push(...options.additionalFlags)
    }

    const envEntries: Record<string, string> = {}
    const planUnsetKeys = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']
    if (options.billingMode === 'api' && options.apiKey) {
      envEntries.ANTHROPIC_API_KEY = options.apiKey
    } else {
      planUnsetKeys.push('ANTHROPIC_API_KEY')
    }

    return {
      binary: 'claude',
      args,
      env: envEntries,
      unsetEnvKeys: planUnsetKeys,
      cwd: options.worktreePath,
    }
  }

  /**
   * Parse Claude CLI JSON stdout output into TaskResult.
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
        parsed.status === 'completed' || parsed.status === undefined

      const rawTokens = parsed.metadata?.tokensUsed
      const tokensUsed =
        rawTokens !== undefined
          ? {
              input: rawTokens.input ?? 0,
              output: rawTokens.output ?? 0,
              total: (rawTokens.input ?? 0) + (rawTokens.output ?? 0),
            }
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
      // Non-JSON output: treat raw stdout as the result
      return {
        success: true,
        output: stdout,
        exitCode,
      }
    }
  }

  /**
   * Parse plan generation output from Claude.
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
        error: 'Failed to parse plan output as JSON',
        rawOutput: stdout,
      }
    }
  }

  /**
   * Estimate token count using character-based heuristic.
   * Approximation: 1 token ≈ 3 characters for English text.
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
   * Return Claude Code's capabilities.
   */
  getCapabilities(): AdapterCapabilities {
    return {
      supportsJsonOutput: true,
      supportsStreaming: true,
      supportsSubscriptionBilling: true,
      supportsApiBilling: true,
      supportsPlanGeneration: true,
      maxContextTokens: 200_000,
      supportedTaskTypes: [
        'code',
        'refactor',
        'test',
        'review',
        'debug',
        'document',
        'analyze',
      ],
      supportedLanguages: ['*'], // Claude supports all languages
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _detectBillingModes(_versionOutput: string): BillingMode[] {
    // 1. If ADT_BILLING_MODE is explicitly set, respect it
    const explicit = process.env.ADT_BILLING_MODE
    if (explicit === 'subscription' || explicit === 'api' || explicit === 'free') {
      return [explicit]
    }

    // 2. Claude Code is a subscription-first product — subscription is always available.
    //    API billing is additionally available when an API key is present.
    const modes: BillingMode[] = ['subscription']

    if (process.env.ANTHROPIC_API_KEY) {
      modes.push('api')
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
