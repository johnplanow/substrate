# Story 37-6: Compiled Workflow Prompts — Stack-Aware Instructions

## Story

As a developer using substrate on a polyglot project,
I want the compiled workflow prompts (dev-story, test-plan, test-expansion) to inject stack-appropriate test and build instructions,
so that sub-agents dispatched for Go, JVM, Python, or Rust stories receive correct testing conventions instead of Vitest-specific instructions that don't apply.

## Acceptance Criteria

### AC1: dev-story — Go fallback patterns when no decisions exist
**Given** a project with `.substrate/project-profile.yaml` containing `project.testCommand: 'go test ./...'` and no `test-patterns` decisions in the decision store
**When** `runDevStory()` assembles the prompt
**Then** the `test_patterns` section contains Go test conventions (`go test ./...`, `_test.go`, table-driven tests) and does NOT contain Vitest-specific instructions

### AC2: dev-story — Vitest fallback unchanged when no profile and no decisions
**Given** no `.substrate/project-profile.yaml` exists and no `test-patterns` decisions in the decision store
**When** `runDevStory()` assembles the prompt
**Then** the `test_patterns` section contains the existing Vitest default patterns — behavior identical to pre-37-6

### AC3: dev-story — Seeded decisions take priority over defaults
**Given** `test-patterns` decisions exist in the decision store (seeded by story 37-5)
**When** `runDevStory()` assembles the prompt
**Then** the seeded decision values are used directly and `resolveDefaultTestPatterns()` is NOT called

### AC4: test-plan — Test patterns injected into prompt
**Given** `test-patterns` decisions exist in the decision store
**When** `runTestPlan()` assembles the prompt
**Then** the assembled prompt contains a test patterns section populated from the decision values

### AC5: test-plan — Stack-aware default patterns when no decisions
**Given** no `test-patterns` decisions exist and `.substrate/project-profile.yaml` indicates Go (`testCommand: 'go test ./...'`)
**When** `runTestPlan()` assembles the prompt
**Then** the assembled prompt contains Go test patterns (from `resolveDefaultTestPatterns()`) rather than Vitest patterns

### AC6: test-expansion — Test patterns injected into prompt
**Given** `test-patterns` decisions exist in the decision store
**When** `runTestExpansion()` assembles the prompt
**Then** the assembled prompt contains the test patterns section with the seeded values; when no decisions exist, a stack-aware default is used

### AC7: `resolveDefaultTestPatterns()` — covers all major stacks with Vitest fallback
**Given** a call to `resolveDefaultTestPatterns(projectRoot)` with various profile configurations
**When** called with a profile whose `testCommand` starts with `go test`, `./gradlew`, `mvn`, `cargo test`, or `pytest`
**Then** the returned string contains the appropriate framework commands and conventions for that stack
**And** when called with no profile, a missing profile file, or an unrecognized `testCommand`, it returns the Vitest default pattern block (backward compatibility preserved)

## Tasks / Subtasks

- [ ] Task 1: Create `src/modules/compiled-workflows/default-test-patterns.ts` (AC: #1, #2, #7)
  - [ ] Add named string constants for each stack: `GO_DEFAULT_PATTERNS`, `GRADLE_DEFAULT_PATTERNS`, `MAVEN_DEFAULT_PATTERNS`, `CARGO_DEFAULT_PATTERNS`, `PYTEST_DEFAULT_PATTERNS`, `VITEST_DEFAULT_PATTERNS` (same text as existing `DEFAULT_VITEST_PATTERNS` in `dev-story.ts`)
  - [ ] Each constant follows the format of the existing `DEFAULT_VITEST_PATTERNS` block in `dev-story.ts` (header `## Test Patterns (defaults)` + 6–8 bullet lines)
  - [ ] Add `resolveDefaultTestPatterns(projectRoot?: string): string` — reads `.substrate/project-profile.yaml` inline using `readFileSync`/`existsSync` from `node:fs` (synchronous — same pattern as Stories 37-3, 37-4, 37-5)
  - [ ] Parse with `yaml.load()` cast to `Record<string, unknown> | null`; return `VITEST_DEFAULT_PATTERNS` on missing file, parse error, or null result
  - [ ] Map `project.testCommand` string prefix to the appropriate constant (case-insensitive substring match):
    - `'go test'` → `GO_DEFAULT_PATTERNS`
    - `'gradlew'` or `'gradle'` → `GRADLE_DEFAULT_PATTERNS`
    - `'mvn'` → `MAVEN_DEFAULT_PATTERNS`
    - `'cargo test'` → `CARGO_DEFAULT_PATTERNS`
    - `'pytest'` → `PYTEST_DEFAULT_PATTERNS`
    - `'vitest'` / `'jest'` / `'mocha'` / `'npm'` → `VITEST_DEFAULT_PATTERNS`
  - [ ] If `testCommand` absent or unmatched, fall through to `project.language` field (go→Go, kotlin/java→Gradle, rust→Cargo, python→pytest, typescript/javascript→Vitest)
  - [ ] If neither matched → return `VITEST_DEFAULT_PATTERNS`
  - [ ] Do NOT import from `src/modules/project-profile/` or `seed-methodology-context.ts` — inline YAML parse only (avoids circular dependency and async cascade)
  - [ ] Export `resolveDefaultTestPatterns` and `VITEST_DEFAULT_PATTERNS` as named exports

- [ ] Task 2: Update `dev-story.ts` — replace hardcoded fallback with resolver (AC: #1, #2, #3)
  - [ ] Add `import { resolveDefaultTestPatterns } from './default-test-patterns.js'` at the top (alongside existing imports)
  - [ ] Remove the `DEFAULT_VITEST_PATTERNS` constant declaration (or mark as `@deprecated` comment pointing to the new module)
  - [ ] In the test-pattern fallback branch (line ~191): replace `testPatternsContent = DEFAULT_VITEST_PATTERNS` with `testPatternsContent = resolveDefaultTestPatterns(deps.projectRoot)`
  - [ ] In the error catch branch (line ~197): same replacement — `testPatternsContent = resolveDefaultTestPatterns(deps.projectRoot)`
  - [ ] `resolveDefaultTestPatterns` is synchronous — no `await`; `deps.projectRoot` is `string | undefined`, function accepts `undefined` and returns Vitest fallback

- [ ] Task 3: Update `test-plan.ts` — add test pattern injection (AC: #4, #5)
  - [ ] Add `import { resolveDefaultTestPatterns } from './default-test-patterns.js'` at the top
  - [ ] After Step 3 (`getArchConstraints`), add Step 3b: query `test-patterns` decisions
    ```typescript
    let testPatternsContent = ''
    try {
      const solutioningDecisions = await getDecisionsByPhase(deps.db, 'solutioning')
      const testPatternDecisions = solutioningDecisions.filter(d => d.category === 'test-patterns')
      if (testPatternDecisions.length > 0) {
        testPatternsContent = '## Test Patterns\n' + testPatternDecisions.map(d => `- ${d.key}: ${d.value}`).join('\n')
        logger.debug({ storyKey, count: testPatternDecisions.length }, 'Loaded test patterns from decision store')
      } else {
        testPatternsContent = resolveDefaultTestPatterns(deps.projectRoot)
        logger.debug({ storyKey }, 'No test-pattern decisions — using stack-aware defaults')
      }
    } catch {
      testPatternsContent = resolveDefaultTestPatterns(deps.projectRoot)
    }
    ```
  - [ ] Add `{ name: 'test_patterns', content: testPatternsContent, priority: 'optional' as const }` as the last section in the `assemblePrompt()` call (after `architecture_constraints`)

- [ ] Task 4: Update `test-expansion.ts` — add test pattern injection (AC: #6)
  - [ ] Add `import { resolveDefaultTestPatterns } from './default-test-patterns.js'` at the top
  - [ ] After Step 3 (`getArchConstraints`), add the same Step 3b query block as Task 3 (adjust variable names to match file style)
  - [ ] Add `{ name: 'test_patterns', content: testPatternsContent, priority: 'optional' as const }` to the sections array — between `git_diff` and `arch_constraints`
  - [ ] Wrap query in `try/catch` consistent with `getArchConstraints()` error handling style in this file

- [ ] Task 5: Audit `code-review.ts` and its prompt template for Node.js hardcoding (AC: #1, #2)
  - [ ] Locate the code-review prompt template file by following `deps.pack.getPrompt('code-review')` — check `src/methodology-pack/` directory for the template source
  - [ ] Search the template text for hardcoded: `vitest`, `jest`, `npm run`, `npx`, `.ts`/`.tsx` file extension assumptions, `node_modules`, `package.json`
  - [ ] If Node.js-specific test instructions found in template: add test pattern injection to `runCodeReview()` (same pattern as Task 3) AND log a note identifying the template file for a follow-up template update
  - [ ] If no hardcoding found: add a JSDoc comment to `runCodeReview()` noting `// Audited Story 37-6: no Node.js-specific test instructions in prompt assembly`
  - [ ] Document findings in Dev Agent Record > Completion Notes (either "no hardcoding found" or "found in <file>, added injection")

- [ ] Task 6: Add unit tests for `resolveDefaultTestPatterns()` (AC: #7)
  - [ ] Create `src/modules/compiled-workflows/__tests__/default-test-patterns.test.ts`
  - [ ] Mock `node:fs` with `vi.mock('node:fs', () => ({ existsSync: vi.fn(), readFileSync: vi.fn() }))`; use `vi.mocked()` wrappers
  - [ ] `beforeEach`: call `vi.clearAllMocks()` to prevent cross-test pollution
  - [ ] Test: Go profile (`testCommand: 'go test ./...'`) → result contains `go test`, does NOT contain `vitest`
  - [ ] Test: Gradle profile (`testCommand: './gradlew test'`) → result contains `./gradlew test` and `@Test`
  - [ ] Test: Maven profile (`testCommand: 'mvn test'`) → result contains `mvn test`
  - [ ] Test: Cargo profile (`testCommand: 'cargo test'`) → result contains `cargo test` and `#[test]`
  - [ ] Test: pytest profile (`testCommand: 'pytest'`) → result contains `pytest`
  - [ ] Test: no profile file (`existsSync` returns `false`) → result contains `vitest` (backward compat)
  - [ ] Test: unrecognized `testCommand: 'bazel test'` → result contains `vitest` (fallback)
  - [ ] Test: `language: 'go'` (no testCommand) → result contains `go test` (language fallback path)
  - [ ] Test: `projectRoot` is `undefined` → result contains `vitest` (no file I/O attempted)

- [ ] Task 7: Add unit tests for `dev-story.ts` stack-aware fallback (AC: #1, #2, #3)
  - [ ] Add `describe('Story 37-6: stack-aware test pattern fallback', ...)` block in `src/modules/compiled-workflows/__tests__/dev-story.test.ts`
  - [ ] Mock `resolveDefaultTestPatterns` via `vi.mock('../default-test-patterns.js', () => ({ resolveDefaultTestPatterns: vi.fn().mockReturnValue('GO_PATTERNS_MOCK') }))` — prevents real file I/O; add mock import
  - [ ] Test AC1: when `getDecisionsByPhase` returns empty test-pattern decisions, mock resolver returns Go patterns → assert `assemblePrompt` received a section containing `GO_PATTERNS_MOCK`
  - [ ] Test AC2: when `getDecisionsByPhase` returns empty AND resolver returns Vitest text → Vitest patterns in prompt sections
  - [ ] Test AC3: when `getDecisionsByPhase` returns `[{category:'test-patterns', key:'framework', value:'Go test (stdlib)'}]` → `resolveDefaultTestPatterns` is NOT called (verify with `expect(mockResolve).not.toHaveBeenCalled()`)

- [ ] Task 8: Add tests for test-plan/test-expansion injection + build validation (AC: #4, #5, #6)
  - [ ] In `src/modules/compiled-workflows/__tests__/test-plan.test.ts`, add `describe('Story 37-6: test pattern injection', ...)` block:
    - Mock `getDecisionsByPhase` returning test-pattern decisions → assert `assemblePrompt` receives a `test_patterns` section whose content contains the decision values
    - Mock `getDecisionsByPhase` returning no test-pattern decisions → assert resolver return value appears in assembled sections
  - [ ] In `src/modules/compiled-workflows/__tests__/test-expansion.test.ts`, add equivalent `describe('Story 37-6: test pattern injection', ...)` block with same assertions
  - [ ] Run `npm run build` — must exit 0 with zero TypeScript errors
  - [ ] Run `npm run test:fast` — do NOT pipe output; raw output must contain `Test Files` summary line; all tests pass

## Dev Notes

### Architecture Constraints

- **ESM project** — all local imports use `.js` extension: `import { resolveDefaultTestPatterns } from './default-test-patterns.js'`
- **`js-yaml` already a project dependency** — confirmed by `src/cli/commands/init.ts` and `src/modules/implementation-orchestrator/seed-methodology-context.ts` usage; no `npm install` required
- **Profile read must be synchronous** — use `readFileSync`/`existsSync` from `node:fs` (NOT `node:fs/promises`). The resolver is called synchronously in `dev-story.ts`'s catch block. Sync I/O avoids `await` refactoring.
- **No imports from `src/modules/project-profile/`** — inline YAML parse only (established pattern from Stories 37-3, 37-4, 37-5). Avoids circular dependency risk at compile time.
- **No imports from `seed-methodology-context.ts`** — that module's builder functions are for seeding the decision store at pipeline startup. Story 37-6 needs compact constant strings for fallback prompt injection; these are independent.
- **Test framework**: Vitest — use `describe`, `it`, `expect`, `vi`, `beforeEach`. Do NOT use Jest APIs.

### Key Files

| File | Action | Purpose |
|---|---|---|
| `src/modules/compiled-workflows/default-test-patterns.ts` | **Create** | `resolveDefaultTestPatterns()` shared helper + per-stack default pattern constants |
| `src/modules/compiled-workflows/dev-story.ts` | **Modify** | Replace `DEFAULT_VITEST_PATTERNS` fallback (~lines 191, 197) with `resolveDefaultTestPatterns(deps.projectRoot)` |
| `src/modules/compiled-workflows/test-plan.ts` | **Modify** | Add Step 3b test pattern query + `test_patterns` prompt section |
| `src/modules/compiled-workflows/test-expansion.ts` | **Modify** | Add test pattern query + `test_patterns` prompt section |
| `src/modules/compiled-workflows/code-review.ts` | **Audit / Modify** | Audit for Node.js hardcoding; add injection if found |
| `src/modules/compiled-workflows/__tests__/default-test-patterns.test.ts` | **Create** | Unit tests for `resolveDefaultTestPatterns()` (all stacks + fallbacks) |
| `src/modules/compiled-workflows/__tests__/dev-story.test.ts` | **Modify** | Add 37-6 stack-aware fallback test block |
| `src/modules/compiled-workflows/__tests__/test-plan.test.ts` | **Modify** | Add 37-6 test pattern injection test block |
| `src/modules/compiled-workflows/__tests__/test-expansion.test.ts` | **Modify** | Add 37-6 test pattern injection test block |

### Import Style

```typescript
// In default-test-patterns.ts
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

// In dev-story.ts, test-plan.ts, test-expansion.ts (add alongside existing imports)
import { resolveDefaultTestPatterns } from './default-test-patterns.js'
```

### Profile YAML Shape (inline-parsed, no TypeScript import needed)

```yaml
# Single project
project:
  type: single
  language: go          # go | kotlin | java | rust | python | typescript | javascript
  buildTool: go
  testCommand: "go test ./..."

# Monorepo (testCommand at root level)
project:
  type: monorepo
  testCommand: "turbo test"
  packages:
    - path: apps/lock-service
      language: go
```

**Fields consumed by `resolveDefaultTestPatterns()`:**

| Field path | Type | Usage |
|---|---|---|
| `project.testCommand` | `string` | Primary key for pattern selection (prefix match) |
| `project.language` | `string` | Secondary key when `testCommand` absent or unmatched |

### `resolveDefaultTestPatterns()` Algorithm

```
1. If projectRoot undefined or empty string → return VITEST_DEFAULT_PATTERNS
2. Build profile path: join(projectRoot, '.substrate/project-profile.yaml')
3. If existsSync(profilePath) is false → return VITEST_DEFAULT_PATTERNS
4. Try readFileSync(profilePath, 'utf-8') and yaml.load(content); on error → return VITEST_DEFAULT_PATTERNS
5. Extract testCommand = project?.testCommand as string (or '')
6. Match testCommand substring (case-insensitive):
   - includes 'go test'       → GO_DEFAULT_PATTERNS
   - includes 'gradlew'       → GRADLE_DEFAULT_PATTERNS
   - includes 'mvn'           → MAVEN_DEFAULT_PATTERNS
   - includes 'cargo test'    → CARGO_DEFAULT_PATTERNS
   - includes 'pytest'        → PYTEST_DEFAULT_PATTERNS
   - includes 'vitest'/'jest'/'mocha'/'npm' → VITEST_DEFAULT_PATTERNS
7. If testCommand not matched, try language = project?.language as string:
   - 'go'                     → GO_DEFAULT_PATTERNS
   - 'kotlin' | 'java'        → GRADLE_DEFAULT_PATTERNS
   - 'rust'                   → CARGO_DEFAULT_PATTERNS
   - 'python'                 → PYTEST_DEFAULT_PATTERNS
   - 'typescript'|'javascript'→ VITEST_DEFAULT_PATTERNS
8. Nothing matched            → return VITEST_DEFAULT_PATTERNS
```

### Default Pattern Block Format

Each constant follows the same format as `DEFAULT_VITEST_PATTERNS` in `dev-story.ts` (6–8 bullet lines, `## Test Patterns (defaults)` header):

```typescript
const GO_DEFAULT_PATTERNS = `## Test Patterns (defaults)
- Framework: Go test (stdlib)
- Test file naming: <module>_test.go alongside source files
- Test structure: table-driven tests using t.Run() subtests
- Run all tests: go test ./...
- Run specific test: go test ./... -v -run TestFunctionName
- IMPORTANT: Run targeted tests during development: go test ./pkg/... -v -run TestSpecific
- Assertion style: t.Errorf(), t.Fatalf(); use testify if already in go.mod (require.Equal, assert.NoError)`

const GRADLE_DEFAULT_PATTERNS = `## Test Patterns (defaults)
- Framework: JUnit 5 (Gradle)
- Test structure: @Test annotated methods in class under src/test/
- Run all tests: ./gradlew test
- Run specific test: ./gradlew test --tests "com.example.ClassName.methodName"
- IMPORTANT: Run targeted tests during development: ./gradlew test --tests "ClassName"
- Assertion style: assertThat(...).isEqualTo(...) (AssertJ) or assertEquals (JUnit)`
// ... etc. for Maven, Cargo, pytest, Vitest
```

### test-plan.ts and test-expansion.ts Injection Pattern

Follow the same pattern `dev-story.ts` uses for test patterns — query decisions first, fall back to resolver:

```typescript
// Step 3b: Query test-pattern decisions (add after getArchConstraints call)
let testPatternsContent = ''
try {
  const solutioningDecisions = await getDecisionsByPhase(deps.db, 'solutioning')
  const testPatternDecisions = solutioningDecisions.filter(d => d.category === 'test-patterns')
  if (testPatternDecisions.length > 0) {
    testPatternsContent = '## Test Patterns\n' +
      testPatternDecisions.map(d => `- ${d.key}: ${d.value}`).join('\n')
    logger.debug({ storyKey, count: testPatternDecisions.length }, 'Loaded test patterns from decision store')
  } else {
    testPatternsContent = resolveDefaultTestPatterns(deps.projectRoot)
    logger.debug({ storyKey }, 'No test-pattern decisions — using stack-aware defaults')
  }
} catch {
  testPatternsContent = resolveDefaultTestPatterns(deps.projectRoot)
}
```

Then add to `assemblePrompt()` sections array:
- `test-plan.ts`: append after `architecture_constraints` section
- `test-expansion.ts`: insert between `git_diff` and `arch_constraints` sections

### Testing Requirements

- **Run during iteration**: `npm run test:fast` (~90s). Do NOT pipe output. Raw output must contain `Test Files` summary.
- **Coverage**: 80% minimum enforced by vitest config.
- **Mock `node:fs` in `default-test-patterns.test.ts`**: `vi.mock('node:fs', () => ({ existsSync: vi.fn(), readFileSync: vi.fn() }))`. Use `vi.mocked()` for typed access.
- **Mock `resolveDefaultTestPatterns` in workflow tests**: `vi.mock('./default-test-patterns.js', () => ({ resolveDefaultTestPatterns: vi.fn().mockReturnValue('MOCK_PATTERNS') }))` — prevents file I/O side effects.
- **`beforeEach`**: call `vi.clearAllMocks()` in new `describe` blocks to prevent cross-test pollution.

### Dependency on Story 37-5

Story 37-5 seeds `test-patterns` decisions into the decision store via `seedMethodologyContext()`. This story CONSUMES those decisions (reads them via `getDecisionsByPhase`). The resolver in `default-test-patterns.ts` is the fallback used ONLY when 37-5 seeding didn't run or yielded no decisions for a story. The two modules are independent — 37-6 does not import from 37-5's builder functions.

## Interface Contracts

- **Export**: `resolveDefaultTestPatterns` @ `src/modules/compiled-workflows/default-test-patterns.ts` (consumed by dev-story.ts, test-plan.ts, test-expansion.ts — all within this module boundary)
- **Import**: `test-patterns` decisions @ decision store `solutioning` phase (seeded by story 37-5 via `seedMethodologyContext()`)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
