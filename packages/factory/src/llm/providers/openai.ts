// packages/factory/src/llm/providers/openai.ts
// OpenAIAdapter — calls the OpenAI Responses API directly via Node.js native fetch.
// Targets POST /v1/responses (NOT /v1/chat/completions) per ADR spec § 2.7.

import {
  LLMError,
  type ProviderAdapter,
  type LLMRequest,
  type LLMResponse,
  type LLMMessage,
  type LLMContentPart,
  type LLMToolCall,
  type LLMUsage,
  type StreamEvent,
  type StopReason,
} from '../types.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OpenAIAdapterOptions {
  apiKey?: string
  baseUrl?: string
  orgId?: string
  projectId?: string
  timeout?: number
}

// ---------------------------------------------------------------------------
// Responses API request/response shapes (internal types)
// ---------------------------------------------------------------------------

type ResponsesAPIContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }

type ResponsesAPIInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: ResponsesAPIContentPart[] }
  | { type: 'function_call_output'; call_id: string; output: string }

interface ResponsesAPITool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

interface ResponsesAPIRequest {
  model: string
  input: ResponsesAPIInputItem[]
  instructions?: string
  tools?: ResponsesAPITool[]
  tool_choice?: string | { type: string; function?: { name: string } }
  max_output_tokens?: number
  temperature?: number
  reasoning?: { effort: 'low' | 'medium' | 'high' }
  stream?: boolean
  [key: string]: unknown
}

type ResponsesAPIOutputItem =
  | { type: 'message'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }

interface ResponsesAPIResponse {
  id: string
  model: string
  status: 'completed' | 'incomplete' | 'in_progress' | 'failed' | 'cancelled'
  incomplete_details?: { reason: 'max_output_tokens' | 'content_filter' }
  output: ResponsesAPIOutputItem[]
  usage: {
    input_tokens: number
    output_tokens: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
}

// ---------------------------------------------------------------------------
// OpenAIAdapter
// ---------------------------------------------------------------------------

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = 'openai'

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly orgId: string | undefined
  private readonly projectId: string | undefined
  private readonly timeout: number

  constructor(options: OpenAIAdapterOptions = {}) {
    const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY']
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required')
    }
    this.apiKey = apiKey

    const rawBaseUrl =
      options.baseUrl ?? process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'
    this.baseUrl = rawBaseUrl.replace(/\/$/, '')

    this.orgId = options.orgId ?? process.env['OPENAI_ORG_ID']
    this.projectId = options.projectId ?? process.env['OPENAI_PROJECT_ID']
    this.timeout = options.timeout ?? 300_000 // 5 minutes
  }

  // -------------------------------------------------------------------------
  // Headers
  // -------------------------------------------------------------------------

  private _defaultHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    }
    if (this.orgId) {
      headers['OpenAI-Organization'] = this.orgId
    }
    if (this.projectId) {
      headers['OpenAI-Project'] = this.projectId
    }
    return headers
  }

  // -------------------------------------------------------------------------
  // Content part translation
  // -------------------------------------------------------------------------

  private _translateContentParts(
    content: LLMContentPart[],
    role: 'user' | 'assistant'
  ): ResponsesAPIContentPart[] {
    const parts: ResponsesAPIContentPart[] = []
    for (const part of content) {
      if (part.kind === 'text' && part.text !== undefined) {
        if (role === 'user') {
          parts.push({ type: 'input_text', text: part.text })
        } else {
          parts.push({ type: 'output_text', text: part.text })
        }
      } else if (part.kind === 'tool_call' && part.toolCall) {
        // Include tool_call content parts in assistant messages as function_call items
        parts.push({
          type: 'function_call',
          call_id: part.toolCall.id,
          name: part.toolCall.name,
          arguments: part.toolCall.rawArguments ?? JSON.stringify(part.toolCall.arguments),
        })
      }
      // Other kinds (image, tool_result, thinking) not handled in this story
    }
    return parts
  }

  // -------------------------------------------------------------------------
  // Message translation (AC2, AC3)
  // -------------------------------------------------------------------------

  private _translateMessages(request: LLMRequest, body: ResponsesAPIRequest): void {
    if (request.systemPrompt) {
      body.instructions = request.systemPrompt
    }

    const input: ResponsesAPIInputItem[] = []

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        // Skip — system prompt is sent via body.instructions
        continue
      }

      if (msg.role === 'user') {
        input.push({
          type: 'message',
          role: 'user',
          content: this._translateContentParts(msg.content, 'user'),
        })
      } else if (msg.role === 'assistant') {
        input.push({
          type: 'message',
          role: 'assistant',
          content: this._translateContentParts(msg.content, 'assistant'),
        })
      } else if (msg.role === 'tool') {
        // Tool result → function_call_output
        const callId = msg.toolCallId ?? this._extractToolCallId(msg)
        const output = this._extractToolOutput(msg)
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output,
        })
      }
    }

    body.input = input
  }

  private _extractToolCallId(msg: LLMMessage): string {
    for (const part of msg.content) {
      if (part.kind === 'tool_result' && part.toolResult?.toolCallId) {
        return part.toolResult.toolCallId
      }
    }
    return ''
  }

  private _extractToolOutput(msg: LLMMessage): string {
    // Prefer text content parts first
    for (const part of msg.content) {
      if (part.kind === 'text' && part.text !== undefined) {
        return part.text
      }
    }
    // Fall back to tool_result content
    for (const part of msg.content) {
      if (part.kind === 'tool_result' && part.toolResult?.content !== undefined) {
        return String(part.toolResult.content)
      }
    }
    return ''
  }

  // -------------------------------------------------------------------------
  // Tool translation (AC4)
  // -------------------------------------------------------------------------

  private _translateTools(request: LLMRequest, body: ResponsesAPIRequest): void {
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    if (request.toolChoice !== undefined) {
      if (typeof request.toolChoice === 'string') {
        // 'auto' | 'none' | 'required' pass through directly
        body.tool_choice = request.toolChoice
      } else if (request.toolChoice.type === 'function') {
        body.tool_choice = {
          type: 'function',
          function: { name: request.toolChoice.name },
        }
      }
    }
    // If toolChoice is undefined, omit tool_choice field entirely
  }

  // -------------------------------------------------------------------------
  // Usage parsing (AC6)
  // -------------------------------------------------------------------------

  private _parseUsage(usage: ResponsesAPIResponse['usage']): LLMUsage {
    const inputTokens = usage.input_tokens
    const outputTokens = usage.output_tokens
    const totalTokens = inputTokens + outputTokens

    const result: LLMUsage = { inputTokens, outputTokens, totalTokens }

    const reasoningTokens = usage.output_tokens_details?.reasoning_tokens
    if (reasoningTokens !== undefined && reasoningTokens > 0) {
      result.reasoningTokens = reasoningTokens
    }

    const cacheReadTokens = usage.input_tokens_details?.cached_tokens
    if (cacheReadTokens !== undefined && cacheReadTokens > 0) {
      result.cacheReadTokens = cacheReadTokens
    }

    // No cacheWriteTokens for OpenAI — caching is fully automatic server-side

    return result
  }

  // -------------------------------------------------------------------------
  // Stop reason mapping (AC5)
  // -------------------------------------------------------------------------

  private _mapStopReason(response: ResponsesAPIResponse, hasToolCalls: boolean): StopReason {
    if (response.status === 'completed') {
      return hasToolCalls ? 'tool_calls' : 'stop'
    }
    if (response.status === 'incomplete') {
      const reason = response.incomplete_details?.reason
      if (reason === 'max_output_tokens') return 'length'
      if (reason === 'content_filter') return 'content_filter'
    }
    return 'other'
  }

  // -------------------------------------------------------------------------
  // complete() (AC5)
  // -------------------------------------------------------------------------

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const body: ResponsesAPIRequest = {
      model: request.model,
      input: [],
    }

    this._translateMessages(request, body)
    this._translateTools(request, body)

    if (request.maxTokens !== undefined) {
      body.max_output_tokens = request.maxTokens
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }
    // AC7: reasoning effort pass-through — only add field when defined
    if (request.reasoningEffort !== undefined) {
      body.reasoning = { effort: request.reasoningEffort }
    }

    // Provider escape hatch — merge provider-namespaced extra fields into request body
    if (request.extra?.openai) {
      Object.assign(body, request.extra.openai)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeout)

    let rawResponse: Response
    try {
      rawResponse = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: this._defaultHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!rawResponse.ok) {
      let errorMessage = `OpenAI API error: ${rawResponse.status}`
      try {
        const errorBody = (await rawResponse.json()) as { error?: { message?: string } }
        if (errorBody.error?.message) {
          errorMessage = `OpenAI API error ${rawResponse.status}: ${errorBody.error.message}`
        }
      } catch {
        // Ignore JSON parse errors for error body
      }
      throw new LLMError(errorMessage, rawResponse.status, 'openai')
    }

    const data = (await rawResponse.json()) as ResponsesAPIResponse

    // Parse text content and tool calls from output items
    let content = ''
    const toolCalls: LLMToolCall[] = []

    for (const item of data.output) {
      if (item.type === 'message') {
        for (const part of item.content) {
          if (part.type === 'output_text') {
            content += part.text
          }
        }
      } else if (item.type === 'function_call') {
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = JSON.parse(item.arguments) as Record<string, unknown>
        } catch {
          // Defensive: if JSON.parse fails, keep empty args and preserve raw
        }
        toolCalls.push({
          id: item.call_id,
          name: item.name,
          arguments: parsedArgs,
          rawArguments: item.arguments,
        })
      }
    }

    const stopReason = this._mapStopReason(data, toolCalls.length > 0)
    const usage = this._parseUsage(data.usage)

    return {
      content,
      toolCalls,
      usage,
      model: data.model,
      stopReason,
      providerMetadata: { id: data.id },
      id: data.id,
    }
  }

  // -------------------------------------------------------------------------
  // stream() — SSE streaming from Responses API (AC5 streaming path, Task 7)
  // -------------------------------------------------------------------------

  async *stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    const body: ResponsesAPIRequest = {
      model: request.model,
      input: [],
      stream: true,
    }

    this._translateMessages(request, body)
    this._translateTools(request, body)

    if (request.maxTokens !== undefined) {
      body.max_output_tokens = request.maxTokens
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }
    if (request.reasoningEffort !== undefined) {
      body.reasoning = { effort: request.reasoningEffort }
    }
    if (request.extra) {
      Object.assign(body, request.extra)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeout)

    let rawResponse: Response
    try {
      rawResponse = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: this._defaultHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      throw err
    }

    if (!rawResponse.ok) {
      clearTimeout(timer)
      let errorMessage = `OpenAI API error: ${rawResponse.status}`
      try {
        const errorBody = (await rawResponse.json()) as { error?: { message?: string } }
        if (errorBody.error?.message) {
          errorMessage = `OpenAI API error ${rawResponse.status}: ${errorBody.error.message}`
        }
      } catch {
        // Ignore JSON parse errors for error body
      }
      throw new LLMError(errorMessage, rawResponse.status, 'openai')
    }

    try {
      const text = await rawResponse.text()
      const lines = text.split('\n')
      let started = false
      let currentEventName = ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('event: ')) {
          currentEventName = trimmed.slice(7).trim()
        } else if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6).trim()
          if (dataStr === '[DONE]') break

          let eventData: Record<string, unknown>
          try {
            eventData = JSON.parse(dataStr) as Record<string, unknown>
          } catch {
            continue
          }

          // Yield message_start on first data event
          if (!started) {
            started = true
            yield { type: 'message_start' }
          }

          if (currentEventName === 'response.output_text.delta') {
            yield {
              type: 'text_delta',
              delta: (eventData['delta'] as string | undefined) ?? '',
            }
          } else if (currentEventName === 'response.function_call_arguments.delta') {
            const itemId = eventData['item_id'] as string | undefined
            const toolCallDelta: StreamEvent['toolCall'] = {
              rawArguments: (eventData['delta'] as string | undefined) ?? '',
            }
            if (itemId !== undefined) {
              toolCallDelta.id = itemId
            }
            yield { type: 'tool_call_delta', toolCall: toolCallDelta }
          } else if (currentEventName === 'response.output_item.done') {
            const itemType = eventData['type'] as string | undefined
            if (itemType === 'function_call') {
              const rawArgs = (eventData['arguments'] as string | undefined) ?? ''
              let parsedArgs: Record<string, unknown> = {}
              try {
                parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>
              } catch {
                // Ignore parse errors
              }
              const callId = eventData['call_id'] as string | undefined
              const callName = eventData['name'] as string | undefined
              const doneToolCall: StreamEvent['toolCall'] = { arguments: parsedArgs }
              if (callId !== undefined) {
                doneToolCall.id = callId
              }
              if (callName !== undefined) {
                doneToolCall.name = callName
              }
              yield { type: 'tool_call_delta', toolCall: doneToolCall }
            }
          } else if (
            currentEventName === 'response.completed' ||
            currentEventName === 'response.created'
          ) {
            if (currentEventName === 'response.completed') {
              const completedResponse = (eventData['response'] ?? eventData) as ResponsesAPIResponse
              const hasToolCalls =
                Array.isArray(completedResponse.output) &&
                completedResponse.output.some((o) => o.type === 'function_call')
              const stopReason = this._mapStopReason(completedResponse, hasToolCalls)
              yield {
                type: 'message_stop',
                usage: this._parseUsage(completedResponse.usage),
                finishReason: { reason: stopReason },
              }
            }
          }
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
