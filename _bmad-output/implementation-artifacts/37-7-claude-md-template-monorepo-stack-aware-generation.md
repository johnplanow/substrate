# Story 37-7: CLAUDE.md Template — Monorepo & Stack-Aware Generation

## Story

As a developer initializing Substrate on a non-Node.js or monorepo project,
I want `substrate init` to generate a CLAUDE.md with project-specific build and test instructions,
so that the AI dev agent receives accurate, stack-appropriate guidance instead of no build/test instructions or silently wrong Node.js defaults.

## Acceptance Criteria

### AC1: TypeScript/Node.js Single Project
**Given** a single-stack Node.js/TypeScript project profile (language: typescript/javascript)
**When** `substrate init` generates CLAUDE.md
**Then** the Dev Workflow section includes build and test commands appropriate to the detected package manager (npm/pnpm/yarn/bun), derived from `project.buildCommand`

### AC2: Go Single Project
**Given** a single-stack Go project profile (language: go, buildTool: go)
**When** `substrate init` generates CLAUDE.md
**Then** the Dev Workflow section includes `go build ./...` and `go test ./...` with Go-specific testing notes (short flag, verbose flag, single-test targeting with `-run`)

### AC3: JVM (Gradle or Maven) Single Project
**Given** a single-stack Gradle profile (buildTool: gradle) or Maven profile (buildTool: maven)
**When** `substrate init` generates CLAUDE.md
**Then** the Dev Workflow section includes the correct build command (`./gradlew build` or `mvn compile`) and test command (`./gradlew test` or `mvn test`)

### AC4: Rust/Cargo Single Project
**Given** a single-stack Rust project profile (buildTool: cargo)
**When** `substrate init` generates CLAUDE.md
**Then** the Dev Workflow section includes `cargo build` and `cargo test` with Rust-specific notes (nocapture flag, targeted test with `-- module::test_name`)

### AC5: Python Single Project
**Given** a single-stack Python project profile (language: python, buildTool: poetry or pip)
**When** `substrate init` generates CLAUDE.md
**Then** the Dev Workflow section includes the appropriate install command (`poetry install` or `pip install -e .`) and `pytest` test command with common flags

### AC6: Turborepo Monorepo
**Given** a monorepo profile (type: monorepo, tool: turborepo) with one or more package entries
**When** `substrate init` generates CLAUDE.md
**Then** the Dev Workflow section documents: the root build command (`project.buildCommand`), the root test command (`project.testCommand`), and a package table listing each package's path, language, framework, and test command

### AC7: No Profile / Backward Compatibility
**Given** no `.substrate/project-profile.yaml` exists and auto-detection returns null
**When** `substrate init` generates CLAUDE.md
**Then** the Dev Workflow section is omitted and the substrate pipeline section is written as before, preserving existing behavior for undetected projects

## Tasks / Subtasks

- [x] Task 1: Create `buildStackAwareDevNotes` pure function (AC: #1, #2, #3, #4, #5, #6, #7)
  - [x] Create `src/cli/templates/build-dev-notes.ts` exporting `buildStackAwareDevNotes(profile: ProjectProfile | null): string`
  - [x] Implement null/undefined branch: return empty string (no section emitted) for missing profile
  - [x] Implement Node.js/TypeScript branch: detect package manager from `project.buildCommand` string (pnpm/yarn/bun/npm), emit matching build and test instructions with `npm run build` / `npm test` as fallback
  - [x] Implement Go branch: emit `go build ./...`, `go test ./...`, and Go-specific testing notes (short flag, verbose, `-run TestName`)
  - [x] Implement Gradle branch: emit `./gradlew build`, `./gradlew test`, `./gradlew test --tests "ClassName"` note
  - [x] Implement Maven branch: emit `mvn compile`, `mvn test`, `mvn test -Dtest=ClassName` note
  - [x] Implement Cargo (Rust) branch: emit `cargo build`, `cargo test`, `cargo test -- --nocapture`, targeted test note
  - [x] Implement Python branch: emit pip/poetry install command (derived from `project.buildCommand`) and `pytest -v` test command
  - [x] Implement monorepo branch: emit root build/test commands from profile, followed by markdown table of `project.packages` (path, language, framework, testCommand columns)
  - [x] Wrap generated content in `<!-- dev-workflow:start -->` / `<!-- dev-workflow:end -->` markers for idempotent re-runs

- [x] Task 2: Unit tests for `buildStackAwareDevNotes` (AC: #1, #2, #3, #4, #5, #6, #7)
  - [x] Create `src/cli/templates/__tests__/build-dev-notes.test.ts`
  - [x] Test: TypeScript profile with `npm run build` → includes `npm run build`, `npm test`
  - [x] Test: TypeScript profile with `pnpm run build` → includes `pnpm run build`, `pnpm test`
  - [x] Test: Go profile (language: go, buildTool: go) → includes `go build ./...`, `go test ./...`, `-run` flag note
  - [x] Test: Gradle profile (buildTool: gradle) → includes `./gradlew build`, `./gradlew test`
  - [x] Test: Maven profile (buildTool: maven) → includes `mvn compile`, `mvn test`
  - [x] Test: Cargo profile (buildTool: cargo) → includes `cargo build`, `cargo test`
  - [x] Test: Python/poetry profile → includes `poetry install`, `pytest`
  - [x] Test: Python/pip profile → includes `pip install`, `pytest`
  - [x] Test: Turborepo monorepo with packages → includes root commands, package table with path and language columns
  - [x] Test: null profile → returns empty string (no section content)

- [x] Task 3: Integrate into `init.ts` CLAUDE.md generation (AC: #1–#7)
  - [x] In `src/cli/commands/init.ts`, import `buildStackAwareDevNotes` from `../templates/build-dev-notes`
  - [x] Update `scaffoldClaudeMd` signature to accept `profile?: ProjectProfile | null` as second parameter
  - [x] Inside `scaffoldClaudeMd`, call `buildStackAwareDevNotes(profile ?? null)` to generate the dev notes section
  - [x] If the generated section is non-empty, prepend it (with a trailing `\n\n`) before `sectionContent` so the final CLAUDE.md reads: `[dev workflow section]\n\n[substrate pipeline section]`
  - [x] For idempotent re-runs: replace existing `<!-- dev-workflow:start -->...<!-- dev-workflow:end -->` block when present (analogous to existing substrate marker replacement logic)
  - [x] Update the call site at Step 5 in `runInitAction`: `await scaffoldClaudeMd(projectRoot, detectedProfile)`

- [x] Task 4: Integration tests for CLAUDE.md generation with profile (AC: #2, #6)
  - [x] In `src/cli/commands/__tests__/init-claude-md.test.ts`, add a test that mocks a Go profile and verifies the generated CLAUDE.md contains `go test ./...`
  - [x] Add a test that mocks a Turborepo monorepo profile (2 packages) and verifies the CLAUDE.md contains the package table with correct path and language columns
  - [x] Add a test that passes null profile and verifies no `<!-- dev-workflow:start -->` marker is present in the output

## Dev Notes

### Architecture Constraints
- Import `ProjectProfile` and `PackageEntry` types from `src/modules/project-profile/types.ts` — the module is fully available from Story 37-1
- `buildStackAwareDevNotes` **must be a pure function** (no filesystem I/O, no YAML parsing, no async) — accepts a `ProjectProfile | null` and returns a `string`. This makes it trivially unit-testable
- Do NOT import from `src/modules/compiled-workflows/default-test-patterns.ts` — that module generates dev-agent prompt injections; `build-dev-notes.ts` generates human-readable CLAUDE.md sections. They serve different consumers and must remain independent
- The `detectedProfile` variable is already in scope at the `scaffoldClaudeMd` call site (line 891, after Step 1b profile detection). Simply pass it through — no additional profile loading is needed
- Follow the same marker pattern as the substrate section (`<!-- substrate:start -->` / `<!-- substrate:end -->`) for idempotent updates; use `<!-- dev-workflow:start -->` / `<!-- dev-workflow:end -->` for the new dev workflow section

### File Paths
- **New file**: `src/cli/templates/build-dev-notes.ts`
- **New test**: `src/cli/templates/__tests__/build-dev-notes.test.ts`
- **Modified**: `src/cli/commands/init.ts` — `scaffoldClaudeMd` signature + call site at line 891
- **No changes needed** to `src/cli/templates/claude-md-substrate-section.md` — the template has no hardcoded Node.js build/test instructions; it is purely Substrate pipeline instructions

### Package Manager Detection (Node.js/TypeScript branch)
Parse `profile.project.buildCommand` to infer package manager:
- Contains `pnpm` → use `pnpm run build` / `pnpm test`
- Contains `yarn` → use `yarn build` / `yarn test`
- Contains `bun` → use `bun run build` / `bun test`
- Default/npm fallback → use `npm run build` / `npm test`

### Monorepo Output Format
For Turborepo monorepos, generate a markdown table after the root commands:

```markdown
## Dev Workflow

**Root build:** `turbo build`
**Root test:** `turbo test`

### Package Structure

| Package | Language | Framework | Test Command |
|---------|----------|-----------|--------------|
| apps/web | TypeScript | Next.js | pnpm test |
| apps/lock-service | Go | — | go test ./... |
| apps/pricing-worker | TypeScript | Node | pnpm test |
```

Omit the Framework column value (use `—`) when `PackageEntry.framework` is undefined. Use `PackageEntry.testCommand` if present, otherwise use the stack default.

### AC7 Implementation Note
When `profile` is null, `buildStackAwareDevNotes` returns `''`. Inside `scaffoldClaudeMd`, when the generated section is empty, the function skips prepending any dev workflow block and writes only the substrate section — identical to current behavior.

### Testing Requirements
- Unit tests use Vitest (`describe`, `it`, `expect`) — no filesystem access
- Pass fully typed `ProjectProfile` mock objects directly to `buildStackAwareDevNotes`
- Integration tests in `init.test.ts` may use `tmp` directories; mock `detectProjectProfile` to return a canned profile
- Run `npm run test:fast` after implementation; verify no regressions in existing init tests
- Confirm the `<!-- dev-workflow:start -->` marker appears in CLAUDE.md for detected profiles, and is absent for null profiles

## Interface Contracts

- **Import**: `ProjectProfile`, `PackageEntry` @ `src/modules/project-profile/types.ts` (from story 37-1)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All 4 tasks completed successfully
- 31 unit tests pass for `buildStackAwareDevNotes`
- 3 integration tests pass for CLAUDE.md generation with profile
- Full test suite: 246 test files, 5882 tests, all passing
- Note: `'pnpm run build'` contains `'npm run build'` as a substring; tests use backtick-delimited string matching for precision

### File List
- `src/cli/templates/build-dev-notes.ts` (new)
- `src/cli/templates/__tests__/build-dev-notes.test.ts` (new)
- `src/cli/commands/__tests__/init-claude-md.test.ts` (new)
- `src/cli/commands/init.ts` (modified — scaffoldClaudeMd signature + call site)

## Change Log
