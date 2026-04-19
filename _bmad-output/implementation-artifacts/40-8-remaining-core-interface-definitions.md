# Story 40.8: Remaining Core Interface Definitions

## Story

As a substrate-core package consumer,
I want `WorkerAdapter`, `SpawnCommand`, `AdapterOptions`, `AdapterRegistry`, `QualityGate`, `GatePipeline`, `ContextCompiler`, and shared core primitive types defined in `packages/core/src/`,
so that other packages can depend on stable, type-safe contracts for agent adapters, quality gates, and context compilation without importing from the monolith.

## Acceptance Criteria

### AC1: Core Primitive Types File Created
**Given** `packages/core/src/types.ts` is created
**When** it is imported
**Then** it exports `TaskId`, `WorkerId`, `AgentId`, `TaskStatus`, `SessionStatus`, `BillingMode`, `LogLevel`, `TaskPriority`, `AgentCapability`, `TaskNode`, `SessionConfig`, and `CostRecord` with signatures matching `src/core/types.ts`

### AC2: Adapter Support Types File Created
**Given** `packages/core/src/adapters/types.ts` is created
**When** it is imported
**Then** it exports `SpawnCommand`, `AdapterOptions`, `AdapterCapabilities`, `AdapterHealthResult`, `TaskResult`, `TokenEstimate`, `PlanRequest`, `PlannedTask`, `PlanParseResult`, `AdapterDiscoveryResult`, and `DiscoveryReport` with signatures matching the monolith's `src/adapters/types.ts` and `src/adapters/adapter-registry.ts`

### AC3: WorkerAdapter Interface Defined
**Given** `packages/core/src/adapters/worker-adapter.ts` is created
**When** the `WorkerAdapter` interface is imported
**Then** it declares `id: AgentId`, `displayName: string`, and `adapterVersion: string` as readonly properties, plus `healthCheck()`, `buildCommand()`, `buildPlanningCommand()`, `parseOutput()`, `parsePlanOutput()`, `estimateTokens()`, and `getCapabilities()` methods with signatures matching `src/adapters/worker-adapter.ts`

### AC4: AdapterRegistry Interface Defined
**Given** `packages/core/src/adapters/types.ts` includes an `AdapterRegistry` interface
**When** the interface is inspected
**Then** it declares `register(adapter: WorkerAdapter): void`, `get(id: AgentId): WorkerAdapter | undefined`, `getAll(): WorkerAdapter[]`, `getPlanningCapable(): WorkerAdapter[]`, and `discoverAndRegister(): Promise<DiscoveryReport>` — the public surface of the monolith's concrete `AdapterRegistry` class expressed as a pure interface

### AC5: Quality Gate Types and Interfaces Defined
**Given** `packages/core/src/quality-gates/types.ts` is created
**When** it is imported
**Then** it exports `EvaluatorFn`, `GateEvaluation`, `GateConfig`, `GateResult`, `GateIssue`, `GatePipelineResult`, `CreateGateOptions`, the `QualityGate` interface, and the `GatePipeline` interface with signatures matching `src/modules/quality-gates/types.ts`, `gate.ts`, `gate-pipeline.ts`, and `gate-registry.ts`

### AC6: Context Compiler Types and Interface Defined
**Given** `packages/core/src/context/types.ts` is created
**When** it is imported
**Then** it exports `StoreQuery`, `TemplateSection`, `ContextTemplate`, `TaskDescriptor`, `SectionReport`, `CompileResult`, the Zod validation schemas for each (`StoreQuerySchema`, `TemplateSectionSchema`, `ContextTemplateSchema`, `TaskDescriptorSchema`, `SectionReportSchema`, `CompileResultSchema`), and the `ContextCompiler` interface with `compile()`, `registerTemplate()`, and `getTemplate()` methods matching `src/modules/context-compiler/`

### AC7: All Subsystems Barrel-Exported from Core and TypeScript Compiles
**Given** all new subsystem type files are created with correct ESM `.js` extension imports
**When** `packages/core/src/index.ts` is updated and `npx tsc -b packages/core --force` is run
**Then** all symbols from `types.ts`, `adapters/`, `quality-gates/`, and `context/` are importable from `@substrate-ai/core`, TypeScript compiles with zero errors, and `packages/core/dist/` is populated with `.js`, `.d.ts`, and `.d.ts.map` artifacts for each new subdirectory

## Tasks / Subtasks

- [ ] Task 1: Create `packages/core/src/types.ts` with core primitive types (AC: #1)
  - [ ] Read `src/core/types.ts` in full; copy all exported type aliases (`TaskId`, `WorkerId`, `AgentId`, `TaskStatus`, `SessionStatus`, `BillingMode`, `LogLevel`, `TaskPriority`) and interfaces (`AgentCapability`, `TaskNode`, `SessionConfig`, `CostRecord`) verbatim into `packages/core/src/types.ts`
  - [ ] Preserve all JSDoc comments from the source
  - [ ] No imports required — all types are self-contained primitives (no external package references)

- [ ] Task 2: Create `packages/core/src/adapters/types.ts` with adapter support types and AdapterRegistry interface (AC: #2, #4)
  - [ ] Read `src/adapters/types.ts` in full; copy `SpawnCommand`, `AdapterOptions`, `AdapterCapabilities`, `AdapterHealthResult`, `TaskResult`, `TokenEstimate`, `PlanRequest`, `PlannedTask`, `PlanParseResult` verbatim; add `import type { TaskId, AgentId, BillingMode } from '../types.js'` for cross-references to the new core primitives
  - [ ] Read `src/adapters/adapter-registry.ts` and extract `AdapterDiscoveryResult` and `DiscoveryReport` type definitions
  - [ ] Define `AdapterRegistry` as an interface (not a class) with `register()`, `get()`, `getAll()`, `getPlanningCapable()`, and `discoverAndRegister()` methods extracted from the public surface of the monolith's concrete class
  - [ ] Preserve all JSDoc comments

- [ ] Task 3: Create `packages/core/src/adapters/worker-adapter.ts` with WorkerAdapter interface (AC: #3)
  - [ ] Read `src/adapters/worker-adapter.ts` in full; copy the `WorkerAdapter` interface verbatim including all method signatures, readonly properties, and JSDoc examples
  - [ ] Add `import type { AgentId, AdapterOptions, SpawnCommand, AdapterCapabilities, AdapterHealthResult, TaskResult, TokenEstimate, PlanRequest, PlanParseResult } from './types.js'` at the top of the file

- [ ] Task 4: Create `packages/core/src/adapters/index.ts` barrel export (AC: #2, #3, #4)
  - [ ] Create `packages/core/src/adapters/index.ts` re-exporting all from `./types.js` and `./worker-adapter.js`
  - [ ] Confirm all public adapter symbols (`WorkerAdapter`, `AdapterRegistry`, `SpawnCommand`, `AdapterOptions`, `AdapterCapabilities`, `AdapterHealthResult`, `TaskResult`, `TokenEstimate`, `PlanRequest`, `PlannedTask`, `PlanParseResult`, `AdapterDiscoveryResult`, `DiscoveryReport`) are reachable via this barrel

- [ ] Task 5: Create quality-gates types file and barrel export (AC: #5)
  - [ ] Read `src/modules/quality-gates/types.ts`, `gate.ts`, `gate-pipeline.ts`, and `gate-registry.ts`; copy `EvaluatorFn`, `GateEvaluation`, `GateConfig`, `GateResult`, `GateIssue`, `GatePipelineResult`, `CreateGateOptions` verbatim into `packages/core/src/quality-gates/types.ts`
  - [ ] Define `QualityGate` interface with `readonly name: string`, `readonly config: GateConfig`, `evaluate(output: unknown): GateResult`, and `reset(): void`; define `GatePipeline` interface with `run(output: unknown): GatePipelineResult`
  - [ ] Add `import { type ZodSchema } from 'zod'` for `GateConfig.schema?: ZodSchema<unknown>` (zod must be in `packages/core/package.json` dependencies — add `"zod": "^4.3.6"` if not already present from story 40-4)
  - [ ] Create `packages/core/src/quality-gates/index.ts` with `export * from './types.js'`

- [ ] Task 6: Create context types file and barrel export (AC: #6)
  - [ ] Read `src/modules/context-compiler/types.ts` in full; copy all TypeScript interfaces (`StoreQuery`, `TemplateSection`, `ContextTemplate`, `TaskDescriptor`, `SectionReport`, `CompileResult`) and Zod schemas (`StoreQuerySchema`, `TemplateSectionSchema`, `ContextTemplateSchema`, `TaskDescriptorSchema`, `SectionReportSchema`, `CompileResultSchema`) verbatim into `packages/core/src/context/types.ts`
  - [ ] Read `src/modules/context-compiler/context-compiler.ts` and copy the `ContextCompiler` interface definition into the same `types.ts` file; add `import type { ContextTemplate, TaskDescriptor, CompileResult } from './types.js'` within the same file (or a separate `context-compiler.ts` if the interface is defined in its own file)
  - [ ] Ensure `import { z, type ZodSchema } from 'zod'` is present for the Zod schemas
  - [ ] Create `packages/core/src/context/index.ts` with `export * from './types.js'`

- [ ] Task 7: Update `packages/core/src/index.ts` with all new barrel re-exports (AC: #7)
  - [ ] Add `export * from './types.js'`, `export * from './adapters/index.js'`, `export * from './quality-gates/index.js'`, and `export * from './context/index.js'` to `packages/core/src/index.ts`
  - [ ] Read the existing barrel to verify no symbol name collisions with previously added exports (`events`, `dispatch`, `persistence`, `routing`, `config`, `telemetry`)
  - [ ] If any collision exists (e.g., a `TaskDescriptor` already exported from another module), use named re-exports to resolve the conflict

- [ ] Task 8: Verify TypeScript compilation succeeds (AC: #7)
  - [ ] Run `npx tsc -b packages/core --force` and confirm exit code 0
  - [ ] Confirm `packages/core/dist/` is populated with `.js`, `.d.ts`, and `.d.ts.map` files under `adapters/`, `quality-gates/`, `context/`, and root `types`
  - [ ] Fix any compilation errors (typically: missing `.js` extension on imports, wrong relative path, missing import for a referenced type) before marking done

## Dev Notes

### Architecture Constraints
- **INTERFACE DEFINITION ONLY** — do NOT modify `src/core/types.ts`, `src/adapters/types.ts`, `src/adapters/worker-adapter.ts`, `src/adapters/adapter-registry.ts`, `src/modules/quality-gates/`, or `src/modules/context-compiler/`. This story defines new interfaces in `packages/core/`; implementations are migrated in Epic 41.
- **ESM imports** — all intra-package imports must use `.js` extensions (e.g., `import type { TaskId } from '../types.js'`). TypeScript resolves `.js` → `.ts` at compile time with `moduleResolution: "NodeNext"`.
- **No circular dependencies** — `packages/core/src/types.ts` has no imports; `adapters/types.ts` imports only from `../types.js`; `quality-gates/types.ts` imports only from `zod`; `context/types.ts` imports only from `zod`. None of these import from other core sub-modules (events, dispatch, persistence, routing, config, telemetry).
- **AdapterRegistry as interface** — the existing monolith `AdapterRegistry` is a concrete class with private `_adapters: Map` state. Export only its public method signatures as `interface AdapterRegistry` in `packages/core/src/adapters/types.ts`. The concrete class stays in `src/adapters/adapter-registry.ts` until Epic 41.
- **Copy verbatim** — copy interface shapes exactly from the monolith sources, preserving all JSDoc comments, generics, and optional field markers.
- **Zod dependency** — `packages/core/package.json` must list `"zod": "^4.3.6"` as a real dependency (not devDependency) because `GateConfig.schema?: ZodSchema<unknown>` and the `CompileResultSchema` export appear in the public type surface. Story 40-4 should have added this already; verify before Task 5 and add it if missing.

### Key Source Files to Read Before Starting
- `src/core/types.ts` — all core primitive types (`TaskId`, `WorkerId`, `AgentId`, `TaskStatus`, etc.)
- `src/adapters/types.ts` — adapter support types (`SpawnCommand`, `AdapterOptions`, `AdapterCapabilities`, etc.)
- `src/adapters/worker-adapter.ts` — `WorkerAdapter` interface with full JSDoc
- `src/adapters/adapter-registry.ts` — `AdapterRegistry` class (extract public interface only; do not copy private fields or the `Map` initializer)
- `src/modules/quality-gates/types.ts` — `GateEvaluation`, `GateConfig`, `GateResult`, `GateIssue`, `GatePipelineResult`, `EvaluatorFn`
- `src/modules/quality-gates/gate.ts` — `QualityGate` interface
- `src/modules/quality-gates/gate-pipeline.ts` — `GatePipeline` interface
- `src/modules/quality-gates/gate-registry.ts` — `CreateGateOptions` interface
- `src/modules/context-compiler/types.ts` — context interfaces + Zod schemas
- `src/modules/context-compiler/context-compiler.ts` — `ContextCompiler` interface
- `packages/core/src/index.ts` — current barrel exports (verify before adding new re-exports)
- `packages/core/package.json` — check whether `zod` is already listed as a dependency

### Target File Structure
```
packages/core/src/
├── types.ts                       # TaskId, WorkerId, AgentId, TaskStatus, SessionStatus,
│                                  # BillingMode, LogLevel, TaskPriority, AgentCapability,
│                                  # TaskNode, SessionConfig, CostRecord
├── adapters/
│   ├── types.ts                   # SpawnCommand, AdapterOptions, AdapterCapabilities,
│   │                              # AdapterHealthResult, TaskResult, TokenEstimate,
│   │                              # PlanRequest, PlannedTask, PlanParseResult,
│   │                              # AdapterDiscoveryResult, DiscoveryReport, AdapterRegistry (interface)
│   ├── worker-adapter.ts          # WorkerAdapter interface
│   └── index.ts                   # export * from './types.js', './worker-adapter.js'
├── quality-gates/
│   ├── types.ts                   # EvaluatorFn, GateEvaluation, GateConfig, GateResult,
│   │                              # GateIssue, GatePipelineResult, CreateGateOptions,
│   │                              # QualityGate (interface), GatePipeline (interface)
│   └── index.ts                   # export * from './types.js'
└── context/
    ├── types.ts                   # StoreQuery, TemplateSection, ContextTemplate, TaskDescriptor,
    │                              # SectionReport, CompileResult, *Schema exports, ContextCompiler (interface)
    └── index.ts                   # export * from './types.js'
```

### Testing Requirements
- This story produces only TypeScript type definitions and interfaces — no runtime logic or side effects
- No unit tests to write for pure interface/type declarations
- Verification is solely via TypeScript compilation: `npx tsc -b packages/core --force` must exit 0
- Do NOT run the full monorepo test suite (`npm test`) — only the core package build needs to pass for this story
- Structural compatibility with the monolith sources will be confirmed when Epic 41 adds re-export shims and TypeScript enforces assignability between the new interfaces and the existing concrete implementations

## Interface Contracts

- **Export**: `TaskId`, `WorkerId`, `AgentId`, `TaskStatus`, `BillingMode`, `TaskNode` @ `packages/core/src/types.ts` (consumed by Epic 41 migration stories and stories 40-9, 40-10)
- **Export**: `WorkerAdapter` @ `packages/core/src/adapters/worker-adapter.ts` (consumed by Epic 41 adapter migration stories)
- **Export**: `AdapterOptions`, `SpawnCommand`, `AdapterRegistry` @ `packages/core/src/adapters/types.ts` (consumed by dispatcher integration in Epic 41; `AdapterOptions` imported by story 40-4's `DispatchRequest` indirectly)
- **Export**: `QualityGate`, `GatePipeline`, `GateResult` @ `packages/core/src/quality-gates/types.ts` (consumed by quality-gate pipeline migration in Epic 41)
- **Export**: `ContextCompiler`, `TaskDescriptor`, `CompileResult`, `CompileResultSchema` @ `packages/core/src/context/types.ts` (consumed by context compilation migration in Epic 41)
- **Import**: `DatabaseAdapter` @ `packages/core/src/persistence/types.ts` (from story 40-5) — verify `ContextCompiler` does not directly reference `DatabaseAdapter` in its interface signature; if it does, import from `../persistence/index.js`

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-22: Story created for Epic 40 (Core Extraction Phase 1)
