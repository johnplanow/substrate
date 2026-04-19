# Story 41.5: Config System Migration

## Story

As a substrate-core package consumer,
I want `ConfigSystemImpl`, `createConfigSystem`, `ConfigWatcher`, `ConfigMigrator`, `DEFAULT_CONFIG`, and all config utility functions available from `@substrate-ai/core`,
so that downstream packages (`@substrate-ai/sdlc`, `@substrate-ai/factory`) can load, validate, watch, and migrate configuration without importing from the monolith's `src/modules/config/`.

## Acceptance Criteria

### AC1: Implementation files migrated to packages/core/src/config/
**Given** `packages/core/src/config/` contains only interface/schema files (`types.ts`, `index.ts`) after story 40-7
**When** story 41-5 is complete
**Then** the following new implementation files exist in `packages/core/src/config/`: `config-system-impl.ts`, `config-watcher.ts`, `config-migrator.ts`, `defaults.ts`, `version-utils.ts`; and no implementation code remains in `src/modules/config/` (only re-export shims)

### AC2: Duck-typed interfaces decouple ConfigSystemImpl from monolith modules
**Given** `packages/core/src/config/config-system-impl.ts` is compiled in `packages/core/`
**When** all imports are resolved
**Then** it has zero imports from `src/modules/`, `src/adapters/`, or `src/utils/`; `ILogger` is imported from `../dispatch/types.js` within the core package; any EventBus usage imports `TypedEventBus` from `../events/event-bus.js`

### AC3: TokenCeilingsSchema and SDLC-specific config remain outside core
**Given** `token_ceilings` is an SDLC-specific configuration section
**When** `packages/core/src/config/types.ts` is inspected
**Then** `TokenCeilingsSchema` and the `token_ceilings` field are absent from the core `SubstrateConfig` type; the SDLC package retains or defines its own `SdlcConfig extends SubstrateConfig` with `token_ceilings`; the core `SubstrateConfigSchema` uses `.passthrough()` to allow SDLC/factory extension without validation errors

### AC4: packages/core/src/config/index.ts exports all implementation symbols
**Given** `packages/core/src/config/index.ts` is updated after migration
**When** code does `import { ConfigSystemImpl, createConfigSystem, ConfigWatcher, ConfigMigrator, DEFAULT_CONFIG, getByPath, setByPath, deepMerge, getVersionCompatibility } from '@substrate-ai/core'`
**Then** all exports resolve and TypeScript compiles without errors

### AC5: Re-export shims at all original src/modules/config/ paths
**Given** every file in `src/modules/config/` is converted to a re-export shim pointing at `@substrate-ai/core`
**When** any existing monolith file imports from `src/modules/config/config-system.ts`, `config-system-impl.ts`, `config-schema.ts`, `config-watcher.ts`, `config-migrator.ts`, `defaults.ts`, `version-utils.ts`, or `index.ts`
**Then** the imports resolve correctly and TypeScript compiles without errors; no implementation code remains in `src/modules/config/`

### AC6: packages/core builds cleanly with zero type errors
**Given** the migration is complete
**When** `tsc -b` is run in `packages/core/`
**Then** it exits with code 0 and zero type errors; no circular dependencies exist within `packages/core/src/config/`

### AC7: All existing config tests pass without modification
**Given** the migration is complete and shims are in place
**When** `npm run test:fast` is executed
**Then** all tests in `src/modules/config/__tests__/` pass without any test file modifications

## Tasks / Subtasks

- [ ] Task 1: Migrate pure utility modules to `packages/core/src/config/` (AC: #1, #6)
  - [ ] Copy `src/modules/config/defaults.ts` to `packages/core/src/config/defaults.ts`; update all imports to use `.js` extensions; verify only local Zod schemas are referenced (from `./types.js`)
  - [ ] Copy `src/modules/config/version-utils.ts` to `packages/core/src/config/version-utils.ts`; update imports to use `.js` extensions; the module uses only `node:` builtins and local types — no external monolith deps expected
  - [ ] Verify `packages/core/src/config/types.ts` already defines all Zod schemas needed by these utilities (SubstrateConfigSchema, ProviderConfigSchema, etc.); add `.passthrough()` calls to top-level schemas that must accept SDLC/factory extension keys without stripping them

- [ ] Task 2: Migrate `ConfigMigrator` to core (AC: #1, #2, #6)
  - [ ] Copy `src/modules/config/config-migrator.ts` to `packages/core/src/config/config-migrator.ts`
  - [ ] Replace `import type pino` or `createLogger` with `ILogger` imported from `../dispatch/types.js`; update constructor to accept `logger?: ILogger` defaulting to `console`
  - [ ] Update all intra-file imports to use `.js` extensions; replace any `SubstrateConfig` or schema imports from monolith paths with imports from `./types.js`

- [ ] Task 3: Migrate `ConfigWatcher` to core (AC: #1, #2, #6)
  - [ ] Copy `src/modules/config/config-watcher.ts` to `packages/core/src/config/config-watcher.ts`
  - [ ] Replace `import type pino` or `createLogger` with `ILogger` from `../dispatch/types.js`; update constructor to accept optional `logger?: ILogger`
  - [ ] Update imports for `SubstrateConfig`, Zod schemas, and yaml parsing; use `js-yaml` (already a core dependency); update all paths to `.js` extensions
  - [ ] Preserve the debounce behavior, `flattenObject`, and `computeChangedKeys` utility functions exactly; move them inline to `config-watcher.ts` if they were previously imported from a shared util

- [ ] Task 4: Migrate `ConfigSystemImpl` and factory to core (AC: #1, #2, #4, #6)
  - [ ] Copy `src/modules/config/config-system-impl.ts` to `packages/core/src/config/config-system-impl.ts`
  - [ ] Replace any `import type pino` / `createLogger` with `ILogger` from `../dispatch/types.js`; add `logger?: ILogger` to `ConfigSystemOptions` defaulting to `console`
  - [ ] Replace all `SubstrateConfig`, schema, migrator, watcher, and defaults imports with local core-package paths using `.js` extensions (`./types.js`, `./defaults.js`, `./config-migrator.js`, `./config-watcher.js`, `./version-utils.js`)
  - [ ] Remove any `token_ceilings` references from the core implementation; use `.passthrough()` schemas so SDLC-extended configs pass validation without errors in core
  - [ ] Verify `getByPath`, `setByPath`, and `deepMerge` utility functions are either defined locally or exported from `./version-utils.js`; do NOT import from monolith's `src/utils/`

- [ ] Task 5: Update barrel exports in packages/core (AC: #4, #6)
  - [ ] Rewrite `packages/core/src/config/index.ts` to export all symbols: `ConfigSystemImpl`, `createConfigSystem`, `ConfigWatcher`, `ConfigMigrator`, `DEFAULT_CONFIG`, `getByPath`, `setByPath`, `deepMerge`, `getVersionCompatibility`, and all Zod schemas / TypeScript types from `./types.js`
  - [ ] Update `packages/core/src/index.ts` to include all new config implementation symbols (verify the config namespace is fully included in the top-level barrel)
  - [ ] Run `tsc -b` in `packages/core/` and fix any type errors before proceeding to shim creation; pay attention to `RateLimitConfig` collision between config and routing namespaces — the config module's `RateLimitConfig` (if different from routing's) must be re-exported under a disambiguated name or omitted per the existing barrel strategy

- [ ] Task 6: Create re-export shims for all `src/modules/config/` files (AC: #5, #7)
  - [ ] Replace each file in `src/modules/config/` with a shim that re-exports from `@substrate-ai/core`; files to shim: `index.ts`, `config-system.ts`, `config-system-impl.ts`, `config-schema.ts`, `config-watcher.ts`, `config-migrator.ts`, `defaults.ts`, `version-utils.ts`
  - [ ] For `config-schema.ts`: its Zod schemas are now in `packages/core/src/config/types.ts`; shim must re-export all schema names that the monolith's callers reference
  - [ ] For `config-system.ts`: it may export only the `ConfigSystem` interface and `ConfigSystemOptions` type; ensure the shim re-exports these as `export type { ... }` from `@substrate-ai/core`
  - [ ] Run `npm run test:fast` and confirm zero regressions; fix any import resolution failures before marking complete

- [ ] Task 7: Integration smoke test (AC: #6, #7)
  - [ ] Run `npm run test:fast` after all shims are in place; confirm all tests in `src/modules/config/__tests__/` pass without modification
  - [ ] Confirm the `ConfigSystem` can be instantiated via `createConfigSystem()` from `@substrate-ai/core` in a throwaway test snippet (import the factory, call it, call `.load()`, call `.getConfig()`)
  - [ ] Run `tsc -b` at repo root to verify monolith TypeScript compilation succeeds end-to-end

## Dev Notes

### Architecture Constraints
- **ESM `.js` imports**: All intra-package imports in `packages/core/src/` must use `.js` extensions (e.g., `import { DEFAULT_CONFIG } from './defaults.js'`)
- **No imports from `src/` in `packages/core/`**: The core package must be self-contained; replace all monolith module references with local duck-typed interfaces or local implementations
- **ILogger**: Already exported from `@substrate-ai/core` via `packages/core/src/dispatch/types.ts` (story 41-2); import within core via `../dispatch/types.js`; do NOT redefine
- **js-yaml is already a dependency of packages/core** (added in story 41-2); no new `package.json` changes needed for YAML config parsing
- **TokenCeilingsSchema excluded from core**: The `token_ceilings` config section is SDLC-specific. The core `SubstrateConfig` type must NOT include it. Use `.passthrough()` on the root Zod schema so that SDLC configs (which add `token_ceilings`) pass core validation without schema stripping
- **RateLimitConfig collision**: The config module defines `RateLimitConfig` (shape: `{ tokens: number; window_seconds: number }`) while the routing module also exports a `RateLimitConfig`. The existing `packages/core/src/config/index.ts` already intentionally excludes the config `RateLimitConfig` from the barrel to avoid collision — preserve this behavior
- **Depends on 40-7 (Config Interface Definition)** and **41-2 (Dispatcher — ILogger source)**: both must be complete before starting this story
- **Zero behavioral change**: All implementation logic must be identical to the monolith; the only changes are import path updates, DI refactoring (logger injection), and `.passthrough()` schema addition

### .passthrough() Pattern for Extensibility
The core `SubstrateConfigSchema` must allow SDLC/factory packages to extend the config shape without core validation stripping unknown keys:
```typescript
// packages/core/src/config/types.ts — BEFORE (strict)
export const SubstrateConfigSchema = z.object({
  global: GlobalSettingsSchema,
  providers: ProvidersConfigSchema,
  // ...
})

// AFTER (extensible)
export const SubstrateConfigSchema = z.object({
  global: GlobalSettingsSchema,
  providers: ProvidersConfigSchema,
  // ...
}).passthrough()
```

SDLC can then define:
```typescript
// packages/sdlc/src/config/sdlc-config.ts
import { SubstrateConfigSchema } from '@substrate-ai/core'
export const SdlcConfigSchema = SubstrateConfigSchema.extend({
  token_ceilings: TokenCeilingsSchema,
})
export type SdlcConfig = z.infer<typeof SdlcConfigSchema>
```

### Dependency Injection Pattern for ConfigSystemImpl
```typescript
// BEFORE (monolith)
export class ConfigSystemImpl implements ConfigSystem {
  private logger = createLogger('config-system')
  constructor(options?: ConfigSystemOptions) { ... }
}

// AFTER (packages/core)
import type { ILogger } from '../dispatch/types.js'

export interface ConfigSystemOptions {
  globalConfigPath?: string
  projectConfigPath?: string
  logger?: ILogger
}

export class ConfigSystemImpl implements ConfigSystem {
  private logger: ILogger
  constructor(options?: ConfigSystemOptions) {
    this.logger = options?.logger ?? console
    // ...
  }
}
```

### Re-Export Shim Patterns
```typescript
// src/modules/config/config-system-impl.ts (shim)
export { ConfigSystemImpl, createConfigSystem } from '@substrate-ai/core'
export type { ConfigSystemOptions } from '@substrate-ai/core'
```

```typescript
// src/modules/config/config-schema.ts (shim)
export {
  SubstrateConfigSchema,
  GlobalSettingsSchema,
  ProviderConfigSchema,
  ProvidersConfigSchema,
  CostTrackerConfigSchema,
  BudgetConfigSchema,
  TelemetryConfigSchema,
} from '@substrate-ai/core'
export type {
  SubstrateConfig,
  GlobalSettings,
  ProviderConfig,
  ProvidersConfig,
  CostTrackerConfig,
  BudgetConfig,
  TelemetryConfig,
  SubscriptionRouting,
} from '@substrate-ai/core'
```

```typescript
// src/modules/config/index.ts (shim — passthrough)
export {
  ConfigSystemImpl,
  createConfigSystem,
  ConfigWatcher,
  ConfigMigrator,
  DEFAULT_CONFIG,
  getByPath,
  setByPath,
  deepMerge,
  getVersionCompatibility,
  SubstrateConfigSchema,
  GlobalSettingsSchema,
  ProviderConfigSchema,
  // ... all other schemas
} from '@substrate-ai/core'
export type {
  ConfigSystem,
  ConfigSystemOptions,
  SubstrateConfig,
  GlobalSettings,
  ProviderConfig,
  // ... all other types
} from '@substrate-ai/core'
```

### Testing Requirements
- Run `tsc -b` in `packages/core/` after Task 5 (barrel updates, before shims) to confirm the core package compiles cleanly
- Run `npm run test:fast` after Task 6 (shims in place) to confirm zero regressions
- The `__tests__/` directory in `src/modules/config/` must NOT be modified — tests run against the shims and must pass unmodified
- Watch for tests that directly import from `src/modules/config/config-schema.ts` and reference `TokenCeilingsSchema`: these tests belong to SDLC-specific behavior and should not reference core config types after migration
- **CRITICAL**: Never run tests concurrently — verify `pgrep -f vitest` returns nothing before running; use `timeout: 300000` in Bash tool

## Interface Contracts

- **Export**: `ConfigSystemImpl`, `createConfigSystem` @ `packages/core/src/config/config-system-impl.ts` (consumed by stories 41-6a, 41-7, 43-x, and all SDLC/factory setup)
- **Export**: `ConfigWatcher` @ `packages/core/src/config/config-watcher.ts` (consumed by SDLC hot-reload orchestrator)
- **Export**: `ConfigMigrator` @ `packages/core/src/config/config-migrator.ts` (consumed by CLI init/upgrade flows)
- **Export**: `DEFAULT_CONFIG`, `getByPath`, `setByPath`, `deepMerge` @ `packages/core/src/config/` (utility consumers across SDLC and factory)
- **Export**: `SubstrateConfigSchema` with `.passthrough()` @ `packages/core/src/config/types.ts` (consumed by SDLC's `SdlcConfigSchema.extend(...)`)
- **Import**: `ILogger` @ `packages/core/src/dispatch/types.ts` (from story 41-2)
- **Import**: `TypedEventBus` @ `packages/core/src/events/event-bus.ts` (from story 41-1, if ConfigSystemImpl emits config-changed events)
- **Import**: `ConfigSystem` interface @ `packages/core/src/config/types.ts` (from story 40-7)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
