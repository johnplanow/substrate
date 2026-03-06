/**
 * Shared test helpers for AdapterRegistry injection tests.
 *
 * Provides a createStubRegistry() factory that produces a minimal
 * AdapterRegistry stub suitable for injection in unit tests.  The stub's
 * discoverAndRegister() is a no-op spy — it never performs real health checks
 * and simulates a registry that was already initialized at CLI startup.
 */

import { vi } from 'vitest'
import type { AdapterRegistry } from '../../../adapters/adapter-registry.js'

/**
 * Creates a minimal stub AdapterRegistry for injection into commands under test.
 *
 * Usage:
 *   const stub = createStubRegistry()
 *   registerRunCommand(program, '1.0.0', '/project', stub)
 *
 * The stub has one healthy adapter pre-registered (claude-code) and its
 * discoverAndRegister() is a spy that resolves immediately without invoking
 * any real CLI health checks.
 */
export function createStubRegistry(): AdapterRegistry {
  return {
    discoverAndRegister: vi.fn().mockResolvedValue({
      registeredCount: 1,
      failedCount: 0,
      results: [
        {
          adapterId: 'claude-code',
          displayName: 'Claude Code',
          registered: true,
          healthResult: { healthy: true, message: 'stub', details: {} },
        },
      ],
    }),
    register: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getPlanningCapable: vi.fn().mockReturnValue([]),
  } as unknown as AdapterRegistry
}
