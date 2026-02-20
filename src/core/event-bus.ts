/**
 * TypedEventBus — typed internal pub/sub for decoupled module communication.
 *
 * Built on top of Node.js EventEmitter (per ADR-004: chosen over RxJS).
 *
 * Key design constraints:
 *  - Event dispatch is SYNCHRONOUS — handlers run immediately when emit() is called.
 *  - No async/Promise-based dispatch; async work should be scheduled separately.
 *  - TypeScript `keyof` constraint enforces handler type safety at compile time.
 *  - Zero circular dependencies: EventBus cannot depend on any module.
 */

import { EventEmitter } from 'node:events'
import type { OrchestratorEvents } from './event-bus.types.js'

// ---------------------------------------------------------------------------
// TypedEventBus interface
// ---------------------------------------------------------------------------

/**
 * A typed publish-subscribe bus.
 *
 * All event names and payload types are enforced by the `OrchestratorEvents` map.
 */
export interface TypedEventBus {
  /**
   * Emit an event with a strongly-typed payload.
   * Dispatch is synchronous — all registered handlers run before emit() returns.
   */
  emit<K extends keyof OrchestratorEvents>(event: K, payload: OrchestratorEvents[K]): void

  /**
   * Subscribe to an event. The handler is called synchronously on each emit.
   */
  on<K extends keyof OrchestratorEvents>(
    event: K,
    handler: (payload: OrchestratorEvents[K]) => void
  ): void

  /**
   * Unsubscribe a previously registered handler.
   * If the handler was not registered, this is a no-op.
   */
  off<K extends keyof OrchestratorEvents>(
    event: K,
    handler: (payload: OrchestratorEvents[K]) => void
  ): void
}

// ---------------------------------------------------------------------------
// TypedEventBusImpl
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of TypedEventBus backed by Node.js EventEmitter.
 *
 * @example
 * const bus = new TypedEventBusImpl()
 * bus.on('task:complete', ({ taskId, result }) => {
 *   console.log(`Task ${taskId} finished`)
 * })
 * bus.emit('task:complete', { taskId: 'abc', result: { exitCode: 0 } })
 */
export class TypedEventBusImpl implements TypedEventBus {
  private readonly _emitter: EventEmitter

  constructor() {
    this._emitter = new EventEmitter()
    // Raise limit to avoid spurious warnings in large systems with many subscribers
    this._emitter.setMaxListeners(100)
  }

  emit<K extends keyof OrchestratorEvents>(event: K, payload: OrchestratorEvents[K]): void {
    this._emitter.emit(event as string, payload)
  }

  on<K extends keyof OrchestratorEvents>(
    event: K,
    handler: (payload: OrchestratorEvents[K]) => void
  ): void {
    // EventEmitter passes arguments as rest params; cast to satisfy TypeScript
    this._emitter.on(event as string, handler as (arg: unknown) => void)
  }

  off<K extends keyof OrchestratorEvents>(
    event: K,
    handler: (payload: OrchestratorEvents[K]) => void
  ): void {
    this._emitter.off(event as string, handler as (arg: unknown) => void)
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a new TypedEventBus instance.
 *
 * @example
 * const bus = createEventBus()
 */
export function createEventBus(): TypedEventBus {
  return new TypedEventBusImpl()
}
