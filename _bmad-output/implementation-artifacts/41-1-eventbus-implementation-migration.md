# Story 41-1: EventBus Implementation Migration

## Story

As a substrate engineer,
I want `TypedEventBusImpl` and `createEventBus` to live in `@substrate-ai/core`,
so that downstream packages (`@substrate-ai/sdlc`, `@substrate-ai/factory`) can instantiate a typed event bus without depending on the `src/` monolith.

## Acceptance Criteria

### AC1: Implementation in packages/core
**Given** `packages/core/src/events/event-bus.ts` currently holds only the generic `TypedEventBus<E>` interface
**When** the migration is complete
**Then** the file also contains a generic `TypedEventBusImpl<E extends EventMap>` class backed by Node.js EventEmitter with synchronous dispatch and `maxListeners` set to 100, plus a `createEventBus<E extends EventMap>(): TypedEventBus<E>` factory function.

### AC2: Public API export from @substrate-ai/core
**Given** `packages/core/src/events/index.ts` currently exports only types
**When** the migration is complete
**Then** `TypedEventBusImpl` (class value) and `createEventBus` (function value) are accessible via `import { TypedEventBusImpl, createEventBus } from '@substrate-ai/core'`.

### AC3: Re-export shim at original path
**Given** the monolith's `src/core/event-bus.ts` contains the full implementation
**When** the migration is complete
**Then** `src/core/event-bus.ts` is replaced by a re-export shim that forwards `TypedEventBusImpl` and `createEventBus` from `@substrate-ai/core`, and re-exports a backward-compatible `TypedEventBus` type alias (specialized to `OrchestratorEvents`) so existing monolith callers remain type-correct.

### AC4: Existing tests pass without modification
**Given** `src/core/__tests__/event-bus.test.ts` imports from `../event-bus.js` and uses `OrchestratorEvents`
**When** `npm run test:fast` is executed after the migration
**Then** all event-bus tests pass with no changes to the test file.

### AC5: packages/core builds cleanly
**Given** `packages/core` is a TypeScript composite project
**When** `npm run build --workspace=packages/core` is executed
**Then** `tsc -b` exits 0 with zero type errors or warnings.

### AC6: Monolith callers are unaffected
**Given** the monolith contains many files that import `TypedEventBus`, `TypedEventBusImpl`, or `createEventBus` from `src/core/event-bus.js`
**When** those imports resolve through the shim to the core implementation
**Then** all existing usages continue to compile and behave identically (zero behavioral change, zero new type errors).

### AC7: Generic parameterization works for cross-package use
**Given** `TypedEventBusImpl` is now generic
**When** a new instance is created as `new TypedEventBusImpl<CoreEvents & SdlcEvents>()`
**Then** the TypeScript compiler accepts event names and payload types from both `CoreEvents` and `SdlcEvents` without casting.

## Tasks / Subtasks

- [ ] Task 1: Add `TypedEventBusImpl<E>` class and `createEventBus<E>` factory to `packages/core/src/events/event-bus.ts` (AC: #1, #5, #7)
  - [ ] Add `import { EventEmitter } from 'node:events'` at the top of the file
  - [ ] Below the existing `TypedEventBus<E>` interface, add `TypedEventBusImpl<E extends EventMap>` that holds a private `EventEmitter`, sets `maxListeners(100)`, and implements `emit`, `on`, `off` generically (same pattern as the monolith implementation, re-parameterized for `E`)
  - [ ] Add `createEventBus<E extends EventMap>(): TypedEventBus<E>` factory that returns `new TypedEventBusImpl<E>()`
  - [ ] Verify no circular imports: `event-bus.ts` must only import from `./types.js` within the events module

- [ ] Task 2: Update barrel exports in `packages/core/src/events/index.ts` (AC: #2)
  - [ ] Change `export type { TypedEventBus } from './event-bus.js'` to also export the value exports: `export { TypedEventBusImpl, createEventBus } from './event-bus.js'`
  - [ ] Keep all existing `export type` lines intact

- [ ] Task 3: Replace `src/core/event-bus.ts` with a backward-compatible shim (AC: #3, #4, #6)
  - [ ] Import `TypedEventBusImpl as GenericImpl` and `createEventBus as genericCreate` from `@substrate-ai/core`
  - [ ] Import `OrchestratorEvents` from `./event-bus.types.js` (unchanged file)
  - [ ] Re-export `TypedEventBusImpl` as a sub-class specialized to `OrchestratorEvents` (e.g., `export class TypedEventBusImpl extends GenericImpl<OrchestratorEvents> {}`) — this preserves the non-generic surface the test expects (`bus = new TypedEventBusImpl()` where `bus: TypedEventBus`)
  - [ ] Re-export `createEventBus` as a wrapper that returns `TypedEventBus<OrchestratorEvents>` (e.g., `export function createEventBus(): TypedEventBus { return new TypedEventBusImpl() }`)
  - [ ] Re-export `TypedEventBus` as a type alias: `export type TypedEventBus = GenericBus<OrchestratorEvents>`
  - [ ] **Rationale:** The test declares `bus: TypedEventBus` (non-generic) and assigns `new TypedEventBusImpl()` to it, then passes `OrchestratorEvents`-typed handlers. A pure `export type { TypedEventBus }` re-export would change the default type param to `Record<string, unknown>`, breaking the test's handler type checks at compile time. The specialized shim preserves compile-time correctness.

- [ ] Task 4: Build `packages/core` and run the full monolith build (AC: #5, #6)
  - [ ] Run `npm run build --workspace=packages/core` and confirm exit 0
  - [ ] Run root-level `npm run build` (or `tsc -b`) to confirm the monolith resolves the shim without new type errors

- [ ] Task 5: Run tests and confirm zero regressions (AC: #4, #6, #7)
  - [ ] Run `npm run test:fast` — all event-bus tests must pass
  - [ ] Confirm the test output shows `src/core/__tests__/event-bus.test.ts` as passing
  - [ ] Optionally add a type-assertion comment in `packages/core/src/events/event-bus.ts` demonstrating `TypedEventBusImpl<CoreEvents & SdlcEvents>` usage (for AC7 verification; do not add a new test file)

## Dev Notes

### Architecture Constraints
- **ESM `.js` imports**: All intra-package imports inside `packages/core/src/` must use `.js` extensions (e.g., `import type { EventMap } from './types.js'`).
- **No circular dependencies**: `packages/core/src/events/event-bus.ts` may only import from `./types.js` within the events directory. It must NOT import from `../config/`, `../routing/`, or any other core module.
- **Node.js EventEmitter only**: Per ADR-004. No RxJS, no custom queues. Dispatch is synchronous — handlers run before `emit()` returns.
- **Zero behavioral change**: The implementation logic is identical to the monolith's `TypedEventBusImpl`. Only the generic parameterization changes.
- **`@substrate-ai/core` has no dependency on the monolith `src/`**: The core package build must not import anything from `../../src/`.

### File Paths
| File | Action |
|------|--------|
| `packages/core/src/events/event-bus.ts` | Add `TypedEventBusImpl<E>` class + `createEventBus<E>` factory below existing interface |
| `packages/core/src/events/index.ts` | Add value exports for `TypedEventBusImpl` and `createEventBus` |
| `src/core/event-bus.ts` | Replace full implementation with backward-compat re-export shim |

### Backward Compatibility — Critical Note
The existing test `src/core/__tests__/event-bus.test.ts` declares:
```typescript
let bus: TypedEventBus          // non-generic; tied to OrchestratorEvents in original
bus = new TypedEventBusImpl()   // concrete impl, also tied to OrchestratorEvents
```
And passes `OrchestratorEvents`-typed handlers to `bus.on(...)`.

If the shim simply does `export type { TypedEventBus } from '@substrate-ai/core'`, `TypedEventBus` would default to `TypedEventBus<Record<string, unknown>>`, making `bus.on()` expect `(payload: unknown) => void`. Under `strictFunctionTypes`, the more specific handler type `(payload: OrchestratorEvents[K]) => void` would be a compile error.

**Solution**: The shim creates a sub-class and type alias that fix the concrete type to `OrchestratorEvents`, preserving full backward compat for all monolith callers. New cross-package callers use the generic form directly from `@substrate-ai/core`.

### Testing Requirements
- Run `npm run test:fast` (not bare `vitest`) — excludes e2e/integration tests, faster feedback
- Do NOT run tests concurrently. Verify `pgrep -f vitest` returns nothing before starting.
- The test file `src/core/__tests__/event-bus.test.ts` must pass without modification
- No new test files required for this story (type assertions can be in-source comments)

### Import Pattern Reference
```typescript
// packages/core/src/events/event-bus.ts (after this story)
import { EventEmitter } from 'node:events'
import type { EventMap, EventHandler } from './types.js'

export class TypedEventBusImpl<E extends EventMap> implements TypedEventBus<E> {
  private readonly _emitter: EventEmitter
  constructor() {
    this._emitter = new EventEmitter()
    this._emitter.setMaxListeners(100)
  }
  emit<K extends keyof E>(event: K, payload: E[K]): void { ... }
  on<K extends keyof E>(event: K, handler: EventHandler<E[K]>): void { ... }
  off<K extends keyof E>(event: K, handler: EventHandler<E[K]>): void { ... }
}

export function createEventBus<E extends EventMap>(): TypedEventBus<E> {
  return new TypedEventBusImpl<E>()
}
```

```typescript
// src/core/event-bus.ts (shim after this story)
import type { OrchestratorEvents } from './event-bus.types.js'
import {
  TypedEventBusImpl as GenericImpl,
  createEventBus as _create,
} from '@substrate-ai/core'
import type { TypedEventBus as GenericBus } from '@substrate-ai/core'

export type TypedEventBus = GenericBus<OrchestratorEvents>

export class TypedEventBusImpl extends GenericImpl<OrchestratorEvents> {}

export function createEventBus(): TypedEventBus {
  return new TypedEventBusImpl()
}
```

## Interface Contracts

- **Export**: `TypedEventBusImpl` @ `packages/core/src/events/event-bus.ts` (from `@substrate-ai/core`)
- **Export**: `createEventBus` @ `packages/core/src/events/event-bus.ts` (from `@substrate-ai/core`)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
