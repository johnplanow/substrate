/**
 * Derive a routing policy that matches the providers actually enabled during
 * `substrate init`.
 *
 * The default routing policy (DEFAULT_ROUTING_POLICY) is claude-first because
 * Claude is substrate's reference provider. But when a user enables only a
 * subset of providers at init time (e.g. Codex-only), writing the unmodified
 * default policy leaves `default_provider: claude` and claude-preferring rules
 * in `routing-policy.yaml` — so the policy disagrees with `config.yaml`, and a
 * no-agent dispatch tries to route to a disabled provider.
 *
 * This helper rewrites the base policy so every `default_provider`,
 * `preferred_provider`, and `fallback_providers` entry references only enabled
 * providers, preserving the base policy's preference order. It is pure and
 * unit-tested; init.ts is the only caller.
 */

import type { ProvidersConfig, RoutingPolicy } from './config-schema.js'

/**
 * Returns a copy of `basePolicy` filtered to the providers enabled in
 * `providers`. Provider preference order is taken from `basePolicy` (the
 * order each provider first appears as default/preferred/fallback), so output
 * is deterministic regardless of the `providers` object key order.
 *
 * Edge case: if no providers are enabled (e.g. the no-selection init fallback
 * where every provider defaults to `enabled: false`), the base policy is
 * returned unchanged — there is nothing to derive from, and an empty policy
 * would be invalid.
 */
export function deriveRoutingPolicy(
  basePolicy: RoutingPolicy,
  providers: ProvidersConfig,
): RoutingPolicy {
  const enabled = Object.entries(providers)
    .filter(([, cfg]) => cfg?.enabled === true)
    .map(([key]) => key)

  if (enabled.length === 0) return structuredClone(basePolicy)

  // Build a canonical preference ranking from the base policy: default
  // provider first, then each rule's preferred + fallbacks in order.
  const ranking: string[] = []
  const addRank = (p: string): void => {
    if (!ranking.includes(p)) ranking.push(p)
  }
  addRank(basePolicy.default_provider)
  for (const rule of basePolicy.rules) {
    addRank(rule.preferred_provider)
    rule.fallback_providers.forEach(addRank)
  }
  const rankOf = (p: string): number => {
    const i = ranking.indexOf(p)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }

  // Enabled providers in canonical order; providers absent from the base
  // policy (rank = MAX) sort last, stable by their order in `enabled`.
  const enabledRanked = [...enabled].sort((a, b) => rankOf(a) - rankOf(b))
  const isEnabled = (p: string): boolean => enabled.includes(p)

  const defaultProvider = isEnabled(basePolicy.default_provider)
    ? basePolicy.default_provider
    : enabledRanked[0]

  const rules = basePolicy.rules.map((rule) => {
    // Keep the rule's existing preferred + fallbacks (enabled only, in order),
    // then append any other enabled provider not already listed so no enabled
    // provider is silently unreachable for this task type.
    const ordered = [rule.preferred_provider, ...rule.fallback_providers].filter(isEnabled)
    for (const p of enabledRanked) {
      if (!ordered.includes(p)) ordered.push(p)
    }
    return {
      task_type: rule.task_type,
      preferred_provider: ordered[0] ?? rule.preferred_provider,
      fallback_providers: ordered.slice(1),
    }
  })

  return { default_provider: defaultProvider, rules }
}
