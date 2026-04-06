/**
 * Adapter subsystem barrel re-exports.
 *
 * Re-exports all adapter types and implementations from @substrate-ai/core so
 * that monolith consumers can import from 'src/adapters' without knowing about
 * the package boundary.
 *
 * New exports added by story 53-10:
 *   - AdapterFormatError: structured error for exhausted normalization
 *   - AdapterOutputNormalizer: multi-strategy YAML extractor
 */

export {
  AdapterFormatError,
  AdapterOutputNormalizer,
} from '@substrate-ai/core'
