# Story 33-2: Level 0 — Structural Output Validation

## Story

As a pipeline orchestrator,
I want a structural validation level that checks agent outputs against their Zod schemas and verifies required files exist on disk,
so that malformed or incomplete agent outputs are caught cheaply (< 100ms) before expensive build or test validations run.

## Acceptance Criteria

### AC1: Schema Validation by Task Type
**Given** a `StructuralValidator` implementing `ValidationLevel` (from Story 33-1)
**When** `run(context)` is called with a result from a dev-story, code-review, or create-story dispatch
**Then** the validator selects the correct Zod schema (`DevStoryResultSchema`, `CodeReviewResultSchema`, or `CreateStoryResultSchema`) based on the result's discriminating fields and returns a `LevelResult` with `passed: true` when the schema parses successfully, or `passed: false` with detailed parse errors mapped to `LevelFailure[]`

### AC2: Files Modified Exist on Disk
**Given** a dev-story result with a non-empty `files_modified` array
**When** `run(context)` is called
**Then** each path in `files_modified` is checked for existence using `existsSync`; any missing paths produce individual `LevelFailure` entries with `category: 'schema'`, the missing absolute path as `location`, and `'existsSync returned false'` as `evidence`; an empty `files_modified` array skips the check entirely

### AC3: Story File Existence Check
**Given** a create-story result with a non-empty `story_file` field
**When** `run(context)` is called
**Then** the validator checks that the file at `result.story_file` exists on disk; a missing story file produces a `LevelFailure` with `category: 'schema'`, the expected path as `location`, and `'Story file not found on disk'` as `evidence`; for task types other than create-story this check is skipped

### AC4: Remediation Context with Parse Error Details
**Given** a Zod schema validation failure
**When** `run(context)` returns a failed `LevelResult`
**Then** `failures` contains entries with `category: 'schema'`, a human-readable `description` of each failed field, the field dotted-path as `location` (e.g., `'result.ac_met[0]'` from `ZodError.errors[i].path.join('.')`), and the Zod error `message` as `evidence`; `canAutoRemediate` is `true` for all structural failures

### AC5: Unknown Task Type Handled Gracefully
**Given** an agent result that does not match any known Zod schema
**When** the validator cannot determine the task type from the result shape
**Then** it returns a failed `LevelResult` with a single failure: `category: 'schema'`, `description: 'Unable to determine task type from result shape'`, `evidence` containing the result's top-level keys, and `canAutoRemediate: false`

### AC6: Execution Time Under 100ms
**Given** any valid or invalid input
**When** `run(context)` completes
**Then** total wall-clock execution time is under 100ms — the validator uses only synchronous in-process operations (Zod parse + `existsSync`); no process spawning, no network calls, no async I/O

### AC7: Unit Tests Cover All Cases
**Given** `src/modules/validation/levels/__tests__/structural.test.ts`
**When** run via `npm run test:fast`
**Then** at least 12 `it(...)` cases pass covering: valid `DevStoryResult` passes, valid `CodeReviewResult` passes, valid `CreateStoryResult` passes, malformed dev-story output (missing required field) fails with schema errors, `LevelFailure` includes `location` and `evidence` from ZodError, missing file in `files_modified` produces failure with path as `location`, empty `files_modified` skips file checks, missing `story_file` in create-story result produces failure, unknown result shape produces non-auto-remediable failure, `canAutoRemediate: true` for schema/file failures, `canAutoRemediate: false` for unknown-type failures, execution time under 150ms (CI-buffered)

## Tasks / Subtasks

- [ ] Task 1: Read `src/modules/validation/types.ts` (from Story 33-1) before writing any code (AC: #1, #4)
  - [ ] Confirm the exact shape of `ValidationLevel`, `LevelResult`, `LevelFailure`, and `ValidationContext`
  - [ ] Note that `ValidationContext` has `story: StoryRecord`, `result: unknown`, `attempt: number`, `projectRoot: string` — the structural validator infers task type from `result` shape rather than requiring an explicit `taskType` field in context
  - [ ] If `ValidationContext` is missing needed fields (e.g., no `result` field), document the gap and work with what 33-1 provides; adapt the validator accordingly rather than modifying 33-1's types.ts

- [ ] Task 2: Create `src/modules/validation/levels/structural.ts` — StructuralValidator class (AC: #1, #4, #5, #6)
  - [ ] Create the `src/modules/validation/levels/` directory (it does not exist yet)
  - [ ] Export `StructuralValidator` class implementing `ValidationLevel` from `../types.js`
  - [ ] Set `level = 0` and `name = 'structural'` as class properties
  - [ ] Import schemas: `DevStoryResultSchema`, `CodeReviewResultSchema`, `CreateStoryResultSchema` from `../../compiled-workflows/schemas.js`
  - [ ] Implement `_detectTaskType(result: unknown): 'dev-story' | 'code-review' | 'create-story' | 'unknown'` private method:
    - Check for `verdict` field → `'code-review'`
    - Check for `ac_met` or `files_modified` field → `'dev-story'`
    - Check for `story_file` or `story_key` or `story_title` field → `'create-story'`
    - Otherwise → `'unknown'`
  - [ ] Implement `run(context: ValidationContext): Promise<LevelResult>`:
    - Record `Date.now()` at start
    - Call `_detectTaskType(context.result)` to select schema
    - If `'unknown'`, return failed `LevelResult` with `canAutoRemediate: false`
    - Parse result against selected schema via `.safeParse(context.result)`
    - On failure: map `zodError.errors` to `LevelFailure[]` with `category: 'schema'`, `description: error.message`, `location: error.path.join('.')`, `evidence: error.message`
    - On success: run file existence checks (AC2) and story file check (AC3)
    - Return `LevelResult` with `passed`, `failures`, `canAutoRemediate: true` (or false for unknown type), and elapsed `durationMs`
  - [ ] Use `import { existsSync } from 'node:fs'` — synchronous, no async

- [ ] Task 3: Implement file existence checks and story file check (AC: #2, #3)
  - [ ] File existence check (dev-story only): after successful schema parse, check `parsed.files_modified` array — for each path call `existsSync(path)`; missing files push `{ category: 'schema', description: 'File listed in files_modified does not exist on disk', location: path, evidence: 'existsSync returned false' }`
  - [ ] Story file check (create-story only): if `parsed.story_file` is a non-empty string, call `existsSync(parsed.story_file)`; if missing push `{ category: 'schema', description: 'Story file not found on disk after create-story dispatch', location: parsed.story_file, evidence: 'Story file not found on disk' }`
  - [ ] Both checks append to the same `failures` array; `passed` is false if any failures exist

- [ ] Task 4: Export `StructuralValidator` from the validation module barrel (AC: #1)
  - [ ] Open `src/modules/validation/index.ts` (created by Story 33-1)
  - [ ] Add: `export { StructuralValidator } from './levels/structural.js'`
  - [ ] Verify no circular dependencies are introduced

- [ ] Task 5: Write unit tests in `src/modules/validation/levels/__tests__/structural.test.ts` (AC: #7)
  - [ ] Create `src/modules/validation/levels/__tests__/` directory
  - [ ] Import `StructuralValidator` from `../structural.js`
  - [ ] Import `ValidationContext` from `../../types.js`
  - [ ] Use `vi.mock('node:fs', () => ({ existsSync: vi.fn().mockReturnValue(true) }))` at top of file; reset in `beforeEach`
  - [ ] Build a minimal valid `ValidationContext` factory helper: `makeCtx(result: unknown): ValidationContext` that wraps result in a stub context (stub `story` as `{ story_key: 'test-33-2', story_file_path: '/tmp/story.md' }`, `attempt: 1`, `projectRoot: '/tmp'`)
  - [ ] Test cases (minimum 12):
    1. Valid DevStoryResult passes → `result.passed === true`, `result.failures.length === 0`
    2. Valid CodeReviewResult passes → `result.passed === true`
    3. Valid CreateStoryResult passes → `result.passed === true` (existsSync mocked to true)
    4. Malformed dev-story result (missing `result` field) → `result.passed === false`, failures contain ZodError
    5. LevelFailure has `location` (dotted path from ZodError) and `evidence` (error message)
    6. Missing file in `files_modified` → failure with path as `location`, `existsSync` called with that path
    7. Empty `files_modified` array → no file-check failures even when existsSync returns false
    8. Create-story result with `story_file` that does not exist → failure with `location = story_file` value
    9. Create-story result without `story_file` field → no story-file failure (field not required)
    10. Unknown result shape (`{ foo: 'bar' }`) → `passed: false`, `canAutoRemediate: false`
    11. Schema failure → `canAutoRemediate: true`; unknown-type failure → `canAutoRemediate: false`
    12. Execution time < 150ms: capture `Date.now()` before and after `run()`; assert elapsed < 150
  - [ ] Use `vi.mocked(existsSync).mockReturnValueOnce(false)` for missing-file tests

- [ ] Task 6: Build and run tests to confirm zero errors (AC: #6, #7)
  - [ ] Run `npm run build` — confirm zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000`; NEVER pipe output; confirm "Test Files" summary line in raw output

## Dev Notes

### Architecture Constraints
- **Module location**: `src/modules/validation/levels/structural.ts` — the `levels/` subdirectory does not exist yet; create it
- **Hard dependency on Story 33-1**: `ValidationLevel`, `LevelResult`, `LevelFailure`, `ValidationContext` must be imported from `../types.js` (Story 33-1's output). If 33-1 is not yet implemented, this story cannot proceed.
- **Import style**: `.js` extensions on all local imports (ESM project): `import type { ValidationLevel } from '../types.js'`
- **No external package imports** from `@substrate-ai/core`, `@substrate-ai/sdlc`, or `@substrate-ai/factory` — this lives in root `src/`
- **Schema imports**: `DevStoryResultSchema`, `CodeReviewResultSchema`, `CreateStoryResultSchema` from `../../compiled-workflows/schemas.js` — these already exist; do NOT redefine them
- **Synchronous file I/O**: `import { existsSync } from 'node:fs'` — intentional; synchronous is required to keep execution < 100ms
- **No logger required in the level itself**: timing and logging are handled by the `CascadeRunner` (Story 33-1 AC7); the `StructuralValidator` only returns `LevelResult`
- **Test framework**: `vitest` with `describe`, `it`, `expect`, `vi`, `beforeEach` — no Jest globals

### Dependency on Story 33-1
The dev agent MUST read `src/modules/validation/types.ts` as the first action before writing any code. Key types needed:
- `ValidationLevel` interface (`level: number`, `name: string`, `run(context): Promise<LevelResult>`)
- `LevelResult` (`passed: boolean`, `failures: LevelFailure[]`, `canAutoRemediate: boolean`)
- `LevelFailure` (`category`, `description`, `location?`, `evidence`, `suggestedAction?`)
- `ValidationContext` (`story: StoryRecord`, `result: unknown`, `attempt: number`, `projectRoot: string`)

### Task Type Detection Logic

```typescript
// src/modules/validation/levels/structural.ts
import type { ValidationLevel, LevelResult, LevelFailure, ValidationContext } from '../types.js'
import {
  DevStoryResultSchema,
  CodeReviewResultSchema,
  CreateStoryResultSchema,
} from '../../compiled-workflows/schemas.js'
import { existsSync } from 'node:fs'

type TaskType = 'dev-story' | 'code-review' | 'create-story' | 'unknown'

export class StructuralValidator implements ValidationLevel {
  readonly level = 0
  readonly name = 'structural'

  private _detectTaskType(result: unknown): TaskType {
    if (result === null || typeof result !== 'object') return 'unknown'
    const r = result as Record<string, unknown>
    if ('verdict' in r) return 'code-review'
    if ('ac_met' in r || 'files_modified' in r || 'ac_failures' in r) return 'dev-story'
    if ('story_file' in r || 'story_key' in r || 'story_title' in r) return 'create-story'
    return 'unknown'
  }

  async run(context: ValidationContext): Promise<LevelResult> {
    const failures: LevelFailure[] = []
    const taskType = this._detectTaskType(context.result)

    if (taskType === 'unknown') {
      const keys = context.result !== null && typeof context.result === 'object'
        ? Object.keys(context.result as object).join(', ')
        : String(context.result)
      return {
        passed: false,
        failures: [{
          category: 'schema',
          description: 'Unable to determine task type from result shape',
          evidence: `Top-level keys: ${keys || '(none)'}`,
        }],
        canAutoRemediate: false,
      }
    }

    const schemaMap = {
      'dev-story': DevStoryResultSchema,
      'code-review': CodeReviewResultSchema,
      'create-story': CreateStoryResultSchema,
    }
    const schema = schemaMap[taskType]
    const parseResult = schema.safeParse(context.result)

    if (!parseResult.success) {
      for (const err of parseResult.error.errors) {
        failures.push({
          category: 'schema',
          description: `Schema validation failed at '${err.path.join('.') || '(root)'}': ${err.message}`,
          location: err.path.join('.') || '(root)',
          evidence: err.message,
        })
      }
      return { passed: false, failures, canAutoRemediate: true }
    }

    const parsed = parseResult.data

    // AC2: files_modified existence check (dev-story only)
    if (taskType === 'dev-story') {
      const filesModified: string[] = (parsed as { files_modified?: string[] }).files_modified ?? []
      for (const filePath of filesModified) {
        if (!existsSync(filePath)) {
          failures.push({
            category: 'schema',
            description: 'File listed in files_modified does not exist on disk',
            location: filePath,
            evidence: 'existsSync returned false',
          })
        }
      }
    }

    // AC3: story_file existence check (create-story only)
    if (taskType === 'create-story') {
      const storyFile: string | undefined = (parsed as { story_file?: string }).story_file
      if (storyFile && !existsSync(storyFile)) {
        failures.push({
          category: 'schema',
          description: 'Story file not found on disk after create-story dispatch',
          location: storyFile,
          evidence: 'Story file not found on disk',
        })
      }
    }

    return {
      passed: failures.length === 0,
      failures,
      canAutoRemediate: true,
    }
  }
}
```

### New File Paths
```
src/modules/validation/levels/structural.ts                        — StructuralValidator
src/modules/validation/levels/__tests__/structural.test.ts         — unit tests (≥12 cases)
```

### Modified File Paths
```
src/modules/validation/index.ts                                    — add StructuralValidator re-export
```

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect`, `vi`, `beforeEach`
- Mock `existsSync` via `vi.mock('node:fs', () => ({ existsSync: vi.fn() }))` — reset in `beforeEach` with `vi.mocked(existsSync).mockReturnValue(true)` as default (all files exist), override per test with `mockReturnValueOnce(false)`
- Import path: `import { existsSync } from 'node:fs'` in both source and test
- Never use Jest globals; always import from `vitest`
- Run tests: `npm run test:fast` — use `timeout: 300000`; NEVER pipe output; confirm "Test Files" line in raw output
- Run `npm run build` before tests to catch TypeScript errors early

## Interface Contracts

- **Import**: `ValidationLevel`, `LevelResult`, `LevelFailure`, `ValidationContext` @ `src/modules/validation/types.ts` (from Story 33-1)
- **Import**: `DevStoryResultSchema`, `CodeReviewResultSchema`, `CreateStoryResultSchema` @ `src/modules/compiled-workflows/schemas.ts` (existing)
- **Export**: `StructuralValidator` @ `src/modules/validation/levels/structural.ts` (consumed by Story 33-1's `CascadeRunner` via `registerLevel()`, and by Story 33-4's orchestrator integration)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
