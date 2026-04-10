/**
 * Unit tests for token-extractor.ts
 *
 * Covers: extractTokensFromAttributes(), extractTokensFromBody(), mergeTokenCounts()
 */

import { describe, it, expect } from 'vitest'
import {
  extractTokensFromAttributes,
  extractTokensFromBody,
  mergeTokenCounts,
} from '../token-extractor.js'

// ---------------------------------------------------------------------------
// extractTokensFromAttributes
// ---------------------------------------------------------------------------

describe('extractTokensFromAttributes', () => {
  it('returns empty object for null', () => {
    expect(extractTokensFromAttributes(null)).toEqual({})
  })

  it('returns empty object for undefined', () => {
    expect(extractTokensFromAttributes(undefined)).toEqual({})
  })

  it('returns empty object for empty array', () => {
    expect(extractTokensFromAttributes([])).toEqual({})
  })

  it('extracts anthropic.input_tokens', () => {
    const attrs = [{ key: 'anthropic.input_tokens', value: { intValue: '2048' } }]
    expect(extractTokensFromAttributes(attrs)).toEqual({ input: 2048 })
  })

  it('extracts openai.prompt_token_count', () => {
    const attrs = [{ key: 'openai.prompt_token_count', value: { intValue: '512' } }]
    expect(extractTokensFromAttributes(attrs)).toEqual({ input: 512 })
  })

  it('extracts gen_ai.usage.output_tokens', () => {
    const attrs = [{ key: 'gen_ai.usage.output_tokens', value: { intValue: '100' } }]
    expect(extractTokensFromAttributes(attrs)).toEqual({ output: 100 })
  })

  it('extracts completion_tokens', () => {
    const attrs = [{ key: 'llm.completion_tokens', value: { intValue: '200' } }]
    expect(extractTokensFromAttributes(attrs)).toEqual({ output: 200 })
  })

  it('extracts gen_ai.usage.cache_read_input_tokens', () => {
    const attrs = [{ key: 'gen_ai.usage.cache_read_input_tokens', value: { intValue: '300' } }]
    expect(extractTokensFromAttributes(attrs)).toEqual({ cacheRead: 300 })
  })

  it('extracts cache_creation tokens', () => {
    const attrs = [{ key: 'anthropic.cache_creation_input_tokens', value: { intValue: '400' } }]
    expect(extractTokensFromAttributes(attrs)).toEqual({ cacheCreation: 400 })
  })

  it('extracts all four fields from mixed attribute set', () => {
    const attrs = [
      { key: 'anthropic.input_tokens', value: { intValue: '1000' } },
      { key: 'anthropic.output_tokens', value: { intValue: '200' } },
      { key: 'gen_ai.usage.cache_read_input_tokens', value: { intValue: '500' } },
      { key: 'anthropic.cache_creation_input_tokens', value: { intValue: '50' } },
    ]
    expect(extractTokensFromAttributes(attrs)).toEqual({
      input: 1000,
      output: 200,
      cacheRead: 500,
      cacheCreation: 50,
    })
  })

  it('handles doubleValue', () => {
    const attrs = [{ key: 'input_tokens', value: { doubleValue: 100.5 } }]
    expect(extractTokensFromAttributes(attrs)).toEqual({ input: 100.5 })
  })

  it('handles intValue as string (OTLP format)', () => {
    const attrs = [{ key: 'input_tokens', value: { intValue: '1024' } }]
    expect(extractTokensFromAttributes(attrs)).toEqual({ input: 1024 })
  })

  it('is case-insensitive in key matching', () => {
    const attrs = [{ key: 'INPUT_TOKENS', value: { intValue: '256' } }]
    expect(extractTokensFromAttributes(attrs)).toEqual({ input: 256 })
  })

  it('ignores attributes with no matching pattern', () => {
    const attrs = [{ key: 'service.name', value: { stringValue: 'claude-code' } }]
    expect(extractTokensFromAttributes(attrs)).toEqual({})
  })

  it('takes first matching value for each field', () => {
    const attrs = [
      { key: 'anthropic.input_tokens', value: { intValue: '100' } },
      { key: 'llm.prompt_tokens', value: { intValue: '999' } }, // second match, ignored
    ]
    expect(extractTokensFromAttributes(attrs)).toEqual({ input: 100 })
  })
})

// ---------------------------------------------------------------------------
// extractTokensFromBody
// ---------------------------------------------------------------------------

describe('extractTokensFromBody', () => {
  it('returns empty for null', () => {
    expect(extractTokensFromBody(null)).toEqual({})
  })

  it('returns empty for undefined', () => {
    expect(extractTokensFromBody(undefined)).toEqual({})
  })

  it('returns empty for non-JSON string', () => {
    expect(extractTokensFromBody('not json')).toEqual({})
  })

  it('extracts tokens from flat JSON object', () => {
    const body = JSON.stringify({ input_tokens: 512, output_tokens: 64 })
    expect(extractTokensFromBody(body)).toEqual({ input: 512, output: 64 })
  })

  it('extracts tokens from nested JSON up to depth 4', () => {
    const body = JSON.stringify({
      usage: {
        prompt_tokens: 256,
        completion_tokens: 32,
      },
    })
    expect(extractTokensFromBody(body)).toEqual({ input: 256, output: 32 })
  })

  it('stops at depth 4 (does not extract at depth 5)', () => {
    // depth 0 (root) -> depth 1 -> depth 2 -> depth 3 -> depth 4 -> depth 5 (BLOCKED)
    const body = JSON.stringify({
      a: { b: { c: { d: { input_tokens: 100 } } } },
    })
    // a=1, b=2, c=3, d=4 -> input_tokens at depth 5 is NOT found (> 4)
    const result = extractTokensFromBody(body)
    expect(result.input).toBeUndefined()
  })

  it('extracts tokens from body up to depth 4', () => {
    // a=1, b=2, c=3, input_tokens at depth 4 IS found
    const body = JSON.stringify({
      a: { b: { c: { input_tokens: 100 } } },
    })
    const result = extractTokensFromBody(body)
    expect(result.input).toBe(100)
  })

  it('handles cache_read keys', () => {
    const body = JSON.stringify({ cache_read_input_tokens: 300 })
    expect(extractTokensFromBody(body)).toEqual({ cacheRead: 300 })
  })

  it('handles array in body', () => {
    const body = JSON.stringify([{ input_tokens: 50 }])
    expect(extractTokensFromBody(body)).toEqual({ input: 50 })
  })

  it('handles string numeric values in body', () => {
    const body = JSON.stringify({ prompt_tokens: '128' })
    expect(extractTokensFromBody(body)).toEqual({ input: 128 })
  })
})

// ---------------------------------------------------------------------------
// mergeTokenCounts
// ---------------------------------------------------------------------------

describe('mergeTokenCounts', () => {
  it('returns all zeros when both are empty', () => {
    expect(mergeTokenCounts({}, {})).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    })
  })

  it('attributes take priority over body', () => {
    const fromAttrs = { input: 100 }
    const fromBody = { input: 999, output: 50 }
    expect(mergeTokenCounts(fromAttrs, fromBody)).toEqual({
      input: 100, // from attrs
      output: 50, // from body (attrs missing)
      cacheRead: 0,
      cacheCreation: 0,
    })
  })

  it('fills missing fields from body', () => {
    const fromAttrs = { input: 100 }
    const fromBody = { output: 200, cacheRead: 50, cacheCreation: 10 }
    expect(mergeTokenCounts(fromAttrs, fromBody)).toEqual({
      input: 100,
      output: 200,
      cacheRead: 50,
      cacheCreation: 10,
    })
  })

  it('defaults to 0 when neither source has a field', () => {
    expect(mergeTokenCounts({ input: 1 }, {})).toEqual({
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    })
  })
})
