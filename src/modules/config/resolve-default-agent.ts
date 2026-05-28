/**
 * Resolve the dispatch agent for `substrate run` when no `--agent` flag is
 * given, by deriving it from the providers enabled in `config.yaml`.
 *
 * Before this, the orchestrator hard-defaulted to `'claude-code'` whenever
 * `--agent` was omitted (orchestrator-impl.ts had ~10 `agentId ?? 'claude-code'`
 * fallbacks). So a Codex-only project — Claude not installed — still tried to
 * dispatch to Claude unless the operator remembered `--agent codex`. This makes
 * `substrate run` honor the configured providers.
 *
 * Pure and unit-tested; run.ts is the only caller. Explicit `--agent` always
 * wins and never reaches this helper.
 */

import type { ProvidersConfig } from './config-schema.js'

/**
 * Maps config provider keys to the dispatch agent ids the registry/orchestrator
 * use. The config keys (`claude`/`codex`/`gemini`) differ from the adapter ids
 * (`claude-code`/`codex`/`gemini`) only for Claude.
 */
const PROVIDER_TO_AGENT: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  gemini: 'gemini',
}

/**
 * Precedence when more than one provider is enabled and no `--agent` is given.
 * Claude first (substrate's reference provider), then Codex, then Gemini.
 */
const PROVIDER_PRECEDENCE = ['claude', 'codex', 'gemini']

export interface ResolveDefaultAgentResult {
  /** The resolved dispatch agent id, when a provider is enabled. */
  agentId?: string
  /** Set when no provider is enabled — the caller surfaces this as a hard error. */
  error?: string
}

/**
 * Returns the dispatch agent id derived from the enabled providers:
 *  - exactly one enabled → that provider's agent id
 *  - several enabled     → the highest-precedence enabled provider
 *  - none enabled        → `{ error }` (no agent can be chosen)
 *
 * Providers absent from the precedence list (future provider keys) sort after
 * the known ones but remain selectable.
 */
export function resolveDefaultAgentId(providers: ProvidersConfig): ResolveDefaultAgentResult {
  const enabled = Object.entries(providers)
    .filter(([, cfg]) => cfg?.enabled === true)
    .map(([key]) => key)

  if (enabled.length === 0) {
    return {
      error:
        'No enabled providers in .substrate/config.yaml. Run `substrate init` and enable at least one CLI, or pass --agent <claude-code|codex|gemini>.',
    }
  }

  const rankOf = (p: string): number => {
    const i = PROVIDER_PRECEDENCE.indexOf(p)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  const chosen = [...enabled].sort((a, b) => rankOf(a) - rankOf(b))[0]

  return { agentId: PROVIDER_TO_AGENT[chosen] ?? chosen }
}
