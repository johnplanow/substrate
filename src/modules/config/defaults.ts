/**
 * Re-export shim for config defaults.
 *
 * DEFAULT_CONFIG and per-provider/global defaults are now in @substrate-ai/core.
 * DEFAULT_ROUTING_POLICY is defined locally here (config-level routing type,
 * distinct from the routing module's RoutingPolicy).
 */

export {
  DEFAULT_CONFIG,
  DEFAULT_CLAUDE_PROVIDER,
  DEFAULT_CODEX_PROVIDER,
  DEFAULT_GEMINI_PROVIDER,
  DEFAULT_GLOBAL_SETTINGS,
} from '@substrate-ai/core'

import type { RoutingPolicy } from './config-schema.js'

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
