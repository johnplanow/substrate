// Export adapter types (SpawnCommand, AdapterOptions, AdapterCapabilities, etc.)
export * from './types.js'
// Export WorkerAdapter interface explicitly; AdapterRegistry interface from worker-adapter
// is superseded by the concrete AdapterRegistry class below (see adapter-registry.ts).
export type { WorkerAdapter } from './worker-adapter.js'
// Concrete AdapterRegistry class (satisfies the AdapterRegistry interface structurally)
export { AdapterRegistry } from './adapter-registry.js'
// CLI adapter implementations
export { ClaudeCodeAdapter, detectClaudeAuthFailure, CLAUDE_AUTH_FAILURE_HINT } from './claude-adapter.js'
export { CodexCLIAdapter, detectCodexSandboxBlock, CODEX_SANDBOX_BLOCK_HINT } from './codex-adapter.js'
export { GeminiCLIAdapter } from './gemini-adapter.js'
// Zod validation schemas
export * from './schemas.js'
// Adapter hardening — format error and multi-strategy normalizer (story 53-10)
export { AdapterFormatError } from './adapter-format-error.js'
export { AdapterOutputNormalizer } from './adapter-output-normalizer.js'
// CLI version-compatibility helper (substrate v0.20.138) — pure check that
// each adapter's healthCheck applies to surface a `compatibilityWarning` when
// the live CLI binary version is outside substrate's tested range.
export { checkAdapterVersionCompat } from './version-compat.js'
export type { TestedVersionRange, CompatibilityCheck } from './version-compat.js'
