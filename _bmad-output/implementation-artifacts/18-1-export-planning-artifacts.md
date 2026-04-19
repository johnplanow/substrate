# Story 18.1: Export Planning Artifacts from Decision Store

Status: backlog

## Story

As a user who has run the substrate pipeline through planning and solutioning,
I want to export the decision store contents as human-readable markdown files,
so that I can share planning artifacts with colleagues for review without requiring database access.

## Context

The pipeline stores all analysis, planning, and solutioning output in the SQLite decision store (`.substrate/substrate.db`). This is great for structured querying and phase-to-phase data flow, but it means there are no human-readable files to share after the pre-implementation phases complete.

The implementation phase already knows how to _read_ these artifact shapes — `seedMethodologyContext()` in `src/modules/implementation-orchestrator/seed-methodology-context.ts` reads `architecture.md` and `epics.md` from `_bmad-output/planning-artifacts/`. The export command closes the loop by _writing_ those same files from the decision store.

Existing formatters that should be reused or extracted:
- `formatProductBriefFromDecisions()` in `src/modules/phase-orchestrator/phases/planning.ts`
- `formatRequirements()` in `src/modules/phase-orchestrator/phases/solutioning.ts`
- `formatArchitectureDecisions()` in `src/modules/phase-orchestrator/phases/solutioning.ts`
- `formatDecisionsForInjection()` in `src/modules/phase-orchestrator/step-runner.ts`

Decision store query API in `src/persistence/queries/decisions.ts`:
- `getDecisionsByPhaseForRun(db, runId, phase)`
- `getArtifactByTypeForRun(db, runId, phase, type)`
- Requirements: `listRequirements(db, filters?)`

### Data inventory (real project example)

| Phase | Category | Count | Total bytes |
|-------|----------|-------|-------------|
| analysis | product-brief | 5 | 10,837 |
| analysis | technology-constraints | 1 | 780 |
| planning | classification | 3 | 1,593 |
| planning | functional-requirements | 15 | 4,006 |
| planning | non-functional-requirements | 12 | 3,129 |
| planning | domain-model | 1 | 5,819 |
| planning | user-stories | 18 | 5,829 |
| planning | tech-stack | 1 | 2,180 |
| planning | out-of-scope | 1 | 1,826 |
| solutioning | architecture | 66 | 52,772 |
| solutioning | epics | 12 | 4,204 |
| solutioning | stories | 95 | 115,640 |
| solutioning | readiness-findings | 18 | 7,489 |
| requirements table | functional | 52 | 23,295 |
| requirements table | non_functional | 12 | 2,618 |

## Acceptance Criteria

### AC1: Export Command Registration
**Given** substrate is installed
**When** the user runs `substrate export --help`
**Then** the command is registered with options:
  - `--run-id <id>` (optional, defaults to latest run)
  - `--output-dir <path>` (optional, defaults to `_bmad-output/planning-artifacts/`)
  - `--project-root <path>` (optional, defaults to cwd)
  - `--output-format <format>` (human or json, default human)
**And** the command appears in `substrate --help` output

### AC2: Product Brief Export
**Given** the decision store has analysis-phase decisions
**When** `substrate export` runs
**Then** it writes `product-brief.md` containing:
  - Problem statement
  - Target users
  - Core features (as bulleted list)
  - Success metrics (as bulleted list)
  - Constraints (as bulleted list)
  - Technology constraints (as bulleted list)

### AC3: PRD Export
**Given** the decision store has planning-phase decisions
**When** `substrate export` runs
**Then** it writes `prd.md` containing:
  - Project classification (type, vision, key goals)
  - Functional requirements (with FR IDs and priority)
  - Non-functional requirements (with NFR IDs and category)
  - Domain model
  - User stories
  - Tech stack decisions
  - Out-of-scope items

### AC4: Architecture Export
**Given** the decision store has solutioning-phase architecture decisions
**When** `substrate export` runs
**Then** it writes `architecture.md` containing:
  - All architecture decisions grouped logically (ADRs, tech-stack, components, project structure, API design, etc.)
  - Each decision formatted as `**key**: value` with rationale where present
**And** the file is consumable by `seedMethodologyContext()` (same format it expects to read)

### AC5: Epics and Stories Export
**Given** the decision store has solutioning-phase epic and story decisions
**When** `substrate export` runs
**Then** it writes `epics.md` containing:
  - Each epic as an H2 heading with title and description
  - Stories listed under their parent epic with key, title, acceptance criteria, and priority
**And** the file is consumable by `seedMethodologyContext()` (parsed by "## Epic N" headings)

### AC6: Readiness Findings Export
**Given** the decision store has readiness-findings decisions
**When** `substrate export` runs
**Then** it writes `readiness-report.md` containing:
  - Readiness findings grouped by category
  - Pass/fail verdict if available

### AC7: JSON Output Format
**Given** the user passes `--output-format json`
**When** `substrate export` runs
**Then** stdout emits a JSON object with:
  - `files_written: string[]` — paths of all exported files
  - `run_id: string` — the pipeline run that was exported
  - `phases_exported: string[]` — which phases had data

### AC8: Idempotent Overwrite
**Given** export files already exist in the output directory
**When** `substrate export` runs again
**Then** files are overwritten with the latest decision store contents
**And** a human-readable message confirms which files were written

### AC9: Graceful Handling of Missing Phases
**Given** the pipeline was stopped after planning (no solutioning decisions)
**When** `substrate export` runs
**Then** it exports only the phases that have data (product-brief.md, prd.md)
**And** skips architecture.md and epics.md without error
**And** reports which files were written and which phases had no data

## Dev Notes

- Register command in `src/cli/index.ts` following the pattern of other top-level commands
- Create `src/cli/commands/export.ts` for the command implementation
- Extract/reuse the existing formatters from planning.ts and solutioning.ts (may need to make them exported rather than module-private)
- The decision `value` field stores stringified JSON for arrays/objects — always `JSON.parse()` before rendering
- Architecture decisions use key-value pairs; stories use structured JSON objects with title, description, AC arrays
- Output format should match what `seedMethodologyContext()` expects to read back — this is the round-trip contract

## Tasks

- [ ] Register `substrate export` command in CLI index
- [ ] Create `src/cli/commands/export.ts` with command options
- [ ] Extract formatters from planning.ts/solutioning.ts into shared module (or make them exported)
- [ ] Implement product-brief renderer (analysis decisions → markdown)
- [ ] Implement PRD renderer (planning decisions + requirements table → markdown)
- [ ] Implement architecture renderer (solutioning/architecture decisions → markdown)
- [ ] Implement epics renderer (solutioning/epics + stories decisions → markdown matching seedMethodologyContext format)
- [ ] Implement readiness report renderer
- [ ] Add JSON output format support
- [ ] Add tests for each renderer
- [ ] Add integration test: write decisions → export → verify markdown output
- [ ] Add integration test: export → seedMethodologyContext round-trip (exported files are parseable by implementation phase)
