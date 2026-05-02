# Smoke Fixture: State-Integrating AC for Prompt-Edit Ships

**Purpose:** Empirical smoke fixture used by `.claude/commands/ship.md` Step 4.5 (prompt-edit empirical smoke) to validate that substrate's `create-story` prompt produces the structural property the prompt change targets.

**Failure shapes covered:**

- **obs_2026-05-01_017 Phase 1** — rendered story should contain a `## Runtime Probes` section because Story 999-1's AC has wall-to-wall state-integration signals (subprocess, filesystem, git, database, network).
- **obs_2026-05-01_017 Phase 2** — rendered story should also have an `external_state_dependencies` frontmatter field populated with the matching categories.

**Not covered (file new fixtures for these):**

- Event-driven AC heuristic (obs_2026-04-26_014, obs_2026-04-27_016).
- Probe-author dispatch (Epic 60 Phase 2).
- Future prompt-edit shapes — author a sibling fixture at `_bmad-output/test-fixtures/prompt-smoke-<shape>-epic.md`.

**Lifecycle:** the smoke step ingests this epic and dispatches Story 999-1, then cleans up both the `wg_stories` row and the rendered artifact afterward. The fixture file itself is durable.

---

## Story Map

- 999-1: Briefing CLI smoke against real fleet state (P0, Small)

## Story 999-1: Briefing CLI smoke against real fleet state

**As a** substrate prompt-edit smoke fixture,
**I want** an acceptance criteria set with high-density state-integration signals,
**So that** create-story prompt revisions are validated empirically before publish.

### Acceptance Criteria

#### AC1: Fleet config is read from disk

**Given** the briefing CLI is invoked

**When** initialization runs

**Then** the CLI reads `~/.config/strata/fleet.yaml` via `fs.readFile`, parses the YAML payload, and validates the resulting `projects: []` against a Zod schema before continuing.

#### AC2: Per-project git operations resolve commit history

**Given** the parsed fleet contains N projects

**When** the CLI iterates each project

**Then** it runs `execSync('git log --since=3.days.ago --oneline --all', { cwd: project.path })` for each, parses commit-line output, and collects per-project commit counts.

#### AC3: Prior-run deduplication queries Dolt

**Given** the briefing pipeline has shipped briefings on prior days

**When** today's run executes

**Then** the CLI queries the local Dolt server via mysql2: `SELECT briefing_id, generated_at FROM briefings WHERE generated_at >= NOW() - INTERVAL 7 DAY` and skips projects whose latest briefing falls within the dedupe window.

#### AC4: Briefing payload is POSTed to a webhook

**Given** webhook delivery is enabled in `~/.config/strata/fleet.yaml`

**When** the briefing markdown is rendered

**Then** the CLI uses `fetch(webhookUrl, { method: 'POST', body: JSON.stringify({ markdown, generated_at }) })` and asserts a 2xx response.

#### AC5: Rendered briefing is written to the vault

**Given** an Obsidian vault path resolves to `<vault>/Journal/<yyyy-mm-dd>.md`

**When** the briefing markdown is finalized

**Then** the CLI calls `fs.writeFile(notePath, briefingMarkdown)` against a host path outside test tmpdirs, creating parent directories as needed via `fs.mkdir({ recursive: true })`.

### Tasks / Subtasks

(Smoke fixture — dev-story dispatch is not the assertion target. The structural assertion is on the rendered story file: presence of `## Runtime Probes` section and/or `external_state_dependencies` frontmatter, depending on the prompt-edit shape under test.)

- [ ] AC1: Read + parse fleet.yaml via `fs.readFile`
- [ ] AC2: Per-project `execSync('git log ...')` with `cwd` per project
- [ ] AC3: Dolt query via mysql2 against `briefings` table
- [ ] AC4: `fetch` POST to webhook URL
- [ ] AC5: `fs.writeFile` to vault path with `fs.mkdir` recursive parent creation
