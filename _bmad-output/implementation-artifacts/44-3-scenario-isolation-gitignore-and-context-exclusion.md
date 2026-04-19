# Story 44-3: Scenario Isolation — Gitignore and Context Exclusion

## Story

As a factory pipeline author,
I want scenario files in `.substrate/scenarios/` to be completely invisible to agent dispatches,
so that agents cannot read or be biased by the expected test outcomes of scenarios they are about to be evaluated against.

## Acceptance Criteria

### AC1: `substrate init` writes `.substrate/scenarios/` to `.gitignore`
**Given** a project directory with no existing `.gitignore`, or with an existing `.gitignore` that does not already contain `.substrate/scenarios/`
**When** `substrate init` completes
**Then** the project's `.gitignore` contains an entry for `.substrate/scenarios/`

### AC2: `substrate init` gitignore write is idempotent
**Given** a project whose `.gitignore` already contains `.substrate/scenarios/`
**When** `substrate init` is run again
**Then** `.substrate/scenarios/` does not appear a second time in `.gitignore` — the entry is not duplicated

### AC3: ContextCompilerImpl accepts an `excludedPaths` configuration option
**Given** `createContextCompiler` is called with `excludedPaths: ['.substrate/scenarios/']`
**When** the returned compiler's `getExcludedPaths()` method is called
**Then** it returns an array containing `.substrate/scenarios/`

### AC4: ContextCompiler filters excluded path content from compiled output
**Given** a `ContextCompilerImpl` with `.substrate/scenarios/` in its `excludedPaths` option, and a registered template whose `format` function returns text containing a `.substrate/scenarios/scenario-secret.sh` reference
**When** `compile()` is called with a valid `TaskDescriptor`
**Then** the `CompileResult.prompt` does not contain `.substrate/scenarios/` and a warning is emitted to the logger

### AC5: RepoMapInjector explicitly guards against `.substrate/` path references
**Given** story file content that contains a path reference to `.substrate/scenarios/scenario-login.sh`
**When** `RepoMapInjector.buildContext()` extracts file references
**Then** `.substrate/` paths are not included in the files queried against the repo-map engine — the injector's filter rejects non-`src/` paths by documented, intentional design

### AC6: Security test — `SCENARIO_SECRET_TOKEN` does not appear in compiled context
**Given** a `ContextCompilerImpl` with `.substrate/scenarios/` in `excludedPaths`, and a template section whose `format` function injects `SCENARIO_SECRET_TOKEN` (simulating a bug where scenario content reached the database)
**When** `compile()` executes
**Then** the `CompileResult.prompt` does not contain `SCENARIO_SECRET_TOKEN`, confirming the exclusion filter catches the leak

## Tasks / Subtasks

- [ ] Task 1: Extend `substrate init` gitignore logic to include scenarios dir (AC: #1, #2)
  - [ ] Locate the `runtimeEntries` array in `src/cli/commands/init.ts` (around line 998)
  - [ ] Add `'.substrate/scenarios/'` to the `runtimeEntries` array alongside `.substrate/orchestrator.pid` and `.substrate/current-run-id`
  - [ ] Confirm the existing idempotency check (`existing.includes(e)`) already covers the new entry — no additional logic needed
  - [ ] Update the surrounding comment from `# Substrate runtime files` to `# Substrate runtime and factory files` (or keep as-is if comment scope is broad enough)

- [ ] Task 2: Add `excludedPaths` option and `getExcludedPaths()` to `ContextCompilerImpl` (AC: #3)
  - [ ] Add `excludedPaths?: string[]` to the `ContextCompilerOptions` interface in `src/modules/context-compiler/context-compiler-impl.ts`
  - [ ] Store `excludedPaths` as `private readonly _excludedPaths: readonly string[]` initialized from the constructor option (default: `[]`)
  - [ ] Add `getExcludedPaths(): readonly string[]` method to `ContextCompilerImpl` that returns `this._excludedPaths`
  - [ ] Add `getExcludedPaths(): readonly string[]` to the `ContextCompiler` interface in `src/modules/context-compiler/context-compiler.ts`

- [ ] Task 3: Implement exclusion filter in `compile()` (AC: #4, #6)
  - [ ] After assembling each section's `text` in `compile()`, call a new `_applyExclusionFilter(text: string): string` private method
  - [ ] In `_applyExclusionFilter`: for each path in `this._excludedPaths`, check whether `text` contains that path string
  - [ ] If a match is found, emit a `logger.warn` with the excluded path and section name, then return an empty string for that section (full section exclusion is safer than partial redaction)
  - [ ] Update section report `included: false` and `truncated: true` when a section is excluded by this filter
  - [ ] Ensure the filter runs before token counting so budgets are correctly updated

- [ ] Task 4: Add explicit `.substrate/` guard to `RepoMapInjector.buildContext()` (AC: #5)
  - [ ] In `src/modules/context-compiler/repo-map-injector.ts`, after the existing `dedupedPaths` filter that removes `.test.ts` / `.test.tsx` files, add a second filter: remove any path that does not start with `src/`
  - [ ] Add a comment: `// Only include src/ paths — excludes .substrate/, node_modules/, dist/, etc. by design`
  - [ ] This makes the existing implicit behaviour (the regex already only matches `src/...`) an explicit, tested, documented invariant

- [ ] Task 5: Write unit tests for init gitignore isolation (AC: #1, #2)
  - [ ] Add tests to `src/cli/commands/__tests__/init.test.ts` (or create a new `init-isolation.test.ts` if the file is too large)
  - [ ] Test AC1: call `runInit()` in a temp dir with no `.gitignore` → verify `.gitignore` contains `.substrate/scenarios/`
  - [ ] Test AC2: pre-populate `.gitignore` with `.substrate/scenarios/` → run init → verify entry appears exactly once (count occurrences)
  - [ ] Test: verify existing runtime entries (`.substrate/orchestrator.pid`) still appear after the change — no regression

- [ ] Task 6: Write unit tests for ContextCompiler exclusion (AC: #3, #4, #6)
  - [ ] Create `src/modules/context-compiler/__tests__/context-compiler-isolation.test.ts`
  - [ ] Test AC3: `createContextCompiler({ db, excludedPaths: ['.substrate/scenarios/'] })` → `compiler.getExcludedPaths()` returns `['.substrate/scenarios/']`
  - [ ] Test AC3 default: `createContextCompiler({ db })` → `getExcludedPaths()` returns `[]`
  - [ ] Test AC4: register a template whose `format` returns `'See .substrate/scenarios/scenario-x.sh for details'`; call `compile()` → `CompileResult.prompt` does NOT contain `.substrate/scenarios/`; confirm logger.warn was called
  - [ ] Test AC6: register a template whose `format` returns a string containing `SCENARIO_SECRET_TOKEN`; `excludedPaths` includes `.substrate/scenarios/`; compile → prompt does NOT contain the token (this verifies defense-in-depth)

- [ ] Task 7: Write unit test for RepoMapInjector guard and run full validation (AC: #5)
  - [ ] In `src/modules/context-compiler/__tests__/repo-map-injector.test.ts`, add a test: story content contains `.substrate/scenarios/scenario-login.sh` → `buildContext()` does NOT query the repo-map engine for that path
  - [ ] Add a companion test: story content contains both `src/modules/foo/bar.ts` AND `.substrate/scenarios/x.sh` → only `src/` paths are queried
  - [ ] Run `npm run build` — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all tests pass, no regressions in existing tests

## Dev Notes

### Architecture Constraints

- **Modified files (no new top-level source modules):**
  - `src/cli/commands/init.ts` — extend `runtimeEntries` array
  - `src/modules/context-compiler/context-compiler.ts` — add `getExcludedPaths()` to interface
  - `src/modules/context-compiler/context-compiler-impl.ts` — add `excludedPaths` option + `_applyExclusionFilter()` + `getExcludedPaths()`
  - `src/modules/context-compiler/repo-map-injector.ts` — add explicit `src/` guard comment and filter

- **New test files only:**
  - `src/modules/context-compiler/__tests__/context-compiler-isolation.test.ts`
  - Tests for init gitignore added to existing `__tests__/init*.test.ts` file or a new `init-isolation.test.ts`

- **Import style:** All imports within `src/` use `.js` extensions (ESM). Example: `import { createContextCompiler } from '../../modules/context-compiler/index.js'`

- **No factory package changes in this story** — 44-3 is entirely within the monolith (`src/`) and does not touch `packages/factory/`, `packages/core/`, or `packages/sdlc/`

- **No new ContextCompiler interface methods beyond `getExcludedPaths()`** — the exclusion filter is an implementation detail that operates transparently inside `compile()`

### Gitignore Modification Pattern

The existing pattern at `src/cli/commands/init.ts` (around line 996):

```typescript
const runtimeEntries = ['.substrate/orchestrator.pid', '.substrate/current-run-id']
try {
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : ''
  const missing = runtimeEntries.filter((e) => !existing.includes(e))
  if (missing.length > 0) {
    const block = '\n# Substrate runtime files\n' + missing.join('\n') + '\n'
    appendFileSync(gitignorePath, block)
  }
} catch (err) { ... }
```

Simply add `'.substrate/scenarios/'` to the `runtimeEntries` array. The idempotency check (`!existing.includes(e)`) already handles the AC2 requirement — no separate logic needed.

### ContextCompilerImpl Exclusion Filter Design

The filter runs **per section** during `compile()`, not on the final assembled prompt. This ensures budget accounting remains accurate — if a section is excluded, its tokens are not counted against the remaining budget. Pseudocode:

```typescript
// In compile(), replace the processSection call result handling:
const { text: rawText, tokens: rawTokens } = await processSection(this._db, section)
const text = this._applyExclusionFilter(rawText, section.name)
const tokens = text === rawText ? rawTokens : countTokens(text)  // recount only if changed
```

```typescript
private _applyExclusionFilter(text: string, sectionName: string): string {
  for (const excludedPath of this._excludedPaths) {
    if (text.includes(excludedPath)) {
      logger.warn(
        { sectionName, excludedPath },
        'ContextCompiler: section excluded — contains path from exclusion list'
      )
      return ''  // Exclude the entire section content
    }
  }
  return text
}
```

Return `''` (empty string) rather than attempting partial redaction — empty string is safe and deterministic.

### RepoMapInjector Guard

The current regex in `repo-map-injector.ts`:
```typescript
const matches = storyContent.match(/\bsrc\/[\w/.-]+\.tsx?\b/g) ?? []
```

This already only captures `src/` paths. The task is to make this intentional by:
1. Adding an explicit post-filter: `const dedupedPaths = [...new Set(matches)].filter(p => p.startsWith('src/') && !p.endsWith('.test.ts') && !p.endsWith('.test.tsx'))`
2. Adding a comment: `// Only src/ paths are queried — .substrate/, node_modules/, dist/ excluded by design`

### Testing Requirements

- **Framework:** Vitest (`import { describe, it, expect, vi, beforeEach } from 'vitest'`)
- **Mocking logger:** Use `vi.mock('../../utils/logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }))` in isolation tests
- **Temp directories for init tests:** Use `mkdtempSync(join(os.tmpdir(), 'substrate-init-test-'))` and clean up in `afterEach` with `rmSync(tmpDir, { recursive: true, force: true })`
- **Run during development:** `npm run test:fast` (unit-only, no coverage, ~50s)
- **Never pipe test output** — look for the `Test Files` summary line to confirm results
- **Minimum test counts:** ≥ 5 tests in `context-compiler-isolation.test.ts`, ≥ 3 new tests in init test file, ≥ 2 new tests in `repo-map-injector.test.ts`
- **No regressions:** Existing 7498 tests must still pass after changes

### Dependency Notes

- **Depends on:** 44-1 (ScenarioManifest, ScenarioEntry types) — but this story does NOT import from the factory scenarios package. The `excludedPaths` value `.substrate/scenarios/` is a hard-coded string constant, not derived from scenario types.
- **Depends on:** 41-9 (core extraction complete) — context compiler lives in `src/modules/context-compiler/`, not yet migrated to `packages/core/src/context/`. Modify the monolith files directly.
- **Unblocks:** 44-4 (integrity verification during pipeline runs) — which extends the isolation contract by verifying checksums

## Interface Contracts

- **Export**: `getExcludedPaths(): readonly string[]` added to `ContextCompiler` interface @ `src/modules/context-compiler/context-compiler.ts`
- **Export**: `excludedPaths?: string[]` added to `ContextCompilerOptions` @ `src/modules/context-compiler/context-compiler-impl.ts` (consumed by any caller of `createContextCompiler` that needs scenario isolation)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-22: Story created for Epic 44, Phase B — Scenario Store + Runner
