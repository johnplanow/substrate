# Smoke Fixture: State-Integrating AC for Prompt-Edit Ships

**Purpose:** Empirical smoke fixture used by `.claude/commands/ship.md` Step 4.5 (prompt-edit empirical smoke) to validate that substrate's `create-story` prompt produces the structural property the prompt change targets.

**Failure shapes covered:**

- **obs_2026-05-01_017 Phase 4 (architectural-level signals)** — rendered story should contain a `## Runtime Probes` section AND `external_state_dependencies` frontmatter when the AC text uses architectural-level phrasing (named external dependencies + interaction verbs) WITHOUT raw code-API mentions like `fetch` or `execSync`. This is the exact failure shape strata Story 2-7 surfaced under v0.20.43.

**Lifecycle:** the smoke step ingests this epic and dispatches Story 999-1, then cleans up both the `wg_stories` row and the rendered artifact afterward. The fixture file itself is durable.

**Why ONLY architectural ACs (no code-API mentions):**

The prior fixture version included 5 code-API ACs + 2 architectural ACs (7 total). That fixture took >30 min to dispatch with `--max-review-cycles 1` because dev-story is implementing 7 distinct integrations. Smoke validation needs minimum-viable scope, not faithful project shape — hence this version trims to ONLY the architectural ACs (2). The code-API path was already empirically proven by the v0.20.43 smoke run (commit `634b6d2`); Phase 4 only needs to prove the architectural path produces the same structural output.

If a future prompt-edit ship needs code-API coverage, author a sibling fixture (`epic-999-prompt-smoke-code-api.md`) with the code-API ACs.

---

## Story Map

- 999-1: Architectural-level state integration smoke (P0, Small)

## Story 999-1: Architectural-level state integration smoke

**As a** substrate prompt-edit smoke fixture for architectural-level signals,
**I want** acceptance criteria phrased at the architectural abstraction level (named external dependencies + interaction verbs) WITHOUT raw code-API mentions,
**So that** Phase 4 of the obs_2026-05-01_017 fix-out is empirically validated — the prompt produces a probes section and frontmatter declaration even when the AC never says `fetch`, `execSync`, `fs.readFile`, etc.

### Acceptance Criteria

#### AC1: Briefing queries agent-mesh's query-reports skill

**Given** the briefing pipeline runs against the local agent-mesh

**When** today's run gathers signals

**Then** the implementation queries agent-mesh's `query-reports` skill via `MeshClient` to fetch the daily `RunReport` / `VisionFinding` / `ConflictAudit` records, with graceful degradation when the mesh is unreachable. (Architectural phrase — names the agent and the skill, no raw `fetch` or `axios`.)

#### AC2: Generated briefing is published via the mesh outbox

**Given** the briefing markdown is finalized

**When** publication runs

**Then** the implementation publishes a `MorningBriefing` mesh record via packages/mesh-agent's outbox using the existing `MeshClient` surface, and a smoke check confirms the outbox file under the mesh-agent's writable directory grew by exactly one record. (Architectural phrase — names the package and the outbox surface, no raw `fs.writeFile`.)

### Tasks / Subtasks

(Smoke fixture — dev-story dispatch is not the assertion target. The structural assertion is on the rendered story file: presence of `## Runtime Probes` section and `external_state_dependencies` frontmatter.)

- [ ] AC1: query agent-mesh's `query-reports` skill via `MeshClient` (architectural phrase)
- [ ] AC2: publish `MorningBriefing` mesh record via packages/mesh-agent's outbox (architectural phrase)
