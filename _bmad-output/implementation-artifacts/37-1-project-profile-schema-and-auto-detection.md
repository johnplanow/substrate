# Story 37-1: Project Profile Schema & Auto-Detection

## Story

As a developer using substrate on a polyglot or monorepo project,
I want substrate to auto-detect my project's language stack and generate a structured project profile,
so that downstream pipeline components (build gate, contract verifier, test patterns, compiled workflows) can be configured correctly without manual intervention.

## Acceptance Criteria

### AC1: ProjectProfile TypeScript Schema
**Given** the `src/modules/project-profile/` module exists
**When** any downstream consumer imports from it
**Then** it exports a fully-typed `ProjectProfile` interface, a Zod schema `ProjectProfileSchema` for validation, and a `PackageEntry` type representing a single package in a monorepo — covering all fields in the `.substrate/project-profile.yaml` specification

### AC2: Single-Project Stack Detection
**Given** a project root with a recognized build system marker (one of: `go.mod`, `build.gradle.kts`, `build.gradle`, `pom.xml`, `Cargo.toml`, `pyproject.toml`, `package.json`)
**When** `detectProjectProfile(rootDir)` is called
**Then** a `ProjectProfile` is returned with `project.type = 'single'`, the correct `language`, `buildTool`, `buildCommand`, and `testCommand` populated for the detected stack

### AC3: Turborepo Monorepo Detection
**Given** a project root containing `turbo.json`
**When** `detectProjectProfile(rootDir)` is called
**Then** a `ProjectProfile` is returned with `project.type = 'monorepo'`, `project.tool = 'turborepo'`, `project.buildCommand = 'turbo build'`, and `project.testCommand = 'turbo test'`

### AC4: Per-Package Stack Enumeration in Monorepo
**Given** a Turborepo monorepo with packages under `apps/*/` and `packages/*/`
**When** `detectProjectProfile(rootDir)` is called
**Then** the returned profile's `packages` array contains one entry per discovered package directory, with each entry's `language` and `buildTool` resolved from the package-level build file markers

### AC5: YAML Override File Loading
**Given** a `.substrate/project-profile.yaml` file exists at the project root
**When** `loadProjectProfile(rootDir)` is called
**Then** the YAML content is parsed and validated against `ProjectProfileSchema`, the parsed profile is returned, and any Zod validation error causes the function to throw with a descriptive message identifying the offending field

### AC6: Auto-Detection Fallback
**Given** no `.substrate/project-profile.yaml` file exists at the project root
**When** `loadProjectProfile(rootDir)` is called
**Then** `detectProjectProfile(rootDir)` is called automatically and its result is returned (the profile is NOT written to disk — detection is in-memory only)

### AC7: Backward Compatibility for Node.js Projects
**Given** an existing Node.js project with `package.json` at the root and no `turbo.json`
**When** `loadProjectProfile(rootDir)` is called
**Then** a valid `ProjectProfile` is returned with `project.type = 'single'`, `language = 'typescript'` (or `'javascript'`), `buildTool = 'npm'` (or `pnpm`/`yarn`/`bun` per lock file), and the behavior of downstream consumers that previously worked is unchanged

## Tasks / Subtasks

- [x] Task 1: Create module skeleton and TypeScript types (AC: #1)
  - [x] Create directory `src/modules/project-profile/`
  - [x] Create `src/modules/project-profile/types.ts` — define `Language` union (`'typescript' | 'javascript' | 'go' | 'java' | 'kotlin' | 'rust' | 'python'`), `BuildTool` union, `PackageEntry` interface, and `ProjectProfile` interface
  - [x] Create `src/modules/project-profile/schema.ts` — define `PackageEntrySchema` and `ProjectProfileSchema` using Zod; import from `'zod'`
  - [x] Ensure all fields have proper optional/required markers matching the YAML spec from the epic doc

- [x] Task 2: Implement single-project stack detection (AC: #2, #7)
  - [x] Create `src/modules/project-profile/detect.ts`
  - [x] Define `STACK_MARKERS` constant — ordered array of `{ file, language, buildTool, buildCommand, testCommand }` entries for: `go.mod`, `build.gradle.kts`, `build.gradle`, `pom.xml`, `Cargo.toml`, `pyproject.toml`, `package.json`
  - [x] Implement `detectSingleProjectStack(dir: string): Promise<PackageEntry>` — iterates `STACK_MARKERS`, calls `fs.access()` per marker file, returns first match; falls back to `language: 'typescript', buildTool: 'npm'` if nothing found
  - [x] For `package.json` detection: read lock file markers (`package-lock.json` → npm, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb` → bun) to set `buildTool` accurately — mirrors existing `detectPackageManager()` logic from `dispatcher-impl.ts`
  - [x] For `pyproject.toml`: check if `poetry.lock` exists alongside it to set `buildTool = 'poetry'`; otherwise `buildTool = 'pip'`

- [x] Task 3: Implement Turborepo monorepo detection (AC: #3, #4)
  - [x] In `detect.ts`, add `detectMonorepoProfile(rootDir: string): Promise<ProjectProfile | null>` — returns `null` if no `turbo.json` found
  - [x] Parse `turbo.json` JSON to detect both Turborepo v1 (`pipeline` key) and v2 (`tasks` key) formats; set `project.tool = 'turborepo'` regardless of version
  - [x] Enumerate package directories: scan `apps/*/` and `packages/*/` using `fs.readdir()` with `{ withFileTypes: true }`, filter to directories
  - [x] For each package directory, call `detectSingleProjectStack(pkgDir)` and set `path` to the relative path (e.g., `apps/lock-service`)
  - [x] Assemble `ProjectProfile` with `type: 'monorepo'`, `tool: 'turborepo'`, `buildCommand: 'turbo build'`, `testCommand: 'turbo test'`, and populated `packages` array

- [x] Task 4: Implement `detectProjectProfile()` top-level function (AC: #2, #3, #4, #7)
  - [x] Add `export async function detectProjectProfile(rootDir: string): Promise<ProjectProfile>` to `detect.ts`
  - [x] First call `detectMonorepoProfile(rootDir)`; if non-null, return monorepo profile
  - [x] Otherwise call `detectSingleProjectStack(rootDir)` and wrap result into a `ProjectProfile` with `type: 'single'`, `tool: null`, `buildCommand` and `testCommand` from the detected stack entry, `packages: []`

- [x] Task 5: Implement `loadProjectProfile()` with YAML override (AC: #5, #6)
  - [x] Create `src/modules/project-profile/loader.ts`
  - [x] Import `yaml` from `'js-yaml'` and `ProjectProfileSchema` from `'./schema.js'`
  - [x] Export `async function loadProjectProfile(rootDir: string): Promise<ProjectProfile>`
  - [x] Check for `.substrate/project-profile.yaml` via `fs.access()`; if missing, call and return `detectProjectProfile(rootDir)`
  - [x] If found: read file content, parse with `yaml.load()`, validate with `ProjectProfileSchema.parse()`, return validated object; catch Zod errors and rethrow with message `'Invalid .substrate/project-profile.yaml: <ZodError.message>'`

- [x] Task 6: Create barrel index (AC: #1)
  - [x] Create `src/modules/project-profile/index.ts` — re-export `ProjectProfile`, `PackageEntry`, `Language`, `BuildTool` from `./types.js`; re-export `ProjectProfileSchema`, `PackageEntrySchema` from `./schema.js`; re-export `detectProjectProfile` from `./detect.js`; re-export `loadProjectProfile` from `./loader.js`

- [x] Task 7: Write unit tests (AC: #1–#7)
  - [x] Create `src/modules/project-profile/__tests__/detect.test.ts`
  - [x] Use `vi.mock('node:fs/promises', ...)` (or `vi.spyOn`) to control which marker files appear to exist — avoids real filesystem side effects
  - [x] Test single-project detection: `go.mod` present → `language: 'go'`; `package.json` + `pnpm-lock.yaml` → `buildTool: 'pnpm'`; no markers → fallback typescript/npm
  - [x] Test monorepo detection: `turbo.json` present + `apps/web/package.json` + `apps/lock-service/go.mod` → `type: 'monorepo'`, two package entries with correct languages
  - [x] Test `turbo.json` v1 (`pipeline`) and v2 (`tasks`) both detected as turborepo
  - [x] Create `src/modules/project-profile/__tests__/loader.test.ts`
  - [x] Test YAML override path: valid YAML → parsed profile returned; invalid YAML (fails Zod) → throws with descriptive message
  - [x] Test fallback path: no YAML file → `detectProjectProfile` called (mock it); result returned
  - [x] Run `npm run build` — must exit 0; run `npm run test:fast` — confirm "Test Files" summary, all passing

- [x] Task 8: Build and validate (AC: all)
  - [x] Run `npm run build` — zero TypeScript errors
  - [x] Run `npm run test:fast` — do NOT pipe output; confirm raw output contains "Test Files" and all tests pass

## Dev Notes

### Architecture Constraints

- **New directory to create**: `src/modules/project-profile/`
- **New files to create**:
  - `src/modules/project-profile/types.ts` — TypeScript interfaces and union types
  - `src/modules/project-profile/schema.ts` — Zod validation schemas
  - `src/modules/project-profile/detect.ts` — auto-detection logic
  - `src/modules/project-profile/loader.ts` — YAML override + fallback entry point
  - `src/modules/project-profile/index.ts` — barrel re-exports
  - `src/modules/project-profile/__tests__/detect.test.ts`
  - `src/modules/project-profile/__tests__/loader.test.ts`
- **No files to modify in this story** — 37-1 is purely additive. Downstream stories (37-2 through 37-7) will import from this module.

- **Import style**: All local imports use `.js` extension (ESM project):
  ```typescript
  import { detectProjectProfile } from '../../modules/project-profile/index.js'
  import yaml from 'js-yaml'
  import { z } from 'zod'
  import * as fs from 'node:fs/promises'
  ```

- **Test framework**: Vitest — use `describe`, `it`, `expect`, `vi`, `beforeEach`. Do NOT use Jest APIs.
- **YAML library**: `js-yaml` — already a project dependency. Import as `import yaml from 'js-yaml'`.
- **Zod**: Already a project dependency. Import as `import { z } from 'zod'`.

### Stack Marker Priority Order

Detection checks markers in this order (first match wins at the single-project level):

| Priority | Marker File | Language | Build Tool | Build Command | Test Command |
|---|---|---|---|---|---|
| 1 | `go.mod` | `go` | `go` | `go build ./...` | `go test ./...` |
| 2 | `build.gradle.kts` | `kotlin` | `gradle` | `./gradlew build` | `./gradlew test` |
| 3 | `build.gradle` | `java` | `gradle` | `./gradlew build` | `./gradlew test` |
| 4 | `pom.xml` | `java` | `maven` | `mvn compile` | `mvn test` |
| 5 | `Cargo.toml` | `rust` | `cargo` | `cargo build` | `cargo test` |
| 6 | `pyproject.toml` | `python` | `poetry`/`pip` | `poetry build`/`pip install -e .` | `pytest` |
| 7 | `package.json` | `typescript` | npm/pnpm/yarn/bun | (lock-file based) | (lock-file based) |

For `package.json`, derive `buildTool` from lock file presence: `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, `bun.lockb` → `bun`, `package-lock.json` or fallback → `npm`.

### ProjectProfile Interface Shape

```typescript
export interface PackageEntry {
  path: string            // relative to project root, e.g. "apps/lock-service"
  language: Language
  buildTool?: BuildTool
  framework?: string      // e.g. "nextjs", "node"
  tools?: string[]        // e.g. ["prisma", "flyway"]
  buildCommand?: string   // per-package override; monorepo uses root turbo build
  testCommand?: string    // per-package override
}

export interface ProjectProfile {
  project: {
    type: 'single' | 'monorepo'
    tool?: 'turborepo' | null
    buildCommand: string
    testCommand: string
    packages?: PackageEntry[]
  }
}
```

### Turborepo Version Compatibility

`turbo.json` differs between v1 and v2:
- v1: top-level `pipeline` key
- v2: top-level `tasks` key

The detection only needs to confirm `turbo.json` exists and is parseable JSON — the build command is always `turbo build` regardless of version. Attempting to parse the JSON is optional; if parse fails, still treat as Turborepo monorepo (conservative).

### Testing Requirements

- Use `vi.mock('node:fs/promises')` or `vi.spyOn(fs, 'access')` / `vi.spyOn(fs, 'readdir')` etc. to mock filesystem — do NOT create real temp directories
- Zod validation test: construct an object with a missing required field (e.g., no `project.type`) and assert the loader throws with a message containing `'Invalid .substrate/project-profile.yaml'`
- Coverage threshold: 80% (enforced by vitest config)
- Run `npm run test:fast` during development — raw output only, never pipe

## Interface Contracts

- **Export**: `ProjectProfile` @ `src/modules/project-profile/index.ts` (consumed by stories 37-2, 37-3, 37-4, 37-5, 37-6, 37-7)
- **Export**: `PackageEntry` @ `src/modules/project-profile/index.ts` (consumed by stories 37-3, 37-5, 37-6)
- **Export**: `loadProjectProfile` @ `src/modules/project-profile/index.ts` (consumed by stories 37-2, 37-3, 37-4, 37-5)
- **Export**: `detectProjectProfile` @ `src/modules/project-profile/index.ts` (consumed by story 37-2)
- **Export**: `ProjectProfileSchema` @ `src/modules/project-profile/index.ts` (consumed by story 37-2 for init command validation)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
