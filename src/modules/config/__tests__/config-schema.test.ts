/**
 * Unit tests for config-schema.ts
 *
 * Validates that:
 *  - SubstrateConfigSchema accepts valid configs
 *  - SubstrateConfigSchema rejects invalid configs with clear errors
 *  - ProviderConfigSchema validates all fields
 *  - RoutingPolicySchema validates routing rules
 *  - PartialSubstrateConfigSchema accepts partial configs
 */

import { describe, it, expect } from 'vitest'
import {
  SubstrateConfigSchema,
  ProviderConfigSchema,
  RoutingPolicySchema,
  PartialSubstrateConfigSchema,
  GlobalSettingsSchema,
  SubscriptionRoutingSchema,
  RateLimitSchema,
} from '../config-schema.js'
import type { SubstrateConfig } from '../config-schema.js'
import { DEFAULT_CONFIG } from '../defaults.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// SubstrateConfigSchema
// ---------------------------------------------------------------------------

describe('SubstrateConfigSchema', () => {
  it('accepts the built-in default config', () => {
    const result = SubstrateConfigSchema.safeParse(DEFAULT_CONFIG)
    expect(result.success).toBe(true)
  })

  it('requires config_format_version', () => {
    const cfg = makeValidConfig()
    const { config_format_version: _, ...rest } = cfg
    const result = SubstrateConfigSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('rejects unknown config_format_version', () => {
    const cfg = { ...makeValidConfig(), config_format_version: '99' }
    const result = SubstrateConfigSchema.safeParse(cfg)
    expect(result.success).toBe(false)
  })

  it('accepts config_format_version "1"', () => {
    const cfg = makeValidConfig({ config_format_version: '1' })
    const result = SubstrateConfigSchema.safeParse(cfg)
    expect(result.success).toBe(true)
  })

  it('requires global section', () => {
    const { global: _, ...rest } = makeValidConfig()
    const result = SubstrateConfigSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('requires providers section', () => {
    const { providers: _, ...rest } = makeValidConfig()
    const result = SubstrateConfigSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('rejects extra top-level fields (strict)', () => {
    const cfg = { ...makeValidConfig(), unknownField: true }
    const result = SubstrateConfigSchema.safeParse(cfg)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GlobalSettingsSchema
// ---------------------------------------------------------------------------

describe('GlobalSettingsSchema', () => {
  it('accepts valid global settings', () => {
    const result = GlobalSettingsSchema.safeParse(DEFAULT_CONFIG.global)
    expect(result.success).toBe(true)
  })

  it('rejects invalid log_level', () => {
    const result = GlobalSettingsSchema.safeParse({
      ...DEFAULT_CONFIG.global,
      log_level: 'verbose',
    })
    expect(result.success).toBe(false)
  })

  it('accepts all valid log levels', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      const result = GlobalSettingsSchema.safeParse({
        ...DEFAULT_CONFIG.global,
        log_level: level,
      })
      expect(result.success).toBe(true)
    }
  })

  it('rejects max_concurrent_tasks less than 1', () => {
    const result = GlobalSettingsSchema.safeParse({
      ...DEFAULT_CONFIG.global,
      max_concurrent_tasks: 0,
    })
    expect(result.success).toBe(false)
  })

  it('rejects max_concurrent_tasks greater than 64', () => {
    const result = GlobalSettingsSchema.safeParse({
      ...DEFAULT_CONFIG.global,
      max_concurrent_tasks: 65,
    })
    expect(result.success).toBe(false)
  })

  it('accepts max_concurrent_tasks = 1 (min boundary)', () => {
    const result = GlobalSettingsSchema.safeParse({
      ...DEFAULT_CONFIG.global,
      max_concurrent_tasks: 1,
    })
    expect(result.success).toBe(true)
  })

  it('accepts max_concurrent_tasks = 64 (max boundary)', () => {
    const result = GlobalSettingsSchema.safeParse({
      ...DEFAULT_CONFIG.global,
      max_concurrent_tasks: 64,
    })
    expect(result.success).toBe(true)
  })

  it('rejects negative budget_cap_tokens', () => {
    const result = GlobalSettingsSchema.safeParse({
      ...DEFAULT_CONFIG.global,
      budget_cap_tokens: -1,
    })
    expect(result.success).toBe(false)
  })

  it('rejects negative budget_cap_usd', () => {
    const result = GlobalSettingsSchema.safeParse({
      ...DEFAULT_CONFIG.global,
      budget_cap_usd: -0.01,
    })
    expect(result.success).toBe(false)
  })

  it('accepts budget_cap_tokens = 0 (unlimited)', () => {
    const result = GlobalSettingsSchema.safeParse({
      ...DEFAULT_CONFIG.global,
      budget_cap_tokens: 0,
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ProviderConfigSchema
// ---------------------------------------------------------------------------

describe('ProviderConfigSchema', () => {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const validProvider = DEFAULT_CONFIG.providers.claude!

  it('accepts valid claude provider', () => {
    const result = ProviderConfigSchema.safeParse(validProvider)
    expect(result.success).toBe(true)
  })

  it('accepts valid codex provider', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const result = ProviderConfigSchema.safeParse(DEFAULT_CONFIG.providers.codex!)
    expect(result.success).toBe(true)
  })

  it('rejects invalid subscription_routing value', () => {
    const result = ProviderConfigSchema.safeParse({
      ...validProvider,
      subscription_routing: 'manual',
    })
    expect(result.success).toBe(false)
  })

  it('accepts all valid subscription_routing values', () => {
    for (const routing of ['auto', 'subscription', 'api', 'disabled']) {
      const result = ProviderConfigSchema.safeParse({
        ...validProvider,
        subscription_routing: routing,
      })
      expect(result.success).toBe(true)
    }
  })

  it('rejects max_concurrent < 1', () => {
    const result = ProviderConfigSchema.safeParse({
      ...validProvider,
      max_concurrent: 0,
    })
    expect(result.success).toBe(false)
  })

  it('rejects max_concurrent > 32', () => {
    const result = ProviderConfigSchema.safeParse({
      ...validProvider,
      max_concurrent: 33,
    })
    expect(result.success).toBe(false)
  })

  it('allows optional cli_path', () => {
    const { cli_path: _, ...withoutPath } = validProvider
    const result = ProviderConfigSchema.safeParse(withoutPath)
    expect(result.success).toBe(true)
  })

  it('allows optional api_key_env', () => {
    const { api_key_env: _, ...withoutKeyEnv } = validProvider
    const result = ProviderConfigSchema.safeParse(withoutKeyEnv)
    expect(result.success).toBe(true)
  })

  it('rejects extra fields (strict)', () => {
    const result = ProviderConfigSchema.safeParse({
      ...validProvider,
      secretField: 'oops',
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// RateLimitSchema
// ---------------------------------------------------------------------------

describe('RateLimitSchema', () => {
  it('accepts valid rate limit', () => {
    const result = RateLimitSchema.safeParse({ tokens: 220000, window_seconds: 18000 })
    expect(result.success).toBe(true)
  })

  it('rejects zero tokens', () => {
    const result = RateLimitSchema.safeParse({ tokens: 0, window_seconds: 18000 })
    expect(result.success).toBe(false)
  })

  it('rejects zero window_seconds', () => {
    const result = RateLimitSchema.safeParse({ tokens: 1000, window_seconds: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer tokens', () => {
    const result = RateLimitSchema.safeParse({ tokens: 1000.5, window_seconds: 18000 })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SubscriptionRoutingSchema
// ---------------------------------------------------------------------------

describe('SubscriptionRoutingSchema', () => {
  it.each(['auto', 'subscription', 'api', 'disabled'])('accepts "%s"', (value) => {
    expect(SubscriptionRoutingSchema.safeParse(value).success).toBe(true)
  })

  it('rejects invalid routing', () => {
    expect(SubscriptionRoutingSchema.safeParse('manual').success).toBe(false)
    expect(SubscriptionRoutingSchema.safeParse('').success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// RoutingPolicySchema
// ---------------------------------------------------------------------------

describe('RoutingPolicySchema', () => {
  it('accepts valid routing policy', () => {
    const result = RoutingPolicySchema.safeParse({
      default_provider: 'claude',
      rules: [
        {
          task_type: 'coding',
          preferred_provider: 'claude',
          fallback_providers: ['codex'],
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('accepts empty rules array', () => {
    const result = RoutingPolicySchema.safeParse({
      default_provider: 'claude',
      rules: [],
    })
    expect(result.success).toBe(true)
  })

  it('requires default_provider', () => {
    const result = RoutingPolicySchema.safeParse({
      rules: [],
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PartialSubstrateConfigSchema
// ---------------------------------------------------------------------------

describe('PartialSubstrateConfigSchema', () => {
  it('accepts empty object', () => {
    const result = PartialSubstrateConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts partial global section', () => {
    const result = PartialSubstrateConfigSchema.safeParse({
      global: { log_level: 'debug' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts partial provider section', () => {
    const result = PartialSubstrateConfigSchema.safeParse({
      providers: { claude: { enabled: true } },
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid partial values', () => {
    const result = PartialSubstrateConfigSchema.safeParse({
      global: { log_level: 'INVALID' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects extra top-level fields (strict)', () => {
    const result = PartialSubstrateConfigSchema.safeParse({
      unknownField: 'nope',
    })
    expect(result.success).toBe(false)
  })
})
