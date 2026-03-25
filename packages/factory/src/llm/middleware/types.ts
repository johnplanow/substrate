// packages/factory/src/llm/middleware/types.ts
// Pure TypeScript types + pure logic for buildMiddlewareChain.
// Zero runtime imports — only type imports from sibling modules.
import type { LLMRequest, LLMResponse } from '../types.js'

// ---------------------------------------------------------------------------
// Core middleware types
// ---------------------------------------------------------------------------

export type MiddlewareNext = (request: LLMRequest) => Promise<LLMResponse>
export type MiddlewareFn = (request: LLMRequest, next: MiddlewareNext) => Promise<LLMResponse>

// ---------------------------------------------------------------------------
// Cost record
// ---------------------------------------------------------------------------

export interface CostRecord {
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  timestamp: number
}

// ---------------------------------------------------------------------------
// HTTP error type
// ---------------------------------------------------------------------------

export interface LLMHttpError extends Error {
  statusCode: number
  retryable?: boolean
}

// ---------------------------------------------------------------------------
// Provider prefix resolver (shared by logging + cost-tracking middleware)
// ---------------------------------------------------------------------------

export function deriveProvider(model: string): string {
  if (/^claude-/i.test(model)) return 'anthropic'
  if (/^gpt-/i.test(model) || /^o\d(-|$)/i.test(model)) return 'openai'
  if (/^gemini-/i.test(model)) return 'gemini'
  return ''
}

// ---------------------------------------------------------------------------
// Chain builder
// ---------------------------------------------------------------------------

/**
 * Composes middleware into a single next-function.
 * First middleware in the array is the outermost wrapper (runs first / last to finish).
 * Implemented via reduceRight so the array order matches onion semantics.
 */
export function buildMiddlewareChain(
  middleware: MiddlewareFn[],
  base: MiddlewareNext,
): MiddlewareNext {
  return middleware.reduceRight<MiddlewareNext>(
    (next, mw) => (req) => mw(req, next),
    base,
  )
}
