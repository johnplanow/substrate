/**
 * ProviderStatus — in-memory rate limit and status tracking per provider.
 *
 * Tracks:
 *  - Subscription routing enabled/disabled
 *  - API billing availability
 *  - Rate limit consumption within the current window
 *
 * References:
 *  - Architecture Section 8: Rate limit tracking per provider
 *  - FR29: Rate limit management
 *  - ADR-004: RoutingEngine is stateless except for rate limit tracking in-memory
 */

// ---------------------------------------------------------------------------
// ProviderStatus interface
// ---------------------------------------------------------------------------

/**
 * Snapshot of a single provider's current status.
 */
export interface ProviderStatus {
  /** Provider name (e.g., 'claude', 'codex', 'gemini') */
  provider: string
  /** Whether subscription routing is enabled for this provider */
  subscriptionRoutingEnabled: boolean
  /** Whether API billing is available for this provider */
  apiBillingEnabled: boolean
  /** Tokens consumed in the current rate limit window */
  tokensUsedInWindow: number
  /** Millisecond timestamp when the current window resets (0 if no rate limit configured) */
  windowResetAtMs: number
  /** Rate limit configuration */
  rateLimit: { tokensPerWindow: number; windowSeconds: number }
}
