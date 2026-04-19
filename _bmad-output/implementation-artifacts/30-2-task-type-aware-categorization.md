# Story 30-2: Task-Type-Aware Categorization

## Story

As a pipeline operator,
I want category stats to reflect the actual task type of each dispatch (dev-story, code-review, create-story, etc.),
so that telemetry breakdowns show meaningful per-category distributions instead of a flat 100% `conversation_history`.

## Acceptance Criteria

### AC1: classify() accepts taskType parameter
**Given** the `Categorizer.classify()` method
**When** called with an optional `taskType` string parameter
**Then** the signature is `classify(operationName: string, toolName?: string, taskType?: string): SemanticCategory` and the existing method contract is preserved

### AC2: taskType acts as Tier 0 — highest priority classification
**Given** a `TurnAnalysis` with `taskType` set to a known task type
**When** `classify()` is called with that `taskType`
**Then** it returns the mapped category without consulting lower tiers:
- `create-story` → `system_prompts`
- `dev-story` → `tool_outputs`
- `code-review` → `conversation_history`
- `test-plan` → `system_prompts`
- `minor-fixes` → `tool_outputs`

### AC3: Unknown or absent taskType falls through to existing tiers
**Given** a `TurnAnalysis` with no `taskType`, or a `taskType` not in the mapping
**When** `classify()` is called
**Then** classification proceeds through Tiers 1–5 (exact match, prefix/regex, fuzzy, toolName fallback, log_turn) unchanged

### AC4: computeCategoryStatsFromTurns() passes taskType to classify()
**Given** `computeCategoryStatsFromTurns()` iterating over a `TurnAnalysis[]`
**When** each turn is classified
**Then** `turn.taskType` is passed as the third argument to `classify()` so Tier 0 is exercised in the production log-only path

### AC5: Multi-dispatch story produces 3+ non-zero category entries
**Given** a synthetic `TurnAnalysis[]` representing a story with three dispatch phases (create-story, dev-story, code-review turns intermixed)
**When** `computeCategoryStatsFromTurns()` is called
**Then** the returned `CategoryStats[]` has non-zero entries for at least three distinct categories (`system_prompts`, `tool_outputs`, `conversation_history`)

### AC6: Existing categorizer behavior is unaffected when taskType absent
**Given** existing unit tests for `classify()` that do not pass a `taskType`
**When** those tests run against the updated implementation
**Then** all existing tests pass without modification

### AC7: Full test suite remains green
**Given** all changes to `categorizer.ts`
**When** `npm run test:fast` is executed
**Then** all test files pass with no regressions

## Tasks / Subtasks

- [ ] Task 1: Update `classify()` signature and add Tier 0 taskType lookup (AC: #1, #2, #3)
  - [ ] Open `src/modules/telemetry/categorizer.ts`, add `taskType?: string` third parameter to `classify()`
  - [ ] Define a `TASK_TYPE_CATEGORY_MAP` constant (a `Map<string, SemanticCategory>`) above the class with the 5 mappings: `create-story→system_prompts`, `dev-story→tool_outputs`, `code-review→conversation_history`, `test-plan→system_prompts`, `minor-fixes→tool_outputs`
  - [ ] Insert Tier 0 block at the top of `classify()`: if `taskType` is defined and non-empty, look it up in `TASK_TYPE_CATEGORY_MAP`; if found, return the mapped category; otherwise fall through
  - [ ] Verify all existing Tier 1–5 logic is untouched

- [ ] Task 2: Thread taskType through computeCategoryStatsFromTurns() (AC: #4)
  - [ ] Locate the `this.classify(turn.name, turn.toolName)` call inside `computeCategoryStatsFromTurns()`
  - [ ] Change it to `this.classify(turn.name, turn.toolName, turn.taskType)`
  - [ ] Confirm no other callers of `classify()` exist that need updating (grep for `\.classify(`)

- [ ] Task 3: Write unit tests for Tier 0 classification (AC: #2, #3, #5, #6)
  - [ ] Open `src/modules/telemetry/__tests__/categorizer.test.ts`
  - [ ] Add a `describe('Tier 0 — taskType classification')` block with one `it` per known task type (5 tests) asserting correct category returned
  - [ ] Add a test for an unknown taskType (e.g., `'unknown-task'`) asserting fallback to Tier 1 behavior
  - [ ] Add a test for absent taskType (`undefined`) asserting fallback to Tier 1 behavior
  - [ ] Add a test for `computeCategoryStatsFromTurns()` with a mixed-taskType turn array: generate 5 turns for `dev-story`, 4 turns for `code-review`, 3 turns for `create-story`, each with `inputTokens: 100`, call method, assert `system_prompts`, `tool_outputs`, and `conversation_history` all have non-zero `totalTokens`

- [ ] Task 4: Run tests and verify no regressions (AC: #7)
  - [ ] Run `npm run test:fast` and confirm all test files pass
  - [ ] If coverage thresholds fail, add any missing branch coverage tests for the new Tier 0 path

## Dev Notes

### Architecture Constraints
- **File to modify (primary):** `src/modules/telemetry/categorizer.ts`
- **File to modify (tests):** `src/modules/telemetry/__tests__/categorizer.test.ts`
- **No schema changes:** `task_type`, `phase`, and `dispatch_id` columns in `turn_analysis` were added in story 30-1 — do not re-add them
- **No changes to:** `ingestion-server.ts`, `types.ts`, `normalizer.ts`, `log-turn-analyzer.ts`, `telemetry-pipeline.ts` — all dispatch context wiring was done in 30-1
- **SemanticCategory type** is defined in `src/modules/telemetry/types.ts` — import from there, do not redefine

### Key Code Location: classify() in categorizer.ts
The current signature is:
```typescript
classify(operationName: string, toolName?: string): SemanticCategory
```
The updated signature must be:
```typescript
classify(operationName: string, toolName?: string, taskType?: string): SemanticCategory
```
This is backward-compatible — all existing callers that omit `taskType` continue to work.

### Key Code Location: computeCategoryStatsFromTurns() call site
In `categorizer.ts`, find the line:
```typescript
this.classify(turn.name, turn.toolName)
```
Change to:
```typescript
this.classify(turn.name, turn.toolName, turn.taskType)
```
This is the **only caller of classify() in the production log-only path**.

### TASK_TYPE_CATEGORY_MAP constant
Define as a module-level constant above the class to keep it testable and outside instance state:
```typescript
const TASK_TYPE_CATEGORY_MAP = new Map<string, SemanticCategory>([
  ['create-story', 'system_prompts'],
  ['dev-story',    'tool_outputs'],
  ['code-review',  'conversation_history'],
  ['test-plan',    'system_prompts'],
  ['minor-fixes',  'tool_outputs'],
])
```

### Why these category mappings?
- `create-story`: workflow template + story spec generation → system prompt token spend
- `dev-story`: code generation + heavy tool use (read/write/bash) → tool output token spend
- `code-review`: reads existing code, produces verdict → conversation/context token spend
- `test-plan`: story + test spec generation → system prompt token spend
- `minor-fixes`: targeted edits, similar to dev-story → tool output token spend

### TurnAnalysis interface (from src/modules/telemetry/types.ts)
The `taskType` field was added in story 30-1:
```typescript
taskType?: string   // 'dev-story', 'code-review', 'create-story', etc. (from dispatch context)
```

### Testing Requirements
- **Framework:** Vitest (not Jest) — do not use `--testPathPattern` flag
- **Run targeted:** `npm run test:changed` during iteration
- **Run full fast suite:** `npm run test:fast` for final verification
- **Coverage:** 80% threshold is enforced — the new Tier 0 branch and the `computeCategoryStatsFromTurns()` call site change must be covered by tests
- **Test helper pattern:** Use existing `buildTurnAnalysis()` or similar builder helpers if present in the test file; otherwise construct `TurnAnalysis` objects inline with required fields

### Scope Boundaries
- **In scope:** Tier 0 classification logic, taskType threading, unit tests
- **Out of scope:** CLI output changes, new database columns, new telemetry pipeline stages, Recommender changes — those are in later 30-x stories
- This story is intentionally small: one file modified, one test file updated, ~40 lines of production code change

## Interface Contracts

- **Import**: `TurnAnalysis` @ `src/modules/telemetry/types.ts` (from story 30-1 — `taskType` field required)
- **Import**: `SemanticCategory` @ `src/modules/telemetry/types.ts`

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
