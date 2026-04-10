/**
 * Re-export shim for token-extractor — implementation lives in @substrate-ai/core.
 * Story 41-6a migrated this module to packages/core/src/telemetry/token-extractor.ts.
 */
export {
  extractTokensFromAttributes,
  extractTokensFromBody,
  mergeTokenCounts,
} from '@substrate-ai/core'
