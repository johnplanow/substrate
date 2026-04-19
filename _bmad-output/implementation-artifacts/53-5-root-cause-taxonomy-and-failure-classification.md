# Story 53-5: Root Cause Taxonomy and Failure Classification

## Story

As a substrate developer,
I want every story failure classified by root cause using a deterministic rule chain and persisted as a structured finding in Dolt,
so that the learning loop can tag, score, and inject relevant findings into future story prompts.

## Acceptance Criteria

### AC1: RootCauseCategory Enum and Finding Schema Defined
**Given** the new `packages/sdlc/src/learning/types.ts` module
**When** it is imported by other learning loop modules
**Then** `RootCauseCategorySchema` is a Zod enum with exactly 9 values: `namespace-collision`, `dependency-ordering`, `spec-staleness`, `adapter-format`, `build-failure`, `test-failure`, `resource-exhaustion`, `infrastructure`, `unclassified`
**And** `FindingSchema` is a Zod object with fields: `id` (UUID string), `run_id` (string), `story_key` (string), `root_cause` (RootCauseCategorySchema), `affected_files` (string array), `description` (string), `confidence` (`z.enum(['high', 'low'])`), `created_at` (ISO string), `expires_after_runs` (positive integer, default 5), and optional `contradicted_by` (string)
**And** `StoryFailureContext` is a plain TypeScript interface (not Zod) with fields: `storyKey`, `runId`, `error?`, `outputTokens?`, `buildFailed?`, `testsFailed?`, `adapterError?`, `affectedFiles?`

### AC2: classifyFailure Applies Deterministic Rule Chain in Priority Order
**Given** a `StoryFailureContext` whose fields match multiple rules simultaneously (e.g., `error: 'already exists'` AND `outputTokens: 5` AND `buildFailed: true`)
**When** `classifyFailure(ctx)` is called
**Then** it returns the category for the **first** matching rule — `'namespace-collision'` in this example — without evaluating subsequent rules
**And** if no rule matches, it returns `'unclassified'`

### AC3: Error Text, Flag, and Token-Count Rules Produce Correct Categories
**Given** `StoryFailureContext` objects with specific fields
**When** `classifyFailure` is called for each
**Then** `error.includes('already exists')` → `'namespace-collision'`
**And** `error.includes('depends on')` or `error.includes('not found')` → `'dependency-ordering'`
**And** `outputTokens < 100` (and no higher-priority rule matches) → `'resource-exhaustion'`
**And** `buildFailed === true` (and no higher-priority rule matches) → `'build-failure'`
**And** `testsFailed === true` (and no higher-priority rule matches) → `'test-failure'`
**And** `adapterError === true` (and no higher-priority rule matches) → `'adapter-format'`

### AC4: Infrastructure Classification Covers All System Error Patterns
**Given** a `StoryFailureContext` where the `error` field matches a system-level pattern (and no higher-priority rule applies)
**When** `classifyFailure(ctx)` is called
**Then** `'heap out of memory'` → `'infrastructure'`
**And** `'ENOSPC'` → `'infrastructure'`
**And** `'EACCES'` → `'infrastructure'`
**And** `'SIGKILL'` → `'infrastructure'`

### AC5: Unclassified Findings Get Low Confidence and Include Raw Error Text
**Given** a `StoryFailureContext` where no classification rule matches (returns `'unclassified'`)
**When** `buildFinding(ctx, 'unclassified', ctx.runId)` constructs the Finding
**Then** the resulting `Finding.confidence` is `'low'`
**And** `Finding.description` contains the raw text from `ctx.error` (or `'No error text available'` if `ctx.error` is absent)
**And** all other categories produce `confidence: 'high'`

### AC6: Findings Persisted to Dolt Decisions Table with Correct Shape
**Given** a `Finding` object returned by `buildFinding`
**When** `persistFinding(finding, db)` is called with a valid `DatabaseAdapter`
**Then** `createDecision` is called with: `category: 'finding'`, `key: '<story_key>:<run_id>'`, `phase: 'implementation'`, `pipeline_run_id: finding.run_id`, and `value: JSON.stringify(finding)` (which embeds `root_cause`, `confidence`, and `affected_files`)
**And** the `LEARNING_FINDING = 'finding'` constant in `packages/core/src/persistence/schemas/operational.ts` is used as the category value (not an inline string literal)

### AC7: classifyAndPersist Handles Unavailable Database Gracefully
**Given** a failed story and either a `null` database adapter or a database adapter whose `query` method rejects
**When** `classifyAndPersist(ctx, null)` or `classifyAndPersist(ctx, failingDb)` is called
**Then** a `Finding` is still classified and returned (in-memory result always provided)
**And** no exception propagates to the caller — persistence failure is non-fatal (caught internally)

## Tasks / Subtasks

- [ ] Task 1: Define types in `packages/sdlc/src/learning/types.ts` and add constant to core (AC: #1)
  - [ ] Create `packages/sdlc/src/learning/types.ts`:
    - `RootCauseCategorySchema = z.enum(['namespace-collision', 'dependency-ordering', 'spec-staleness', 'adapter-format', 'build-failure', 'test-failure', 'resource-exhaustion', 'infrastructure', 'unclassified'])` + inferred `RootCauseCategory` type
    - `FindingSchema = z.object({ id: z.string().uuid(), run_id: z.string(), story_key: z.string(), root_cause: RootCauseCategorySchema, affected_files: z.array(z.string()), description: z.string(), confidence: z.enum(['high', 'low']), created_at: z.string(), expires_after_runs: z.number().int().positive().default(5), contradicted_by: z.string().optional() })` + inferred `Finding` type
    - `StoryFailureContext` plain TypeScript interface (not Zod — pure type, no validation needed at call sites): `{ storyKey: string; runId: string; error?: string; outputTokens?: number; buildFailed?: boolean; testsFailed?: boolean; adapterError?: boolean; affectedFiles?: string[] }`
  - [ ] Add `LEARNING_FINDING = 'finding' as const` to `packages/core/src/persistence/schemas/operational.ts` with JSDoc comment following the same pattern as `ESCALATION_DIAGNOSIS` (key schema: `'{storyKey}:{runId}'`; value shape: JSON-serialized `Finding` object)

- [ ] Task 2: Implement `classifyFailure` and `buildFinding` in `packages/sdlc/src/learning/failure-classifier.ts` (AC: #2, #3, #4, #5)
  - [ ] Export `classifyFailure(ctx: StoryFailureContext): RootCauseCategory` — deterministic rule chain from architecture §3.4 applied in this exact priority order:
    1. `ctx.error?.includes('already exists')` → `'namespace-collision'`
    2. `ctx.error?.includes('depends on') || ctx.error?.includes('not found')` → `'dependency-ordering'`
    3. `(ctx.outputTokens ?? Infinity) < 100` → `'resource-exhaustion'`
    4. `ctx.buildFailed === true` → `'build-failure'`
    5. `ctx.testsFailed === true` → `'test-failure'`
    6. `ctx.adapterError === true` → `'adapter-format'`
    7. `/heap out of memory|ENOSPC|EACCES|SIGKILL/.test(ctx.error ?? '')` → `'infrastructure'`
    8. else → `'unclassified'`
  - [ ] Export `buildFinding(ctx: StoryFailureContext, rootCause: RootCauseCategory, runId: string): Finding` that:
    - Generates `id` via `crypto.randomUUID()`
    - Sets `confidence: 'low'` when `rootCause === 'unclassified'`, `'high'` for all other categories
    - For `'unclassified'`: sets `description` to `ctx.error ?? 'No error text available'` (raw error for agent context)
    - For all other categories: sets a short human-readable description (e.g., `'Build failed after story dispatch'` for `'build-failure'`)
    - Sets `expires_after_runs: 5`, `created_at: new Date().toISOString()`, `affected_files: ctx.affectedFiles ?? []`
    - Sets `story_key: ctx.storyKey`, `run_id: runId`
    - Returns a validated `Finding` (parse with `FindingSchema.parse(...)` before return to catch any construction errors early)

- [ ] Task 3: Implement `persistFinding` in `packages/sdlc/src/learning/finding-store.ts` (AC: #6)
  - [ ] Export `persistFinding(finding: Finding, db: DatabaseAdapter): Promise<void>`
  - [ ] Call `createDecision(db, { pipeline_run_id: finding.run_id, phase: 'implementation', category: LEARNING_FINDING, key: \`${finding.story_key}:${finding.run_id}\`, value: JSON.stringify(finding) })`
  - [ ] Import `createDecision` from `@substrate-ai/core` (or its package-internal path — verify the export chain: `packages/core/src/persistence/queries/decisions.ts` → check if re-exported from `packages/core/src/index.ts`)
  - [ ] Import `LEARNING_FINDING` from `@substrate-ai/core` (same export chain check for `packages/core/src/persistence/schemas/operational.ts`)
  - [ ] Import `DatabaseAdapter` type from `@substrate-ai/core`

- [ ] Task 4: Implement `classifyAndPersist` in `packages/sdlc/src/learning/finding-classifier.ts` (AC: #7)
  - [ ] Export `async function classifyAndPersist(ctx: StoryFailureContext, db: DatabaseAdapter | null): Promise<Finding>`:
    - Calls `classifyFailure(ctx)` to get the root cause
    - Calls `buildFinding(ctx, rootCause, ctx.runId)` to create the Finding
    - If `db !== null`: calls `persistFinding(finding, db).catch(() => { /* non-fatal */ })` — swallows any DB error silently
    - Returns the `Finding` unconditionally (in-memory result is always available)

- [ ] Task 5: Create barrel and wire into sdlc index (AC: #1)
  - [ ] Create `packages/sdlc/src/learning/index.ts` with: `export * from './types.js'`, `export * from './failure-classifier.js'`, `export * from './finding-store.js'`, `export * from './finding-classifier.js'`
  - [ ] Add `// Story 53-5: Learning loop — root cause taxonomy and failure classification` + `export * from './learning/index.js'` to `packages/sdlc/src/index.ts`

- [ ] Task 6: Write unit tests for classifyFailure and buildFinding (AC: #2, #3, #4, #5)
  - [ ] Create `packages/sdlc/src/learning/__tests__/failure-classifier.test.ts` using Vitest:
    - `classifyFailure({ storyKey: 'x', runId: 'r', error: 'already exists' })` → `'namespace-collision'`
    - `classifyFailure({ storyKey: 'x', runId: 'r', error: 'depends on foo' })` → `'dependency-ordering'`
    - `classifyFailure({ storyKey: 'x', runId: 'r', error: 'module not found' })` → `'dependency-ordering'`
    - `classifyFailure({ storyKey: 'x', runId: 'r', outputTokens: 50 })` → `'resource-exhaustion'`
    - `classifyFailure({ storyKey: 'x', runId: 'r', outputTokens: 100 })` → `'unclassified'` (boundary: 100 is NOT < 100)
    - `classifyFailure({ storyKey: 'x', runId: 'r', buildFailed: true })` → `'build-failure'`
    - `classifyFailure({ storyKey: 'x', runId: 'r', testsFailed: true })` → `'test-failure'`
    - `classifyFailure({ storyKey: 'x', runId: 'r', adapterError: true })` → `'adapter-format'`
    - `classifyFailure({ storyKey: 'x', runId: 'r', error: 'heap out of memory' })` → `'infrastructure'`
    - `classifyFailure({ storyKey: 'x', runId: 'r', error: 'ENOSPC no space left' })` → `'infrastructure'`
    - `classifyFailure({ storyKey: 'x', runId: 'r', error: 'EACCES permission denied' })` → `'infrastructure'`
    - `classifyFailure({ storyKey: 'x', runId: 'r', error: 'Process received SIGKILL' })` → `'infrastructure'`
    - `classifyFailure({ storyKey: 'x', runId: 'r' })` → `'unclassified'`
    - Priority test: `{ error: 'already exists', outputTokens: 5, buildFailed: true }` → `'namespace-collision'` (first rule wins)
    - Priority test: `{ outputTokens: 5, buildFailed: true }` → `'resource-exhaustion'` (not build-failure — resource rule is higher priority)
    - `buildFinding` confidence: `'unclassified'` → `confidence: 'low'`; `'build-failure'` → `confidence: 'high'`
    - `buildFinding` description for `'unclassified'` with `error: 'some error'` → description contains `'some error'`
    - `buildFinding` description for `'unclassified'` with no `error` → description equals `'No error text available'`

- [ ] Task 7: Write integration tests for persistFinding and classifyAndPersist (AC: #6, #7)
  - [ ] Create `packages/sdlc/src/learning/__tests__/finding-classifier.test.ts` using Vitest:
    - Mock `DatabaseAdapter` using `vi.fn()` — `{ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }`
    - `persistFinding(finding, mockDb)` test: verify `mockDb.query` was called with SQL containing `'INSERT INTO decisions'` and arguments including `'finding'` (category) and `'<storyKey>:<runId>'` (key)
    - `classifyAndPersist(ctx, mockDb)` test: resolves with a `Finding` having `root_cause`, `confidence`, `id` (UUID), `created_at` (ISO string)
    - Null db test: `classifyAndPersist(ctx, null)` resolves with a `Finding` and `mockDb.query` is never called
    - Rejecting db test: pass a db whose `query` rejects with `new Error('DB unavailable')` — verify function still resolves (no throw)

## Dev Notes

### Architecture Constraints
- All new files live in `packages/sdlc/src/learning/` — this directory does not yet exist and must be created
- Import style: `.js` extension on all local ESM imports (e.g., `import { ... } from './types.js'`)
- `classifyFailure` is a **pure synchronous function** — no I/O, no async, no LLM calls (FR-V9 principle applies to all deterministic classification)
- No logger dependency is required in this story — the only async failure path (`persistFinding`) should silently swallow errors using `.catch(() => {})` in `classifyAndPersist`; add `console.warn` at most for the rejection path if needed for observability
- `crypto.randomUUID()` is available in Node.js ≥18 natively — no polyfill needed
- `spec-staleness` is included in `RootCauseCategorySchema` but **no detection rule** is added for it in the classifier rule chain — it is reserved for future detection mechanisms and may be assigned manually or via a separate mechanism
- The `LEARNING_FINDING` constant in `packages/core/src/persistence/schemas/operational.ts` must use `as const` (not an enum entry) to match the existing `OPERATIONAL_FINDING`, `STORY_METRICS`, etc. pattern

### Key File Paths
- **New:** `packages/sdlc/src/learning/types.ts` — `RootCauseCategorySchema`, `RootCauseCategory`, `FindingSchema`, `Finding`, `StoryFailureContext`
- **New:** `packages/sdlc/src/learning/failure-classifier.ts` — `classifyFailure`, `buildFinding`
- **New:** `packages/sdlc/src/learning/finding-store.ts` — `persistFinding`
- **New:** `packages/sdlc/src/learning/finding-classifier.ts` — `classifyAndPersist`
- **New:** `packages/sdlc/src/learning/index.ts` — barrel export
- **New:** `packages/sdlc/src/learning/__tests__/failure-classifier.test.ts`
- **New:** `packages/sdlc/src/learning/__tests__/finding-classifier.test.ts`
- **Modify:** `packages/sdlc/src/index.ts` — add `export * from './learning/index.js'`
- **Modify:** `packages/core/src/persistence/schemas/operational.ts` — add `LEARNING_FINDING = 'finding' as const`

### Classification Rule Chain (Canonical — Do Not Reorder)
Per architecture §3.4:
```typescript
export function classifyFailure(ctx: StoryFailureContext): RootCauseCategory {
  if (ctx.error?.includes('already exists')) return 'namespace-collision'
  if (ctx.error?.includes('depends on') || ctx.error?.includes('not found')) return 'dependency-ordering'
  if ((ctx.outputTokens ?? Infinity) < 100) return 'resource-exhaustion'
  if (ctx.buildFailed) return 'build-failure'
  if (ctx.testsFailed) return 'test-failure'
  if (ctx.adapterError) return 'adapter-format'
  if (/heap out of memory|ENOSPC|EACCES|SIGKILL/.test(ctx.error ?? '')) return 'infrastructure'
  return 'unclassified'
}
```

### Decisions Table Key Format
`key: '{story_key}:{run_id}'` — matches the existing pattern used by `STORY_METRICS` and `ESCALATION_DIAGNOSIS` constants (see `packages/core/src/persistence/schemas/operational.ts`).

### Import Verification for @substrate-ai/core Exports
Before writing `finding-store.ts`, verify that `createDecision`, `DatabaseAdapter`, and `LEARNING_FINDING` are accessible from `@substrate-ai/core`:
- `createDecision` — check `packages/core/src/index.ts` for re-export from `./persistence/queries/decisions.js`
- `DatabaseAdapter` — check `packages/core/src/index.ts` for re-export from `./persistence/adapter.js` or `./persistence/types.js`
- If not yet re-exported from the core index, add the exports there rather than using deep relative paths from the sdlc package

### classifyAndPersist Non-Fatal Persistence Pattern
```typescript
export async function classifyAndPersist(
  ctx: StoryFailureContext,
  db: DatabaseAdapter | null,
): Promise<Finding> {
  const rootCause = classifyFailure(ctx)
  const finding = buildFinding(ctx, rootCause, ctx.runId)
  if (db !== null) {
    persistFinding(finding, db).catch(() => {
      // Non-fatal: Dolt may be unavailable; in-memory finding is always returned
    })
  }
  return finding
}
```

### Testing Requirements
- Framework: Vitest — `import { describe, it, expect, vi } from 'vitest'`
- `classifyFailure` tests are pure unit tests: pass minimal `StoryFailureContext` objects, assert return values — no mocks needed
- The token boundary test (`outputTokens: 100`) is important: the rule is strictly `< 100`, so 100 tokens should NOT trigger `resource-exhaustion`
- The priority tests are the most critical correctness checks — verifying rule 1 takes precedence over rules 3, 4
- `finding-classifier.test.ts` mocks `DatabaseAdapter` using `{ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }` — verify the `query` call received the expected SQL and parameters
- All new tests go in `packages/sdlc/src/learning/__tests__/` — no changes to existing test files

## Interface Contracts

- **Export**: `RootCauseCategory`, `RootCauseCategorySchema` @ `packages/sdlc/src/learning/types.ts` (consumed by stories 53-6 FindingsInjector relevance scorer, 53-7 finding dedup/expiry, 53-9 dispatch gating, and Epic 54 RecoveryEngine)
- **Export**: `Finding`, `FindingSchema` @ `packages/sdlc/src/learning/types.ts` (consumed by stories 53-6, 53-7, 53-8, 53-9)
- **Export**: `StoryFailureContext` @ `packages/sdlc/src/learning/types.ts` (consumed by story 53-8 intra-run propagation and Epic 54 RecoveryEngine failure injection)
- **Export**: `classifyAndPersist` @ `packages/sdlc/src/learning/finding-classifier.ts` (consumed by `src/modules/implementation-orchestrator/orchestrator-impl.ts` when Epic 54 wires the learning loop into the failure handling path)
- **Export**: `LEARNING_FINDING` constant @ `packages/core/src/persistence/schemas/operational.ts` (consumed by stories 53-6 and 53-7 for Dolt decisions queries filtered by `category: 'finding'`)
- **Import**: `retry_count` field on `PerStoryStateSchema` @ `packages/sdlc/src/run-model/per-story-state.ts` (from story 53-4 — `StoryFailureContext.outputTokens` and retry metadata are siblings in the manifest; the classifier is typically called after reading per-story-state)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-04-06: Story created (Epic 53, Phase D Autonomous Operations)
