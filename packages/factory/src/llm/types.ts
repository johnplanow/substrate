// packages/factory/src/llm/types.ts
// Pure TypeScript interface/type declarations — zero runtime imports.

// ---------------------------------------------------------------------------
// Roles and enum-like string unions
// ---------------------------------------------------------------------------

export type LLMRole = 'system' | 'user' | 'assistant' | 'tool'

export type StopReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'other'

export type ContentKind = 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'image'

// ---------------------------------------------------------------------------
// Content part sub-types (embedded in LLMContentPart)
// ---------------------------------------------------------------------------

export interface LLMToolCallData {
  id: string
  name: string
  arguments: Record<string, unknown>
  rawArguments?: string
}

export interface LLMToolResultData {
  toolCallId: string
  content: string
  isError: boolean
}

export interface LLMContentPart {
  kind: ContentKind | string
  text?: string
  toolCall?: LLMToolCallData
  toolResult?: LLMToolResultData
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export interface LLMMessage {
  role: LLMRole
  content: LLMContentPart[]
  toolCallId?: string
  name?: string
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface LLMUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

// ---------------------------------------------------------------------------
// Tool types
// ---------------------------------------------------------------------------

/** Extracted tool call for execution (distinct from LLMToolCallData embedded in content parts). */
export interface LLMToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  rawArguments?: string
}

/** Result produced after executing a tool call. */
export interface LLMToolResult {
  toolCallId: string
  content: string | Record<string, unknown>
  isError: boolean
}

/** JSON Schema–based definition of a tool exposed to the model. */
export interface LLMToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export type LLMToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string }

export interface LLMRequest {
  /** Target model identifier (e.g. "claude-opus-4-5", "gpt-4o"). */
  model: string
  messages: LLMMessage[]
  systemPrompt?: string
  tools?: LLMToolDefinition[]
  toolChoice?: LLMToolChoice
  maxTokens?: number
  temperature?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
  metadata?: Record<string, string>
  /**
   * Provider-specific escape hatch.
   * Each adapter extracts the keys it understands and ignores the rest.
   */
  extra?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export interface FinishReason {
  reason: StopReason
  raw?: string
}

export interface LLMResponse {
  content: string
  toolCalls: LLMToolCall[]
  usage: LLMUsage
  model: string
  stopReason: StopReason
  providerMetadata: Record<string, unknown>
  id?: string
  finishReason?: FinishReason
  warnings?: Array<{ message: string; code?: string }>
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export type StreamEventType =
  | 'text_delta'
  | 'reasoning_delta'
  | 'tool_call_delta'
  | 'message_start'
  | 'message_stop'
  | 'error'
  | 'usage'

export interface StreamEvent {
  type: StreamEventType | string
  delta?: string
  reasoningDelta?: string
  toolCall?: Partial<LLMToolCall>
  finishReason?: FinishReason
  usage?: LLMUsage
  error?: Error
  raw?: unknown
}

// ---------------------------------------------------------------------------
// Provider adapter
// ---------------------------------------------------------------------------

/**
 * Error thrown by provider adapters that includes the HTTP status code.
 * The retry middleware uses `statusCode` to determine if an error is retryable
 * (429, 500, 502, 503) vs non-retryable (400, 401, 403, 404).
 */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly provider: string,
  ) {
    super(message)
    this.name = 'LLMError'
  }
}

/**
 * Layer 1 of the Unified LLM Client spec.
 * Each provider adapter (Anthropic, OpenAI, Gemini) implements this interface.
 * @see docs/reference/unified-llm-spec.md § 7.1
 */
export interface ProviderAdapter {
  readonly name: string
  complete(request: LLMRequest): Promise<LLMResponse>
  stream(request: LLMRequest): AsyncIterable<StreamEvent>
  close?(): void | Promise<void>
  initialize?(): void | Promise<void>
  supportsToolChoice?(mode: string): boolean
}
