/**
 * @substrate-ai/core events barrel export.
 * Re-exports all event-related types for package consumers.
 */

export type { EventMap, EventHandler } from './types.js'
export type { TypedEventBus } from './event-bus.js'
export { TypedEventBusImpl, createEventBus } from './event-bus.js'
export type {
  CoreEvents,
  // TaskId and WorkerId are re-exported from packages/core/src/types.ts (canonical source)
  // to avoid TS2308 ambiguous re-export conflict when all subsystems are combined in index.ts
  EventTaskResult,
  EventTaskError,
} from './core-events.js'
