/**
 * Built-in default values for the Substrate configuration system.
 *
 * These are the lowest-priority defaults; they are overridden by:
 *   global config → project config → environment variables → CLI flags
 */

import type {
  SubstrateConfig,
  ProviderConfig,
  GlobalSettings,
  RoutingPolicy,
} from './config-schema.js'

// ---------------------------------------------------------------------------
// Per-provider defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CLAUDE_PROVIDER: ProviderConfig = {
  enabled: false,
  subscription_routing: 'auto',
  max_concurrent: 2,
  rate_limit: {
    // 220 000 tokens per 5-hour window (architecture section 2)
    tokens: 220_000,
    window_seconds: 18_000,
  },
  api_key_env: 'ANTHROPIC_API_KEY',
  api_billing: false,
}

export const DEFAULT_CODEX_PROVIDER: ProviderConfig = {
  enabled: false,
  subscription_routing: 'api',
  max_concurrent: 2,
  api_key_env: 'OPENAI_API_KEY',
  api_billing: true,
}

export const DEFAULT_GEMINI_PROVIDER: ProviderConfig = {
  enabled: false,
  subscription_routing: 'api',
  max_concurrent: 2,
  api_key_env: 'GOOGLE_API_KEY',
  api_billing: true,
}

// ---------------------------------------------------------------------------
// Global settings defaults
// ---------------------------------------------------------------------------

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  log_level: 'info',
  max_concurrent_tasks: 4,
  budget_cap_tokens: 0,
  budget_cap_usd: 0,
}

// ---------------------------------------------------------------------------
// Default routing policy
// ---------------------------------------------------------------------------

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  default_provider: 'claude',
  rules: [
    {
      task_type: 'planning',
      preferred_provider: 'claude',
      fallback_providers: ['gemini', 'codex'],
    },
    {
      task_type: 'coding',
      preferred_provider: 'claude',
      fallback_providers: ['codex', 'gemini'],
    },
    {
      task_type: 'review',
      preferred_provider: 'claude',
      fallback_providers: ['gemini'],
    },
  ],
}

// ---------------------------------------------------------------------------
// Full default config document
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: SubstrateConfig = {
  config_format_version: '1',
  task_graph_version: '1',
  global: DEFAULT_GLOBAL_SETTINGS,
  providers: {
    claude: DEFAULT_CLAUDE_PROVIDER,
    codex: DEFAULT_CODEX_PROVIDER,
    gemini: DEFAULT_GEMINI_PROVIDER,
  },
}
