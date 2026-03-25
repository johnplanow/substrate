// packages/factory/src/agent/loop.ts
// Core agentic loop for CodingAgentSession.
// Story 48-7: Coding Agent Loop — Core Agentic Loop
// Story 48-8: Loop Detection and Steering Injection

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { LLMClient } from '../llm/client.js'
import type { LLMRequest, LLMMessage, LLMToolCall } from '../llm/types.js'
import type { ProviderProfile } from './tools/profiles.js'
import type { ExecutionEnvironment } from './tools/types.js'
import { ToolRegistry } from './tools/registry.js'
import {
  SessionConfig,
  SessionState,
  SessionEvent,
  EventKind,
  UserTurn,
  AssistantTurn,
  ToolResultsTurn,
  SteeringTurn,
  Turn,
  ToolCallResult,
  DEFAULT_SESSION_CONFIG,
} from './types.js'
import { truncateToolOutput, DEFAULT_LINE_LIMIT } from './truncation.js'
import { LoopDetector } from './loop-detection.js'

// ---------------------------------------------------------------------------
// CreateSessionOptions
// ---------------------------------------------------------------------------

export interface CreateSessionOptions {
  llmClient: LLMClient
  providerProfile: ProviderProfile
  executionEnv: ExecutionEnvironment
  config?: Partial<SessionConfig>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ToolRegistry from a ProviderProfile's tool definitions. */
function buildRegistryFromProfile(profile: ProviderProfile): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of profile.tools()) {
    registry.register(tool)
  }
  return registry
}

/**
 * Convert session history turns to LLMMessage array for the LLM request.
 * SystemTurns are skipped (system prompt is provided separately via ProviderProfile).
 */
export function convertHistoryToMessages(history: Turn[]): LLMMessage[] {
  const messages: LLMMessage[] = []
  for (const turn of history) {
    switch (turn.type) {
      case 'user':
      case 'steering':
        messages.push({
          role: 'user',
          content: [{ kind: 'text', text: turn.content }],
        })
        break

      case 'assistant':
        if (turn.tool_calls.length > 0) {
          // Encode both text and tool_use parts
          const parts: LLMMessage['content'] = []
          if (turn.content) {
            parts.push({ kind: 'text', text: turn.content })
          }
          for (const tc of turn.tool_calls) {
            parts.push({
              kind: 'tool_call',
              toolCall: {
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
                ...(tc.rawArguments !== undefined ? { rawArguments: tc.rawArguments } : {}),
              },
            })
          }
          messages.push({ role: 'assistant', content: parts })
        } else {
          messages.push({
            role: 'assistant',
            content: [{ kind: 'text', text: turn.content }],
          })
        }
        break

      case 'tool_results':
        messages.push({
          role: 'user',
          content: turn.results.map(r => ({
            kind: 'tool_result',
            toolResult: {
              toolCallId: r.tool_call_id,
              content: r.content,
              isError: r.is_error,
            },
          })),
        })
        break

      case 'system':
        // System turns are passed as systemPrompt, not in the message array
        break
    }
  }
  return messages
}

/**
 * Build LLMRequest from the current session state.
 */
export function buildLLMRequest(session: CodingAgentSession): LLMRequest {
  const profile = session.providerProfile
  const config = session.config

  // Convert ToolDefinition[] → LLMToolDefinition[]
  const tools = profile.tools().map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }))

  // Extract provider options
  const providerOptions = profile.provider_options() as {
    max_tokens?: number
    temperature?: number
    [key: string]: unknown
  }
  const { max_tokens, temperature, ...rest } = providerOptions

  const req: LLMRequest = {
    model: profile.model,
    systemPrompt: profile.build_system_prompt(),
    messages: convertHistoryToMessages(session.history),
    tools,
    toolChoice: 'auto',
  }

  if (max_tokens !== undefined) req.maxTokens = max_tokens
  if (temperature !== undefined) req.temperature = temperature
  if (config.reasoning_effort) {
    req.reasoningEffort = config.reasoning_effort as 'low' | 'medium' | 'high'
  }
  if (Object.keys(rest).length > 0) {
    req.extra = rest
  }

  return req
}

// ---------------------------------------------------------------------------
// CodingAgentSession
// ---------------------------------------------------------------------------

export class CodingAgentSession {
  readonly id: string
  state: SessionState
  readonly history: Turn[]
  readonly config: SessionConfig
  readonly llmClient: LLMClient
  readonly providerProfile: ProviderProfile
  readonly executionEnv: ExecutionEnvironment

  // Underscore-prefixed fields are internal but accessible for testing/extension
  _steeringQueue: string[]
  _followupQueue: string[]

  private _emitter: EventEmitter
  private _abortController: AbortController
  private _toolRegistry: ToolRegistry

  constructor(options: CreateSessionOptions) {
    this.id = randomUUID()
    this.state = SessionState.IDLE
    this.history = []
    this._steeringQueue = []
    this._followupQueue = []
    this._emitter = new EventEmitter()
    this._emitter.setMaxListeners(50) // allow many event listeners in complex sessions
    this._abortController = new AbortController()
    this.llmClient = options.llmClient
    this.providerProfile = options.providerProfile
    this.executionEnv = options.executionEnv
    this.config = {
      ...DEFAULT_SESSION_CONFIG,
      ...options.config,
      // Ensure tool_output_limits is always a Map (not plain object)
      tool_output_limits: options.config?.tool_output_limits ?? new Map(),
      // Explicit truncation defaults so DEFAULT_LINE_LIMIT is always resolved at runtime
      truncation_mode: options.config?.truncation_mode ?? 'head_tail',
      max_output_lines: options.config?.max_output_lines ?? DEFAULT_LINE_LIMIT,
    }
    this._toolRegistry = buildRegistryFromProfile(options.providerProfile)

    // Emit SESSION_START synchronously during construction
    this._emit(EventKind.SESSION_START, { session_id: this.id })
  }

  /** Subscribe to session events. */
  on(kind: EventKind, handler: (event: SessionEvent) => void): void {
    this._emitter.on(kind, handler)
  }

  /** Transition to CLOSED state and emit SESSION_END. */
  close(): void {
    this.state = SessionState.CLOSED
    this._emit(EventKind.SESSION_END, {})
  }

  /** Abort the current operation and close the session. */
  abort(): void {
    this._abortController.abort()
    this.close()
  }

  /**
   * Push a steering message onto the steering queue.
   * It will be injected into history (as a SteeringTurn) before the next LLM call.
   * Safe to call from any state (IDLE, PROCESSING, CLOSED); if CLOSED, the message
   * is queued but will never be drained.
   */
  steer(message: string): void {
    this._steeringQueue.push(message)
  }

  /**
   * Push a follow-up message onto the follow-up queue.
   * After the current processInput cycle completes naturally (no more tool calls),
   * the first queued follow-up triggers a new processInput cycle recursively.
   * PROCESSING_END is not emitted until all follow-ups are exhausted.
   * Safe to call from any state.
   */
  follow_up(message: string): void {
    this._followupQueue.push(message)
  }

  /**
   * Construct and emit a SessionEvent.
   * Internal — underscore prefix signals non-public API.
   */
  _emit(kind: EventKind, data: Record<string, unknown> = {}): void {
    const event: SessionEvent = {
      kind,
      timestamp: new Date(),
      session_id: this.id,
      data,
    }
    this._emitter.emit(kind, event)
  }

  /**
   * Dequeue all steering messages, append as SteeringTurns, emit STEERING_INJECTED.
   * Called before each LLM call and after tool execution.
   * Story 48-8 will extend this method.
   */
  _drainSteering(): void {
    while (this._steeringQueue.length > 0) {
      const content = this._steeringQueue.shift()!
      const turn: SteeringTurn = {
        type: 'steering',
        content,
        timestamp: new Date(),
      }
      this.history.push(turn)
      this._emit(EventKind.STEERING_INJECTED, { content })
    }
  }

  /**
   * Process a user input string through the agentic loop.
   *
   * Appends a UserTurn, then repeatedly calls the LLM and executes tool calls
   * until natural completion (no tool calls) or a configured limit is hit.
   *
   * After natural completion, drains the follow-up queue (FIFO) by recursively
   * calling processInput for each queued message. PROCESSING_END is only emitted
   * when the follow-up queue is fully exhausted.
   */
  async processInput(userInput: string): Promise<void> {
    this.state = SessionState.PROCESSING

    // Append user turn and emit USER_INPUT
    const userTurn: UserTurn = {
      type: 'user',
      content: userInput,
      timestamp: new Date(),
    }
    this.history.push(userTurn)
    this._emit(EventKind.USER_INPUT, { content: userInput })

    let roundCount = 0

    // Fresh loop detector for this processInput call (per-call scope, not per-session)
    const loopDetector = new LoopDetector({
      windowSize: this.config.loop_detection_window,
      enabled: this.config.enable_loop_detection,
    })

    try {
      while (true) {
        // --- Limit checks at the start of each iteration ---

        // Check max_turns (count all turns in history)
        const totalTurns = this.history.length
        if (this.config.max_turns > 0 && totalTurns >= this.config.max_turns) {
          this._emit(EventKind.TURN_LIMIT, {
            total_turns: totalTurns,
            reason: 'max_turns',
          })
          break
        }

        // Check max_tool_rounds_per_input
        if (
          this.config.max_tool_rounds_per_input > 0 &&
          roundCount >= this.config.max_tool_rounds_per_input
        ) {
          this._emit(EventKind.TURN_LIMIT, {
            round: roundCount,
            reason: 'max_tool_rounds_per_input',
          })
          break
        }

        // Check abort signal
        if (this._abortController.signal.aborted) {
          break
        }

        // Drain any queued steering messages before LLM call
        this._drainSteering()

        // Call the LLM
        const response = await this.llmClient.complete(buildLLMRequest(this))

        // Append assistant turn to history
        const assistantTurn: AssistantTurn = {
          type: 'assistant',
          content: response.content,
          tool_calls: response.toolCalls ?? [],
          reasoning: null, // story 48-9 will populate this for reasoning-capable models
          usage: response.usage,
          response_id: response.id ?? null,
          timestamp: new Date(),
        }
        this.history.push(assistantTurn)
        this._emit(EventKind.ASSISTANT_TEXT_END, {
          text: response.content,
          reasoning: null,
        })

        // Natural completion: no tool calls
        if (!response.toolCalls || response.toolCalls.length === 0) {
          // Check for queued follow-up messages; if present, recurse instead of emitting PROCESSING_END
          if (this._followupQueue.length > 0) {
            const nextInput = this._followupQueue.shift()!
            await this.processInput(nextInput)
            // Return immediately — the recursive call will emit PROCESSING_END when its own
            // follow-up queue is exhausted; we must not double-emit it here.
            return
          }
          break
        }

        // Execute tool calls
        roundCount++
        const toolResults = await this._executeToolCalls(response.toolCalls)

        // Append tool results turn
        const toolResultsTurn: ToolResultsTurn = {
          type: 'tool_results',
          results: toolResults,
          timestamp: new Date(),
        }
        this.history.push(toolResultsTurn)

        // Record each tool call in the loop detector
        let loopTriggered = false
        for (const tc of response.toolCalls) {
          const detected = loopDetector.record(tc.name, tc.arguments)
          if (detected) loopTriggered = true
        }

        // Drain steering again after tool execution
        this._drainSteering()

        // Inject loop detection warning directly into history (bypasses steering queue per spec)
        if (loopTriggered) {
          const warningMessage = `Loop detected: the last ${this.config.loop_detection_window} tool calls follow a repeating pattern. Try a different approach.`
          const loopTurn: SteeringTurn = {
            type: 'steering',
            content: warningMessage,
            timestamp: new Date(),
          }
          this.history.push(loopTurn)
          this._emit(EventKind.LOOP_DETECTION, { message: warningMessage })
        }
      }

      this.state = SessionState.IDLE
      this._emit(EventKind.PROCESSING_END, {})
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this._emit(EventKind.ERROR, { message })
      this.state = SessionState.CLOSED
      throw err
    }
  }

  /** Dispatch tool calls in parallel or sequentially based on provider profile. */
  private async _executeToolCalls(toolCalls: LLMToolCall[]): Promise<ToolCallResult[]> {
    if (this.providerProfile.supports_parallel_tool_calls && toolCalls.length > 1) {
      // Parallel dispatch
      return Promise.all(toolCalls.map(tc => this._executeSingleTool(tc)))
    } else {
      // Sequential dispatch
      const results: ToolCallResult[] = []
      for (const tc of toolCalls) {
        results.push(await this._executeSingleTool(tc))
      }
      return results
    }
  }

  /** Execute a single tool call: lookup, emit events, delegate to registry, truncate. */
  private async _executeSingleTool(toolCall: LLMToolCall): Promise<ToolCallResult> {
    this._emit(EventKind.TOOL_CALL_START, {
      tool_name: toolCall.name,
      call_id: toolCall.id,
    })

    // Check if tool exists in registry
    const toolDef = this._toolRegistry.get(toolCall.name)
    if (!toolDef) {
      // Unknown tool: return error without throwing
      const errorContent = `Unknown tool: ${toolCall.name}`
      this._emit(EventKind.TOOL_CALL_END, {
        call_id: toolCall.id,
        output: errorContent,
        is_error: true,
      })
      return {
        tool_call_id: toolCall.id,
        content: errorContent,
        is_error: true,
      }
    }

    // Delegate to registry (handles schema validation, executor errors, outputTruncation)
    const toolResult = await this._toolRegistry.execute(
      toolCall.name,
      toolCall.arguments,
      this.executionEnv,
    )

    const rawOutput = toolResult.content

    // Apply SessionConfig-level truncation for LLM-bound content
    const truncatedOutput = truncateToolOutput(rawOutput, toolCall.name, this.config)

    // Emit TOOL_CALL_END with the FULL untruncated output
    this._emit(EventKind.TOOL_CALL_END, {
      call_id: toolCall.id,
      output: rawOutput,
      is_error: toolResult.isError,
    })

    return {
      tool_call_id: toolCall.id,
      content: truncatedOutput,
      is_error: toolResult.isError,
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a new CodingAgentSession.
 * SESSION_START is emitted synchronously during construction.
 */
export function createSession(options: CreateSessionOptions): CodingAgentSession {
  return new CodingAgentSession(options)
}
