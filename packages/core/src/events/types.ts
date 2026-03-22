/**
 * Base event type primitives for the TypedEventBus system.
 *
 * These types are the foundation of the event bus contract.
 * All event maps must satisfy EventMap; all handlers must satisfy EventHandler<T>.
 */

/**
 * Base constraint for event maps.
 * Each key is an event name (string), and the value is the payload type.
 *
 * Using `object` (not `Record<string, unknown>`) so that TypeScript interfaces
 * with named properties (without index signatures) satisfy the constraint.
 * TypeScript interfaces extend `object` but may not extend `Record<string, unknown>`
 * unless they have an explicit index signature.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type EventMap = object

/**
 * A typed event handler function for payload type T.
 */
export type EventHandler<T> = (payload: T) => void
