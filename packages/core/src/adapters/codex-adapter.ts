/**
 * Codex CLI adapter
 *
 * Implements WorkerAdapter for the OpenAI Codex CLI agent.
 * Binary: `codex`
 * Execution: `codex exec --json` with task prompt on stdin
 * Billing: Subscription (ChatGPT Plus/Pro via `codex login`) or API key
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
import { createStderrLogger } from '../utils/stderr-logger.js'

const execAsync = promisify(exec)

/** Approximate characters per token for estimation */
const CHARS_PER_TOKEN = 3

/** Estimated output token multiplier relative to input */
const OUTPUT_RATIO = 0.5

/** Strip markdown code fences from LLM output (e.g. ```json ... ```) */
function stripCodeFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
}

/** Codex default billing modes — subscription via `codex login`, or API key */
const CODEX_BILLING_MODES: BillingMode[] = ['subscription', 'api']

/**
 * Signatures emitted by `codex exec` when its sandbox/approval policy prevents
 * a file write or command in non-interactive mode. The first two are the
 * "exec can't service an approval" failures; the third is what an org policy
 * prints when it overrides the requested approval/sandbox configuration.
 */
const CODEX_SANDBOX_BLOCK_SIGNATURES = [
  'approval is not supported in exec mode',
  'command execution approval is not supported',
  'file change approval is not supported',
  'disallowed by requirements',
]

/** Human-readable explanation appended to escalations caused by a Codex write-block. */
export const CODEX_SANDBOX_BLOCK_HINT =
  'Likely cause: Codex could not write files. Substrate runs `codex exec --full-auto` ' +
  '(Codex\'s documented alias for `-a on-request --sandbox workspace-write` — the standard ' +
  'low-friction non-interactive automation mode, NOT the org-blocked ' +
  '`--dangerously-bypass-approvals-and-sandbox`). If the run log shows ' +
  '"approval is not supported in exec mode" or "patch rejected by user", the most likely ' +
  'cause is a known Codex defect: `UnlessTrusted` policy unconditionally asks for approval ' +
  'on `apply_patch` (see codex-rs/core/src/safety.rs TODO(ragona)), and `OnRequest` may also ' +
  'fail in environments where `get_platform_sandbox()` returns None (e.g. WSL — see Codex issue ' +
  '#18365). Workarounds: dispatch with a provider that can write here (e.g. `--agent claude-code`), ' +
  'or get the Codex CLI bug fixed upstream.'

/**
 * Returns the Codex-write-block hint if `output` contains a sandbox/approval
 * block signature, else null. Pure + exported for diagnostics and testing.
 */
export function detectCodexSandboxBlock(output: string | undefined | null): string | null {
  if (output === undefined || output === null || output === '') return null
  const lower = output.toLowerCase()
  return CODEX_SANDBOX_BLOCK_SIGNATURES.some((sig) => lower.includes(sig))
    ? CODEX_SANDBOX_BLOCK_HINT
    : null
}

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
 * Codex supports subscription billing (via `codex login`) and API key billing.
 */
export class CodexCLIAdapter implements WorkerAdapter {
  readonly id: AgentId = 'codex'
  readonly displayName = 'Codex CLI'
  readonly adapterVersion = '1.0.0'

  private readonly _logger: ILogger

  constructor(logger?: ILogger) {
    // Default to console if no logger is injected
    this._logger = logger ?? createStderrLogger('codex-adapter')
  }

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
        detectedBillingModes: CODEX_BILLING_MODES,
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
   * Uses: `codex exec` with prompt delivered via stdin.
   *
   * `--full-auto` is Codex's documented `exec` convenience alias for
   * `-a on-request --sandbox workspace-write` — the standard low-friction
   * non-interactive automation mode. We use this form for three reasons:
   *
   *   1. **It parses cleanly on `exec`.** `--full-auto` is a documented
   *      subcommand flag (`codex exec --help` lists it). The earlier substrate
   *      attempts hit two failure modes: `--ask-for-approval` is top-level
   *      only and errors `unexpected argument` after `exec` (v0.20.131–133),
   *      and `-c approval_policy=never` parses but gets silently downshifted
   *      under enterprise cloud-managed policies that disallow `Never`
   *      (v0.20.134–135 — the operator's pv-core-harness case).
   *   2. **`OnRequest` works with `apply_patch` in `workspace-write`.** Per
   *      Codex source (`codex-rs/core/src/safety.rs:33-116`), `OnRequest`
   *      falls through to `is_write_patch_constrained_to_writable_paths` and
   *      AUTO-APPROVES `apply_patch` calls when every target path is inside
   *      the writable roots of an active platform sandbox. So Codex writes
   *      land in `exec` mode without any approval prompt or escalation.
   *      `UnlessTrusted` is the only policy with the broken `TODO(ragona)`
   *      branch that unconditionally asks for approval — we avoid it.
   *   3. **`OnRequest` is broadly allow-listed.** Enterprise cloud policies
   *      that disallow `Never` typically still permit `OnRequest`
   *      (it's strictly more conservative). `--full-auto` is therefore the
   *      form most likely to work across both unrestricted and managed Codex
   *      installs.
   *
   * Not the org-blocked `--dangerously-bypass-approvals-and-sandbox` flag.
   * The planning command stays read-only (it must not write).
   *
   * Do NOT use --json: it produces a JSONL event stream that prevents
   * extractYamlBlock from finding the structured result block in stdout.
   * Raw text output is required (same rationale as Claude adapter).
   */
  buildCommand(prompt: string, options: AdapterOptions): SpawnCommand {
    // Defaults first so caller-supplied additionalFlags can still override
    // (clap honors the last occurrence of a repeated flag).
    const args = ['exec', '--full-auto']

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
    // Use positional prompt arg without --json:
    // `codex exec <prompt> --sandbox read-only` outputs the model's raw text to stdout.
    // `--json` produces a JSONL event stream which breaks direct JSON parsing.
    // Positional arg avoids the stdin piping issue with execFileAsync.
    const args = ['exec', planningPrompt, '--sandbox', 'read-only']

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
    }
  }

  /**
   * Parse Codex CLI output into a TaskResult.
   *
   * With raw text mode (no --json), stdout is the agent's direct output.
   * YAML extraction happens in the dispatcher's extractYamlBlock, not here.
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

    return {
      success: true,
      output: stdout,
      exitCode,
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
      const parsed = JSON.parse(stripCodeFences(stdout)) as CodexPlanOutput

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
      supportsSubscriptionBilling: true,
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
      timeoutMultiplier: 3.0,
      supportsSystemPrompt: false,
      supportsOtlpExport: false,
      requiresYamlSuffix: true,
      defaultMaxReviewCycles: 3,
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
      `Produce at most ${String(maxTasks)} tasks. ` +
      `Output ONLY raw valid JSON — no markdown, no code fences, no explanation. ` +
      `Start your response with { and end with }.`
    )
  }
}
