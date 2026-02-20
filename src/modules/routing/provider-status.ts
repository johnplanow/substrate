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

// ---------------------------------------------------------------------------
// Internal rate limit window tracking
// ---------------------------------------------------------------------------

interface RateLimitWindow {
  provider: string
  tokensUsedInWindow: number
  windowStartAtMs: number
  windowDurationMs: number
  tokensPerWindow: number
}

// ---------------------------------------------------------------------------
// ProviderStatusTracker
// ---------------------------------------------------------------------------

/**
 * Manages in-memory rate limit state and provider availability for all providers.
 *
 * This is a pure in-memory tracker — all state is reset when the daemon restarts.
 * This is acceptable per ADR-004 (stateless except for rate limit tracking).
 *
 * @example
 * const tracker = new ProviderStatusTracker()
 * tracker.initProvider('claude', true, true, { tokensPerWindow: 220000, windowSeconds: 18000 })
 * const ok = tracker.checkRateLimit('claude', 1000) // true if capacity available
 * tracker.recordTokenUsage('claude', 1000)
 */
export class ProviderStatusTracker {
  private readonly _windows: Map<string, RateLimitWindow> = new Map()
  private readonly _subscriptionEnabled: Map<string, boolean> = new Map()
  private readonly _apiBillingEnabled: Map<string, boolean> = new Map()

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Initialize tracking for a provider.
   * Called once during RoutingEngine initialization from the routing policy.
   *
   * @param provider - Provider name
   * @param subscriptionEnabled - Whether subscription routing is on
   * @param apiBillingEnabled - Whether API billing is available
   * @param rateLimit - Rate limit configuration (optional)
   */
  initProvider(
    provider: string,
    subscriptionEnabled: boolean,
    apiBillingEnabled: boolean,
    rateLimit?: { tokensPerWindow: number; windowSeconds: number }
  ): void {
    this._subscriptionEnabled.set(provider, subscriptionEnabled)
    this._apiBillingEnabled.set(provider, apiBillingEnabled)

    if (rateLimit !== undefined) {
      this._windows.set(provider, {
        provider,
        tokensUsedInWindow: 0,
        windowStartAtMs: Date.now(),
        windowDurationMs: rateLimit.windowSeconds * 1000,
        tokensPerWindow: rateLimit.tokensPerWindow,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Rate limit management
  // ---------------------------------------------------------------------------

  /**
   * Check whether a provider can accept the estimated token usage without exceeding its limit.
   *
   * @param provider - Provider name
   * @param estimatedTokens - Tokens that would be consumed
   * @returns true if tokens won't exceed limit (or no rate limit configured), false otherwise
   */
  checkRateLimit(provider: string, estimatedTokens: number): boolean {
    const window = this._windows.get(provider)
    if (window === undefined) {
      // No rate limit configured — always available
      return true
    }

    // Check if window has expired and reset if needed
    this._resetWindowIfExpired(window)

    return window.tokensUsedInWindow + estimatedTokens <= window.tokensPerWindow
  }

  /**
   * Record token usage for a provider after task completion.
   * Resets the window if it has expired before recording.
   *
   * @param provider - Provider name
   * @param tokensUsed - Actual tokens consumed
   */
  recordTokenUsage(provider: string, tokensUsed: number): void {
    const window = this._windows.get(provider)
    if (window === undefined) {
      return
    }

    // Reset if window expired
    this._resetWindowIfExpired(window)

    window.tokensUsedInWindow += tokensUsed
  }

  /**
   * Get the timestamp when the current rate limit window resets.
   *
   * @param provider - Provider name
   * @returns Date when the window resets, or the current time if no rate limit configured
   */
  getRateLimitResetTime(provider: string): Date {
    const window = this._windows.get(provider)
    if (window === undefined) {
      return new Date()
    }
    return new Date(window.windowStartAtMs + window.windowDurationMs)
  }

  // ---------------------------------------------------------------------------
  // Status snapshot
  // ---------------------------------------------------------------------------

  /**
   * Return a snapshot of the current status for a provider.
   *
   * @param provider - Provider name
   * @returns ProviderStatus snapshot, or null if provider is not tracked
   */
  getStatus(provider: string): ProviderStatus | null {
    const subscriptionEnabled = this._subscriptionEnabled.get(provider)
    if (subscriptionEnabled === undefined) {
      return null
    }

    const apiBillingEnabled = this._apiBillingEnabled.get(provider) ?? false
    const window = this._windows.get(provider)

    if (window !== undefined) {
      this._resetWindowIfExpired(window)
      return {
        provider,
        subscriptionRoutingEnabled: subscriptionEnabled,
        apiBillingEnabled,
        tokensUsedInWindow: window.tokensUsedInWindow,
        windowResetAtMs: window.windowStartAtMs + window.windowDurationMs,
        rateLimit: {
          tokensPerWindow: window.tokensPerWindow,
          windowSeconds: window.windowDurationMs / 1000,
        },
      }
    }

    return {
      provider,
      subscriptionRoutingEnabled: subscriptionEnabled,
      apiBillingEnabled,
      tokensUsedInWindow: 0,
      windowResetAtMs: 0,
      rateLimit: { tokensPerWindow: 0, windowSeconds: 0 },
    }
  }

  /**
   * Return all tracked provider names.
   */
  getTrackedProviders(): string[] {
    return Array.from(this._subscriptionEnabled.keys())
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _resetWindowIfExpired(window: RateLimitWindow): void {
    const now = Date.now()
    if (now > window.windowStartAtMs + window.windowDurationMs) {
      window.tokensUsedInWindow = 0
      window.windowStartAtMs = now
    }
  }
}
