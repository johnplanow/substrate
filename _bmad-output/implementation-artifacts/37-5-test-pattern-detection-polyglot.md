# Story 37-5: Test Pattern Detection — Go, JVM, Python, Rust

## Story

As a developer using substrate on a polyglot or non-Node.js project,
I want the test pattern seeder to detect and seed framework-appropriate test instructions for Go, JVM, Python, and Rust stacks,
so that sub-agents receive correct testing conventions (`go test`, `./gradlew test`, `pytest`, `cargo test`) instead of returning `undefined` and leaving agents with no test guidance.

## Acceptance Criteria

### AC1: Profile-first — testCommand mapped to Go patterns
**Given** a `.substrate/project-profile.yaml` with `project.testCommand: 'go test ./...'` and `project.packages: []`
**When** `seedMethodologyContext()` is called with no pre-existing `test-patterns` decision
**Then** a `test-patterns` decision is seeded containing Go test conventions (`go test ./...`, table-driven tests, `_test.go` file naming)

### AC2: go.mod filesystem probe — Go patterns (no profile)
**Given** `go.mod` exists at the project root, no `package.json` is present, and no `.substrate/project-profile.yaml` exists
**When** `detectTestPatterns(projectRoot)` is called
**Then** Go test patterns are returned, including `go test ./...`, `_test.go` file naming, table-driven test structure, and a note about `testify` if `go.mod` contains `github.com/stretchr/testify`

### AC3: Gradle filesystem probe — JUnit 5 patterns (no profile)
**Given** `build.gradle.kts` (or `build.gradle`) exists at project root containing the string `junit-jupiter`, no `package.json`, no profile
**When** `detectTestPatterns(projectRoot)` is called
**Then** JUnit 5 patterns are returned, including `./gradlew test --tests "ClassName"`, `@Test` annotation style, and `assertThat` assertion patterns

### AC4: pytest filesystem probe — Python patterns (no profile)
**Given** at least one of: `pyproject.toml` at root containing `[tool.pytest` OR `conftest.py` at root; no `package.json`, no profile
**When** `detectTestPatterns(projectRoot)` is called
**Then** pytest patterns are returned, including `pytest` run command, fixture patterns, and `assert` statement style

### AC5: Cargo.toml filesystem probe — Rust patterns (no profile)
**Given** `Cargo.toml` exists at the project root, no `package.json` is present, and no profile exists
**When** `detectTestPatterns(projectRoot)` is called
**Then** Rust test patterns are returned, including `cargo test`, `#[test]` attribute, and `assert_eq!` / `assert!` macros

### AC6: Monorepo profile — multi-language combined patterns
**Given** a `.substrate/project-profile.yaml` with `project.type: 'monorepo'` and `packages` containing at least one Go entry (`language: 'go'`) and one TypeScript entry (`language: 'typescript'`)
**When** `seedMethodologyContext()` is called with no pre-existing `test-patterns` decision
**Then** a single `test-patterns` decision is seeded that includes both Go test conventions (with package path context) and Vitest conventions (with package path context), clearly separated by package

### AC7: Existing Node.js detection unchanged
**Given** only `package.json` exists with vitest in devDependencies, no profile, no `go.mod`, no `Cargo.toml`, no `build.gradle*`, no `pyproject.toml`
**When** `detectTestPatterns(projectRoot)` is called
**Then** the existing Vitest patterns are returned — behavior identical to pre-37-5

## Tasks / Subtasks

- [ ] Task 1: Add `js-yaml` import and inline profile-read helper (AC: #1, #6)
  - [ ] Add `import yaml from 'js-yaml'` after existing `node:*` imports at top of `seed-methodology-context.ts` (same style used in `src/cli/commands/init.ts`)
  - [ ] Confirm `js-yaml` is already a project dependency (established in Story 37-3 audit — no `npm install` needed)
  - [ ] Add private helper `readProfileSync(projectRoot: string)` immediately above `detectTestPatterns()` that:
    - Reads `.substrate/project-profile.yaml` using `readFileSync` (sync — do NOT use `loadProjectProfile()` from 37-1, avoids async cascade)
    - Parses with `yaml.load()` cast to `Record<string, unknown> | null`
    - Returns `null` on missing file, parse error, or unexpected shape
    - Uses `existsSync` guard before `readFileSync` to avoid unnecessary throws
    - Does NOT import from `src/modules/project-profile/` — inline parse only (same pattern as Story 37-3 and 37-4)

- [ ] Task 2: Add profile-driven detection path at top of `detectTestPatterns()` (AC: #1, #6)
  - [ ] Call `readProfileSync(projectRoot)` at the start of `detectTestPatterns()`
  - [ ] If profile has `project.packages` array that is non-empty → call `buildMonorepoTestPatterns(packages)` and return result
  - [ ] If profile has `project.testCommand` string (packages empty or absent) → call `mapTestCommandToPatterns(testCommand)` and return result
  - [ ] If profile is present but both paths yield nothing → fall through to existing filesystem detection (conservative)
  - [ ] Place this block BEFORE the existing `const pkgPath = join(projectRoot, 'package.json')` line

- [ ] Task 3: Add polyglot filesystem probes to `detectTestPatterns()` (AC: #2, #3, #4, #5)
  - [ ] After the existing `package.json` check block (lines 437–488), add filesystem probes in this priority order — each probe runs only if the previous probes returned `undefined`:
    1. `go.mod` → `buildGoTestPatterns(projectRoot)`
    2. `build.gradle.kts` or `build.gradle` → `buildGradleTestPatterns(projectRoot)`
    3. `pom.xml` → `buildMavenTestPatterns()`
    4. `Cargo.toml` → `buildCargoTestPatterns()`
    5. `pyproject.toml` OR `conftest.py` → `buildPytestPatterns(projectRoot)`
  - [ ] Each probe uses `existsSync(join(projectRoot, '<marker>'))` — keep probes concise and non-throwing
  - [ ] Return `undefined` if none match (existing behavior for truly unknown stacks)

- [ ] Task 4: Implement Go, Rust, and JVM builder functions (AC: #2, #3, #5)
  - [ ] Add `buildGoTestPatterns(projectRoot: string): string`:
    - Detect testify: read `go.mod` content, check for `github.com/stretchr/testify`
    - Return pattern block with: `go test ./...`, `go test ./... -v -run TestName`, `_test.go` naming, table-driven structure, optional testify line if detected
  - [ ] Add `buildGradleTestPatterns(projectRoot: string): string`:
    - Detect JUnit5 vs JUnit4: read `build.gradle.kts` (prefer) or `build.gradle` content, check for `junit-jupiter`
    - Return pattern block with: `./gradlew test`, `./gradlew test --tests "com.example.ClassName"`, `@Test` annotation, `assertThat`/`assertEquals` style
  - [ ] Add `buildMavenTestPatterns(): string`:
    - Return pattern block with: `mvn test`, `mvn test -Dtest=ClassName`, `@Test` annotation, `assertEquals` style
  - [ ] Add `buildCargoTestPatterns(): string`:
    - Return pattern block with: `cargo test`, `cargo test module_name`, `#[test]` attribute, `assert_eq!` / `assert!` macros, `#[cfg(test)] mod tests` block structure

- [ ] Task 5: Implement Python and multi-language builder functions (AC: #4, #6)
  - [ ] Add `buildPytestPatterns(projectRoot: string): string`:
    - Detect pytest config: check `pyproject.toml` for `[tool.pytest`, check for `conftest.py`
    - Return pattern block with: `pytest`, `pytest tests/test_file.py -v -k "test_name"`, fixture pattern (`@pytest.fixture`), `assert` statement style, `conftest.py` usage
  - [ ] Add `mapTestCommandToPatterns(testCommand: string): string | undefined`:
    - Maps profile `testCommand` to existing or new builder: `go test` → `buildGoTestPatterns` (no project root available — generate generic Go patterns); `./gradlew` / `gradlew` → `buildGradleTestPatterns`; `mvn` → `buildMavenTestPatterns`; `cargo test` → `buildCargoTestPatterns`; `pytest` → `buildPytestPatterns`; `vitest` / `npx vitest` → `buildVitestPatterns`; `jest` → `buildJestPatterns`; `mocha` → `buildMochaPatterns`; unrecognized → `undefined`
    - Note: builder functions that take `projectRoot` for deeper inspection should receive an empty string `''` when called from profile mapping (testify/junit detection falls back to defaults)
  - [ ] Add `buildMonorepoTestPatterns(packages: Array<{language?: string; path?: string}>): string`:
    - Filter packages to distinct languages
    - For each language present, generate a concise header + key test commands (do not repeat full pattern details, keep under `MAX_TEST_PATTERNS_CHARS` / number-of-languages)
    - Include `path` context (e.g., `# apps/lock-service (Go)`) before each language block
    - Join with double newlines

- [ ] Task 6: Add unit tests for polyglot detection (AC: #1–#7)
  - [ ] Add new `describe` block: `'detectTestPatterns: Story 37-5 polyglot detection'` in `seed-methodology-context.test.ts`
  - [ ] **AC1 test** — profile with go testCommand seeds Go patterns:
    - Mock `existsSync` → `true` for profile path; `false` for everything else
    - Mock `readFileSync` for profile → YAML with `project: { testCommand: 'go test ./...', packages: [] }`
    - Call `seedMethodologyContext(db, PROJECT_ROOT)` on a fresh test DB
    - Retrieve `test-patterns` decisions; assert value contains `go test`
  - [ ] **AC2 test** — `go.mod` probe → Go patterns:
    - Mock `existsSync` → `false` for profile and `package.json`; `true` for `go.mod`
    - Mock `readFileSync` for `go.mod` → `module example.com/app\ngo 1.22\n`
    - Call `detectTestPatterns(PROJECT_ROOT)` (import and call directly); assert result contains `go test ./...`
  - [ ] **AC2b test** — testify detection: mock `go.mod` with `github.com/stretchr/testify`, assert result mentions `testify`
  - [ ] **AC3 test** — `build.gradle.kts` with `junit-jupiter` → Gradle patterns:
    - Mock `existsSync` → `false` for profile, `package.json`, `go.mod`; `true` for `build.gradle.kts`
    - Mock `readFileSync` for `build.gradle.kts` → content containing `junit-jupiter`
    - Assert result contains `./gradlew test` and `@Test`
  - [ ] **AC4 test** — `pyproject.toml` with `[tool.pytest]` → pytest patterns:
    - Mock appropriate `existsSync` / `readFileSync` returns
    - Assert result contains `pytest` and `fixture`
  - [ ] **AC4b test** — `conftest.py` only (no pyproject.toml) → pytest patterns
  - [ ] **AC5 test** — `Cargo.toml` → Rust patterns:
    - Mock `existsSync` → `true` for `Cargo.toml`; false for all others
    - Assert result contains `cargo test` and `#[test]`
  - [ ] **AC6 test** — monorepo profile with Go + TypeScript → combined patterns:
    - Mock profile with `packages: [{path: 'apps/lock-service', language: 'go'}, {path: 'apps/web', language: 'typescript'}]`
    - Assert seeded value contains both `go test` and `vitest` (or `npm`) sections
  - [ ] **AC7 test** — no regression on vitest detection:
    - Mock `existsSync` → `false` for profile; `true` for `package.json`
    - Mock `readFileSync` for `package.json` → `{"devDependencies": {"vitest": "^1.0.0"}, "scripts": {}}`
    - Assert result contains `vitest` and does NOT contain `go test`

- [ ] Task 7: Export `detectTestPatterns` for testing and build validation (AC: all)
  - [ ] Add `detectTestPatterns` to the export list in `seed-methodology-context.ts` (similar to how `parseStorySubsections` is exported for testing — see line 45 of test file). Mark as `@internal` in JSDoc if needed.
  - [ ] Run `npm run build` — must exit 0 with zero TypeScript errors
  - [ ] Run `npm run test:fast` — do NOT pipe output; raw output must contain `Test Files` summary; all tests pass

## Dev Notes

### Architecture Constraints

- **File to modify (primary)**: `src/modules/implementation-orchestrator/seed-methodology-context.ts`
  - `detectTestPatterns()` is currently a private function at line 436 — export it for direct unit testing (add to module exports, annotate `@internal`)
  - `readProfileSync()` must be **synchronous** — use `readFileSync`, not `loadProjectProfile()` (which is async). Follow the Story 37-3 / 37-4 pattern exactly.
  - **Do NOT** import from `src/modules/project-profile/` — inline YAML parse only (avoids async cascade and circular dependency risk at compile time)
  - `js-yaml` is already a dependency (confirmed Story 37-3 audit); no `npm install` required
  - New builder functions (`buildGoTestPatterns`, `buildGradleTestPatterns`, etc.) follow the same pattern as existing `buildVitestPatterns`, `buildJestPatterns`, `buildMochaPatterns` — pure functions that return a `string`
  - `MAX_TEST_PATTERNS_CHARS = 2_000` (line 32) — monorepo combined patterns must stay under this limit. Use concise per-language blocks.

- **File to modify (tests)**: `src/modules/implementation-orchestrator/__tests__/seed-methodology-context.test.ts`
  - The existing `vi.mock('node:fs', ...)` at line 21 already mocks `existsSync` and `readFileSync` — extend it to cover `go.mod`, `build.gradle.kts`, `pyproject.toml`, `Cargo.toml`, and profile path returns
  - Import `detectTestPatterns` from the module under test (once exported in Task 7)
  - Add new `describe` block after existing suites to avoid coupling with existing test expectations

### Key Files

| File | Action | Purpose |
|---|---|---|
| `src/modules/implementation-orchestrator/seed-methodology-context.ts` | **Modify** | Add `readProfileSync()`, profile-driven detection, polyglot filesystem probes, new builder functions, export `detectTestPatterns` |
| `src/modules/implementation-orchestrator/__tests__/seed-methodology-context.test.ts` | **Modify** | Add polyglot detection test suite (ACs 1–7) |

### Import Style

All local imports use `.js` extension (ESM project). External packages use bare specifier:

```typescript
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
// ... internal imports with .js extension
```

The `js-yaml` import should follow the existing pattern established in `src/cli/commands/init.ts`.

### Profile YAML Shape

Story 37-1 defines and writes the profile. The `readProfileSync()` helper reads these fields inline (no TypeScript import needed):

```yaml
# Single Go project
project:
  type: single
  language: go
  buildTool: go
  buildCommand: "go build ./..."
  testCommand: "go test ./..."
  packages: []

# Turborepo monorepo
project:
  type: monorepo
  tool: turborepo
  buildCommand: "turbo build"
  testCommand: "turbo test"
  packages:
    - path: apps/lock-service
      language: go
    - path: apps/web
      language: typescript
      framework: nextjs
```

**Fields consumed by this story:**
| Field path | Type | Meaning |
|---|---|---|
| `project.testCommand` | `string` | Root-level test command (used when packages[] is empty) |
| `project.packages` | `Array<{language: string; path: string}>` | Per-package language (used for monorepo patterns) |

### Detection Priority in `detectTestPatterns()`

```
1. Profile present + packages[] non-empty    → buildMonorepoTestPatterns(packages)
2. Profile present + testCommand non-empty   → mapTestCommandToPatterns(testCommand)
3. No profile / profile fallthrough:
   a. package.json present                   → existing vitest/jest/mocha detection (unchanged)
   b. go.mod present                         → buildGoTestPatterns(projectRoot)
   c. build.gradle.kts or build.gradle       → buildGradleTestPatterns(projectRoot)
   d. pom.xml                                → buildMavenTestPatterns()
   e. Cargo.toml                             → buildCargoTestPatterns()
   f. pyproject.toml OR conftest.py          → buildPytestPatterns(projectRoot)
4. Nothing matched                           → undefined
```

**Note:** Package.json check runs before other filesystem probes (step 3a before 3b-3f). This preserves exact backward-compat behavior — Node.js projects with `package.json` are handled as before. Non-Node projects that have both `package.json` and `go.mod` (rare) will get Node.js patterns; the profile (step 1/2) is the override mechanism for mixed cases.

### Builder Function Contracts

Each builder returns a `string` with `## Test Patterns` header (same format as `buildVitestPatterns`):

```typescript
// Go example
function buildGoTestPatterns(projectRoot: string): string {
  // detect testify by reading go.mod if available
  const hasTestify = (() => { /* try readFileSync, look for stretchr/testify */ })()
  return [
    '## Test Patterns',
    '- Framework: Go test (stdlib)',
    '- Test file naming: <module>_test.go alongside source files',
    '- Test structure: table-driven tests with t.Run() subtests',
    '- Run all tests: go test ./...',
    '- Run specific test: go test ./... -v -run TestFunctionName',
    '- Assertion style: t.Errorf(), t.Fatalf(), require.Equal() (testify)',
    hasTestify ? '- Testify available: use require.Equal(), assert.NoError(), etc.' : '',
  ].filter(Boolean).join('\n')
}
```

Keep each builder ≤ 8 bullet points to stay within `MAX_TEST_PATTERNS_CHARS` budget. For `buildMonorepoTestPatterns()`, emit a 3–4 line block per language, prefixed with the package path.

### testCommand Mapping in `mapTestCommandToPatterns()`

```
'go test'          → buildGoTestPatterns('')     (no projectRoot — skip testify detection)
'gradlew' / 'gradle' → buildGradleTestPatterns('')
'mvn'              → buildMavenTestPatterns()
'cargo test'       → buildCargoTestPatterns()
'pytest'           → buildPytestPatterns('')
'vitest'           → buildVitestPatterns(testCommand)
'jest'             → buildJestPatterns(testCommand)
'mocha'            → buildMochaPatterns()
unrecognized       → undefined
```

When `projectRoot` is `''` (empty), the builder should skip all `existsSync`/`readFileSync` calls (use `projectRoot.length > 0` guard inside the builder before any filesystem access).

### Testing Requirements

- **Test framework**: Vitest — use `describe`, `it`, `expect`, `vi`, `beforeEach`. Do NOT use Jest APIs.
- **Run during iteration**: `npm run test:fast` (unit tests only, ~90s). Do NOT pipe output.
- **Coverage**: 80% minimum enforced by vitest config.
- **Test DB**: use the existing `createTestDb()` helper from the test file for integration-style `seedMethodologyContext()` tests.
- **PROJECT_ROOT constant**: use `'/project'` (the existing convention in the test file) — profile path will be `/project/.substrate/project-profile.yaml`.
- **Mock reset**: call `vi.clearAllMocks()` or individual `.mockReset()` in `beforeEach` within the new describe block to avoid cross-test pollution.

### Dependency on Story 37-1

Story 37-1 defines `ProjectProfile` schema and writes the profile file. This story reads the same YAML shape inline (no TypeScript import) — the shape is stable and documented above. Stories 37-3 and 37-4 establish the exact inline-parse pattern to follow.

## Interface Contracts

- **Import**: `ProjectProfile.project.testCommand`, `ProjectProfile.project.packages[].{language, path}` @ `src/modules/project-profile/types.ts` (from story 37-1) — consumed indirectly via inline YAML parse in `readProfileSync()`, not a TypeScript import

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
