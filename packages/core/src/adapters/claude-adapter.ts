/**
 * Claude Code adapter
 *
 * Implements WorkerAdapter for the Claude Code CLI agent.
 * Binary: `claude`
 * Output format: JSON via `--output-format json`
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, mkdirSync } from 'node:fs'
import * as path from 'node:path'
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
import { checkAdapterVersionCompat, type TestedVersionRange } from './version-compat.js'

const execAsync = promisify(exec)

/**
 * H4.3: generate the per-worktree Claude Code settings file for the
 * 'scoped' permission profile. Written NEXT TO the worktree (its parent
 * directory — the worktree base, outside any repo after H4.2) so it can
 * never be committed by commit-first.
 *
 * Scopes the Edit/Write/NotebookEdit TOOLS to the worktree (out-of-worktree
 * mutation via those tools falls to "ask", which headless -p mode denies).
 *
 * NOT A SECURITY BOUNDARY (red-team, 2026-07-06). `Bash` is allowed with no
 * path restriction — Claude Code's Bash permissioning is command-string
 * based, and Bash can invoke any binary that writes (echo/tee/python/…), so a
 * determined agent can mutate ANY path the host user can write. `git -C
 * <path>` likewise reaches repos outside the worktree (the H4.1
 * GIT_CEILING_DIRECTORIES scrub only blocks AMBIENT discovery, not explicit
 * targets). This profile is accident-mitigation — it stops a well-behaved
 * agent from *tool*-writing outside its worktree — not containment of a
 * hostile one. Real confinement (worktree as the only writable mount)
 * requires the container execution backend (H4.4 seam; see
 * docs/2026-07-06-container-execution-seam.md and the red-team review).
 */
export function writeScopedPermissionSettings(worktreePath: string): string {
  const wt = path.resolve(worktreePath)
  const settings = {
    permissions: {
      allow: [
        'Read',
        'Glob',
        'Grep',
        'Bash',
        'WebFetch',
        'WebSearch',
        'TodoWrite',
        'Task',
        `Edit(${wt}/**)`,
        `Write(${wt}/**)`,
        `NotebookEdit(${wt}/**)`,
      ],
      // No deny rules: deny WINS over allow in Claude Code, and any parent
      // pattern would also match the worktree beneath it. Scoping lives in
      // the allow rules — a mutation outside the worktree matches nothing,
      // falls to "ask", and headless -p mode denies it visibly.
      deny: [],
    },
  }
  const settingsPath = path.join(path.dirname(wt), `.agent-settings-${path.basename(wt)}.json`)
  mkdirSync(path.dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return settingsPath
}

/** Default model used when none is specified */
const DEFAULT_MODEL = 'claude-sonnet-4-6'

/**
 * Signatures the Claude Code CLI emits when a dispatch dies on authentication
 * rather than doing any work (H0.4, field finding #10). Matched
 * case-insensitively against the dispatch's combined output.
 *
 * Field-verified: a stale `ANTHROPIC_API_KEY` in the operator's shell made
 * spawned CLIs reject with "auth source takes precedence over claude.ai
 * login · Invalid API key" — surfaced as `create-story-no-file`
 * (qualityScore 40) or a full 600s timeout, never as an auth error, burning
 * ~25 minutes and two runs before diagnosis.
 */
const CLAUDE_AUTH_FAILURE_SIGNATURES = [
  'invalid api key',
  'auth source takes precedence',
  'please run /login',
  'oauth token has expired',
  'oauth token is invalid',
  'oauth token revoked',
  'authentication_error',
  'credit balance is too low',
] as const

/** Operator-facing remediation appended to auth-failure escalations. */
export const CLAUDE_AUTH_FAILURE_HINT =
  'The Claude CLI rejected authentication before doing any work. Every subsequent ' +
  'dispatch in this run would fail identically, so the run was halted. Likely causes, ' +
  'in order: (1) a stale ANTHROPIC_API_KEY exported in the environment that spawned ' +
  'substrate — the CLI prefers it over claude.ai subscription login and rejects it if ' +
  'invalid (substrate scrubs the var on coding dispatches, but keys configured inside ' +
  'Claude Code settings/apiKeyHelper are outside substrate\'s control; verify with ' +
  '`env -u ANTHROPIC_API_KEY claude -p "ok"`); (2) an expired claude.ai session — run ' +
  '`claude login`; (3) an exhausted API credit balance when api_billing is enabled. ' +
  'Fix the credential, then re-run — completed stories are preserved.'

/**
 * Returns the matched auth-failure signature if `output` shows the Claude CLI
 * dying on authentication, else null. Pure + exported for diagnostics and
 * testing (mirrors detectCodexSandboxBlock).
 */
export function detectClaudeAuthFailure(output: string | undefined | null): string | null {
  if (output === undefined || output === null || output === '') return null
  const lower = output.toLowerCase()
  return CLAUDE_AUTH_FAILURE_SIGNATURES.find((sig) => lower.includes(sig)) ?? null
}

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

/**
 * Shape of the terminal result event emitted by Claude Code CLI with
 * `--output-format stream-json` (NDJSON event stream format).
 *
 * Documented fields relevant to substrate (Story 81-9):
 *   - `type`:      Always `"result"` for this event.
 *   - `subtype`:   `"success"` | `"error_during_execution"` | etc.
 *   - `result`:    Full agent text output (same as raw stdout without stream-json).
 *                  Contains the YAML block extracted by AdapterOutputNormalizer.
 *   - `num_turns`: Agentic turn count — the reliable synchronous turn-count source.
 *                  Absent on older CLI versions or certain error subtypes.
 *   - `is_error`:  True when the agent encountered a hard error.
 */
interface ClaudeStreamResultEvent {
  type: 'result'
  subtype?: string
  result?: string
  num_turns?: number
  is_error?: boolean
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
   * Claude Code CLI version range substrate's `buildCommand` has been
   * empirically verified against (as of substrate v0.20.138 on 2026-05-31).
   * `healthCheck` compares the live `claude --version` against this range
   * and surfaces a warning when the operator's CLI is outside it.
   *
   * The `note` flags `--max-turns`: the flag is silently accepted by clap
   * but not honored — substrate's `options.maxTurns` has no effect on
   * Claude Code 2.x dispatches. Bumping the upper bound requires re-running
   * the empirical audit (see `feedback_cli_adapter_empirical_version_match`).
   */
  static readonly TESTED_CLI_VERSION_RANGE: TestedVersionRange = {
    min: '2.1.152',
    max: '2.1.168',
    note: 'Claude Code 2.x silently accepts but does not honor `--max-turns`; substrate no longer passes that flag. `-p --output-format stream-json` REQUIRES `--verbose` (hard error otherwise) — empirically verified against 2.1.168 (2026-06-07): with --verbose, NDJSON events emitted and `num_turns` present on the terminal result event.',
  }

  private readonly _logger: ILogger

  constructor(logger?: ILogger) {
    // Default to console if no logger is injected
    this._logger = logger ?? createStderrLogger('claude-adapter')
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

      const compat = checkAdapterVersionCompat(
        'claude-code',
        output,
        ClaudeCodeAdapter.TESTED_CLI_VERSION_RANGE,
      )

      return {
        healthy: true,
        version: output,
        ...(cliPath !== undefined ? { cliPath } : {}),
        detectedBillingModes,
        supportsHeadless: true,
        ...(compat.warning !== undefined ? { compatibilityWarning: compat.warning } : {}),
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
    // the YAML result block in the raw stdout. NDJSON stream output is used instead
    // (--output-format stream-json, see below); parseStreamOutput() extracts the
    // agent text from the terminal `result` field before YAML extraction runs.
    //
    // --system-prompt: replaces CLAUDE.md and auto-memory context so the subprocess
    // does not re-read the orchestrator's own CLAUDE.md instructions.
    const args = [
      '-p',
      '--model',
      model,
    ]

    // H4.3 (permission-scoped dispatch experiment): 'scoped' swaps the
    // blanket --dangerously-skip-permissions for --permission-mode
    // acceptEdits plus a generated per-worktree settings file that allows
    // Edit/Write only under the worktree (deny outside). In headless -p
    // mode, anything not allowed is DENIED (never an interactive stall),
    // so a scoped agent that reaches outside its worktree fails visibly.
    // Default remains 'skip' pending the AC2 evidence comparison —
    // flip only via config `dispatch.permission_profile: scoped`.
    if (options.permissionProfile === 'scoped') {
      const settingsPath = writeScopedPermissionSettings(options.worktreePath)
      args.push('--permission-mode', 'acceptEdits', '--settings', settingsPath)
    } else {
      // --dangerously-skip-permissions: required for headless automated
      // pipeline use. Without this, Claude in -p mode refuses to write
      // files, asking for permission.
      args.push('--dangerously-skip-permissions')
    }

    // --output-format stream-json: emit NDJSON events to stdout instead of raw text.
    // Each line is a JSON object; the terminal `{"type":"result",...}` event carries:
    //   - `result`: full agent text output (same as raw stdout in plain-text mode)
    //   - `num_turns`: agentic turn count — the sole synchronous reliable turn source
    // The dispatcher calls `parseStreamOutput()` to extract both fields before
    // passing the agent text to the YAML extraction pipeline (Story 81-9, AC2).
    //
    // NOTE: `--output-format json` (NOT used here) wraps output in a single JSON
    // object and prevents extractYamlBlock from finding the YAML code fence.
    // `stream-json` is safe: parseStreamOutput extracts the raw text from the
    // `result` field and passes it unchanged to AdapterOutputNormalizer.
    //
    // --verbose is REQUIRED with `-p --output-format stream-json`: Claude Code
    // 2.1.168 hard-errors otherwise ("When using --print,
    // --output-format=stream-json requires --verbose") — empirically confirmed
    // 2026-06-07 when every Phase 4.2 v5 eval dispatch failed in <1s. The
    // verbose stream adds intermediate assistant/system events, which
    // parseStreamOutput() already skips while scanning for the terminal
    // `type:"result"` event.
    args.push('--output-format', 'stream-json', '--verbose')

    // NOTE: substrate previously passed `--max-turns` here when options.maxTurns
    // was set. Empirical audit against Claude Code 2.1.152 + 2.1.158 (substrate
    // v0.20.138, 2026-05-31): the flag is silently accepted by clap (no
    // `unknown option` error) but is not documented in `claude --help` and is
    // not honored — substrate's `options.maxTurns` had no effect on dispatch
    // length. Removed so substrate-hygiene matches reality. Same pattern as
    // the earlier `--max-context-tokens` removal in Claude Code v2.x.
    //
    // Operators who relied on bounded dispatch length should use Claude Code's
    // own session-level limits or `--max-budget-usd <amount>` (available 2.1.x).
    // Substrate's healthCheck compatibilityWarning surfaces this caveat at
    // dispatch time via the TESTED_CLI_VERSION_RANGE note.

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
   * Pre-process `--output-format stream-json` stdout before YAML extraction (Story 81-9).
   *
   * Claude Code CLI with `--output-format stream-json` emits NDJSON events to stdout.
   * This method parses that stream to extract:
   *   1. `extractedText` — the full agent response from the terminal result event's
   *      `result` field. Identical to raw text output; passed to AdapterOutputNormalizer.
   *   2. `totalTurns` — agentic turn count from `num_turns` in the result event.
   *      This is the ONLY synchronous, reliable turn-count source available at
   *      DispatchResult resolution time.
   *
   * Graceful fallbacks:
   *   - If the stream cannot be parsed as NDJSON, returns `{ extractedText: stdout }`.
   *   - If the result event is missing, returns `{ extractedText: stdout }`.
   *   - If `num_turns` is absent from the event, returns without `totalTurns` (AC2:
   *     "when the count is genuinely unavailable, leave the field absent, never fabricate").
   *
   * @param stdout Raw subprocess stdout (NDJSON event stream from Claude Code CLI)
   * @returns `{ extractedText, totalTurns? }` — text for YAML extraction and optional turn count
   */
  parseStreamOutput(stdout: string): { extractedText: string; totalTurns?: number } {
    try {
      const lines = stdout.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let event: unknown
        try {
          event = JSON.parse(trimmed)
        } catch {
          continue // skip malformed JSON lines
        }
        // Find the terminal result event
        if (
          event !== null &&
          typeof event === 'object' &&
          (event as Record<string, unknown>)['type'] === 'result'
        ) {
          const resultEvent = event as ClaudeStreamResultEvent
          const extractedText =
            typeof resultEvent.result === 'string' && resultEvent.result.length > 0
              ? resultEvent.result
              : stdout // fallback: use raw stdout if result field is absent/empty

          // Surface num_turns when present and is a valid positive integer.
          // Absent → leave totalTurns undefined (forward-only, never fabricate zero).
          const totalTurns =
            typeof resultEvent.num_turns === 'number' && resultEvent.num_turns >= 0
              ? resultEvent.num_turns
              : undefined

          return totalTurns !== undefined
            ? { extractedText, totalTurns }
            : { extractedText }
        }
      }
    } catch {
      // Any unexpected error → fall through to raw-stdout fallback
    }
    // No result event found → return raw stdout for YAML extraction, no turn count
    return { extractedText: stdout }
  }

  /**
   * Build spawn command for plan generation.
   */
  buildPlanningCommand(request: PlanRequest, options: AdapterOptions): SpawnCommand {
    const model = options.model ?? DEFAULT_MODEL
    const planningPrompt = this._buildPlanningPrompt(request)

    // Prompt delivered via stdin (not CLI args) to avoid E2BIG on large prompts.
    const args = [
      '-p',
      '--model',
      model,
      '--dangerously-skip-permissions',
    ]

    if (options.additionalFlags && options.additionalFlags.length > 0) {
      args.push(...options.additionalFlags)
    }

    const envEntries: Record<string, string> = {}
    if (options.billingMode === 'api' && options.apiKey) {
      envEntries.ANTHROPIC_API_KEY = options.apiKey
    }

    // H0.4 (field finding #10): the coding path (buildCommand) has scrubbed
    // ANTHROPIC_API_KEY under non-API billing since v0.10.0, but the planning
    // path never did — a stale env key could still poison planning dispatches.
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
      supportsSystemPrompt: true,
      supportsOtlpExport: true,
      requiresYamlSuffix: false,
      defaultMaxReviewCycles: 2,
      defaultModel: DEFAULT_MODEL,
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
