/**
 * Token ceiling resolution helper for compiled workflows.
 *
 * Provides a single `getTokenCeiling()` function that resolves the effective
 * token ceiling for a given workflow type, checking the configured overrides
 * first and falling back to hardcoded defaults.
 *
 * Story 24-7: Configurable Token Ceiling Per Workflow
 */

import type { TokenCeilings } from '../config/config-schema.js'

// ---------------------------------------------------------------------------
// Hardcoded defaults
// ---------------------------------------------------------------------------

/**
 * Default token ceilings for each compiled workflow.
 * These match the hardcoded constants previously defined inline in each workflow.
 */
export const TOKEN_CEILING_DEFAULTS: Record<string, number> = {
  'create-story': 50_000,
  'dev-story': 400_000,
  'code-review': 500_000,
  'test-plan': 100_000,
  'test-expansion': 200_000,
}

// ---------------------------------------------------------------------------
// getTokenCeiling
// ---------------------------------------------------------------------------

/**
 * Resolve the effective token ceiling for a workflow type.
 *
 * Returns the ceiling from `tokenCeilings` config if present and valid,
 * otherwise falls back to the hardcoded default.
 *
 * @param workflowType - One of: 'create-story', 'dev-story', 'code-review', 'test-plan', 'test-expansion'
 * @param tokenCeilings - Optional per-workflow overrides from parsed config
 * @returns `{ ceiling: number, source: 'config' | 'default' }`
 */
export function getTokenCeiling(
  workflowType: string,
  tokenCeilings?: TokenCeilings,
): { ceiling: number; source: 'config' | 'default' } {
  if (tokenCeilings !== undefined) {
    const configured = tokenCeilings[workflowType as keyof TokenCeilings]
    if (configured !== undefined) {
      return { ceiling: configured, source: 'config' }
    }
  }

  const defaultValue = TOKEN_CEILING_DEFAULTS[workflowType] ?? 0
  return { ceiling: defaultValue, source: 'default' }
}
