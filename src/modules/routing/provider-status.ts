/**
 * Re-export shim — routing/provider-status.ts
 *
 * ProviderStatus and ProviderStatusTracker have moved to @substrate-ai/core.
 * This file exists for backwards compatibility with existing monolith imports.
 */
export type { ProviderStatus } from '@substrate-ai/core'
export { ProviderStatusTracker } from '@substrate-ai/core'
