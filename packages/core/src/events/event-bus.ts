/**
 * TypedEventBus<E extends EventMap> — generic event bus interface and implementation.
 *
 * This interface is the stable contract for the event bus system.
 * Packages parameterize it with their own event map types (e.g., TypedEventBus<SdlcEvents>).
 */

import { EventEmitter } from 'node:events'
import type { EventMap, EventHandler } from './types.js'

/**
 * A type-safe event bus parameterized over an event map E.
 *
 * @example
 * const bus: TypedEventBus<CoreEvents & SdlcEvents> = createEventBus()
 * bus.on('orchestrator:story-complete', ({ storyKey }) => { ... })
 */
export interface TypedEventBus<E extends EventMap> {
  /**
   * Emit an event with a typed payload.
   * All registered handlers for this event key are called synchronously.
   */
  emit<K extends keyof E>(event: K, payload: E[K]): void

  /**
   * Register a handler for an event.
   */
  on<K extends keyof E>(event: K, handler: EventHandler<E[K]>): void

  /**
   * Unregister a previously registered handler.
   */
  off<K extends keyof E>(event: K, handler: EventHandler<E[K]>): void
}

// ---------------------------------------------------------------------------
// TypedEventBusImpl
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of TypedEventBus backed by Node.js EventEmitter.
 *
 * Dispatch is SYNCHRONOUS — all handlers run before emit() returns (per ADR-004).
 * maxListeners is set to 100 to avoid spurious warnings in large systems.
 *
 * @example
 * const bus = new TypedEventBusImpl<CoreEvents & SdlcEvents>()
 * bus.on('orchestrator:story-complete', ({ storyKey }) => { ... })
 * bus.emit('orchestrator:story-complete', { storyKey: '1-1', reviewCycles: 1 })
 */
export class TypedEventBusImpl<E extends EventMap> implements TypedEventBus<E> {
  private readonly _emitter: EventEmitter

  constructor() {
    this._emitter = new EventEmitter()
    // Raise limit to avoid spurious warnings in large systems with many subscribers
    this._emitter.setMaxListeners(100)
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    this._emitter.emit(event as string, payload)
  }

  on<K extends keyof E>(event: K, handler: EventHandler<E[K]>): void {
    // EventEmitter passes arguments as rest params; cast to satisfy TypeScript
    this._emitter.on(event as string, handler as (arg: unknown) => void)
  }

  off<K extends keyof E>(event: K, handler: EventHandler<E[K]>): void {
    this._emitter.off(event as string, handler as (arg: unknown) => void)
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a new TypedEventBus instance parameterized over event map E.
 *
 * @example
 * const bus = createEventBus<CoreEvents & SdlcEvents>()
 */
export function createEventBus<E extends EventMap>(): TypedEventBus<E> {
  return new TypedEventBusImpl<E>()
}
