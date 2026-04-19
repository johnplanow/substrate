# Story 43.6: SDLC Handler Registration via Runtime Composition

## Story

As a CLI composition root,
I want SDLC handlers registered in the factory's `HandlerRegistry` at startup when graph-based execution is requested,
so that the graph executor can dispatch to SDLC-specific node handlers without any compile-time coupling between `@substrate-ai/sdlc` and `@substrate-ai/factory`.

## Acceptance Criteria

### AC1: HandlerRegistry and NodeHandler Are Exported from @substrate-ai/factory
**Given** the factory package's public API
**When** TypeScript imports from `@substrate-ai/factory`
**Then** `HandlerRegistry`, `createDefaultRegistry`, `IHandlerRegistry`, and `NodeHandler` are all accessible via the package's main entry point

### AC2: buildSdlcHandlerRegistry Returns a Registry with All Four Handlers
**Given** a `buildSdlcHandlerRegistry(deps)` call with valid `SdlcRegistryDeps`
**When** the function executes
**Then** it returns a `HandlerRegistry` instance with `sdlc.phase`, `sdlc.create-story`, `sdlc.dev-story`, and `sdlc.code-review` registered as callable node handlers

### AC3: Registry Resolves Each SDLC Node Type to the Correct Handler Function
**Given** the registry returned by `buildSdlcHandlerRegistry`
**When** `registry.resolve({ id: 'dev_story', type: 'sdlc.dev-story', label: '', prompt: '' })` (or any of the four SDLC types) is called
**Then** it returns the handler function created by the corresponding factory (`createSdlcDevStoryHandler`, etc.) — not the default or a fallback

### AC4: Handlers Are Instantiated with Injected Dependencies
**Given** `SdlcRegistryDeps` containing mock options for each handler
**When** `buildSdlcHandlerRegistry(deps)` instantiates the four handlers
**Then** each handler factory function is called exactly once with the matching sub-options object from `deps` (verifiable via spy injection in tests)

### AC5: ADR-003 — No Cross-Package Compile-Time Coupling
**Given** the TypeScript build output for `@substrate-ai/sdlc` and `@substrate-ai/factory`
**When** `npm run build` runs from the monorepo root
**Then** zero TypeScript errors occur, there are no circular dependency warnings, and the sdlc package's non-test source files contain no `import … from '@substrate-ai/factory'` statements

### AC6: buildSdlcHandlerRegistry Module Is Accessible for Import by the CLI
**Given** the new `src/cli/commands/sdlc-graph-setup.ts` module
**When** `src/cli/commands/run.ts` imports `buildSdlcHandlerRegistry` from it
**Then** the import resolves correctly and the function can be called with a concrete `SdlcRegistryDeps` object assembled from live pipeline dependencies

## Tasks / Subtasks

- [ ] Task 1: Export HandlerRegistry and NodeHandler from @substrate-ai/factory public API (AC: #1)
  - [ ] Open `packages/factory/src/index.ts` and add re-exports from `./handlers/index.js`:
        `export { HandlerRegistry, createDefaultRegistry } from './handlers/index.js'`
        `export type { IHandlerRegistry, NodeHandler } from './handlers/index.js'`
  - [ ] Run `npm run build` — confirm zero TypeScript errors and no circular dependency warnings

- [ ] Task 2: Create `SdlcRegistryDeps` interface and `buildSdlcHandlerRegistry` function (AC: #2, #3, #4, #6)
  - [ ] Create `src/cli/commands/sdlc-graph-setup.ts`
  - [ ] Import `HandlerRegistry` and `NodeHandler` from `@substrate-ai/factory`
  - [ ] Import `createSdlcPhaseHandler`, `createSdlcCreateStoryHandler`, `createSdlcDevStoryHandler`, `createSdlcCodeReviewHandler` plus their options types from `@substrate-ai/sdlc`
  - [ ] Define exported `SdlcRegistryDeps` interface with fields: `phaseHandlerDeps: SdlcPhaseHandlerDeps`, `createStoryOptions: SdlcCreateStoryHandlerOptions`, `devStoryOptions: SdlcDevStoryHandlerOptions`, `codeReviewOptions: SdlcCodeReviewHandlerOptions`
  - [ ] Implement `buildSdlcHandlerRegistry(deps: SdlcRegistryDeps): HandlerRegistry` — create handler instances, cast each to `NodeHandler` via `as unknown as NodeHandler` (duck-typing bridge), and register under `'sdlc.phase'`, `'sdlc.create-story'`, `'sdlc.dev-story'`, `'sdlc.code-review'`

- [ ] Task 3: Write unit tests for handler registration (AC: #2, #3, #4)
  - [ ] Create `src/cli/commands/__tests__/sdlc-graph-setup.test.ts`
  - [ ] Test: `buildSdlcHandlerRegistry` returns an `instanceof HandlerRegistry`
  - [ ] Test: `registry.resolve({ id: 'analysis', type: 'sdlc.phase', label: '', prompt: '' })` returns a function (does not throw)
  - [ ] Test: `registry.resolve({ id: 'create_story', type: 'sdlc.create-story', label: '', prompt: '' })` returns a function
  - [ ] Test: `registry.resolve({ id: 'dev_story', type: 'sdlc.dev-story', label: '', prompt: '' })` returns a function
  - [ ] Test: `registry.resolve({ id: 'code_review', type: 'sdlc.code-review', label: '', prompt: '' })` returns a function
  - [ ] Test: each handler factory is called with the matching sub-options from `deps` — inject `vi.fn()` wrappers around factory functions to spy on call arguments
  - [ ] Test: resolving an unregistered type (no default set) throws `HandlerRegistry`'s standard error — confirms no inadvertent default is installed

- [ ] Task 4: Write ADR-003 compliance test (AC: #5)
  - [ ] In the test file, add a test that reads the sdlc package source files (via `fs.readdirSync` / `fs.readFileSync`) and asserts no non-test `.ts` file contains `@substrate-ai/factory` as an import source
  - [ ] Alternatively, verify the absence of cross-package imports at the TypeScript tsc level by confirming `npm run build` emits no errors (can be documented as a manual verification step in Dev Notes rather than a runtime test, given the monorepo's `tsconfig` project references already enforce this)

- [ ] Task 5: Verify build and test suite (AC: #1, #5, #6)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all new tests pass, no regressions in existing factory or sdlc tests

## Dev Notes

### Architecture Constraints

- **ADR-003 (no cross-package coupling)**: `src/cli/commands/sdlc-graph-setup.ts` is the **only** file that imports from both `@substrate-ai/sdlc` and `@substrate-ai/factory`. This is by design — the CLI is the composition root.
- **Duck-typing bridge**: SDLC handlers return `SdlcOutcome` (defined locally in the sdlc package). The factory's `NodeHandler` type expects `Outcome` (from `packages/factory/src/graph/types.ts`). Both interfaces are structurally compatible — `SdlcOutcome.status` uses `OutcomeStatus` values (`'SUCCESS'|'FAILURE'|...`) which are the same as `Outcome.status`. Cast via `as unknown as NodeHandler` in the registration step; do NOT add `@substrate-ai/factory` to sdlc's production dependencies.
- **`@substrate-ai/factory` is NOT in sdlc's `dependencies`**: It is already listed as a `devDependency` (for test mocking only). The new `src/cli/commands/sdlc-graph-setup.ts` lives in the monolith's `src/`, which already has access to both packages via the monorepo workspace.
- **Handler factory signatures**: All four handler factories accept a single options/deps object. The `createSdlcPhaseHandler` accepts `SdlcPhaseHandlerDeps`; the other three accept their respective `*HandlerOptions` interfaces. Wrap each factory call and cast the return value.
- **No default handler**: `buildSdlcHandlerRegistry` should NOT call `registry.setDefault()`. The four SDLC types are explicit; any unrecognised node should throw to surface configuration errors early.
- **`HandlerRegistry` not yet exported from `@substrate-ai/factory`**: Task 1 must add this export before the build in Task 5 can succeed. Add to `packages/factory/src/index.ts` only — do not modify `packages/factory/package.json`.

### File Paths

- **New file**: `src/cli/commands/sdlc-graph-setup.ts`
- **New test**: `src/cli/commands/__tests__/sdlc-graph-setup.test.ts`
- **Modify**: `packages/factory/src/index.ts` — add exports for `HandlerRegistry`, `createDefaultRegistry`, `IHandlerRegistry`, `NodeHandler` from `./handlers/index.js`

### Import Pattern (sdlc-graph-setup.ts)

```typescript
// Composition root: this file is the ONLY place that imports from both packages.
import { HandlerRegistry } from '@substrate-ai/factory'
import type { NodeHandler } from '@substrate-ai/factory'
import {
  createSdlcPhaseHandler,
  createSdlcCreateStoryHandler,
  createSdlcDevStoryHandler,
  createSdlcCodeReviewHandler,
} from '@substrate-ai/sdlc'
import type {
  SdlcPhaseHandlerDeps,
  SdlcCreateStoryHandlerOptions,
  SdlcDevStoryHandlerOptions,
  SdlcCodeReviewHandlerOptions,
} from '@substrate-ai/sdlc'

export interface SdlcRegistryDeps {
  phaseHandlerDeps: SdlcPhaseHandlerDeps
  createStoryOptions: SdlcCreateStoryHandlerOptions
  devStoryOptions: SdlcDevStoryHandlerOptions
  codeReviewOptions: SdlcCodeReviewHandlerOptions
}

export function buildSdlcHandlerRegistry(deps: SdlcRegistryDeps): HandlerRegistry {
  const registry = new HandlerRegistry()

  registry.register(
    'sdlc.phase',
    createSdlcPhaseHandler(deps.phaseHandlerDeps) as unknown as NodeHandler,
  )
  registry.register(
    'sdlc.create-story',
    createSdlcCreateStoryHandler(deps.createStoryOptions) as unknown as NodeHandler,
  )
  registry.register(
    'sdlc.dev-story',
    createSdlcDevStoryHandler(deps.devStoryOptions) as unknown as NodeHandler,
  )
  registry.register(
    'sdlc.code-review',
    createSdlcCodeReviewHandler(deps.codeReviewOptions) as unknown as NodeHandler,
  )

  return registry
}
```

### Handler Type Keys Reference

| Type key | Factory function | Handler source |
|---|---|---|
| `sdlc.phase` | `createSdlcPhaseHandler` | Story 43-2 |
| `sdlc.create-story` | `createSdlcCreateStoryHandler` | Story 43-3 |
| `sdlc.dev-story` | `createSdlcDevStoryHandler` | Story 43-4 |
| `sdlc.code-review` | `createSdlcCodeReviewHandler` | Story 43-5 |

### Testing Requirements

- **Framework**: Vitest (same as all monolith tests in `src/`)
- **Mock pattern**: Use `vi.mock('@substrate-ai/sdlc', ...)` to spy on handler factory calls, then verify each factory was called with the correct sub-options from `deps`. Alternatively, inject factory functions as parameters to a test-only overload (simpler and avoids module-level mocking).
- **Context mock**: Tests for handler resolution only need to call `registry.resolve(node)` and assert the result is a function — no need to execute the handler.
- **Circular dependency check**: TypeScript project references in `tsconfig.json` enforce package boundaries. The build passing (Task 5) is sufficient to prove ADR-003 compliance; a separate runtime check is optional.
- **Test file**: `src/cli/commands/__tests__/sdlc-graph-setup.test.ts`
- **Run**: `npm run test:fast` from monorepo root; confirm zero failures

## Interface Contracts

- **Import**: `SdlcPhaseHandlerDeps` @ `packages/sdlc/src/handlers/types.ts` (from story 43-2)
- **Import**: `SdlcCreateStoryHandlerOptions` @ `packages/sdlc/src/handlers/sdlc-create-story-handler.ts` (from story 43-3)
- **Import**: `SdlcDevStoryHandlerOptions` @ `packages/sdlc/src/handlers/sdlc-dev-story-handler.ts` (from story 43-4)
- **Import**: `SdlcCodeReviewHandlerOptions` @ `packages/sdlc/src/handlers/sdlc-code-review-handler.ts` (from story 43-5)
- **Export**: `buildSdlcHandlerRegistry` @ `src/cli/commands/sdlc-graph-setup.ts` (consumed by story 43-7 — graph orchestrator, and story 43-10 — `--engine` flag wiring)
- **Export**: `SdlcRegistryDeps` @ `src/cli/commands/sdlc-graph-setup.ts` (consumed by story 43-7 and story 43-10)
- **Modify**: `HandlerRegistry`, `NodeHandler` @ `packages/factory/src/index.ts` (added to factory public API; consumed here and by story 43-7)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-22: Story created for Epic 43, Phase A — SDLC Pipeline as Graph
