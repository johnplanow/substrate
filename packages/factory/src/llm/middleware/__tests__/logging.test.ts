// packages/factory/src/llm/middleware/__tests__/logging.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoggingMiddleware } from '../logging.js'
import type { LLMRequest, LLMResponse } from '../../types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRequest(model = 'claude-opus-4-6'): LLMRequest {
  return {
    model,
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'hello' }] }],
  }
}

function makeResponse(
  inputTokens = 100,
  outputTokens = 50,
  model = 'claude-opus-4-6'
): LLMResponse {
  return {
    content: 'test response',
    toolCalls: [],
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    model,
    stopReason: 'stop',
    providerMetadata: {},
  }
}

function makeError(message: string, statusCode?: number): Error {
  const err = new Error(message) as Error & { statusCode?: number }
  if (statusCode !== undefined) err.statusCode = statusCode
  return err
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createLoggingMiddleware', () => {
  let logsRoot: string
  let logFile: string

  beforeEach(async () => {
    logsRoot = join(
      tmpdir(),
      `logging-mw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    logFile = join(logsRoot, 'llm-calls.ndjson')
    // Do NOT pre-create the directory — the middleware must handle it
  })

  afterEach(async () => {
    await rm(logsRoot, { recursive: true, force: true })
  })

  it('AC1: success path writes correct NDJSON fields', async () => {
    const mw = createLoggingMiddleware({ logsRoot })
    const request = makeRequest('claude-opus-4-6')
    const response = makeResponse(100, 50, 'claude-opus-4-6')

    await mw(request, async () => response)

    const content = await readFile(logFile, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]!)

    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(record.model).toBe('claude-opus-4-6')
    expect(record.inputTokens).toBe(100)
    expect(record.outputTokens).toBe(50)
    expect(typeof record.cost_usd).toBe('number')
    expect(typeof record.durationMs).toBe('number')
    expect(record.status).toBe('success')
  })

  it('AC2: error path writes status: error and errorMessage, then re-throws', async () => {
    const mw = createLoggingMiddleware({ logsRoot })
    const request = makeRequest('claude-opus-4-6')
    const err = makeError('test error')

    await expect(
      mw(request, async () => {
        throw err
      })
    ).rejects.toThrow('test error')

    const content = await readFile(logFile, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]!)

    expect(record.status).toBe('error')
    expect(record.errorMessage).toBe('test error')
    expect(typeof record.durationMs).toBe('number')
  })

  it('AC1+2: durationMs is a positive number in both success and error paths', async () => {
    const mw = createLoggingMiddleware({ logsRoot })
    const request = makeRequest()

    // Success
    await mw(request, async () => makeResponse())

    // Error
    await expect(
      mw(request, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow()

    const content = await readFile(logFile, 'utf8')
    const lines = content.trim().split('\n')
    for (const line of lines) {
      const record = JSON.parse(line)
      expect(record.durationMs).toBeGreaterThanOrEqual(0)
      expect(typeof record.durationMs).toBe('number')
    }
  })

  it('creates the log file if it does not exist (directory auto-created)', async () => {
    const mw = createLoggingMiddleware({ logsRoot })
    const request = makeRequest()

    await mw(request, async () => makeResponse())

    const content = await readFile(logFile, 'utf8')
    expect(content.length).toBeGreaterThan(0)
  })

  it('multiple calls append lines (N calls = N lines)', async () => {
    const mw = createLoggingMiddleware({ logsRoot })
    const request = makeRequest()

    for (let i = 0; i < 3; i++) {
      await mw(request, async () => makeResponse())
    }

    const content = await readFile(logFile, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
  })

  it('cost_usd is 0 for an unknown model and positive for claude-opus-4-6', async () => {
    const mw = createLoggingMiddleware({ logsRoot })

    // Unknown model
    await mw(makeRequest('unknown-model-xyz'), async () =>
      makeResponse(100, 50, 'unknown-model-xyz')
    )

    // Known model
    await mw(makeRequest('claude-opus-4-6'), async () => makeResponse(100, 50, 'claude-opus-4-6'))

    const content = await readFile(logFile, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)

    const unknown = JSON.parse(lines[0]!)
    const known = JSON.parse(lines[1]!)

    expect(unknown.cost_usd).toBe(0)
    expect(known.cost_usd).toBeGreaterThan(0)
  })
})
