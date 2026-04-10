// packages/factory/src/llm/middleware/logging.ts
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { estimateCostSafe } from '@substrate-ai/core'
import type { LLMRequest, LLMResponse } from '../types.js'
import { deriveProvider, type MiddlewareFn } from './types.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LoggingMiddlewareOptions {
  logsRoot: string
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLoggingMiddleware(options: LoggingMiddlewareOptions): MiddlewareFn {
  const logFile = `${options.logsRoot}/llm-calls.ndjson`
  let dirEnsured = false

  async function ensureDir(): Promise<void> {
    if (!dirEnsured) {
      await mkdir(dirname(logFile), { recursive: true })
      dirEnsured = true
    }
  }

  async function appendLog(record: Record<string, unknown>): Promise<void> {
    await ensureDir()
    await appendFile(logFile, JSON.stringify(record) + '\n', 'utf8')
  }

  return async (request: LLMRequest, next): Promise<LLMResponse> => {
    const start = Date.now()
    try {
      const response = await next(request)
      const durationMs = Date.now() - start
      const provider = deriveProvider(request.model)
      const cost_usd = estimateCostSafe(
        provider,
        request.model,
        response.usage.inputTokens,
        response.usage.outputTokens
      )
      await appendLog({
        timestamp: new Date(start).toISOString(),
        model: request.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cost_usd,
        durationMs,
        status: 'success',
      })
      return response
    } catch (err) {
      const durationMs = Date.now() - start
      const errorMessage = err instanceof Error ? err.message : String(err)
      await appendLog({
        timestamp: new Date(start).toISOString(),
        model: request.model,
        durationMs,
        status: 'error',
        errorMessage,
      })
      throw err
    }
  }
}
