import { describe, it, expect } from 'vitest'
import { buildProviderConfig } from '../init.js'

describe('buildProviderConfig — disabled routing maps to enabled:false', () => {
  it('enables the provider for auto/subscription/api routing', () => {
    for (const routing of ['auto', 'subscription', 'api'] as const) {
      const cfg = buildProviderConfig('codex', '/usr/bin/codex', routing)
      expect(cfg.enabled).toBe(true)
      expect(cfg.subscription_routing).toBe(routing)
      expect(cfg.cli_path).toBe('/usr/bin/codex')
    }
  })

  it('disables the provider when routing is "disabled"', () => {
    // The bug: picking "disabled" at the init prompt previously left
    // enabled:true, so the provider stayed in play for dispatch/routing.
    const cfg = buildProviderConfig('claude-code', '/usr/bin/claude', 'disabled')
    expect(cfg.enabled).toBe(false)
    expect(cfg.subscription_routing).toBe('disabled')
  })
})
