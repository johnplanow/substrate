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
   * Additional prefix → module mappings that extend (or override) the
   * built-in STORY_PREFIX_TO_MODULE map.
   *
   * Format: prefix (e.g. "12-") → module name (e.g. "my-module")
   */
  moduleMap?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Module prefix map
// ---------------------------------------------------------------------------

/**
 * Maps story key prefix patterns to module directory names.
 *
 * The heuristic: stories whose numeric prefix belongs to the same epic
 * (same first digit) and whose known mapping points to the same module are
 * considered conflicting. Unknown prefixes default to the story key itself
 * (each unknown story is in its own group).
 *
 * Format: prefix (e.g. "10-") → module name
 */
const STORY_PREFIX_TO_MODULE: Record<string, string> = {
  '1-': 'core',
  '2-': 'core',
  '3-': 'core',
  '4-': 'core',
  '5-': 'core',
  '6-': 'task-graph',
  '7-': 'worker-pool',
  '8-': 'monitor',
  '9-': 'bmad-context-engine',
  '10-1': 'compiled-workflows',
  '10-2': 'compiled-workflows',
  '10-3': 'compiled-workflows',
  '10-4': 'implementation-orchestrator',
  '10-5': 'cli',
  '11-': 'pipeline-phases',
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
 * @param effectiveMap - The resolved prefix-to-module map (built-in + any extras)
 * @returns module name string used for conflict grouping
 */
function resolveModulePrefix(storyKey: string, effectiveMap: Record<string, string>): string {
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
 * @param storyKeys - Array of story key strings
 * @param config - Optional configuration; supply `moduleMap` to extend the
 *                 built-in prefix-to-module mappings (additional entries are
 *                 merged on top of the defaults, allowing overrides).
 * @returns Array of conflict groups; each inner array is a list of story keys
 *          that must be processed sequentially
 *
 * @example
 * detectConflictGroups(['10-1', '10-2', '10-4', '10-5'])
 * // => [['10-1', '10-2'], ['10-4'], ['10-5']]
 *
 * @example
 * detectConflictGroups(['12-1', '12-2'], { moduleMap: { '12-': 'my-module' } })
 * // => [['12-1', '12-2']]
 */
export function detectConflictGroups(storyKeys: string[], config?: ConflictDetectorConfig): string[][] {
  const effectiveMap: Record<string, string> = {
    ...STORY_PREFIX_TO_MODULE,
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
