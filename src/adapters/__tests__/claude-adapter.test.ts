/**
 * Unit tests for ClaudeCodeAdapter (Story 27-9, Tasks 3 and 7).
 *
 * Focuses on OTLP env var injection in buildCommand() when otlpEndpoint is set.
 * Task 7 adds a round-trip test using a real IngestionServer.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { ClaudeCodeAdapter } from '../claude-adapter.js'
import type { AdapterOptions } from '../types.js'
import { IngestionServer } from '../../modules/telemetry/ingestion-server.js'

function makeOptions(overrides: Partial<AdapterOptions> = {}): AdapterOptions {
  return {
    worktreePath: '/tmp/test-worktree',
    billingMode: 'subscription',
    ...overrides,
  }
}

describe('ClaudeCodeAdapter.buildCommand()', () => {
  const adapter = new ClaudeCodeAdapter()

  it('does not include OTLP env vars when otlpEndpoint is not set', () => {
    const cmd = adapter.buildCommand('test prompt', makeOptions())
    expect(cmd.env).not.toHaveProperty('CLAUDE_CODE_ENABLE_TELEMETRY')
    expect(cmd.env).not.toHaveProperty('OTEL_LOGS_EXPORTER')
    expect(cmd.env).not.toHaveProperty('OTEL_METRICS_EXPORTER')
    expect(cmd.env).not.toHaveProperty('OTEL_EXPORTER_OTLP_PROTOCOL')
    expect(cmd.env).not.toHaveProperty('OTEL_EXPORTER_OTLP_ENDPOINT')
  })

  it('injects all OTLP env vars when otlpEndpoint is set', () => {
    const endpoint = 'http://localhost:9317'
    const cmd = adapter.buildCommand('test prompt', makeOptions({ otlpEndpoint: endpoint }))
    expect(cmd.env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_LOG_TOOL_DETAILS: '1',
      OTEL_METRIC_EXPORT_INTERVAL: '10000',
    })
  })

  it('injects OTEL_RESOURCE_ATTRIBUTES when storyKey is set', () => {
    const cmd = adapter.buildCommand('test prompt', makeOptions({
      otlpEndpoint: 'http://localhost:9317',
      storyKey: '28-1',
    }))
    expect(cmd.env?.OTEL_RESOURCE_ATTRIBUTES).toBe('substrate.story_key=28-1')
  })

  it('does not inject OTEL_RESOURCE_ATTRIBUTES when storyKey is not set', () => {
    const cmd = adapter.buildCommand('test prompt', makeOptions({
      otlpEndpoint: 'http://localhost:9317',
    }))
    expect(cmd.env).not.toHaveProperty('OTEL_RESOURCE_ATTRIBUTES')
  })

  it('OTEL_EXPORTER_OTLP_ENDPOINT matches the provided endpoint exactly', () => {
    const endpoint = 'http://localhost:4318'
    const cmd = adapter.buildCommand('prompt', makeOptions({ otlpEndpoint: endpoint }))
    expect(cmd.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(endpoint)
  })

  it('still includes API key env when billingMode=api and otlpEndpoint is set', () => {
    const cmd = adapter.buildCommand(
      'prompt',
      makeOptions({
        billingMode: 'api',
        apiKey: 'sk-test',
        otlpEndpoint: 'http://localhost:4318',
      }),
    )
    expect(cmd.env).toHaveProperty('ANTHROPIC_API_KEY', 'sk-test')
    expect(cmd.env).toHaveProperty('CLAUDE_CODE_ENABLE_TELEMETRY', '1')
  })

  it('builds valid args without prompt in CLI args (prompt goes to stdin)', () => {
    const cmd = adapter.buildCommand('my prompt', makeOptions())
    expect(cmd.args).toContain('-p')
    // Prompt must NOT be in args — avoids E2BIG on large prompts.
    // Dispatcher delivers prompt via stdin instead.
    expect(cmd.args).not.toContain('my prompt')
    expect(cmd.binary).toBe('claude')
  })

  it('does not include --max-context-tokens arg even when maxContextTokens is set (claude CLI v2.x removed the flag)', () => {
    const cmd = adapter.buildCommand('test prompt', makeOptions({ maxContextTokens: 80000 }))
    expect(cmd.args).not.toContain('--max-context-tokens')
  })

  it('does not include --max-context-tokens arg when maxContextTokens is not set', () => {
    const cmd = adapter.buildCommand('test prompt', makeOptions())
    expect(cmd.args).not.toContain('--max-context-tokens')
  })

  // ---------------------------------------------------------------------------
  // Story 30-6: optimizationDirectives injection into system prompt
  // ---------------------------------------------------------------------------

  it('appends optimization directives to system prompt when optimizationDirectives is set', () => {
    const directives = 'OPTIMIZATION (critical): Enable caching. Use prompt caching to reduce costs.'
    const cmd = adapter.buildCommand('test prompt', makeOptions({ optimizationDirectives: directives }))
    const systemPromptIdx = cmd.args.indexOf('--system-prompt')
    expect(systemPromptIdx).toBeGreaterThan(-1)
    const systemPrompt = cmd.args[systemPromptIdx + 1]
    expect(systemPrompt).toContain('## Optimization Directives')
    expect(systemPrompt).toContain(directives)
  })

  it('system prompt contains base prompt text before the directives section', () => {
    const directives = 'OPTIMIZATION (warning): Reduce tool calls.'
    const cmd = adapter.buildCommand('test prompt', makeOptions({ optimizationDirectives: directives }))
    const systemPromptIdx = cmd.args.indexOf('--system-prompt')
    const systemPrompt = cmd.args[systemPromptIdx + 1] ?? ''
    expect(systemPrompt).toContain('You are an autonomous coding agent')
    const baseIndex = systemPrompt.indexOf('You are an autonomous coding agent')
    const headerIndex = systemPrompt.indexOf('## Optimization Directives')
    expect(baseIndex).toBeLessThan(headerIndex)
  })

  it('system prompt is exactly the base prompt when optimizationDirectives is undefined', () => {
    const cmd = adapter.buildCommand('test prompt', makeOptions())
    const systemPromptIdx = cmd.args.indexOf('--system-prompt')
    const systemPrompt = cmd.args[systemPromptIdx + 1] ?? ''
    expect(systemPrompt).not.toContain('## Optimization Directives')
    expect(systemPrompt).toContain('You are an autonomous coding agent')
  })

  it('system prompt is exactly the base prompt when optimizationDirectives is empty string', () => {
    const cmd = adapter.buildCommand('test prompt', makeOptions({ optimizationDirectives: '' }))
    const systemPromptIdx = cmd.args.indexOf('--system-prompt')
    const systemPrompt = cmd.args[systemPromptIdx + 1] ?? ''
    expect(systemPrompt).not.toContain('## Optimization Directives')
    expect(systemPrompt).toContain('You are an autonomous coding agent')
  })
})

// ---------------------------------------------------------------------------
// Task 7: Round-trip test with real IngestionServer
// ---------------------------------------------------------------------------

describe('ClaudeCodeAdapter + IngestionServer round-trip (Story 27-9, Task 7)', () => {
  let server: IngestionServer | null = null

  afterEach(async () => {
    if (server !== null) {
      await server.stop().catch(() => undefined)
      server = null
    }
  })

  it('env vars from getOtlpEnvVars() match those injected by buildCommand()', async () => {
    server = new IngestionServer({ port: 0 })
    await server.start()

    const serverVars = server.getOtlpEnvVars()
    const endpoint = serverVars.OTEL_EXPORTER_OTLP_ENDPOINT!

    const adapter = new ClaudeCodeAdapter()
    const cmd = adapter.buildCommand('prompt', makeOptions({ otlpEndpoint: endpoint }))

    // All 5 env vars from getOtlpEnvVars() should match what buildCommand() injects
    expect(cmd.env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: serverVars.CLAUDE_CODE_ENABLE_TELEMETRY,
      OTEL_LOGS_EXPORTER: serverVars.OTEL_LOGS_EXPORTER,
      OTEL_METRICS_EXPORTER: serverVars.OTEL_METRICS_EXPORTER,
      OTEL_EXPORTER_OTLP_PROTOCOL: serverVars.OTEL_EXPORTER_OTLP_PROTOCOL,
      OTEL_EXPORTER_OTLP_ENDPOINT: serverVars.OTEL_EXPORTER_OTLP_ENDPOINT,
    })
  })
})
