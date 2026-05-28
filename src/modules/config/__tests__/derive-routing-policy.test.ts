import { describe, it, expect } from 'vitest'
import { deriveRoutingPolicy } from '../derive-routing-policy.js'
import { DEFAULT_ROUTING_POLICY } from '../defaults.js'
import type { ProvidersConfig, ProviderConfig, RoutingPolicy } from '../config-schema.js'

/** Minimal enabled/disabled provider stub — only `enabled` matters here. */
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

describe('deriveRoutingPolicy', () => {
  it('rewrites a claude-first base to Codex-only when only Codex is enabled', () => {
    const result = deriveRoutingPolicy(
      DEFAULT_ROUTING_POLICY,
      providers({ claude: false, codex: true, gemini: false }),
    )

    expect(result.default_provider).toBe('codex')
    for (const rule of result.rules) {
      expect(rule.preferred_provider).toBe('codex')
      expect(rule.fallback_providers).toEqual([])
    }
    // The bug repro: the serialized policy must not mention a disabled provider.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('claude')
    expect(serialized).not.toContain('gemini')
  })

  it('keeps the base default_provider when it is still enabled', () => {
    const result = deriveRoutingPolicy(
      DEFAULT_ROUTING_POLICY,
      providers({ claude: true, codex: true, gemini: false }),
    )

    expect(result.default_provider).toBe('claude')
    // gemini filtered out of every fallback list; codex retained.
    for (const rule of result.rules) {
      expect(rule.fallback_providers).not.toContain('gemini')
    }
    expect(JSON.stringify(result)).not.toContain('gemini')
  })

  it('promotes a fallback to preferred when the rule preferred is disabled', () => {
    // claude disabled, gemini + codex enabled. planning rule was
    // preferred=claude, fallbacks=[gemini, codex] → preferred should become gemini.
    const result = deriveRoutingPolicy(
      DEFAULT_ROUTING_POLICY,
      providers({ claude: false, codex: true, gemini: true }),
    )

    const planning = result.rules.find((r) => r.task_type === 'planning')
    expect(planning?.preferred_provider).toBe('gemini')
    expect(planning?.fallback_providers).toEqual(['codex'])
    // default_provider: base 'claude' disabled → first enabled in canonical order.
    expect(['gemini', 'codex']).toContain(result.default_provider)
  })

  it('appends an enabled provider that the base rule never listed', () => {
    // A base rule whose fallbacks omit codex must still reach codex when it is
    // the only other enabled provider (no enabled provider left unreachable).
    const base: RoutingPolicy = {
      default_provider: 'claude',
      rules: [
        { task_type: 'review', preferred_provider: 'claude', fallback_providers: ['gemini'] },
      ],
    }
    const result = deriveRoutingPolicy(base, providers({ claude: true, codex: true, gemini: false }))

    const review = result.rules.find((r) => r.task_type === 'review')
    expect(review?.preferred_provider).toBe('claude')
    expect(review?.fallback_providers).toEqual(['codex'])
  })

  it('returns the base policy unchanged when no providers are enabled', () => {
    // The no-selection init fallback: DEFAULT_CONFIG.providers are all disabled.
    const result = deriveRoutingPolicy(
      DEFAULT_ROUTING_POLICY,
      providers({ claude: false, codex: false, gemini: false }),
    )
    expect(result).toEqual(DEFAULT_ROUTING_POLICY)
  })

  it('is deterministic regardless of providers key order', () => {
    const a = deriveRoutingPolicy(
      DEFAULT_ROUTING_POLICY,
      providers({ codex: true, gemini: true, claude: false }),
    )
    const b = deriveRoutingPolicy(
      DEFAULT_ROUTING_POLICY,
      providers({ gemini: true, claude: false, codex: true }),
    )
    expect(a).toEqual(b)
  })

  it('does not mutate the base policy', () => {
    const snapshot = structuredClone(DEFAULT_ROUTING_POLICY)
    deriveRoutingPolicy(DEFAULT_ROUTING_POLICY, providers({ codex: true }))
    expect(DEFAULT_ROUTING_POLICY).toEqual(snapshot)
  })

  it('produces a schema-valid policy (preferred not duplicated in fallbacks)', () => {
    const result = deriveRoutingPolicy(
      DEFAULT_ROUTING_POLICY,
      providers({ claude: false, codex: true, gemini: true }),
    )
    for (const rule of result.rules) {
      expect(rule.fallback_providers).not.toContain(rule.preferred_provider)
    }
  })
})
