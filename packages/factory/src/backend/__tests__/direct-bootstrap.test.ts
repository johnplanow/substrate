/**
 * Unit tests for bootstrapDirectBackend.
 *
 * Story 48-12 AC2.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

vi.mock('../../llm/providers/anthropic.js', () => ({
  AnthropicAdapter: vi.fn().mockImplementation((opts) => ({
    _sentinelKind: 'anthropic-adapter',
    _opts: opts,
    complete: vi.fn(),
    stream: vi.fn(),
  })),
}))

vi.mock('../../llm/providers/openai.js', () => ({
  OpenAIAdapter: vi.fn().mockImplementation((opts) => ({
    _sentinelKind: 'openai-adapter',
    _opts: opts,
    complete: vi.fn(),
    stream: vi.fn(),
  })),
}))

vi.mock('../../llm/providers/gemini.js', () => ({
  GeminiAdapter: vi.fn().mockImplementation((opts) => ({
    _sentinelKind: 'gemini-adapter',
    _opts: opts,
    complete: vi.fn(),
    stream: vi.fn(),
  })),
}))

// Capture options passed to createDirectCodergenBackend
let capturedDirectBackendOptions: unknown = undefined
vi.mock('../../backend/direct-backend.js', () => ({
  createDirectCodergenBackend: vi.fn().mockImplementation((opts) => {
    capturedDirectBackendOptions = opts
    return { _sentinelKind: 'direct-codergen-backend', options: opts }
  }),
  DirectCodergenBackend: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bootstrapDirectBackend', () => {
  beforeEach(() => {
    capturedDirectBackendOptions = undefined
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('provider=anthropic + ANTHROPIC_API_KEY set → AnthropicAdapter with apiKey, createDirectCodergenBackend with AnthropicProfile', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-anthropic')

    const { bootstrapDirectBackend } = await import('../direct-bootstrap.js')
    const { AnthropicAdapter } = await import('../../llm/providers/anthropic.js')

    const result = bootstrapDirectBackend({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      maxTurns: 20,
      projectDir: '/tmp/test',
    })

    expect(result).toBeDefined()
    expect(vi.mocked(AnthropicAdapter)).toHaveBeenCalledWith({ apiKey: 'test-key-anthropic' })

    const opts = capturedDirectBackendOptions as { providerProfile: { id: string } }
    expect(opts.providerProfile.id).toBe('anthropic')
  })

  it('provider=openai + OPENAI_API_KEY set → OpenAIAdapter with apiKey, createDirectCodergenBackend with OpenAIProfile', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key-openai')

    const { bootstrapDirectBackend } = await import('../direct-bootstrap.js')
    const { OpenAIAdapter } = await import('../../llm/providers/openai.js')

    const result = bootstrapDirectBackend({
      provider: 'openai',
      model: 'gpt-4o',
      maxTurns: 10,
      projectDir: '/tmp/test',
    })

    expect(result).toBeDefined()
    expect(vi.mocked(OpenAIAdapter)).toHaveBeenCalledWith({ apiKey: 'test-key-openai' })

    const opts = capturedDirectBackendOptions as { providerProfile: { id: string } }
    expect(opts.providerProfile.id).toBe('openai')
  })

  it('provider=gemini + GEMINI_API_KEY set → GeminiAdapter with apiKey, createDirectCodergenBackend with GeminiProfile', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key-gemini')

    const { bootstrapDirectBackend } = await import('../direct-bootstrap.js')
    const { GeminiAdapter } = await import('../../llm/providers/gemini.js')

    const result = bootstrapDirectBackend({
      provider: 'gemini',
      model: 'gemini-1.5-pro',
      maxTurns: 15,
      projectDir: '/tmp/test',
    })

    expect(result).toBeDefined()
    expect(vi.mocked(GeminiAdapter)).toHaveBeenCalledWith({ apiKey: 'test-key-gemini' })

    const opts = capturedDirectBackendOptions as { providerProfile: { id: string } }
    expect(opts.providerProfile.id).toBe('gemini')
  })

  it('provider=anthropic with ANTHROPIC_API_KEY unset → throws with message containing ANTHROPIC_API_KEY', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    // Ensure the env var is actually missing
    process.env['ANTHROPIC_API_KEY'] = ''

    const { bootstrapDirectBackend } = await import('../direct-bootstrap.js')

    // Set to empty string — provider checks for undefined/empty
    vi.stubEnv('ANTHROPIC_API_KEY', '')

    // Actually delete it to simulate "unset"
    const savedKey = process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']

    try {
      expect(() =>
        bootstrapDirectBackend({
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          maxTurns: 20,
          projectDir: '/tmp/test',
        })
      ).toThrow('ANTHROPIC_API_KEY')
    } finally {
      if (savedKey !== undefined) {
        process.env['ANTHROPIC_API_KEY'] = savedKey
      }
    }
  })

  it('provider=openai with OPENAI_API_KEY unset → throws with message containing OPENAI_API_KEY', async () => {
    const savedKey = process.env['OPENAI_API_KEY']
    delete process.env['OPENAI_API_KEY']

    const { bootstrapDirectBackend } = await import('../direct-bootstrap.js')

    try {
      expect(() =>
        bootstrapDirectBackend({
          provider: 'openai',
          model: 'gpt-4o',
          maxTurns: 10,
          projectDir: '/tmp/test',
        })
      ).toThrow('OPENAI_API_KEY')
    } finally {
      if (savedKey !== undefined) {
        process.env['OPENAI_API_KEY'] = savedKey
      }
    }
  })

  it('unknown provider string → throws Error containing "Unknown direct backend provider"', async () => {
    const { bootstrapDirectBackend } = await import('../direct-bootstrap.js')

    expect(() =>
      bootstrapDirectBackend({
        provider: 'unknown-provider',
        model: 'some-model',
        maxTurns: 5,
        projectDir: '/tmp/test',
      })
    ).toThrow('Unknown direct backend provider')
  })

  it('maxTurns is forwarded to createDirectCodergenBackend config', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')

    const { bootstrapDirectBackend } = await import('../direct-bootstrap.js')

    bootstrapDirectBackend({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      maxTurns: 5,
      projectDir: '/tmp/test',
    })

    const opts = capturedDirectBackendOptions as { config: { max_turns: number } }
    expect(opts.config.max_turns).toBe(5)
  })

  it('onEvent callback is forwarded unchanged to createDirectCodergenBackend options', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')

    const { bootstrapDirectBackend } = await import('../direct-bootstrap.js')

    const onEvent = vi.fn()

    bootstrapDirectBackend({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      maxTurns: 20,
      projectDir: '/tmp/test',
      onEvent,
    })

    const opts = capturedDirectBackendOptions as { onEvent: typeof onEvent }
    expect(opts.onEvent).toBe(onEvent)
  })
})
