# Story 14.2: Depend on bmad-method Instead of Bundling BMAD

Status: draft

## Story

As a maintainer of Substrate,
I want to consume `bmad-method` as an npm dependency instead of committing a copy of the BMAD framework into the repo,
so that BMAD upgrades are a version bump (not a re-install), licensing attribution is explicit, and the repo stays lean.

## Background

The project currently has two BMAD-related directories:

- **`_bmad/`** — A committed copy of `bmad-method` (installed via `npx bmad-method@latest install`). Contains the full BMAD framework: `core/tasks/workflow.xml`, `bmm/workflows/`, agents, IDE configs, etc. Used by BMAD orchestration commands (`/bmad-auto-implement`, etc.) that load `workflow.xml` and follow `workflow.yaml` configs. **~260 files, not shipped with npm.**

- **`packs/bmad/`** — Substrate's own compiled methodology pack. Contains 8 prompt templates, 3 constraint files, and 1 story template with `{{placeholder}}` syntax for Substrate's compiled pipeline system. These are **original Substrate code**, not copies of bmad-method content. **Ships with npm, scaffolded into user projects via `substrate auto init`.**

This story addresses `_bmad/` — making `bmad-method` a proper dependency so the framework resolves from `node_modules` instead of being a committed copy. The compiled pack (`packs/bmad/`) is unaffected — it's Substrate's own code and stays.

## Acceptance Criteria

### AC1: bmad-method Declared as Dependency
**Given** the Substrate package.json
**When** a user installs `substrate-ai`
**Then** `bmad-method` is listed in `dependencies` (not devDependencies)
**And** the BMAD framework files are available at `node_modules/bmad-method/src/`

### AC2: BMAD Framework Resolves from node_modules
**Given** the orchestration commands reference `{project-root}/_bmad/` paths
**When** `_bmad/` does not exist locally (fresh clone, CI, etc.)
**Then** paths like `{project-root}/_bmad/core/tasks/workflow.xml` resolve to `node_modules/bmad-method/src/core/tasks/workflow.xml`
**And** the resolution is transparent to sub-agents — they receive resolved absolute paths

### AC3: Auto Init Installs BMAD Framework
**Given** a user runs `substrate auto init` in a project without `_bmad/`
**When** `bmad-method` is available in node_modules
**Then** the BMAD framework is scaffolded from `node_modules/bmad-method/src/` into `<projectRoot>/_bmad/`
**And** this is logged: "Scaffolding BMAD framework from bmad-method@<version>"
**And** the scaffolding step runs before pack scaffolding (existing behavior)

### AC4: Existing Local _bmad/ Not Overwritten
**Given** a user has a customized `_bmad/` directory (e.g., modified workflow configs)
**When** they run `substrate auto init`
**Then** the existing `_bmad/` is NOT overwritten
**And** `--force` replaces it with the bundled version (with warning)

### AC5: _bmad/ Removed from Substrate Git History
**Given** `bmad-method` is a dependency
**When** inspecting the Substrate repo
**Then** `_bmad/` is listed in `.gitignore`
**And** the committed `_bmad/` directory is removed from tracking
**And** a comment in `.gitignore` explains: `# Installed from bmad-method dependency — run 'substrate auto init' to populate`

### AC6: BMAD Version Accessible at Runtime
**Given** `bmad-method` is installed as a dependency
**When** Substrate reports its version or diagnostics
**Then** the installed `bmad-method` version is resolvable (e.g., via `npm ls bmad-method` or reading its package.json)
**And** `substrate auto init` logs which version it scaffolded from

### AC7: Compiled Pack Unchanged
**Given** the compiled pack at `packs/bmad/` is Substrate-original code
**When** this story is implemented
**Then** `packs/bmad/` content, scaffolding behavior, and npm distribution are unchanged
**And** the pack loader, pack interface, and all downstream consumers are unaffected

### AC8: All Existing Tests Pass
**Given** the refactored resolution logic
**When** the full test suite runs
**Then** all existing tests pass with updated paths
**And** new tests cover node_modules resolution and fallback
**And** coverage remains at or above 80%

## Dev Notes

### Architecture

The BMAD framework (`_bmad/`) is used exclusively by the orchestration layer — specifically the sub-agent prompts in `bmad-commands/` that tell agents to "LOAD {project-root}/_bmad/core/tasks/workflow.xml". The compiled pipeline (`packs/bmad/`) is a separate system that doesn't use `_bmad/` at runtime.

Two resolution strategies are needed:

1. **For `substrate auto init`**: Copy from `node_modules/bmad-method/src/` → `<projectRoot>/_bmad/` (same pattern as pack scaffolding)
2. **For orchestration commands**: Sub-agent prompts use `{project-root}/_bmad/` paths. After scaffolding, these resolve normally. For development (where `_bmad/` might not be scaffolded), resolve from `node_modules/bmad-method/src/` as fallback.

### Path Mapping

| Local path | node_modules equivalent |
|---|---|
| `_bmad/core/` | `node_modules/bmad-method/src/core/` |
| `_bmad/bmm/` | `node_modules/bmad-method/src/bmm/` |
| `_bmad/tea/` | `node_modules/bmad-method/src/tea/` |

The `_bmad/_config/` and `_bmad/_memory/` directories are **local state** created by the BMAD installer and should NOT come from node_modules. These are project-specific (user name, language prefs, etc.) and should be generated during `auto init`.

### Key Changes

1. **`package.json`** — Add `"bmad-method": "^6.0.3"` to dependencies
2. **`src/cli/commands/auto.ts`** — Add BMAD framework scaffolding step (resolve from node_modules, copy `src/` to `_bmad/`)
3. **`.gitignore`** — Add `_bmad/` with explanatory comment
4. **Remove `_bmad/`** — `git rm -r _bmad/` (content now comes from dependency)
5. **`bmad-commands/`** — Audit all sub-agent prompts that reference `{project-root}/_bmad/` to ensure they work with scaffolded paths

### What Does NOT Change

- `packs/bmad/` — Substrate's compiled pack (stays, ships with npm)
- `src/modules/methodology-pack/` — Pack loader and types
- `src/modules/compiled-workflows/` — Compiled pipeline system
- User-facing `substrate auto init` behavior for pack scaffolding
- Test infrastructure (mocks for pack loading)

### bmad-method Install vs Substrate Scaffolding

`npx bmad-method install` runs an interactive installer that detects IDEs, generates configs, and sets up project-specific state. Substrate's scaffolding should NOT replicate this — it should:
- Copy `src/core/`, `src/bmm/`, `src/tea/` from node_modules (the framework itself)
- Generate minimal `_config/` and `_memory/` stubs if they don't exist
- Skip IDE-specific setup (Substrate has its own CLI/config system)

This is simpler and more predictable than delegating to bmad-method's installer.

## Tasks

- [ ] Task 1: Add `bmad-method` to dependencies in package.json (AC: #1)
- [ ] Task 2: Implement BMAD framework scaffolding in `auto.ts` — resolve from `node_modules/bmad-method/src/`, copy to `<projectRoot>/_bmad/` (AC: #2, #3, #4)
  - [ ] Resolve bmad-method package path via `import.meta.resolve` or `require.resolve`
  - [ ] Copy `src/core/`, `src/bmm/`, `src/tea/` to `_bmad/`
  - [ ] Generate minimal `_config/config.yaml` stub if missing
  - [ ] Respect existing `_bmad/` (skip unless `--force`)
  - [ ] Log version scaffolded from
- [ ] Task 3: Add `_bmad/` to `.gitignore` and `git rm -r _bmad/` (AC: #5)
- [ ] Task 4: Audit `bmad-commands/` prompts for `{project-root}/_bmad/` references — ensure they resolve after scaffolding (AC: #2)
- [ ] Task 5: Write unit tests for BMAD framework scaffolding (AC: #8)
- [ ] Task 6: Write integration test — full auto init in temp dir scaffolds both framework and pack (AC: #8)
- [ ] Task 7: Verify `npm pack --dry-run` does not include `_bmad/` (AC: #5)
- [ ] Task 8: Update MEMORY.md if needed to reflect new BMAD resolution pattern
