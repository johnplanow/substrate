/**
 * Unit tests for source-detector (Story 27-12, Task 6).
 *
 * Verifies detectSource() correctly identifies OTLP sources from
 * resourceSpans and resourceLogs payloads.
 */

import { describe, it, expect } from 'vitest'
import { detectSource } from '../source-detector.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResourceSpansPayload(serviceName: string) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: { stringValue: serviceName },
            },
          ],
        },
        scopeSpans: [],
      },
    ],
  }
}

function makeResourceLogsPayload(serviceName: string) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: { stringValue: serviceName },
            },
          ],
        },
        scopeLogs: [],
      },
    ],
  }
}

function makePayloadWithSdkName(sdkName: string) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: 'telemetry.sdk.name',
              value: { stringValue: sdkName },
            },
          ],
        },
        scopeSpans: [],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectSource', () => {
  // -- claude-code detection --

  it('detects claude-code from service.name = "claude-code"', () => {
    expect(detectSource(makeResourceSpansPayload('claude-code'))).toBe('claude-code')
  })

  it('detects claude-code from service.name = "Claude Code"', () => {
    expect(detectSource(makeResourceSpansPayload('Claude Code'))).toBe('claude-code')
  })

  it('detects claude-code from service.name containing "claude"', () => {
    expect(detectSource(makeResourceSpansPayload('my-claude-agent'))).toBe('claude-code')
  })

  it('detects claude-code from resourceLogs payload', () => {
    expect(detectSource(makeResourceLogsPayload('claude-code'))).toBe('claude-code')
  })

  // -- codex detection --

  it('detects codex from service.name = "codex"', () => {
    expect(detectSource(makeResourceSpansPayload('codex'))).toBe('codex')
  })

  it('detects codex from service.name containing "openai"', () => {
    expect(detectSource(makeResourceSpansPayload('openai-agent'))).toBe('codex')
  })

  it('detects codex from service.name = "OpenAI Codex"', () => {
    expect(detectSource(makeResourceSpansPayload('OpenAI Codex'))).toBe('codex')
  })

  // -- local-llm detection --

  it('detects local-llm from service.name containing "ollama"', () => {
    expect(detectSource(makeResourceSpansPayload('ollama-service'))).toBe('local-llm')
  })

  it('detects local-llm from service.name containing "llama"', () => {
    expect(detectSource(makeResourceSpansPayload('llama-cpp'))).toBe('local-llm')
  })

  it('detects local-llm from service.name containing "local"', () => {
    expect(detectSource(makeResourceSpansPayload('local-model'))).toBe('local-llm')
  })

  // -- unknown fallback --

  it('returns unknown for unrecognized service.name', () => {
    expect(detectSource(makeResourceSpansPayload('my-custom-service'))).toBe('unknown')
  })

  it('returns unknown for empty payload', () => {
    expect(detectSource({})).toBe('unknown')
  })

  it('returns unknown for null input', () => {
    expect(detectSource(null)).toBe('unknown')
  })

  it('returns unknown for non-object input', () => {
    expect(detectSource('string-input')).toBe('unknown')
  })

  it('returns unknown for payload with empty resourceSpans', () => {
    expect(detectSource({ resourceSpans: [] })).toBe('unknown')
  })

  it('returns unknown for payload with no service.name attribute', () => {
    expect(detectSource({
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'other.key', value: { stringValue: 'value' } },
          ],
        },
      }],
    })).toBe('unknown')
  })

  // -- telemetry.sdk.name attribute --

  it('detects claude-code from telemetry.sdk.name containing "claude"', () => {
    expect(detectSource(makePayloadWithSdkName('claude-sdk'))).toBe('claude-code')
  })

  // -- edge cases --

  it('handles malformed attribute value gracefully', () => {
    const payload = {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: null },
          ],
        },
      }],
    }
    expect(detectSource(payload)).toBe('unknown')
  })

  it('handles missing resource gracefully', () => {
    const payload = {
      resourceSpans: [{ scopeSpans: [] }],
    }
    expect(detectSource(payload)).toBe('unknown')
  })
})
