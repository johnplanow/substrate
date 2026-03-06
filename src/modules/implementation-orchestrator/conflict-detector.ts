/**
 * Conflict detector for the Implementation Orchestrator.
 *
 * Groups story keys by module prefix to identify which stories may modify
 * the same files and must therefore be serialized within a conflict group.
 */

// ---------------------------------------------------------------------------
// ConflictDetectorConfig
// ---------------------------------------------------------------------------

/**
 * Optional configuration for the conflict detector.
 */
export interface ConflictDetectorConfig {
  /**
   * Prefix → module mappings that control conflict grouping.
   *
   * When provided, stories whose keys start with the same prefix (and map to
   * the same module name) are placed in the same conflict group and serialized.
   *
   * When omitted (or empty), every story key is treated as its own group,
   * maximizing parallelism for cross-project runs.
   *
   * Format: prefix (e.g. "12-") → module name (e.g. "my-module")
   */
  moduleMap?: Record<string, string>
}

// ---------------------------------------------------------------------------
// detectConflictGroups
// ---------------------------------------------------------------------------

/**
 * Determine the module prefix for a story key.
 *
 * Checks most-specific prefix first (e.g., "10-1" before "10-"), then falls
 * back to single-digit prefix (e.g., "9-"), and finally uses the story key
 * itself for unknown stories so each gets its own group.
 *
 * @param storyKey - e.g. "10-1", "10-2-dev-story", "5-3-something"
 * @param effectiveMap - The resolved prefix-to-module map
 * @returns module name string used for conflict grouping
 */
function resolveModulePrefix(storyKey: string, effectiveMap: Record<string, string>): string {
  // If no map provided, every story is isolated
  if (Object.keys(effectiveMap).length === 0) {
    return storyKey
  }
  // Try longest matches first (e.g., "10-1" before "10-")
  const sortedKeys = Object.keys(effectiveMap).sort((a, b) => b.length - a.length)
  for (const prefix of sortedKeys) {
    if (storyKey.startsWith(prefix)) {
      return effectiveMap[prefix] as string
    }
  }
  // Unknown story — isolated group
  return storyKey
}

/**
 * Group story keys by potential file conflicts.
 *
 * Stories that map to the same module prefix are placed in the same conflict
 * group and will be serialized. Stories with different prefixes can run in
 * parallel.
 *
 * When no `moduleMap` is configured, every story key is placed in its own
 * conflict group (maximum parallelism). This is the default for cross-project
 * runs where the story key prefixes are not known in advance.
 *
 * @param storyKeys - Array of story key strings
 * @param config - Optional configuration; supply `moduleMap` to define
 *                 prefix-to-module mappings. Without this config, each story
 *                 gets its own group (maximum parallelism).
 * @returns Array of conflict groups; each inner array is a list of story keys
 *          that must be processed sequentially
 *
 * @example
 * // Without a moduleMap, all stories run in parallel
 * detectConflictGroups(['4-1', '4-2', '4-3'])
 * // => [['4-1'], ['4-2'], ['4-3']]
 *
 * @example
 * // With a moduleMap, matching stories are serialized
 * detectConflictGroups(['10-1', '10-2', '10-4'], { moduleMap: { '10-1': 'compiled-workflows', '10-2': 'compiled-workflows', '10-4': 'implementation-orchestrator' } })
 * // => [['10-1', '10-2'], ['10-4']]
 *
 * @example
 * detectConflictGroups(['12-1', '12-2'], { moduleMap: { '12-': 'my-module' } })
 * // => [['12-1', '12-2']]
 */
export function detectConflictGroups(storyKeys: string[], config?: ConflictDetectorConfig): string[][] {
  const effectiveMap: Record<string, string> = {
    ...(config?.moduleMap ?? {}),
  }

  const moduleToStories = new Map<string, string[]>()

  for (const key of storyKeys) {
    const module = resolveModulePrefix(key, effectiveMap)
    const existing = moduleToStories.get(module)
    if (existing !== undefined) {
      existing.push(key)
    } else {
      moduleToStories.set(module, [key])
    }
  }

  return Array.from(moduleToStories.values())
}
