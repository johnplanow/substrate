# Story 41.2: Dispatcher Implementation Migration

## Story

As a substrate-core package consumer,
I want `DispatcherImpl`, `createDispatcher`, and the pure dispatch utilities (`extractYamlBlock`, `parseYamlResult`, `detectInterfaceChanges`, `extractExportedNames`) exported from `@substrate-ai/core`,
so that the factory loop and other downstream packages can spawn agents without importing from the monolith's `src/modules/agent-dispatch/`.

## Acceptance Criteria

### AC1: Pure Utility Files Moved to `packages/core/src/dispatch/`
**Given** `src/modules/agent-dispatch/yaml-parser.ts` and `src/modules/agent-dispatch/interface-change-detector.ts` contain no monolith-specific dependencies
**When** both files are copied verbatim to `packages/core/src/dispatch/`
**Then** `yaml-parser.ts` exports `extractYamlBlock` and `parseYamlResult`, and `interface-change-detector.ts` exports `detectInterfaceChanges`, `extractExportedNames`, and `InterfaceChangeResult` — all with identical signatures to the originals

### AC2: `IAdapterRegistry` Interface Defined in Core
**Given** `DispatcherImpl` constructor depends on the concrete `AdapterRegistry` from `src/adapters/`
**When** `IAdapterRegistry` is added to `packages/core/src/dispatch/types.ts`
**Then** it defines only the methods that `DispatcherImpl` actually calls on `AdapterRegistry` (e.g., `getAdapter(name: string): ICliAdapter | undefined`), and the existing concrete `AdapterRegistry` class satisfies this interface structurally via TypeScript's structural typing — with no changes required to the monolith's `AdapterRegistry`

### AC3: `ILogger` Interface Defined in Core and Injected into `DispatcherImpl`
**Given** `DispatcherImpl` calls `createLogger('agent-dispatch')` from `src/utils/logger.js` at module load time
**When** an `ILogger` interface is defined in `packages/core/src/` (or inline in dispatch) and `DispatcherImpl` accepts it as an optional constructor parameter (defaulting to `console`)
**Then** the logger dependency is severed from the monolith, the concrete logger returned by `createLogger` satisfies `ILogger` structurally, and the monolith can pass its logger at instantiation time without any changes to call sites

### AC4: `DispatcherImpl` Class Migrated to `packages/core/src/dispatch/dispatcher-impl.ts`
**Given** the implementation in `src/modules/agent-dispatch/dispatcher-impl.ts` uses `ITypedEventBus` (from core after story 41-1), `IAdapterRegistry` (AC2), `IRoutingResolver` (already in core from story 40-4), and `ILogger` (AC3)
**When** `packages/core/src/dispatch/dispatcher-impl.ts` is created
**Then** it contains `DispatcherImpl` (class), `createDispatcher` (factory function), `CreateDispatcherOptions` (interface), and all build-verification / package-manager-detection helpers — with all internal imports updated to reference `packages/core`-local paths using `.js` ESM extensions, and no imports from `src/`

### AC5: `packages/core/src/dispatch/index.ts` Exports All Implementation Symbols
**Given** the existing `packages/core/src/dispatch/index.ts` only exports type-level symbols from Epic 40
**When** it is updated
**Then** it additionally exports `DispatcherImpl`, `createDispatcher`, `CreateDispatcherOptions`, `extractYamlBlock`, `parseYamlResult`, `detectInterfaceChanges`, `extractExportedNames`, `InterfaceChangeResult`, `IAdapterRegistry`, and `ILogger` — all importable from `@substrate-ai/core`

### AC6: Re-Export Shims Replace Migrated Files in Monolith
**Given** existing monolith code imports from `src/modules/agent-dispatch/dispatcher-impl.ts`, `src/modules/agent-dispatch/yaml-parser.ts`, and `src/modules/agent-dispatch/interface-change-detector.ts`
**When** those three files are replaced with thin re-export shims pointing at `@substrate-ai/core`
**Then** every existing import site in the monolith continues to resolve correctly without modification, and `src/modules/agent-dispatch/index.ts` requires no changes

### AC7: `packages/core` Build Succeeds and All Existing Tests Pass
**Given** the implementation is migrated and shims are in place
**When** `npm run build` is run inside `packages/core/` and then `npm run test:fast` is run from the repo root
**Then** TypeScript compiles with zero errors, `packages/core/dist/dispatch/` contains `dispatcher-impl.js`, `yaml-parser.js`, and `interface-change-detector.js`, and all existing dispatcher tests pass (including `__tests__/dispatcher.test.ts`, `__tests__/dispatcher-routing.test.ts`, `__tests__/interface-change-detector.test.ts`, and `__tests__/yaml-parser.test.ts`)

## Tasks / Subtasks

- [ ] Task 1: Add `js-yaml` dependency to `packages/core` (AC: #4)
  - [ ] Read `packages/core/package.json` to confirm existing dependencies
  - [ ] Add `"js-yaml": "^4.1.0"` to `packages/core/package.json` dependencies (match root version)
  - [ ] Add `"@types/js-yaml": "^4.0.9"` to `packages/core/package.json` devDependencies
  - [ ] Verify the versions match those in the root `package.json`

- [ ] Task 2: Move `yaml-parser.ts` and `interface-change-detector.ts` to `packages/core` (AC: #1)
  - [ ] Read `src/modules/agent-dispatch/yaml-parser.ts` in full
  - [ ] Create `packages/core/src/dispatch/yaml-parser.ts` with identical content — the only change is removing any monolith-specific imports (the file should be self-contained with only `node:*` and `zod` dependencies)
  - [ ] Read `src/modules/agent-dispatch/interface-change-detector.ts` in full
  - [ ] Create `packages/core/src/dispatch/interface-change-detector.ts` with identical content — confirm it only depends on `node:fs`, `node:path`, and `node:child_process`

- [ ] Task 3: Define `IAdapterRegistry` and `ILogger` interfaces in `packages/core` (AC: #2, #3)
  - [ ] Read `src/adapters/adapter-registry.ts` to identify which methods `DispatcherImpl` actually calls
  - [ ] Add `IAdapterRegistry` interface to `packages/core/src/dispatch/types.ts` with only the required methods
  - [ ] Define `ICliAdapter` interface (or import from `packages/core/src/adapters/` if created by another parallel story) to type the return value of `IAdapterRegistry.getAdapter()`
  - [ ] Define `ILogger` interface (fields: `info`, `warn`, `error`, `debug` — all `(message: string, ...meta: unknown[]) => void`) in `packages/core/src/dispatch/types.ts` or a new `packages/core/src/logger.ts`

- [ ] Task 4: Create `packages/core/src/dispatch/dispatcher-impl.ts` (AC: #4)
  - [ ] Read `src/modules/agent-dispatch/dispatcher-impl.ts` in full (1,245 lines)
  - [ ] Copy the file to `packages/core/src/dispatch/dispatcher-impl.ts`
  - [ ] Update import for `TypedEventBus` — change from `'../../core/event-bus.js'` to `'./types.js'` or `'../events/index.js'` (whichever exports the interface after story 41-1)
  - [ ] Update import for `AdapterRegistry` type — change from `'../../adapters/adapter-registry.js'` to the `IAdapterRegistry` interface defined in `'./types.js'`
  - [ ] Remove import for `RoutingResolver` concrete type — `DispatchConfig.routingResolver` is already typed as `IRoutingResolver` from `'./types.js'`
  - [ ] Update import for `createLogger` — replace the module-level `const logger = createLogger(...)` with an `ILogger` parameter on the `DispatcherImpl` constructor (defaulting to `console`)
  - [ ] Update imports for `DispatcherShuttingDownError`, `DEFAULT_TIMEOUTS`, `DEFAULT_MAX_TURNS`, and other types — change from `'./types.js'` (relative to monolith) to `'./types.js'` (relative to packages/core/src/dispatch/) — paths are the same but verify no `../../` references remain
  - [ ] Update imports for `extractYamlBlock`, `parseYamlResult` — change from `'./yaml-parser.js'` (already correct relative path within packages/core/src/dispatch/)
  - [ ] Confirm all remaining imports are Node built-ins (`node:child_process`, `node:fs`, `node:path`, `node:os`, `node:crypto`) or `js-yaml` — no monolith imports

- [ ] Task 5: Update `packages/core/src/dispatch/index.ts` to export implementation (AC: #5)
  - [ ] Read `packages/core/src/dispatch/index.ts`
  - [ ] Add exports for `DispatcherImpl`, `createDispatcher`, `CreateDispatcherOptions` from `'./dispatcher-impl.js'`
  - [ ] Add exports for `extractYamlBlock`, `parseYamlResult` from `'./yaml-parser.js'`
  - [ ] Add exports for `detectInterfaceChanges`, `extractExportedNames`, `InterfaceChangeResult` from `'./interface-change-detector.js'`
  - [ ] Add type exports for `IAdapterRegistry`, `ILogger` from `'./types.js'`

- [ ] Task 6: Create re-export shims in `src/modules/agent-dispatch/` (AC: #6)
  - [ ] Replace contents of `src/modules/agent-dispatch/yaml-parser.ts` with: `export { extractYamlBlock, parseYamlResult } from '@substrate-ai/core'`
  - [ ] Replace contents of `src/modules/agent-dispatch/interface-change-detector.ts` with: `export { detectInterfaceChanges, extractExportedNames } from '@substrate-ai/core'` and `export type { InterfaceChangeResult } from '@substrate-ai/core'`
  - [ ] Replace contents of `src/modules/agent-dispatch/dispatcher-impl.ts` with: re-exports of `DispatcherImpl`, `createDispatcher`, `CreateDispatcherOptions`, and all build-verification helpers from `'@substrate-ai/core'`
  - [ ] Verify `src/modules/agent-dispatch/index.ts` requires no changes (it imports from the local `.js` files which now re-export from core)

- [ ] Task 7: Build `packages/core` and verify zero TypeScript errors (AC: #7)
  - [ ] Run `npm run build` inside `packages/core/` and confirm exit code 0
  - [ ] Confirm `packages/core/dist/dispatch/` contains `dispatcher-impl.js`, `dispatcher-impl.d.ts`, `yaml-parser.js`, `yaml-parser.d.ts`, `interface-change-detector.js`, `interface-change-detector.d.ts`
  - [ ] If TypeScript errors exist (e.g., unresolved `ITypedEventBus` after 41-1 migration), align import path to wherever `TypedEventBus` interface lives in packages/core after story 41-1

- [ ] Task 8: Run full unit test suite and verify all dispatcher tests pass (AC: #7)
  - [ ] Check no vitest instance is running: `pgrep -f vitest` returns nothing
  - [ ] Run `npm run test:fast` from repo root (timeout: 300000ms, foreground, do NOT pipe output)
  - [ ] Confirm output contains "Test Files" summary line and zero failures in `agent-dispatch/__tests__/`
  - [ ] If tests fail due to import resolution through the shim, check that `@substrate-ai/core` is resolvable from the monolith's `tsconfig.json` (it should be via `packages/core` in the workspace)

## Dev Notes

### Architecture Constraints
- **No imports from `src/` in `packages/core/`** — the core package must be self-contained. Every monolith import in `dispatcher-impl.ts` must be replaced with an interface defined in `packages/core/` or a Node built-in.
- **ESM imports with `.js` extensions** — all intra-package imports in `packages/core/src/` must use `.js` extensions. TypeScript resolves these to `.ts` at compile time via `moduleResolution: "NodeNext"`.
- **IAdapterRegistry structural compatibility** — define only the methods that `DispatcherImpl` actually calls. Read `src/adapters/adapter-registry.ts` to identify the exact method surface used, then define a minimal interface. The concrete `AdapterRegistry` must satisfy it without modification.
- **ILogger default is `console`** — `console` satisfies `ILogger` structurally (it has `.info`, `.warn`, `.error`, `.debug`). Existing call sites that do `new DispatcherImpl(bus, registry, config)` continue to work (the logger parameter is optional with `console` as default).
- **`createDispatcher` factory** — the factory function in the monolith wraps `new DispatcherImpl(...)`. When migrated to core, it accepts `IAdapterRegistry` (not the concrete type) and `CreateDispatcherOptions`. The shim in the monolith re-exports it — call sites pass the concrete `AdapterRegistry` which satisfies `IAdapterRegistry` structurally.
- **Dependency on story 41-1** — this story depends on 41-1 (EventBus Implementation Migration) having moved `TypedEventBusImpl` to packages/core. If running independently, check what `TypedEventBus` interface path is available in packages/core after 41-1 and use that import path.
- **No `RoutingResolver` concrete import** — `DispatcherImpl`'s constructor parameter `config.routingResolver` is typed as `IRoutingResolver | undefined` (already abstracted in Epic 40). Remove the `import type { RoutingResolver }` line when copying to core.
- **js-yaml and zod** — both must be real dependencies in `packages/core/package.json`, not devDependencies, because they appear in exported type signatures and runtime dispatch logic.

### Key Files to Read Before Starting
- `src/modules/agent-dispatch/dispatcher-impl.ts` — full 1,245-line source (map every monolith import before writing the migration)
- `src/modules/agent-dispatch/yaml-parser.ts` — pure utility to copy verbatim
- `src/modules/agent-dispatch/interface-change-detector.ts` — pure utility to copy verbatim
- `src/adapters/adapter-registry.ts` — identify exact method surface used by `DispatcherImpl`
- `packages/core/src/dispatch/types.ts` — existing interfaces to extend with `IAdapterRegistry` and `ILogger`
- `packages/core/src/dispatch/index.ts` — barrel to update with implementation exports
- `packages/core/package.json` — add `js-yaml` and `@types/js-yaml` dependencies

### IAdapterRegistry Pattern
```typescript
// packages/core/src/dispatch/types.ts — append these interfaces
export interface ICliAdapter {
  getCommand(): string
  getArgs(prompt: string): string[]
  // extend as needed based on actual usage in DispatcherImpl
}

export interface IAdapterRegistry {
  getAdapter(name: string): ICliAdapter | undefined
}
```

### ILogger Pattern
```typescript
// packages/core/src/dispatch/types.ts — or packages/core/src/logger.ts
export interface ILogger {
  info(message: string, ...meta: unknown[]): void
  warn(message: string, ...meta: unknown[]): void
  error(message: string, ...meta: unknown[]): void
  debug(message: string, ...meta: unknown[]): void
}
```

### DispatcherImpl Constructor Signature (after migration)
```typescript
// packages/core/src/dispatch/dispatcher-impl.ts
export class DispatcherImpl implements Dispatcher {
  constructor(
    eventBus: TypedEventBus<CoreEvents>,   // from packages/core/src/events/
    adapterRegistry: IAdapterRegistry,      // interface, not concrete class
    config: DispatchConfig,                 // already uses IRoutingResolver
    logger: ILogger = console,              // optional, defaults to console
  ) { ... }
}
```

### Re-Export Shim Pattern
```typescript
// src/modules/agent-dispatch/dispatcher-impl.ts — replace entire file
export {
  DispatcherImpl,
  createDispatcher,
  runBuildVerification,
  detectPackageManager,
  checkGitDiffFiles,
  deriveTurboFilters,
} from '@substrate-ai/core'
export type { CreateDispatcherOptions } from '@substrate-ai/core'
```

### Target File Structure After Migration
```
packages/core/src/dispatch/
├── types.ts              # Interfaces + IAdapterRegistry + ILogger added
├── dispatcher-impl.ts    # DispatcherImpl class + createDispatcher factory (NEW)
├── yaml-parser.ts        # extractYamlBlock, parseYamlResult (NEW)
├── interface-change-detector.ts  # detectInterfaceChanges, extractExportedNames (NEW)
└── index.ts              # Updated barrel — exports types + implementations

src/modules/agent-dispatch/
├── dispatcher-impl.ts    # REPLACED — thin re-export shim → @substrate-ai/core
├── yaml-parser.ts        # REPLACED — thin re-export shim → @substrate-ai/core
├── interface-change-detector.ts  # REPLACED — thin re-export shim → @substrate-ai/core
├── types.ts              # UNCHANGED
├── dispatcher.ts         # UNCHANGED
└── index.ts              # UNCHANGED
```

### Testing Requirements
- Run `npm run build` inside `packages/core/` to verify TypeScript compilation (must exit 0)
- Run `npm run test:fast` from repo root (NOT inside packages/core — tests live in monolith's `__tests__/` directories and exercise the shims)
- Do NOT run tests concurrently — verify `pgrep -f vitest` returns nothing before starting
- Do NOT pipe test output through `head`, `grep`, or `tail` — must see the "Test Files" summary line
- Target zero failures in: `dispatcher.test.ts`, `dispatcher-routing.test.ts`, `yaml-parser.test.ts`, `interface-change-detector.test.ts`

## Interface Contracts

- **Export**: `DispatcherImpl` @ `packages/core/src/dispatch/dispatcher-impl.ts` (consumed by factory loop stories 44-46)
- **Export**: `createDispatcher`, `CreateDispatcherOptions` @ `packages/core/src/dispatch/dispatcher-impl.ts` (consumed by factory loop stories 44-46)
- **Export**: `extractYamlBlock`, `parseYamlResult` @ `packages/core/src/dispatch/yaml-parser.ts` (consumed by factory loop and SDLC packages)
- **Export**: `detectInterfaceChanges`, `extractExportedNames` @ `packages/core/src/dispatch/interface-change-detector.ts` (consumed by quality gate stories in later epics)
- **Export**: `IAdapterRegistry` @ `packages/core/src/dispatch/types.ts` (from story 41-2; consumed by `DispatcherImpl` and factory package)
- **Import**: `TypedEventBus<CoreEvents>` interface @ `packages/core/src/events/` (from story 41-1)
- **Import**: `IRoutingResolver`, `DispatchConfig` @ `packages/core/src/dispatch/types.ts` (from story 40-4)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-22: Story created for Epic 41 (Core Extraction Phase 2 — Implementation Migration)
