# Story 53-6: Findings Injector with Relevance Scoring

## Story

As a substrate developer,
I want classified findings injected into story prompts ranked by relevance,
so that the most applicable findings get prompt budget priority and the learning loop produces targeted, actionable guidance.

## Acceptance Criteria

### AC1: RelevanceScorer Module with Correct Weighted Formula
**Given** a `Finding` with `affected_files` and `root_cause`, and an `InjectionContext` with `targetFiles`, `packageName`, and `riskProfile`
**When** `scoreRelevance(finding, context)` is called
**Then** it returns a number in [0, 1] computed as `0.5 * jaccardFileOverlap + 0.3 * packageMatch + 0.2 * rootCauseMatch`
**And** `jaccardFileOverlap = intersectionCount / min(finding.affected_files.length, cappedTargetFiles.length)` where `cappedTargetFiles` are up to 20 story target files (sorted by path length ascending)
**And** `packageMatch` is `1.0` if `packageName` matches the package inferred from finding's `affected_files` (segment after `packages/` and before next `/`), `0.5` if `packageName` is undefined or no matching files, `0.0` if `packageName` is provided but doesn't match
**And** `rootCauseMatch` is `1.0` if `riskProfile` is provided and includes the finding's `root_cause`, `0.5` if `riskProfile` is undefined or empty, `0.0` if `riskProfile` is provided but does not include the finding's `root_cause`
**And** if either `targetFiles` or `finding.affected_files` is empty, `jaccardFileOverlap` is `0`

### AC2: FindingsInjector Queries Structured Findings and Applies Threshold Filter
**Given** a `DatabaseAdapter` and `InjectionContext`
**When** `FindingsInjector.inject(db, context, config?)` is called
**Then** it queries the decisions table with `category: LEARNING_FINDING` using `getDecisionsByCategory`
**And** each row's `value` is parsed with `FindingSchema.safeParse`; malformed rows are silently skipped
**And** each valid `Finding` is scored with `scoreRelevance(finding, context)`
**And** findings with `score < threshold` (default `0.3`) are excluded from injection
**And** if no findings remain after filtering, an empty string `''` is returned

### AC3: Saturation Guard Dynamically Raises Threshold
**Given** the findings set after initial threshold filtering contains more than `saturationLimit` findings (default `10`)
**When** `FindingsInjector.inject` evaluates the filtered set
**Then** the threshold is raised by `0.1` increments until `≤ saturationLimit` findings remain above it
**And** if raising the threshold above `1.0` would still leave more than `saturationLimit` findings, the top `saturationLimit` by score are used instead

### AC4: Serialization with Directive/Warning Framing and Budget Enforcement
**Given** filtered and sorted (score descending) findings
**When** `FindingsInjector.inject` serializes them
**Then** each `confidence: 'high'` finding is framed as `"[${root_cause}] Directive: ${description}"`
**And** each `confidence: 'low'` finding is framed as `"[${root_cause}] Note (low confidence): ${description}"`
**And** findings are appended to the output in score-descending order until the `maxChars` budget (default `2000`) is exhausted — any finding that would exceed the budget is omitted
**And** the result is prefixed with `"Prior run findings (most relevant first):\n\n"` when at least one finding is serialized

### AC5: FindingsInjectorConfig Overrides Are Applied Correctly
**Given** a `FindingsInjectorConfig` with custom `threshold`, `maxChars`, and/or `saturationLimit`
**When** `FindingsInjector.inject(db, context, config)` is called
**Then** the injector uses the provided override values in place of their defaults
**And** omitted config fields continue to use their defaults

### AC6: Callsite Swap in dev-story.ts
**Given** the compiled dev-story workflow in `src/modules/compiled-workflows/dev-story.ts`
**When** it assembles prior findings for prompt injection
**Then** the existing `getProjectFindings(deps.db)` call is replaced with `FindingsInjector.inject(deps.db, { storyKey, runId: params.pipelineRunId ?? '', targetFiles: extractTargetFilesFromStoryContent(storyContent) })`
**And** the `import { getProjectFindings }` line is replaced with `import { FindingsInjector, extractTargetFilesFromStoryContent } from '@substrate-ai/sdlc'`
**And** the existing try/catch wrapper and `''`-on-error fallback are preserved unchanged
**And** the log message is updated to reflect the new injector

### AC7: Unit Tests Cover Scoring, Saturation, Framing, and Edge Cases
**Given** the test suite in `packages/sdlc/src/learning/__tests__/`
**When** `npm run test:fast` is executed
**Then** `relevance-scorer.test.ts` covers: the three-component weighted formula, empty `targetFiles` → `jaccardFileOverlap = 0`, empty `affected_files` → `jaccardFileOverlap = 0`, partial overlap, 20-file cap on target files, `packageMatch` matching and mismatch, `rootCauseMatch` with/without `riskProfile`
**And** `findings-injector.test.ts` covers: empty decisions → `''`, malformed rows skipped, threshold exclusion, saturation guard raises threshold, budget truncation stops at `maxChars`, `confidence: 'high'` directive framing, `confidence: 'low'` warning framing, config overrides applied, DB error → `''`, and `extractTargetFilesFromStoryContent` parsing accuracy

## Tasks / Subtasks

- [ ] Task 1: Implement `RelevanceScorer` in `packages/sdlc/src/learning/relevance-scorer.ts` (AC: #1)
  - [ ] Export `InjectionContext` interface:
    ```typescript
    export interface InjectionContext {
      storyKey: string
      runId: string
      targetFiles?: string[]
      packageName?: string
      riskProfile?: RootCauseCategory[]
    }
    ```
  - [ ] Export `scoreRelevance(finding: Finding, context: InjectionContext): number`:
    - `cappedTargetFiles`: sort `context.targetFiles` by path length ascending, take first 20; if `undefined` or empty → `[]`
    - `jaccardFileOverlap`: if either `cappedTargetFiles` or `finding.affected_files` is empty → `0`; else `intersectionSet.size / Math.min(finding.affected_files.length, cappedTargetFiles.length)` where intersection uses exact string equality
    - `packageMatch`: extract package name from each path in `finding.affected_files` via regex `packages\/([^/]+)\/`; if no package can be inferred or `context.packageName` is undefined → `0.5`; if at least one inferred package matches `context.packageName` → `1.0`; else → `0.0`
    - `rootCauseMatch`: if `context.riskProfile` is `undefined` or empty → `0.5`; if `context.riskProfile.includes(finding.root_cause)` → `1.0`; else → `0.0`
    - Return `Math.min(1, Math.max(0, 0.5 * jaccardFileOverlap + 0.3 * packageMatch + 0.2 * rootCauseMatch))`
  - [ ] Import `Finding` and `RootCauseCategory` from `./types.js`

- [ ] Task 2: Implement `FindingsInjector` in `packages/sdlc/src/learning/findings-injector.ts` (AC: #2, #3, #4, #5)
  - [ ] Export `FindingsInjectorConfig` interface: `{ threshold?: number; maxChars?: number; saturationLimit?: number }`
  - [ ] Export `FindingsInjector` class with a **static** `inject` method:
    ```typescript
    static async inject(
      db: DatabaseAdapter,
      context: InjectionContext,
      config?: FindingsInjectorConfig,
    ): Promise<string>
    ```
  - [ ] Inside `inject`:
    1. Resolve config defaults: `threshold = config?.threshold ?? 0.3`, `maxChars = config?.maxChars ?? 2000`, `saturationLimit = config?.saturationLimit ?? 10`
    2. Query `getDecisionsByCategory(db, LEARNING_FINDING)` in try/catch; on any error return `''`
    3. Parse each row: `FindingSchema.safeParse(JSON.parse(row.value))`; skip rows where `safeParse.success === false` or `JSON.parse` throws
    4. Score each parsed Finding with `scoreRelevance(finding, context)`
    5. Filter: keep only `score >= threshold`
    6. Saturation guard: while `filtered.length > saturationLimit && threshold <= 1.0`: `threshold += 0.1`; re-filter; after loop if still > `saturationLimit`, slice to top `saturationLimit` by score
    7. Sort by score descending
    8. Serialize with budget: for each finding in order, build line `"[${root_cause}] Directive: ${description}"` or `"[${root_cause}] Note (low confidence): ${description}"`; stop if appending would exceed `maxChars`
    9. If output is empty, return `''`; else return `"Prior run findings (most relevant first):\n\n" + lines.join('\n')`
  - [ ] Imports: `DatabaseAdapter` from `@substrate-ai/core`, `getDecisionsByCategory` from `@substrate-ai/core`, `LEARNING_FINDING` from `@substrate-ai/core`, `Finding`, `FindingSchema` from `./types.js`, `InjectionContext` from `./relevance-scorer.js`, `scoreRelevance` from `./relevance-scorer.js`

- [ ] Task 3: Implement `extractTargetFilesFromStoryContent` helper in `packages/sdlc/src/learning/findings-injector.ts` (AC: #6)
  - [ ] Export `extractTargetFilesFromStoryContent(storyContent: string): string[]`:
    - Use regex to extract file path tokens matching `(?:packages\/|src\/)[\w/.~-]+\.(?:ts|js|json|md)` from the full story content
    - Deduplicate and return up to 30 paths
    - Return `[]` if none found

- [ ] Task 4: Swap callsite in `src/modules/compiled-workflows/dev-story.ts` (AC: #6)
  - [ ] Remove `import { getProjectFindings } from '../implementation-orchestrator/project-findings.js'`
  - [ ] Add `import { FindingsInjector, extractTargetFilesFromStoryContent } from '@substrate-ai/sdlc'`
  - [ ] In the try/catch block that currently calls `getProjectFindings(deps.db)`:
    - Replace: `const findings = await getProjectFindings(deps.db)`
    - With: `const findings = await FindingsInjector.inject(deps.db, { storyKey, runId: params.pipelineRunId ?? '', targetFiles: extractTargetFilesFromStoryContent(storyContent) })`
  - [ ] Update the log message from `'Injecting prior findings into dev-story prompt'` to `'Injecting relevance-scored findings into dev-story prompt'`
  - [ ] Preserve the outer `try/catch` and all other surrounding logic unchanged

- [ ] Task 5: Update barrel exports in `packages/sdlc/src/learning/index.ts` (AC: #1, #2)
  - [ ] Add to the barrel: `export * from './relevance-scorer.js'` and `export * from './findings-injector.js'`
  - [ ] If `packages/sdlc/src/learning/index.ts` does not yet exist (story 53-5 not yet shipped), create it with all four story-53-5 exports plus the two new ones; and add `export * from './learning/index.js'` to `packages/sdlc/src/index.ts`
  - [ ] If it already exists (story 53-5 was shipped), append the two new exports only

- [ ] Task 6: Write unit tests for `RelevanceScorer` (AC: #7)
  - [ ] Create `packages/sdlc/src/learning/__tests__/relevance-scorer.test.ts` using Vitest:
    - `scoreRelevance` with empty `targetFiles` → `jaccardFileOverlap = 0`, full score = `0.3 * packageMatch + 0.2 * rootCauseMatch`
    - `scoreRelevance` with empty `affected_files` → same result
    - Perfect overlap (same 3 files) → `jaccardFileOverlap = 1.0`
    - Partial overlap (2 of 4 files match) → `jaccardFileOverlap = 0.5`
    - 25-target-file input → only 20 shortest-path files used for Jaccard
    - `packageMatch` = 1.0 when `packageName: 'sdlc'` and affected_files contains `packages/sdlc/src/foo.ts`
    - `packageMatch` = 0.5 when `packageName` is undefined
    - `packageMatch` = 0.0 when `packageName: 'sdlc'` but affected_files only has `packages/core/src/bar.ts`
    - `rootCauseMatch` = 1.0 when `riskProfile: ['build-failure']` and `root_cause: 'build-failure'`
    - `rootCauseMatch` = 0.5 when `riskProfile` is undefined
    - `rootCauseMatch` = 0.0 when `riskProfile: ['namespace-collision']` and `root_cause: 'build-failure'`
    - Full formula verification: known inputs → expected score

- [ ] Task 7: Write unit tests for `FindingsInjector` (AC: #2, #3, #4, #5, #7)
  - [ ] Create `packages/sdlc/src/learning/__tests__/findings-injector.test.ts` using Vitest; mock DB as `{ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }`:
    - Empty decisions table → `inject()` returns `''`
    - Malformed JSON row (not parseable) → skipped, remaining findings processed
    - Finding with score `< 0.3` → excluded, result is `''`
    - Finding with score `≥ 0.3` → included with correct framing
    - `confidence: 'high'` → `"[build-failure] Directive: Build failed after story dispatch"`
    - `confidence: 'low'` → `"[unclassified] Note (low confidence): some error text"`
    - 12 findings at threshold 0.3 → saturation guard raises threshold, ≤10 remain
    - `maxChars: 100` → only first finding(s) fitting within budget are included
    - Config override `{ threshold: 0.8, maxChars: 500 }` → applied
    - DB `query` rejects with error → `inject()` returns `''`
    - `extractTargetFilesFromStoryContent` with a real story snippet containing `packages/sdlc/src/learning/types.ts` → returns that path

## Dev Notes

### Architecture Constraints
- All new files live in `packages/sdlc/src/learning/` — this directory is created by story 53-5; story 53-6 adds two new files to it
- Import style: `.js` extension on all local ESM imports (e.g., `import { ... } from './types.js'`)
- `FindingsInjector.inject` is a **static async method** — callers do not instantiate the class; this mirrors the functional style used across the learning module
- `scoreRelevance` is a **pure synchronous function** — no I/O, no async, no LLM calls (deterministic scoring)
- Error handling in `inject`: any exception from `getDecisionsByCategory`, `JSON.parse`, or `FindingSchema.safeParse` must not propagate — return `''` on query errors; skip individual malformed rows
- `extractTargetFilesFromStoryContent` is exported from `findings-injector.ts` (not a separate file) to keep the module surface minimal
- The `getProjectFindings` function in `src/modules/implementation-orchestrator/project-findings.ts` is **not deleted** — only its callsite in `dev-story.ts` is replaced. The function may still be used by other callers or future cleanup stories.

### Key File Paths
- **New:** `packages/sdlc/src/learning/relevance-scorer.ts` — `InjectionContext`, `scoreRelevance`
- **New:** `packages/sdlc/src/learning/findings-injector.ts` — `FindingsInjector`, `FindingsInjectorConfig`, `extractTargetFilesFromStoryContent`
- **New:** `packages/sdlc/src/learning/__tests__/relevance-scorer.test.ts`
- **New:** `packages/sdlc/src/learning/__tests__/findings-injector.test.ts`
- **Modify:** `packages/sdlc/src/learning/index.ts` — add `export * from './relevance-scorer.js'` and `export * from './findings-injector.js'`
- **Modify:** `src/modules/compiled-workflows/dev-story.ts` — replace `getProjectFindings` import and callsite

### Import Verification for @substrate-ai/sdlc in dev-story.ts
Before writing the callsite swap, verify the export chain:
- `packages/sdlc/src/learning/index.ts` re-exports `FindingsInjector` and `extractTargetFilesFromStoryContent` from `findings-injector.js`
- `packages/sdlc/src/index.ts` re-exports `./learning/index.js`
- `packages/sdlc/package.json` `exports` field maps to `dist/index.js`
- The workspace dependency `@substrate-ai/sdlc` is already listed in `src/package.json` dependencies (or root `tsconfig.json` paths) — check before adding

### Relevance Scorer Design Notes (Canonical)
```typescript
// Jaccard file overlap
const cappedTargets = (context.targetFiles ?? [])
  .sort((a, b) => a.length - b.length)
  .slice(0, 20)
const targetSet = new Set(cappedTargets)
const intersectionCount = finding.affected_files.filter(f => targetSet.has(f)).length
const jaccardFileOverlap =
  cappedTargets.length === 0 || finding.affected_files.length === 0
    ? 0
    : intersectionCount / Math.min(finding.affected_files.length, cappedTargets.length)

// Package match
const pkgRegex = /packages\/([^/]+)\//
const inferredPackages = finding.affected_files
  .map(f => pkgRegex.exec(f)?.[1])
  .filter((p): p is string => p !== undefined)
const packageMatch =
  context.packageName === undefined || inferredPackages.length === 0
    ? 0.5
    : inferredPackages.includes(context.packageName) ? 1.0 : 0.0

// Root cause match
const rootCauseMatch =
  !context.riskProfile || context.riskProfile.length === 0
    ? 0.5
    : context.riskProfile.includes(finding.root_cause) ? 1.0 : 0.0

return Math.min(1, Math.max(0, 0.5 * jaccardFileOverlap + 0.3 * packageMatch + 0.2 * rootCauseMatch))
```

### Saturation Guard Design Notes (Canonical)
```typescript
// Saturation guard
let dynamicThreshold = threshold
let filtered = scored.filter(({ score }) => score >= dynamicThreshold)
while (filtered.length > saturationLimit && dynamicThreshold <= 1.0) {
  dynamicThreshold = Math.round((dynamicThreshold + 0.1) * 10) / 10
  filtered = scored.filter(({ score }) => score >= dynamicThreshold)
}
if (filtered.length > saturationLimit) {
  filtered = filtered.sort((a, b) => b.score - a.score).slice(0, saturationLimit)
}
```

### Callsite Swap Pattern (Canonical)
In `src/modules/compiled-workflows/dev-story.ts`, the existing block is:
```typescript
// Query prior findings for learning loop injection (Story 22-1, AC2)
let priorFindingsContent = ''
try {
  const findings = await getProjectFindings(deps.db)
  if (findings.length > 0) {
    priorFindingsContent = 'Previous pipeline runs encountered these issues — avoid repeating them:\n\n' + findings
    logger.debug({ storyKey, findingsLen: findings.length }, 'Injecting prior findings into dev-story prompt')
  }
} catch {
  // AC5: graceful fallback — empty string on error
}
```

Replace with:
```typescript
// Query relevance-scored findings for learning loop injection (Story 53-6)
let priorFindingsContent = ''
try {
  const findings = await FindingsInjector.inject(deps.db, {
    storyKey,
    runId: params.pipelineRunId ?? '',
    targetFiles: extractTargetFilesFromStoryContent(storyContent),
  })
  if (findings.length > 0) {
    priorFindingsContent = findings
    logger.debug({ storyKey, findingsLen: findings.length }, 'Injecting relevance-scored findings into dev-story prompt')
  }
} catch {
  // Graceful fallback — empty string on error
}
```

Note: the outer `priorFindingsContent` prefix string (`'Previous pipeline runs encountered these issues...'`) is removed because `FindingsInjector.inject` already includes its own header.

### Testing Requirements
- Framework: Vitest — `import { describe, it, expect, vi } from 'vitest'`
- `scoreRelevance` tests are pure unit tests: no mocks needed, deterministic math
- `FindingsInjector` tests mock `DatabaseAdapter` via `{ query: vi.fn() }` — mock `getDecisionsByCategory` module using `vi.mock('@substrate-ai/core', ...)` or by mocking the DB query result directly
- Alternative mock approach: stub `getDecisionsByCategory` by passing a mock DB whose `query` returns structured rows — match how existing tests in `packages/sdlc/src/` mock the DB adapter
- All new test files go in `packages/sdlc/src/learning/__tests__/`

## Interface Contracts

- **Import**: `Finding`, `FindingSchema`, `RootCauseCategory` @ `packages/sdlc/src/learning/types.ts` (from story 53-5)
- **Import**: `LEARNING_FINDING` @ `packages/core/src/persistence/schemas/operational.ts` (from story 53-5)
- **Import**: `getDecisionsByCategory`, `DatabaseAdapter` @ `@substrate-ai/core` (existing)
- **Export**: `InjectionContext` @ `packages/sdlc/src/learning/relevance-scorer.ts` (consumed by stories 53-7, 53-8, 53-9 and Epic 54 RecoveryEngine)
- **Export**: `scoreRelevance` @ `packages/sdlc/src/learning/relevance-scorer.ts` (may be reused by story 53-7 for pre-injection validation)
- **Export**: `FindingsInjector`, `FindingsInjectorConfig`, `extractTargetFilesFromStoryContent` @ `packages/sdlc/src/learning/findings-injector.ts` (consumed by `src/modules/compiled-workflows/dev-story.ts`)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-04-06: Story created (Epic 53, Phase D Autonomous Operations)
