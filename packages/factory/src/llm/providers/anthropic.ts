// packages/factory/src/llm/providers/anthropic.ts
// AnthropicAdapter — calls the Anthropic Messages API directly via fetch.
// No SDK dependency; fetch is injected for testability.

import {
  LLMError,
  type ProviderAdapter,
  type LLMRequest,
  type LLMResponse,
  type LLMMessage,
  type LLMToolDefinition,
  type LLMToolCall,
  type StreamEvent,
  type StopReason,
} from '../types.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AnthropicAdapterOptions {
  apiKey: string
  baseUrl?: string
  /** Injected fetch function — use globalThis.fetch when omitted. */
  fetch?: typeof globalThis.fetch
  anthropicVersion?: string
}

// ---------------------------------------------------------------------------
// Anthropic API shape (request/response)
// ---------------------------------------------------------------------------

interface AnthropicCacheControl {
  type: 'ephemeral'
}

type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: AnthropicCacheControl }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
      cache_control?: AnthropicCacheControl
    }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  cache_control?: AnthropicCacheControl
}

type AnthropicToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string }

interface AnthropicThinking {
  type: 'enabled'
  budget_tokens: number
}

interface AnthropicRequestBody {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: AnthropicContentBlock[]
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  temperature?: number
  thinking?: AnthropicThinking
  stream?: boolean
}

interface AnthropicRawResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  model: string
  stop_reason: string
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'
const PROMPT_CACHING_BETA = 'prompt-caching-2024-07-31'

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

function mapStopReason(raw: string): StopReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    default:
      return 'other'
  }
}

// ---------------------------------------------------------------------------
// Reasoning effort → thinking budget_tokens
// ---------------------------------------------------------------------------

function reasoningBudget(effort: 'low' | 'medium' | 'high'): number {
  switch (effort) {
    case 'low':
      return 1024
    case 'medium':
      return 8192
    case 'high':
      return 32000
  }
}

// ---------------------------------------------------------------------------
// AnthropicAdapter
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic'

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly anthropicVersion: string
  private readonly fetch: typeof globalThis.fetch

  constructor(options: AnthropicAdapterOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com'
    this.anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION
    this.fetch = options.fetch ?? globalThis.fetch
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const { body, betaHeaders } = this.buildRequestBody(request)
    const headers = this.buildHeaders(betaHeaders)
    const url = `${this.baseUrl}/v1/messages`

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await this.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (response.status === 429) {
        if (attempt === MAX_RETRIES) {
          throw new LLMError(
            `[anthropic] Rate limit exceeded after ${MAX_RETRIES} retries`,
            429,
            'anthropic'
          )
        }
        const retryAfterStr = response.headers.get('Retry-After')
        const retryAfter = retryAfterStr !== null ? parseInt(retryAfterStr, 10) * 1000 : 0
        const backoff = Math.max(retryAfter, BASE_DELAY_MS * 2 ** attempt)
        await new Promise((resolve) => setTimeout(resolve, backoff))
        continue
      }

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => ({}))) as Record<string, unknown>
        const errorObj = errorBody?.error as Record<string, unknown> | undefined
        const message =
          typeof errorObj?.message === 'string' ? errorObj.message : response.statusText
        throw new LLMError(
          `[anthropic] ${response.status}: ${message}`,
          response.status,
          'anthropic'
        )
      }

      const raw = (await response.json()) as AnthropicRawResponse
      return this.parseResponse(raw, request.model)
    }

    // Should be unreachable, but satisfies TypeScript
    throw new Error('[anthropic] Unexpected end of retry loop')
  }

  // eslint-disable-next-line require-yield
  async *stream(_request: LLMRequest): AsyncIterable<StreamEvent> {
    // TODO: streaming
    throw new Error('streaming not yet implemented')
  }

  // -------------------------------------------------------------------------
  // Request building
  // -------------------------------------------------------------------------

  private buildRequestBody(request: LLMRequest): {
    body: AnthropicRequestBody
    betaHeaders: string[]
  } {
    const betaHeaders: string[] = []
    const anthropicExtra = (request.extra as Record<string, Record<string, unknown>> | undefined)
      ?.anthropic
    const autoCache = anthropicExtra !== undefined ? anthropicExtra['auto_cache'] !== false : true

    // Extract extra beta headers from request
    const extraBetas = anthropicExtra?.['beta_headers']
    if (Array.isArray(extraBetas)) {
      for (const b of extraBetas as string[]) {
        betaHeaders.push(b)
      }
    }

    // --- System prompt ---
    let systemBlocks: AnthropicContentBlock[] | undefined
    if (request.systemPrompt) {
      const block: AnthropicContentBlock = { type: 'text', text: request.systemPrompt }
      systemBlocks = [block]
    }

    // --- Messages ---
    const messages = this.translateMessages(request.messages)

    // --- Tools ---
    const toolChoiceIsNone = request.toolChoice === 'none'
    let tools: AnthropicTool[] | undefined
    let toolChoice: AnthropicToolChoice | undefined

    if (!toolChoiceIsNone && request.tools && request.tools.length > 0) {
      tools = this.translateTools(request.tools)
      toolChoice = this.mapToolChoice(request.toolChoice)
    }

    // --- Prompt caching injection ---
    let cachingInjected = false

    if (autoCache) {
      // Cache last system block
      if (systemBlocks && systemBlocks.length > 0) {
        const lastBlock = systemBlocks[systemBlocks.length - 1]
        if (lastBlock && !('cache_control' in lastBlock && lastBlock.cache_control)) {
          ;(lastBlock as { cache_control?: AnthropicCacheControl }).cache_control = {
            type: 'ephemeral',
          }
          cachingInjected = true
        }
      }

      // Cache last tool definition
      if (tools && tools.length > 0) {
        const lastTool = tools[tools.length - 1]
        if (lastTool && !lastTool.cache_control) {
          lastTool.cache_control = { type: 'ephemeral' }
          cachingInjected = true
        }
      }
    }

    if (cachingInjected && !betaHeaders.includes(PROMPT_CACHING_BETA)) {
      betaHeaders.push(PROMPT_CACHING_BETA)
    }

    // --- Build body ---
    const body: AnthropicRequestBody = {
      model: request.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
    }

    if (systemBlocks) {
      body.system = systemBlocks
    }

    if (tools) {
      body.tools = tools
    }

    if (toolChoice) {
      body.tool_choice = toolChoice
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    if (request.reasoningEffort) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: reasoningBudget(request.reasoningEffort),
      }
    }

    return { body, betaHeaders }
  }

  private buildHeaders(betaHeaders: string[]): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.anthropicVersion,
    }
    if (betaHeaders.length > 0) {
      headers['anthropic-beta'] = betaHeaders.join(',')
    }
    return headers
  }

  // -------------------------------------------------------------------------
  // Message translation
  // -------------------------------------------------------------------------

  private translateMessages(messages: LLMMessage[]): AnthropicMessage[] {
    // Filter system messages (handled via system param)
    const filtered = messages.filter((m) => m.role !== 'system')

    // Translate each message to Anthropic format
    const translated: AnthropicMessage[] = filtered.map((msg) => {
      if (msg.role === 'tool') {
        // Tool result messages → user role with tool_result content blocks
        const content: AnthropicContentBlock[] = msg.content.map((part) => {
          if (part.toolResult) {
            return {
              type: 'tool_result',
              tool_use_id: part.toolResult.toolCallId,
              content: part.toolResult.content,
              is_error: part.toolResult.isError,
            } as AnthropicContentBlock
          }
          // Fallback: translate as text
          return { type: 'text', text: part.text ?? '' } as AnthropicContentBlock
        })
        return { role: 'user', content }
      }

      const role = msg.role as 'user' | 'assistant'
      const content: AnthropicContentBlock[] = msg.content.map((part) => {
        if (part.kind === 'text') {
          return { type: 'text', text: part.text ?? '' } as AnthropicContentBlock
        }
        if (part.kind === 'tool_call' && part.toolCall) {
          return {
            type: 'tool_use',
            id: part.toolCall.id,
            name: part.toolCall.name,
            input: part.toolCall.arguments,
          } as AnthropicContentBlock
        }
        if (part.kind === 'tool_result' && part.toolResult) {
          return {
            type: 'tool_result',
            tool_use_id: part.toolResult.toolCallId,
            content: part.toolResult.content,
            is_error: part.toolResult.isError,
          } as AnthropicContentBlock
        }
        // Fallback for unknown kinds
        return { type: 'text', text: part.text ?? '' } as AnthropicContentBlock
      })

      return { role, content }
    })

    // Merge consecutive same-role messages
    const merged: AnthropicMessage[] = []
    for (const msg of translated) {
      const last: AnthropicMessage | undefined = merged[merged.length - 1]
      if (last !== undefined && last.role === msg.role) {
        last.content = [...last.content, ...msg.content]
      } else {
        merged.push({ role: msg.role, content: [...msg.content] })
      }
    }

    return merged
  }

  // -------------------------------------------------------------------------
  // Tool translation
  // -------------------------------------------------------------------------

  private translateTools(tools: LLMToolDefinition[]): AnthropicTool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }))
  }

  private mapToolChoice(toolChoice: LLMRequest['toolChoice']): AnthropicToolChoice | undefined {
    if (!toolChoice || toolChoice === 'none') return undefined
    if (toolChoice === 'auto') return { type: 'auto' }
    if (toolChoice === 'required') return { type: 'any' }
    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      return { type: 'tool', name: toolChoice.name }
    }
    return undefined
  }

  // -------------------------------------------------------------------------
  // Response parsing
  // -------------------------------------------------------------------------

  private parseResponse(raw: AnthropicRawResponse, model: string): LLMResponse {
    let content = ''
    const toolCalls: LLMToolCall[] = []

    for (const block of raw.content) {
      if (block.type === 'text') {
        content += block.text
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input,
          rawArguments: JSON.stringify(block.input),
        })
      }
    }

    const stopReason = mapStopReason(raw.stop_reason)

    const usage = {
      inputTokens: raw.usage.input_tokens,
      outputTokens: raw.usage.output_tokens,
      totalTokens: raw.usage.input_tokens + raw.usage.output_tokens,
      ...(raw.usage.cache_read_input_tokens !== undefined
        ? { cacheReadTokens: raw.usage.cache_read_input_tokens }
        : {}),
      ...(raw.usage.cache_creation_input_tokens !== undefined
        ? { cacheWriteTokens: raw.usage.cache_creation_input_tokens }
        : {}),
    }

    return {
      content,
      toolCalls,
      usage,
      model: raw.model ?? model,
      stopReason,
      providerMetadata: { raw },
      id: raw.id,
    }
  }
}
