# Story 40.4: Dispatcher Interface Extraction

## Story

As a substrate-core package consumer,
I want `Dispatcher`, `DispatchRequest`, `DispatchResult`, `DispatchHandle`, `DispatchConfig`, and related types defined in `packages/core/src/dispatch/`,
so that other packages can depend on a stable, type-safe dispatch contract without importing from the monolith `src/modules/agent-dispatch/types.ts`.

## Acceptance Criteria

### AC1: Core Dispatch Types File Created with All Required Exports
**Given** the `packages/core/src/dispatch/` directory is created
**When** `packages/core/src/dispatch/types.ts` is imported
**Then** it exports `Dispatcher`, `DispatchRequest<T>`, `DispatchResult<T>`, `DispatchHandle`, `DispatchConfig`, `DispatcherMemoryState`, `DispatcherShuttingDownError`, `DEFAULT_TIMEOUTS`, and `DEFAULT_MAX_TURNS`

### AC2: DispatchRequest Contains All Required Fields with Identical Types
**Given** the existing `src/modules/agent-dispatch/types.ts`
**When** the core `DispatchRequest<T>` is compared field-by-field
**Then** it contains at minimum `prompt`, `agent`, `taskType`, `timeout`, `model`, `maxTurns`, `workingDirectory`, `outputSchema`, `otlpEndpoint`, `storyKey`, `maxContextTokens`, and `optimizationDirectives` with matching TypeScript types

### AC3: Dispatcher Interface Methods Match DispatcherImpl
**Given** the core `Dispatcher` interface and the existing `DispatcherImpl` class in `src/modules/agent-dispatch/dispatcher-impl.ts`
**When** the method signatures are compared
**Then** `DispatcherImpl` structurally satisfies the core `Dispatcher` interface without modification — covering `dispatch<T>()`, `getPending()`, `getRunning()`, `getMemoryState()`, and `shutdown()`

### AC4: DispatchConfig Uses a Local IRoutingResolver Abstraction
**Given** the existing `DispatchConfig.routingResolver` uses the concrete `RoutingResolver` class from the routing module
**When** `DispatchConfig` is defined in the core package
**Then** it declares a local `IRoutingResolver` interface (with `resolveModel(taskType: string): ModelResolution | null`) and `DispatchConfig.routingResolver` is typed as `IRoutingResolver | undefined`; the existing `RoutingResolver` class satisfies this interface structurally via TypeScript's structural typing

### AC5: DEFAULT_TIMEOUTS and DEFAULT_MAX_TURNS Constants Exported
**Given** the existing constants in `src/modules/agent-dispatch/types.ts`
**When** `DEFAULT_TIMEOUTS` and `DEFAULT_MAX_TURNS` are exported from `packages/core/src/dispatch/types.ts`
**Then** both are typed as `Record<string, number>` and contain identical task-type keys and values as the monolith originals

### AC6: Barrel Export from `dispatch/index.ts` and Core Root
**Given** all dispatch type files are created
**When** `packages/core/src/dispatch/index.ts` and `packages/core/src/index.ts` are updated
**Then** all dispatch symbols (`Dispatcher`, `DispatchRequest`, `DispatchResult`, `DispatchHandle`, `DispatchConfig`, `DispatcherMemoryState`, `DispatcherShuttingDownError`, `DEFAULT_TIMEOUTS`, `DEFAULT_MAX_TURNS`, `IRoutingResolver`, `ModelResolution`) are importable from `@substrate-ai/core`

### AC7: TypeScript Compilation Succeeds with Zero Errors
**Given** all files are created with correct ESM `.js` extension imports
**When** `npm run build` is run inside `packages/core/`
**Then** TypeScript compiles with zero errors and composite build artifacts are emitted to `packages/core/dist/dispatch/`

## Tasks / Subtasks

- [ ] Task 1: Add zod as a dependency of `packages/core` (AC: #2)
  - [ ] Add `"zod": "^4.3.6"` to `packages/core/package.json` dependencies (not devDependencies — zod appears in exported type signatures)
  - [ ] Verify the version matches the root `package.json` zod version (`^4.3.6`)

- [ ] Task 2: Create `packages/core/src/dispatch/types.ts` with all interfaces and constants (AC: #1, #2, #3, #4, #5)
  - [ ] Read `src/modules/agent-dispatch/types.ts` to copy all type signatures verbatim
  - [ ] Read `src/modules/routing/model-routing-resolver.ts` to copy `ModelResolution` interface
  - [ ] Define `ModelResolution` interface (fields: `model`, `maxTokens?`, `phase`, `source`) inline in dispatch/types.ts — note: story 40-6 will export the full routing interface family from `packages/core/src/routing/`
  - [ ] Define `IRoutingResolver` interface with single method: `resolveModel(taskType: string): ModelResolution | null`
  - [ ] Copy `DispatchRequest<T>` — preserve `outputSchema?: ZodSchema<T>` from zod; import `ZodSchema` from `'zod'`
  - [ ] Copy `DispatchHandle` (fields: `id`, `status`, `cancel()`)
  - [ ] Copy `DispatchResult<T>` (fields: `id`, `status`, `exitCode`, `output`, `parsed`, `parseError`, `durationMs`, `tokenEstimate`)
  - [ ] Copy `DispatchConfig` — use `IRoutingResolver` (not the concrete class) for `routingResolver?` field
  - [ ] Copy `DispatcherMemoryState` (fields: `freeMB`, `thresholdMB`, `pressureLevel`, `isPressured`)
  - [ ] Copy `Dispatcher` interface with all five methods: `dispatch<T>()`, `getPending()`, `getRunning()`, `getMemoryState()`, `shutdown()`
  - [ ] Copy `DEFAULT_TIMEOUTS` and `DEFAULT_MAX_TURNS` constants verbatim
  - [ ] Copy `DispatcherShuttingDownError` class (extends Error, sets name in constructor)
  - [ ] Add JSDoc comments matching the originals for all exported symbols

- [ ] Task 3: Create `packages/core/src/dispatch/index.ts` barrel export (AC: #6)
  - [ ] Create `packages/core/src/dispatch/index.ts` re-exporting all symbols from `./types.js`
  - [ ] Ensure every exported name from `./types.js` is included (types, interfaces, constants, class)

- [ ] Task 4: Update `packages/core/src/index.ts` to include dispatch exports (AC: #6)
  - [ ] Add `export * from './dispatch/index.js'` to `packages/core/src/index.ts`
  - [ ] Verify no naming conflicts with the events barrel already exported

- [ ] Task 5: Verify TypeScript compilation succeeds (AC: #7)
  - [ ] Run `npm run build` inside `packages/core/` and confirm exit code 0
  - [ ] Confirm `packages/core/dist/dispatch/` directory is populated with `.js` and `.d.ts` files
  - [ ] If compilation errors exist (e.g., missing zod types, bad import paths), fix before marking done

## Dev Notes

### Architecture Constraints
- **INTERFACE DEFINITION ONLY** — do NOT modify `src/modules/agent-dispatch/types.ts`, `src/modules/agent-dispatch/dispatcher-impl.ts`, or any existing monolith source files. This story defines new interfaces in `packages/core/`; implementations are migrated in later epics.
- **ESM imports** — all intra-package imports must use `.js` extensions: `import type { ZodSchema } from 'zod'` (external), `import { ... } from './types.js'` (intra-package). TypeScript resolves `.js` imports to `.ts` at compile time with `moduleResolution: "NodeNext"` or `"Bundler"`.
- **No circular dependencies** — `packages/core/src/dispatch/` must not import from `packages/core/src/events/` or any other core sub-module. It is self-contained.
- **IRoutingResolver vs RoutingResolver** — the concrete `RoutingResolver` class cannot be imported from the monolith into `packages/core`. Instead, define a minimal structural interface `IRoutingResolver` locally. Since TypeScript uses structural (duck) typing, the existing `RoutingResolver` class will satisfy `IRoutingResolver` automatically — no changes to `DispatcherImpl` are required.
- **Zod dependency** — `outputSchema?: ZodSchema<T>` in `DispatchRequest<T>` requires zod as a real dependency (not devDependency) because it appears in exported type signatures. Match the root `package.json` version (`^4.3.6`).
- **Copy verbatim** — copy payload types and interface shapes exactly from `src/modules/agent-dispatch/types.ts` rather than importing from the monolith. The goal is a standalone, self-contained interface package.
- **DispatcherShuttingDownError** — include the concrete `Error` subclass (not just an interface) since it is part of the dispatch contract used by callers for `instanceof` checks.

### Key Files to Read Before Starting
- `src/modules/agent-dispatch/types.ts` — full source of all dispatch types and constants to copy verbatim
- `src/modules/routing/model-routing-resolver.ts` — `ModelResolution` interface definition to copy for `IRoutingResolver` return type
- `packages/core/tsconfig.json` — verify `composite: true`, `outDir`, `rootDir` from story 40-2
- `packages/core/src/index.ts` — barrel to update with dispatch re-export (must not conflict with events exports)
- `packages/core/package.json` — add zod dependency here

### Target File Structure
```
packages/core/src/dispatch/
├── types.ts     # All dispatch interfaces, types, constants, and error class
└── index.ts     # Barrel export
```

### zod Import Pattern
```typescript
// In packages/core/src/dispatch/types.ts — import from zod (not from monolith)
import type { ZodSchema } from 'zod'
```

### IRoutingResolver Pattern
```typescript
// Define locally in packages/core/src/dispatch/types.ts
// Story 40-6 will define a more complete RoutingEngine interface in packages/core/src/routing/
export interface ModelResolution {
  model: string
  maxTokens?: number
  phase: string
  source: 'phase' | 'override'
}

export interface IRoutingResolver {
  resolveModel(taskType: string): ModelResolution | null
}
```

### Testing Requirements
- This story produces only TypeScript type definitions — no runtime behavior is added or changed
- There are no unit tests to write for pure interface/type declarations
- Verification is done by TypeScript compilation: `npm run build` in `packages/core/` must exit 0
- Do NOT run the full monorepo test suite (`npm test`) — only the core package build needs to pass for this story
- AC3 (DispatcherImpl satisfies Dispatcher interface) is verified structurally — TypeScript will enforce this when Epic 41 adds the re-export shim

## Interface Contracts

- **Export**: `Dispatcher` @ `packages/core/src/dispatch/types.ts` (consumed by stories 40-8, and factory package epics 44-46)
- **Export**: `DispatchRequest<T>`, `DispatchResult<T>`, `DispatchHandle`, `DispatchConfig` @ `packages/core/src/dispatch/types.ts` (consumed by orchestration stories in later epics)
- **Export**: `IRoutingResolver`, `ModelResolution` @ `packages/core/src/dispatch/types.ts` (forward-referenced; superseded by story 40-6's `packages/core/src/routing/types.ts`)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-22: Story created for Epic 40 (Core Extraction Phase 1)
