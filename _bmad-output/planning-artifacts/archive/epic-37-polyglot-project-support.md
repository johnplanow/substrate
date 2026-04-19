# Epic 37: Polyglot Project Support

## Problem Statement

Substrate is currently coupled to Node.js/TypeScript projects at multiple layers. This coupling prevents it from orchestrating implementation on projects that use Go, JVM (Gradle/Maven), Python, Rust, or mixed-stack architectures — which describes most real-world software.

**Coupling points identified (v0.6.0 audit):**

1. **Build verification gate** — `detectPackageManager()` in `dispatcher-impl.ts:826` only checks for npm/pnpm/yarn/bun lock files. When none are found, it returns `packageManager: 'none'` and falls back to `DEFAULT_VERIFY_COMMAND = 'npm run build'`, which fails on non-Node projects. The `verifyCommand` config slot exists (Story 24-2) but auto-detection is Node-only.

2. **Contract verifier** — `contract-verifier.ts:86` hardcodes `node_modules/.bin/tsc` for type checking. On non-TypeScript projects, this path doesn't exist and the verifier fails.

3. **Test framework detection** — `seed-methodology-context.ts:374` reads `package.json` for vitest/jest/mocha detection. Returns `undefined` for non-Node projects, so no test patterns are seeded into the decisions table.

4. **Compiled workflow prompts** — `dev-story.ts:43-52` hardcodes `DEFAULT_VITEST_PATTERNS` with vitest commands. `test-plan.ts` and `test-expansion.ts` have similar hardcoding. These get injected when no test-pattern decisions exist — which is always the case for non-Node projects (see point 3).

5. **CLAUDE.md template** — generated during `substrate init`, contains Node.js-specific build/test instructions that sub-agents follow.

6. **Epic shard pipeline** — shards per-epic, not per-story. `MAX_EPIC_SHARD_CHARS = 12_000` can truncate large epics, losing downstream stories. Not strictly a polyglot issue but a cross-project reliability concern that will bite on the ticketing platform's larger epics.

**Impact:** The nextgen ticketing platform (Turborepo monorepo: Next.js + Go + Node.js worker) cannot run Go back-end stories through the pipeline. The pipeline either crashes on build verification or dispatches sub-agents with incorrect Node.js/vitest instructions.

**Primary validation target:** NextGen Ticketing Platform — Turborepo monorepo:
- `apps/web` — Next.js (TypeScript)
- `apps/lock-service` — Go
- `apps/pricing-worker` — Node.js (TypeScript)
- `packages/db` — Prisma + Flyway migrations
- `packages/ui` — shared components
- `packages/config` — tenant config types

## Goals

1. Substrate auto-detects project stack (Node.js, Go, JVM/Gradle, JVM/Maven, Python, Rust) and configures build/test commands accordingly
2. Monorepo support — detect Turborepo structure, enumerate per-package stacks, use `turbo build` from root
3. Sub-agents receive correct build, test, and language instructions for the detected stack
4. Users can override any auto-detected setting via `.substrate/project-profile.yaml`
5. Existing Node.js project behavior is unchanged (backward compatible)

## Non-Goals

- Per-package build isolation (v1 uses `turbo build` from root; per-package routing is v2)
- IDE-specific integrations (e.g., IntelliJ for JVM)
- Language-specific code generation strategies (sub-agents use Claude Code which handles any language)
- Supporting every possible build system — we cover the 80% case and provide escape hatches

## Decisions (resolved in planning session 2026-03-15)

| Question | Decision | Rationale |
|---|---|---|
| Profile storage | `.substrate/project-profile.yaml` (dedicated file) | Separation of concerns, inspectable, git-friendly |
| Monorepo build strategy | Option B — agent-driven. `turbo build` from root, sub-agents handle per-package commands | Turborepo is the abstraction layer; Claude Code agents navigate monorepos naturally |
| Test expansion + test-plan workflows | Included in Story 37-6 as sub-tasks | Same pattern as dev-story fix; must be consistent across all compiled workflows |
| Per-story sharding | Added as Story 37-0 (prerequisite) | Large ticketing epics may exceed 12K char shard limit |
| Monorepo profile schema | Auto-detect from `turbo.json` + per-package build files | `turbo.json` tasks key enumerates packages; combined with `go.mod`/`package.json` per app gives full picture |

## Proposed Approach

### Story 37-0: Per-Story Epic Shard Extraction

Replace per-epic sharding with per-story sharding to eliminate truncation risk for large epics.

**Current behavior:** One decision per epic (key = epicId, e.g. `"3"`), content truncated at 12K chars. `extractStorySection()` in create-story tries to pull target story from the shard, but if the shard was truncated, downstream stories are lost.

**New behavior:** One decision per story (key = storyKey, e.g. `"3-1"`). Parse story headings within each epic section. Downstream `getEpicShard()` queries by storyKey directly instead of epicId + extraction.

**Files:** `src/modules/implementation-orchestrator/seed-methodology-context.ts`, `src/modules/compiled-workflows/create-story.ts`

### Story 37-1: Project Profile Schema & Auto-Detection

Define a project profile that captures stack-specific configuration. Add auto-detection that probes the project root for build system markers, including Turborepo monorepo support.

**Schema (`.substrate/project-profile.yaml`):**
```yaml
project:
  type: monorepo            # or "single"
  tool: turborepo           # or null for non-monorepo
  build_command: "turbo build"
  test_command: "turbo test"
  packages:
    - path: apps/web
      language: typescript
      framework: nextjs
    - path: apps/lock-service
      language: go
    - path: apps/pricing-worker
      language: typescript
      framework: node
    - path: packages/db
      language: typescript
      tools: [prisma, flyway]
```

**Auto-detection logic:**
1. Check for `turbo.json` → monorepo mode, parse `tasks` key for package enumeration
2. Scan `apps/*/` and `packages/*/` for per-package build files
3. For each package, detect stack from markers:

| Marker File | Language | Build Tool | Build Command | Test Command |
|---|---|---|---|---|
| `go.mod` | go | go | `go build ./...` | `go test ./...` |
| `build.gradle.kts` | kotlin | gradle | `./gradlew build` | `./gradlew test` |
| `build.gradle` | java | gradle | `./gradlew build` | `./gradlew test` |
| `pom.xml` | java | maven | `mvn compile` | `mvn test` |
| `Cargo.toml` | rust | cargo | `cargo build` | `cargo test` |
| `pyproject.toml` | python | poetry/pip | `poetry build` / `pip install -e .` | `pytest` |
| `go.mod` | go | go | `go build ./...` | `go test ./...` |
| `package.json` | typescript/javascript | npm/pnpm/yarn | (existing detection) | (existing detection) |

4. For non-monorepo projects, detect single stack at project root

**Files:** New `src/modules/project-profile/project-profile.ts`, `src/modules/project-profile/detect.ts`

### Story 37-2: `substrate init` — Profile Detection & User Confirmation

Update `substrate init` to:
1. Run auto-detection from Story 37-1
2. Display detected stack configuration (including per-package breakdown for monorepos)
3. Allow overrides before writing the profile
4. Write to `.substrate/project-profile.yaml`

**Files:** `src/cli/commands/init.ts`, new profile writer

### Story 37-3: Build Gate — Read Profile, Support Non-Node

Update `runBuildVerification()` and `detectPackageManager()` to:
1. Read `build_command` from `.substrate/project-profile.yaml` (when present)
2. Fall back to existing Node.js lock file detection (backward compat)
3. When no profile exists AND no Node.js lock file found, return `{ status: 'skipped' }` instead of running `npm run build` and failing
4. Support Turborepo: detect `turbo.json` → use `turbo build`
5. Support arbitrary build commands from profile (Go, Gradle, Maven, Cargo, etc.)

**Key change:** The build gate becomes a pass-through for whatever command the profile specifies. It doesn't need to understand the build system — just execute the command and check exit code.

**Files:** `src/modules/agent-dispatch/dispatcher-impl.ts` (detectPackageManager, runBuildVerification)

### Story 37-4: Contract Verifier — Skip tsc for Non-TypeScript

Update the contract verifier to:
1. Read project profile language
2. When language is not TypeScript, skip tsc-based contract verification entirely
3. Return a "skipped" result so downstream logic doesn't treat it as a failure

**Files:** `src/modules/implementation-orchestrator/contract-verifier.ts`

### Story 37-5: Test Pattern Detection — Go, JVM, Python, Rust

Extend `detectTestPatterns()` in `seed-methodology-context.ts` to:
1. Read project profile first (if `test_framework` is set, use it directly)
2. Add detection and pattern generation for:
   - **Go test** — detect `go.mod`, generate Go test patterns (`go test ./...`, table-driven tests, `testify` if present)
   - **JUnit 5** — detect `build.gradle(.kts)` with `junit-jupiter`, generate JUnit patterns (`./gradlew test --tests`, `@Test`, `assertThat`)
   - **pytest** — detect `pyproject.toml` with `[tool.pytest]` or `conftest.py`, generate pytest patterns
   - **Cargo test** — detect `Cargo.toml`, generate Rust test patterns (`cargo test`, `#[test]`, `assert_eq!`)
3. For monorepos, detect per-package and seed decisions with package path context

**Files:** `src/modules/implementation-orchestrator/seed-methodology-context.ts`

### Story 37-6: Compiled Workflow Prompts — Stack-Aware Instructions

Update all three compiled workflows that hardcode vitest patterns:
1. **dev-story.ts** — replace `DEFAULT_VITEST_PATTERNS` with stack-aware default resolver. Read test framework from decisions table. Generate appropriate test/build commands per detected stack.
2. **test-plan.ts** — same pattern: read framework from decisions, generate appropriate test commands
3. **test-expansion.ts** — same pattern

For each framework, generate the equivalent of the vitest patterns block:
- Go: `go test ./... -v -run TestName`, test file conventions (`_test.go`), table-driven test structure
- JUnit: `./gradlew test --tests "ClassName"`, `@Test` annotations, assertion patterns
- pytest: `pytest tests/test_file.py -v -k "test_name"`, fixture patterns
- Cargo: `cargo test module_name`, `#[test]` attribute, assertion macros

**Files:** `src/modules/compiled-workflows/dev-story.ts`, `test-plan.ts`, `test-expansion.ts`

### Story 37-7: CLAUDE.md Template — Monorepo & Stack-Aware Generation

Update the CLAUDE.md template generated by `substrate init` to:
1. Read the project profile
2. For monorepos: document the package structure, per-package stacks, and build commands
3. For single-stack: include stack-appropriate build/test instructions
4. Replace hardcoded Node.js instructions with profile-driven content

**Files:** `src/cli/templates/claude-md-substrate-section.md`, `src/cli/commands/init.ts`

### Story 37-8: NextGen Ticketing Platform Validation Run

Run the ticketing platform's Go back-end stories through the pipeline on macOS:
1. Run `substrate init` on the ticketing platform (verifies Turborepo + Go detection)
2. Inspect generated `.substrate/project-profile.yaml` — confirm monorepo structure, Go lock-service detected
3. Run `substrate run --events --stories <go-lock-service-stories>`
4. Verify:
   - Build gate runs `turbo build` (not `npm run build`)
   - Sub-agent prompts contain Go test patterns (not vitest)
   - Contract verifier skips tsc
   - No Node.js assumptions leak through to Go stories
5. Document any new findings

**Acceptance criteria:**
- At least 2 Go stories complete successfully (SHIP_IT or LGTM_WITH_NOTES)
- Build verification uses `turbo build` from project root
- Sub-agent prompts for Go stories contain `go test` patterns
- `.substrate/project-profile.yaml` correctly enumerates all packages
- No P0 failures related to stack detection

## Dependencies

- **Epic 35 (telemetry scoring v2)** — shipped in v0.6.0
- **Epic 36 (shard P0 fixes)** — already shipped (Story 23-1 "Epic Shard Overhaul" landed the heading regex fix, 12K char limit, and hash-based re-seed)
- NextGen ticketing platform PRD + epics ready for implementation phase (confirmed)
- Development environment: macOS (ticketing platform repo is on mac)

## Effort Estimate

9 items (8 stories + validation), ~2 sprints. Story 37-0 is a prerequisite. Stories 37-1 through 37-3 are foundational and should ship together. Stories 37-4 through 37-7 can be parallelized. Story 37-8 is the validation gate.

**Risk:** Compiled workflow prompts may have additional Node.js assumptions embedded in prompt text beyond the test patterns (e.g., file extension assumptions, import syntax). The validation run (37-8) will surface these.

## Open Questions

1. **Code-review prompt** — The code-review compiled workflow may also have Node.js assumptions in its prompt assembly. Needs audit during implementation — if found, fold fix into 37-6.

2. **Turborepo v1 vs v2** — `turbo.json` schema differs between versions (`pipeline` key in v1 vs `tasks` key in v2). Auto-detection should handle both.
