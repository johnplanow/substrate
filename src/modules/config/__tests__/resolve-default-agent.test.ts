import { describe, it, expect } from 'vitest'
import { resolveDefaultAgentId } from '../resolve-default-agent.js'
import type { ProvidersConfig, ProviderConfig } from '../config-schema.js'

function provider(enabled: boolean): ProviderConfig {
  return {
    enabled,
    subscription_routing: 'auto',
    max_concurrent: 2,
    api_key_env: 'X',
    api_billing: false,
  }
}

function providers(flags: Record<string, boolean>): ProvidersConfig {
  const out: ProvidersConfig = {}
  for (const [key, enabled] of Object.entries(flags)) {
    out[key as keyof ProvidersConfig] = provider(enabled)
  }
  return out
}

describe('resolveDefaultAgentId', () => {
  it('returns the single enabled provider mapped to its agent id (Codex-only)', () => {
    const result = resolveDefaultAgentId(providers({ claude: false, codex: true, gemini: false }))
    expect(result.agentId).toBe('codex')
    expect(result.error).toBeUndefined()
  })

  it('maps claude provider to the claude-code agent id', () => {
    const result = resolveDefaultAgentId(providers({ claude: true, codex: false, gemini: false }))
    expect(result.agentId).toBe('claude-code')
  })

  it('prefers Claude when multiple providers are enabled', () => {
    const result = resolveDefaultAgentId(providers({ claude: true, codex: true, gemini: true }))
    expect(result.agentId).toBe('claude-code')
  })

  it('prefers Codex over Gemini when Claude is disabled', () => {
    const result = resolveDefaultAgentId(providers({ claude: false, codex: true, gemini: true }))
    expect(result.agentId).toBe('codex')
  })

  it('returns a clear error when no provider is enabled', () => {
    const result = resolveDefaultAgentId(providers({ claude: false, codex: false, gemini: false }))
    expect(result.agentId).toBeUndefined()
    expect(result.error).toMatch(/no enabled providers/i)
    expect(result.error).toMatch(/--agent/)
  })

  it('is independent of providers key order', () => {
    const a = resolveDefaultAgentId(providers({ gemini: true, codex: true, claude: false }))
    const b = resolveDefaultAgentId(providers({ codex: true, gemini: true, claude: false }))
    expect(a.agentId).toBe('codex')
    expect(b.agentId).toBe('codex')
  })
})
