/**
 * Shared model tier resolution utility.
 *
 * Determines whether a model string belongs to the haiku (1), sonnet (2),
 * or opus (3) tier based on substring matching against well-known keywords.
 *
 * Used by both RoutingRecommender and RoutingTuner to ensure consistent
 * tier comparisons — in particular the one-step guard in RoutingTuner.
 */

/** Ordered tier keywords: index 0 = cheapest, index N = most expensive. */
const TIER_KEYWORDS: Array<{ keyword: string; tier: number }> = [
  { keyword: 'haiku', tier: 1 },
  { keyword: 'sonnet', tier: 2 },
  { keyword: 'opus', tier: 3 },
]

/**
 * Get the model tier for a given model name string.
 *
 * Returns:
 *  - 1  for haiku-tier models
 *  - 2  for sonnet-tier models (also the default when unrecognized)
 *  - 3  for opus-tier models
 *
 * Matching is case-insensitive substring search.
 */
export function getModelTier(model: string): number {
  const lower = model.toLowerCase()
  for (const { keyword, tier } of TIER_KEYWORDS) {
    if (lower.includes(keyword)) return tier
  }
  return 2 // default: sonnet tier
}
