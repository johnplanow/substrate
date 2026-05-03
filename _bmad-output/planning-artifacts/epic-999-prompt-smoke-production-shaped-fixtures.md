# Smoke Fixture: Plural-State Shape AC for obs_018 (Production-Shaped Fixtures)

**Purpose:** Empirical smoke fixture used by `.claude/commands/ship.md` Step 4.5 (prompt-edit empirical smoke) to validate that substrate's `create-story` prompt produces probes whose `command:` fixture exercises **≥2 distinct resources** when the AC names a plural state shape.

**Failure shapes covered:**

- **obs_2026-05-02_018 (production-shaped fixtures)** — when an AC describes integration with a *collection* of real-state resources (fleet of repos, set of files, list of services, multiple registry rows), the rendered story's `## Runtime Probes` section should include a `command:` block whose fixture setup populates ≥2 distinct, non-overlapping instances. A single-resource fixture would silently pass against multi-resource production state, masking defects whose failure mode only surfaces under multiplicity (wrong-cwd-with-N-children, substring-collision attribution, etc.). Strata Story 2-4's `fetchGitLog` cwd=fleetRoot defect is the canonical example.

**Lifecycle:** the smoke step ingests this epic and dispatches Story 999-2, then cleans up both the `wg_stories` row and the rendered artifact afterward. The fixture file itself is durable.

**Why a separate fixture from epic-999-prompt-smoke-state-integrating.md:**

The Phase 4 smoke fixture (story `999-1`) covers architectural-level signal recognition (named external dependencies + interaction verbs → probes section authored). obs_018 is orthogonal: probe-fixture *quality* discipline once probes ARE authored. Mixing the two would slow dispatch and complicate assertion. Per the smoke-fixture lesson (minimum-viable scope, not faithful project shape), this fixture has ONE AC describing exactly one plural-state shape so the structural property under test is unambiguous.

---

## Story Map

- 999-2: Production-shaped fixture smoke (P0, Small)

## Story 999-2: Production-shaped fixture smoke

**As a** substrate prompt-edit smoke fixture for production-shaped probe fixtures,
**I want** an acceptance criterion that names a *fleet of repos* as the integration surface,
**So that** obs_2026-05-02_018's prompt fix is empirically validated — the rendered probe must build a fixture with ≥2 distinct repos, not a one-repo tmpdir.

### Acceptance Criteria

#### AC1: Fleet activity scanner reports per-project commit counts

**Given** a daily fleet activity scanner runs against a fleet root that is a parent directory of N project subdirectories (each with its own `.git`)

**When** the scanner runs

**Then** the implementation iterates over **each project** in the fleet and reports `gitCommitsLast3Days` per project, with attribution that does NOT use substring-match (substring match would mis-route a commit message containing one project's name when authored in another project). The probe fixture must populate ≥2 distinct, non-overlapping project subdirs to exercise the per-project attribution path; a one-repo fixture passes the broken substring-match implementation and would not catch the regression.

### Tasks / Subtasks

(Smoke fixture — dev-story dispatch is not the assertion target. The structural assertion is on the rendered story file: presence of `## Runtime Probes` section AND a `command:` block whose fixture setup creates ≥2 distinct resources, e.g., a loop over project names or two distinct `git init` calls.)

- [ ] AC1: scan each project in the fleet root and report per-project commit counts (plural-state-shape phrase)
