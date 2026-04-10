/**
 * Unit tests for normalizer.ts — TelemetryNormalizer
 *
 * Covers: Claude Code OTLP traces, Codex OTLP payloads, body fallback,
 * malformed payloads, cost computation, and log normalization.
 */

import { describe, it, expect, vi } from 'vitest'
import type pino from 'pino'
import { TelemetryNormalizer } from '../normalizer.js'

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

function makeMockLogger(): pino.Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as pino.Logger
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLAUDE_CODE_TRACE = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'claude-code' } },
          { key: 'substrate.story_key', value: { stringValue: '27-10' } },
        ],
      },
      scopeSpans: [
        {
          spans: [
            {
              spanId: 'abc123',
              traceId: 'trace456',
              parentSpanId: 'parent789',
              name: 'LLM.call',
              startTimeUnixNano: '1709900000000000000',
              endTimeUnixNano: '1709900005000000000',
              attributes: [
                {
                  key: 'gen_ai.request.model',
                  value: { stringValue: 'claude-3-5-sonnet-20241022' },
                },
                { key: 'anthropic.input_tokens', value: { intValue: '2048' } },
                { key: 'anthropic.output_tokens', value: { intValue: '512' } },
                { key: 'gen_ai.usage.cache_read_input_tokens', value: { intValue: '1000' } },
                { key: 'anthropic.cache_creation_input_tokens', value: { intValue: '100' } },
              ],
              events: [],
            },
          ],
        },
      ],
    },
  ],
}

const CODEX_TRACE = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'codex-agent' } }],
      },
      scopeSpans: [
        {
          spans: [
            {
              spanId: 'codex-span-1',
              traceId: 'codex-trace-1',
              name: 'openai.chat_completion',
              startTimeUnixNano: '1709900000000000000',
              endTimeUnixNano: '1709900002000000000',
              attributes: [
                { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4-turbo' } },
                { key: 'openai.prompt_token_count', value: { intValue: '1024' } },
                { key: 'llm.completion_tokens', value: { intValue: '256' } },
              ],
            },
          ],
        },
      ],
    },
  ],
}

const LOGS_PAYLOAD = {
  resourceLogs: [
    {
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }],
      },
      scopeLogs: [
        {
          logRecords: [
            {
              logRecordId: 'log-001',
              traceId: 'trace-log-1',
              spanId: 'span-log-1',
              timeUnixNano: '1709900000000000000',
              severityText: 'INFO',
              body: { stringValue: '{"event": "tool_use"}' },
              attributes: [
                { key: 'event.name', value: { stringValue: 'tool_call' } },
                { key: 'session.id', value: { stringValue: 'session-abc' } },
                { key: 'tool.name', value: { stringValue: 'Read' } },
                {
                  key: 'gen_ai.request.model',
                  value: { stringValue: 'claude-3-5-sonnet-20241022' },
                },
                { key: 'anthropic.input_tokens', value: { intValue: '500' } },
                { key: 'anthropic.output_tokens', value: { intValue: '50' } },
              ],
            },
          ],
        },
      ],
    },
  ],
}

// ---------------------------------------------------------------------------
// TelemetryNormalizer.normalizeSpan
// ---------------------------------------------------------------------------

describe('TelemetryNormalizer.normalizeSpan', () => {
  it('returns empty array for null input', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    expect(normalizer.normalizeSpan(null)).toEqual([])
  })

  it('returns empty array for non-object input', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    expect(normalizer.normalizeSpan('not-an-object')).toEqual([])
    expect(normalizer.normalizeSpan(42)).toEqual([])
  })

  it('returns empty array for malformed OTLP (no resourceSpans)', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    expect(normalizer.normalizeSpan({ foo: 'bar' })).toEqual([])
  })

  it('never throws on malformed input', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    expect(() => normalizer.normalizeSpan({ resourceSpans: 'not-array' })).not.toThrow()
    expect(() => normalizer.normalizeSpan({ resourceSpans: [null] })).not.toThrow()
    expect(() =>
      normalizer.normalizeSpan({ resourceSpans: [{ scopeSpans: [{ spans: [null] }] }] })
    ).not.toThrow()
  })

  it('normalizes a Claude Code OTLP trace correctly', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    const spans = normalizer.normalizeSpan(CLAUDE_CODE_TRACE)

    expect(spans).toHaveLength(1)
    const span = spans[0]

    expect(span.spanId).toBe('abc123')
    expect(span.traceId).toBe('trace456')
    expect(span.parentSpanId).toBe('parent789')
    expect(span.name).toBe('LLM.call')
    expect(span.source).toBe('claude-code')
    expect(span.model).toBe('claude-3-5-sonnet-20241022')
    expect(span.provider).toBe('anthropic')
    expect(span.storyKey).toBe('27-10')
    expect(span.inputTokens).toBe(2048)
    expect(span.outputTokens).toBe(512)
    expect(span.cacheReadTokens).toBe(1000)
    expect(span.cacheCreationTokens).toBe(100)
    expect(span.costUsd).toBeGreaterThan(0)
    expect(span.durationMs).toBe(5000)
    expect(span.startTime).toBe(1709900000000)
    expect(span.endTime).toBe(1709900005000)
  })

  it('normalizes a Codex OTLP trace correctly', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    const spans = normalizer.normalizeSpan(CODEX_TRACE)

    expect(spans).toHaveLength(1)
    const span = spans[0]

    expect(span.source).toBe('codex')
    expect(span.model).toBe('gpt-4-turbo')
    expect(span.inputTokens).toBe(1024)
    expect(span.outputTokens).toBe(256)
    expect(span.cacheReadTokens).toBe(0)
    expect(span.cacheCreationTokens).toBe(0)
    expect(span.costUsd).toBeGreaterThan(0)
  })

  it('defaults missing numeric fields to 0', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  spanId: 'test-span',
                  traceId: 'test-trace',
                  name: 'test',
                  startTimeUnixNano: '1709900000000000000',
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    }
    const spans = normalizer.normalizeSpan(payload)
    expect(spans).toHaveLength(1)
    expect(spans[0].inputTokens).toBe(0)
    expect(spans[0].outputTokens).toBe(0)
    expect(spans[0].cacheReadTokens).toBe(0)
    expect(spans[0].cacheCreationTokens).toBe(0)
    expect(spans[0].costUsd).toBe(0)
  })

  it('uses body fallback when token attributes are absent', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  spanId: 'body-span',
                  traceId: 'body-trace',
                  name: 'LLM.call',
                  startTimeUnixNano: '1709900000000000000',
                  attributes: [
                    {
                      key: 'gen_ai.request.model',
                      value: { stringValue: 'claude-3-5-sonnet-20241022' },
                    },
                    {
                      key: 'llm.response.body',
                      value: {
                        stringValue: JSON.stringify({
                          usage: { input_tokens: 256, output_tokens: 64 },
                        }),
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    const spans = normalizer.normalizeSpan(payload)
    expect(spans).toHaveLength(1)
    expect(spans[0].inputTokens).toBe(256)
    expect(spans[0].outputTokens).toBe(64)
  })

  it('computes cost correctly for claude-3-5-sonnet-20241022', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  spanId: 'cost-span',
                  traceId: 'cost-trace',
                  name: 'LLM.call',
                  startTimeUnixNano: '1709900000000000000',
                  attributes: [
                    {
                      key: 'gen_ai.request.model',
                      value: { stringValue: 'claude-3-5-sonnet-20241022' },
                    },
                    { key: 'anthropic.input_tokens', value: { intValue: '1000000' } },
                    { key: 'anthropic.output_tokens', value: { intValue: '0' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    const spans = normalizer.normalizeSpan(payload)
    // 1M input tokens at $3.00/M = $3.00
    expect(spans[0].costUsd).toBeCloseTo(3.0, 5)
  })

  it('handles multiple spans across multiple resource spans', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                { spanId: 'a', traceId: 't', name: 'n1', startTimeUnixNano: '1', attributes: [] },
                { spanId: 'b', traceId: 't', name: 'n2', startTimeUnixNano: '1', attributes: [] },
              ],
            },
          ],
        },
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                { spanId: 'c', traceId: 't', name: 'n3', startTimeUnixNano: '1', attributes: [] },
              ],
            },
          ],
        },
      ],
    }
    const spans = normalizer.normalizeSpan(payload)
    expect(spans).toHaveLength(3)
    expect(spans.map((s) => s.spanId)).toEqual(['a', 'b', 'c'])
  })
})

// ---------------------------------------------------------------------------
// TelemetryNormalizer.normalizeLog
// ---------------------------------------------------------------------------

describe('TelemetryNormalizer.normalizeLog', () => {
  it('returns empty array for null input', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    expect(normalizer.normalizeLog(null)).toEqual([])
  })

  it('returns empty array for malformed input (no resourceLogs)', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    expect(normalizer.normalizeLog({ foo: 'bar' })).toEqual([])
  })

  it('never throws on malformed input', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    expect(() => normalizer.normalizeLog({ resourceLogs: 'not-array' })).not.toThrow()
    expect(() => normalizer.normalizeLog({ resourceLogs: [null] })).not.toThrow()
  })

  it('normalizes a log record correctly', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    const logs = normalizer.normalizeLog(LOGS_PAYLOAD)

    expect(logs).toHaveLength(1)
    const log = logs[0]

    expect(log.logId).toBe('log-001')
    expect(log.traceId).toBe('trace-log-1')
    expect(log.spanId).toBe('span-log-1')
    expect(log.timestamp).toBe(1709900000000)
    expect(log.severity).toBe('INFO')
    expect(log.eventName).toBe('tool_call')
    expect(log.sessionId).toBe('session-abc')
    expect(log.toolName).toBe('Read')
    expect(log.model).toBe('claude-3-5-sonnet-20241022')
    expect(log.inputTokens).toBe(500)
    expect(log.outputTokens).toBe(50)
    expect(log.cacheReadTokens).toBe(0)
    expect(log.costUsd).toBeGreaterThan(0)
  })

  it('generates a logId when logRecordId is absent', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    const payload = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1709900000000000000',
                  severityText: 'DEBUG',
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    }
    const logs = normalizer.normalizeLog(payload)
    expect(logs).toHaveLength(1)
    expect(logs[0].logId).toBeTruthy()
    expect(typeof logs[0].logId).toBe('string')
  })

  it('defaults missing numeric fields to 0', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    const payload = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                {
                  logRecordId: 'r1',
                  timeUnixNano: '1709900000000000000',
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    }
    const logs = normalizer.normalizeLog(payload)
    expect(logs[0].inputTokens).toBe(0)
    expect(logs[0].outputTokens).toBe(0)
    expect(logs[0].cacheReadTokens).toBe(0)
    expect(logs[0].costUsd).toBe(0)
  })

  it('extracts body string from stringValue wrapper', () => {
    const normalizer = new TelemetryNormalizer(makeMockLogger())
    const payload = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                {
                  logRecordId: 'r2',
                  timeUnixNano: '1709900000000000000',
                  body: { stringValue: 'hello world' },
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    }
    const logs = normalizer.normalizeLog(payload)
    expect(logs[0].body).toBe('hello world')
  })
})
