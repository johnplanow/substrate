// packages/factory/src/llm/providers/gemini.ts
// GeminiAdapter — calls the native Gemini API directly via Node.js native fetch.
// Targets POST /v1beta/models/{model}:generateContent per the unified LLM spec § 2.7.
// Authentication is via `key` query parameter — NOT an Authorization header.

import { randomUUID } from 'node:crypto'
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

export interface GeminiAdapterOptions {
  apiKey?: string
  baseUrl?: string
  timeout?: number
}

// ---------------------------------------------------------------------------
// Gemini API request/response shapes (internal types)
// ---------------------------------------------------------------------------

type GeminiPart =
  | { text: string; thought?: boolean }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiToolSpec {
  functionDeclarations: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
  }>
}

interface GeminiToolConfig {
  functionCallingConfig: {
    mode: 'AUTO' | 'NONE' | 'ANY'
    allowedFunctionNames?: string[]
  }
}

interface GeminiGenerationConfig {
  maxOutputTokens?: number
  temperature?: number
  [key: string]: unknown
}

interface GeminiRequestBody {
  contents: GeminiContent[]
  systemInstruction?: { parts: Array<{ text: string }> }
  tools?: GeminiToolSpec[]
  toolConfig?: GeminiToolConfig
  generationConfig?: GeminiGenerationConfig
  [key: string]: unknown
}

interface GeminiUsageMetadata {
  promptTokenCount: number
  candidatesTokenCount: number
  totalTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
}

interface GeminiCandidate {
  content: {
    role: 'model'
    parts: GeminiPart[]
  }
  finishReason?:
    | 'STOP'
    | 'MAX_TOKENS'
    | 'SAFETY'
    | 'RECITATION'
    | 'OTHER'
    | 'FINISH_REASON_UNSPECIFIED'
  safetyRatings?: unknown[]
}

interface GeminiResponse {
  candidates: GeminiCandidate[]
  usageMetadata: GeminiUsageMetadata
  modelVersion?: string
}

// ---------------------------------------------------------------------------
// GeminiAdapter
// ---------------------------------------------------------------------------

export class GeminiAdapter implements ProviderAdapter {
  readonly name = 'gemini'

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeout: number

  constructor(options: GeminiAdapterOptions = {}) {
    const apiKey = options.apiKey ?? process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY']

    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is required')
    }
    this.apiKey = apiKey

    const rawBaseUrl =
      options.baseUrl ??
      process.env['GEMINI_BASE_URL'] ??
      'https://generativelanguage.googleapis.com'
    this.baseUrl = rawBaseUrl.replace(/\/$/, '')

    this.timeout = options.timeout ?? 300_000 // 5 minutes
  }

  // -------------------------------------------------------------------------
  // URL builder
  // -------------------------------------------------------------------------

  private _buildUrl(model: string, streaming: boolean): string {
    const action = streaming ? 'streamGenerateContent' : 'generateContent'
    let url = `${this.baseUrl}/v1beta/models/${model}:${action}?key=${this.apiKey}`
    if (streaming) {
      url += '&alt=sse'
    }
    return url
  }

  // -------------------------------------------------------------------------
  // Tool result response wrapping
  // -------------------------------------------------------------------------

  private _wrapResponse(content: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(content) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Not JSON — wrap as result string
    }
    return { result: content }
  }

  // -------------------------------------------------------------------------
  // Message translation helpers
  // -------------------------------------------------------------------------

  private _translateParts(content: LLMContentPart[]): GeminiPart[] {
    const parts: GeminiPart[] = []
    for (const part of content) {
      if (part.kind === 'text' && part.text !== undefined) {
        parts.push({ text: part.text })
      } else if (part.kind === 'tool_call' && part.toolCall) {
        parts.push({
          functionCall: {
            name: part.toolCall.name,
            args: part.toolCall.arguments,
          },
        })
      }
      // Other kinds (image, thinking, tool_result) not handled here
    }
    return parts
  }

  /**
   * Scan all messages to build a mapping from synthetic tool call IDs to function names.
   * This is needed to translate tool-result messages back into Gemini's functionResponse format.
   */
  private _buildToolCallIdMap(messages: LLMMessage[]): Map<string, string> {
    const idToName = new Map<string, string>()
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        for (const part of msg.content) {
          if (part.kind === 'tool_call' && part.toolCall) {
            idToName.set(part.toolCall.id, part.toolCall.name)
          }
        }
      }
    }
    return idToName
  }

  // -------------------------------------------------------------------------
  // Message translation (AC2, AC3)
  // -------------------------------------------------------------------------

  private _translateMessages(request: LLMRequest, body: GeminiRequestBody): void {
    // AC2: Extract systemPrompt to systemInstruction
    if (request.systemPrompt) {
      body.systemInstruction = { parts: [{ text: request.systemPrompt }] }
    }

    // Build ID→name map from assistant messages for tool result translation
    const idToName = this._buildToolCallIdMap(request.messages)

    const contents: GeminiContent[] = []

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        // Skip — system prompt sent via systemInstruction
        continue
      }

      if (msg.role === 'user') {
        contents.push({ role: 'user', parts: this._translateParts(msg.content) })
      } else if (msg.role === 'assistant') {
        contents.push({ role: 'model', parts: this._translateParts(msg.content) })
      } else if (msg.role === 'tool') {
        // AC3: tool-result messages → functionResponse parts (role: "user")
        const toolResultParts: GeminiPart[] = []

        for (const part of msg.content) {
          if (part.kind === 'tool_result' && part.toolResult) {
            const { toolCallId, content } = part.toolResult
            const functionName = idToName.get(toolCallId) ?? toolCallId
            toolResultParts.push({
              functionResponse: {
                name: functionName,
                response: this._wrapResponse(String(content)),
              },
            })
          }
        }

        // If no tool_result parts found, fall back to text content
        if (toolResultParts.length === 0) {
          const callId = msg.toolCallId ?? ''
          const functionName = idToName.get(callId) ?? callId
          const textContent = msg.content
            .filter((p) => p.kind === 'text')
            .map((p) => p.text ?? '')
            .join('')
          toolResultParts.push({
            functionResponse: {
              name: functionName,
              response: this._wrapResponse(textContent),
            },
          })
        }

        contents.push({ role: 'user', parts: toolResultParts })
      }
    }

    body.contents = contents
  }

  // -------------------------------------------------------------------------
  // Tool translation (AC7)
  // -------------------------------------------------------------------------

  private _translateTools(request: LLMRequest, body: GeminiRequestBody): void {
    if (request.tools && request.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ]
    }

    if (request.toolChoice !== undefined) {
      if (request.toolChoice === 'auto') {
        body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
      } else if (request.toolChoice === 'none') {
        body.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
      } else if (request.toolChoice === 'required') {
        body.toolConfig = { functionCallingConfig: { mode: 'ANY' } }
      } else if (typeof request.toolChoice === 'object' && request.toolChoice.type === 'function') {
        body.toolConfig = {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [request.toolChoice.name],
          },
        }
      }
    }
    // When toolChoice is undefined, omit toolConfig entirely
  }

  // -------------------------------------------------------------------------
  // Usage parsing (AC6)
  // -------------------------------------------------------------------------

  private _parseUsage(usageMetadata: GeminiUsageMetadata): LLMUsage {
    const inputTokens = usageMetadata.promptTokenCount ?? 0
    const outputTokens = usageMetadata.candidatesTokenCount ?? 0
    const totalTokens = inputTokens + outputTokens

    const result: LLMUsage = { inputTokens, outputTokens, totalTokens }

    if (usageMetadata.thoughtsTokenCount !== undefined && usageMetadata.thoughtsTokenCount > 0) {
      result.reasoningTokens = usageMetadata.thoughtsTokenCount
    }

    if (
      usageMetadata.cachedContentTokenCount !== undefined &&
      usageMetadata.cachedContentTokenCount > 0
    ) {
      result.cacheReadTokens = usageMetadata.cachedContentTokenCount
    }

    // No cacheWriteTokens for Gemini — prefix caching is fully automatic server-side

    return result
  }

  // -------------------------------------------------------------------------
  // Stop reason mapping (AC5)
  // -------------------------------------------------------------------------

  private _mapStopReason(
    finishReason: GeminiCandidate['finishReason'] | undefined,
    hasToolCalls: boolean
  ): StopReason {
    // When function calls are present, always return tool_calls regardless of finishReason
    if (hasToolCalls) {
      return 'tool_calls'
    }

    switch (finishReason) {
      case 'STOP':
        return 'stop'
      case 'MAX_TOKENS':
        return 'length'
      case 'SAFETY':
      case 'RECITATION':
        return 'content_filter'
      default:
        // absent, null, FINISH_REASON_UNSPECIFIED, OTHER
        return 'other'
    }
  }

  // -------------------------------------------------------------------------
  // complete() (AC4, AC5)
  // -------------------------------------------------------------------------

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const body: GeminiRequestBody = {
      contents: [],
    }

    this._translateMessages(request, body)
    this._translateTools(request, body)

    const generationConfig: GeminiGenerationConfig = {}
    if (request.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = request.maxTokens
    }
    if (request.temperature !== undefined) {
      generationConfig.temperature = request.temperature
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig
    }

    // Provider escape hatch — merge provider-namespaced extra fields into request body
    if (request.extra?.gemini) {
      Object.assign(body, request.extra.gemini)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeout)

    let rawResponse: Response
    try {
      rawResponse = await fetch(this._buildUrl(request.model, false), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!rawResponse.ok) {
      let errorMessage = `[gemini] ${rawResponse.status}`
      try {
        const errorBody = (await rawResponse.json()) as {
          error?: { message?: string }
        }
        if (errorBody.error?.message) {
          errorMessage = `[gemini] ${rawResponse.status}: ${errorBody.error.message}`
        }
      } catch {
        // Ignore JSON parse errors for error body
      }
      throw new LLMError(errorMessage, rawResponse.status, 'gemini')
    }

    const data = (await rawResponse.json()) as GeminiResponse

    const candidate = data.candidates?.[0]
    const parts = candidate?.content?.parts ?? []

    // AC4: Build synthetic ID map and extract tool calls
    const syntheticIdMap = new Map<string, string>() // synthId → functionName
    const toolCalls: LLMToolCall[] = []
    let content = ''

    for (const part of parts) {
      if ('text' in part && part.text !== undefined) {
        // AC5: Filter out thought parts
        const thoughtPart = part as { text: string; thought?: boolean }
        if (!thoughtPart.thought) {
          content += thoughtPart.text
        }
      } else if ('functionCall' in part) {
        const synthId = `call_${randomUUID()}`
        syntheticIdMap.set(synthId, part.functionCall.name)
        toolCalls.push({
          id: synthId,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
          rawArguments: JSON.stringify(part.functionCall.args),
        })
      }
    }

    const stopReason = this._mapStopReason(candidate?.finishReason, toolCalls.length > 0)
    const usage = this._parseUsage(
      data.usageMetadata ?? { promptTokenCount: 0, candidatesTokenCount: 0 }
    )

    return {
      content,
      toolCalls,
      usage,
      model: request.model,
      stopReason,
      providerMetadata: {
        model: data.modelVersion ?? request.model,
      },
    }
  }

  // -------------------------------------------------------------------------
  // stream() — SSE streaming from Gemini API (AC5 streaming path)
  // -------------------------------------------------------------------------

  async *stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    const body: GeminiRequestBody = {
      contents: [],
    }

    this._translateMessages(request, body)
    this._translateTools(request, body)

    const generationConfig: GeminiGenerationConfig = {}
    if (request.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = request.maxTokens
    }
    if (request.temperature !== undefined) {
      generationConfig.temperature = request.temperature
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig
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
      rawResponse = await fetch(this._buildUrl(request.model, true), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      throw err
    }

    if (!rawResponse.ok) {
      clearTimeout(timer)
      let errorMessage = `[gemini] ${rawResponse.status}`
      try {
        const errorBody = (await rawResponse.json()) as { error?: { message?: string } }
        if (errorBody.error?.message) {
          errorMessage = `[gemini] ${rawResponse.status}: ${errorBody.error.message}`
        }
      } catch {
        // Ignore JSON parse errors for error body
      }
      throw new LLMError(errorMessage, rawResponse.status, 'gemini')
    }

    try {
      const text = await rawResponse.text()
      const lines = text.split('\n')
      let started = false

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue

        const dataStr = trimmed.slice(6).trim()
        if (dataStr === '[DONE]') break

        let chunk: GeminiResponse & {
          candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
        }
        try {
          chunk = JSON.parse(dataStr) as typeof chunk
        } catch {
          continue
        }

        if (!started) {
          started = true
          yield { type: 'message_start' }
        }

        const candidateParts = chunk.candidates?.[0]?.content?.parts ?? []
        for (const part of candidateParts) {
          if ('text' in part && part.text !== undefined) {
            const thoughtPart = part as { text: string; thought?: boolean }
            if (!thoughtPart.thought) {
              yield { type: 'text_delta', delta: thoughtPart.text }
            }
          } else if ('functionCall' in part) {
            const synthId = `call_${randomUUID()}`
            yield {
              type: 'tool_call_delta',
              toolCall: {
                id: synthId,
                name: part.functionCall.name,
                arguments: part.functionCall.args ?? {},
              },
            }
          }
        }

        // Final chunk with usageMetadata
        if (chunk.usageMetadata) {
          const finishReason = chunk.candidates?.[0]?.finishReason as
            | GeminiCandidate['finishReason']
            | undefined
          const hasToolCalls = candidateParts.some((p) => 'functionCall' in p)
          const stopReason = this._mapStopReason(finishReason, hasToolCalls)
          yield {
            type: 'message_stop',
            usage: this._parseUsage(chunk.usageMetadata),
            finishReason: { reason: stopReason },
          }
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
