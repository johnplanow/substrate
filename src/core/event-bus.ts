/**
 * TypedEventBus — backward-compatible re-export shim.
 *
 * The full generic implementation now lives in @substrate-ai/core.
 * This shim specializes the generic types to OrchestratorEvents so that
 * all existing monolith callers continue to compile without modification.
 *
 * New cross-package callers should import directly from '@substrate-ai/core'
 * and parameterize with their own event map types.
 */

import type { OrchestratorEvents } from './event-bus.types.js'
import {
  TypedEventBusImpl as GenericImpl,
  createEventBus as _create,
} from '@substrate-ai/core'
import type { TypedEventBus as GenericBus } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// TypedEventBus — specialized type alias for OrchestratorEvents
// ---------------------------------------------------------------------------

/**
 * Backward-compatible type alias: TypedEventBus specialized to OrchestratorEvents.
 *
 * Existing monolith code declares `let bus: TypedEventBus` (non-generic).
 * This alias ensures those declarations continue to enforce OrchestratorEvents
 * handler types rather than defaulting to Record<string, unknown>.
 */
export type TypedEventBus = GenericBus<OrchestratorEvents>

// ---------------------------------------------------------------------------
// TypedEventBusImpl — sub-class specialized to OrchestratorEvents
// ---------------------------------------------------------------------------

/**
 * Concrete implementation specialized to OrchestratorEvents.
 *
 * Sub-classing the generic impl preserves the non-generic surface that
 * existing tests and callers rely on:
 *   bus = new TypedEventBusImpl()  // no type param needed
 *
 * @example
 * const bus = new TypedEventBusImpl()
 * bus.on('task:complete', ({ taskId, result }) => {
 *   console.log(`Task ${taskId} finished`)
 * })
 * bus.emit('task:complete', { taskId: 'abc', result: { exitCode: 0 } })
 */
export class TypedEventBusImpl extends GenericImpl<OrchestratorEvents> {}

// ---------------------------------------------------------------------------
// Factory function — specialized to OrchestratorEvents
// ---------------------------------------------------------------------------

/**
 * Create a new TypedEventBus instance specialized to OrchestratorEvents.
 *
 * @example
 * const bus = createEventBus()
 */
export function createEventBus(): TypedEventBus {
  return new TypedEventBusImpl()
}
