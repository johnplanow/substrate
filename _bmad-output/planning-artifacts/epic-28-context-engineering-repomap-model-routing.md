# Epic 28: Context Engineering — Repo-Map + Model Routing

## Vision

Close the feedback loop between observability (Epic 27) and agent behavior. Build a persistent, tree-sitter-based repo-map that gives agents structural knowledge of the codebase without re-exploring it from scratch every turn. Implement model routing so 90% of exploration tokens go to cheap models and expensive models are reserved for code generation. Use telemetry data from Epic 27 to measure actual savings and continuously optimize routing decisions.

Source: Integrated Synthesis report findings on Aider's repo-map (10-100x smaller than full file contents), model routing as cross-cutting pattern (90% of activity is exploration), "caching strategies" gap, substrate operational data showing agents repeatedly re-read the same files.

## Scope

### In Scope

- Tree-sitter-based repo-map: parse codebase into structural skeleton (classes, functions, exports, imports, types) stored in Dolt
- Incremental repo-map updates: after each story execution, update only changed files (via git diff)
- Repo-map query interface: agents request relevant structure by topic/file/symbol, get a focused skeleton instead of full file contents
- Model routing configuration: per-task-type model selection (exploration vs. generation vs. review)
- Model routing in dispatch: the agent dispatcher selects model based on task phase, with fallback to default
- Routing telemetry integration: measure token savings from model routing using Epic 27's efficiency data
- Repo-map injection into prompts: automatically include relevant repo-map context in story agent prompts
- Repo-map CLI: `substrate repo-map --show`, `substrate repo-map --update`, `substrate repo-map --query <symbol>`

### Out of Scope

- Language-specific semantic analysis beyond tree-sitter (e.g., type inference, flow analysis)
- Automatic prompt rewriting based on telemetry (future — would build on recommendations engine)
- Multi-repo repo-map (start with single repo)
- Fine-tuning or custom model training
- Third-party model providers beyond Claude and OpenAI (start with these two)

## Story Map

```
Sprint 1 — Repo-Map Foundation (P0):
  Story 28-1: Tree-Sitter Integration + Repo-Map Generation (P0, L)
  Story 28-2: Repo-Map Dolt Storage + Incremental Updates (P0, M)
  Story 28-3: Repo-Map Query Interface (P0, M)

Sprint 2 — Model Routing (P0/P1):
  Story 28-4: Model Routing Configuration Schema (P0, S)
  Story 28-5: Model-Routed Agent Dispatch (P0, L)
  Story 28-6: Routing Telemetry + Savings Measurement (P1, M)

Sprint 3 — Integration + Optimization (P1):
  Story 28-7: Repo-Map Prompt Injection (P1, M)
  Story 28-8: Feedback Loop — Telemetry-Driven Routing Tuning (P1, L)
  Story 28-9: Repo-Map + Routing CLI Commands (P2, S)

Sprint 4 — Migration + Hardening (P1):
  Story 28-10: Dolt Schema Migration — dependencies Column (P1, S)
```

## Story Details

### Story 28-1: Tree-Sitter Integration + Repo-Map Generation (P0, L)

**Problem:** Every story agent re-discovers the codebase from scratch — globbing, grepping, reading files. Aider's repo-map technique builds a structural skeleton that's 10-100x smaller than full file contents, giving agents the "lay of the land" without burning context tokens.

**Acceptance Criteria:**
- AC1: Tree-sitter parses TypeScript/JavaScript files (primary targets) and extracts: exported functions, classes, interfaces, type aliases, enums, and their signatures (name + params + return type)
- AC2: Also extracts: import statements (what each file depends on), file-level exports, module structure
- AC3: Support for additional languages via tree-sitter grammars: Python, Go, Rust (configured per-project in manifest)
- AC4: Repo-map output is a compact text format: one line per symbol, grouped by file, with file paths relative to project root
- AC5: Generation runs on the full codebase: `substrate repo-map --generate` parses all source files and outputs the map
- AC6: Performance: generating a repo-map for a 500-file TypeScript project takes <10 seconds
- AC7: Files excluded via `.gitignore` patterns and configurable `repo_map.exclude` patterns

**Files:** new `src/modules/repo-map/generator.ts`, new `src/modules/repo-map/tree-sitter-parser.ts`, new `src/modules/repo-map/types.ts`

### Story 28-2: Repo-Map Dolt Storage + Incremental Updates (P0, M)

**Problem:** The repo-map must persist across pipeline runs and update incrementally — re-parsing the entire codebase after every story is wasteful.

**Acceptance Criteria:**
- AC1: Dolt schema extended with `repo_map_symbols` table: `file_path, symbol_name, symbol_type (function|class|interface|type|enum|export), signature, line_number, dependencies (JSON array of imports), file_hash`
- AC2: Incremental update: after story completion, `git diff` identifies changed files, only those files are re-parsed and their symbols updated in Dolt
- AC3: `stateStore.getRepoMap(filter?)` returns the full or filtered repo-map from Dolt
- AC4: Staleness detection: if `file_hash` doesn't match current file content, flag as stale
- AC5: Initial seed: `substrate repo-map --generate` does a full parse and inserts into Dolt; subsequent runs are incremental

**Depends on:** Story 28-1, Epic 26 (Dolt StateStore)

**Files:** new `src/modules/repo-map/storage.ts`, schema extension in `src/modules/state/schema.sql`

### Story 28-3: Repo-Map Query Interface (P0, M)

**Problem:** A raw repo-map dump of the entire codebase is still too large for agent context. Agents need to query for relevant structure by topic, file pattern, or symbol name.

**Acceptance Criteria:**
- AC1: `queryRepoMap({ files?: glob[], symbols?: string[], types?: SymbolType[], dependsOn?: string[], dependedBy?: string[] })` returns a filtered, ranked subset of the repo-map
- AC2: Relevance ranking: symbols in files that match the query pattern rank higher; symbols with matching dependency chains rank higher
- AC3: Output formats: compact text (for prompt injection), JSON (for programmatic use)
- AC4: Size budget: queries accept a `maxTokens` parameter; output is truncated to fit within the budget, prioritizing by relevance rank
- AC5: Dependency traversal: `dependedBy: "StoryState"` returns all files that import/use `StoryState`, enabling agents to understand impact

**Files:** new `src/modules/repo-map/query.ts`

### Story 28-4: Model Routing Configuration Schema (P0, S)

**Problem:** Substrate currently uses a single model for all agent tasks. The research synthesis shows 90% of agent activity is exploration (file reads, grep, understanding code) — cheap models handle this well. Expensive models should be reserved for code generation.

**Acceptance Criteria:**
- AC1: Config schema extended with `model_routing` section: `exploration: { model, provider }`, `generation: { model, provider }`, `review: { model, provider }`, `default: { model, provider }`
- AC2: Task type → routing phase mapping: `create-story` → generation, `dev-story` → generation, `code-review` → review, subagent exploration → exploration
- AC3: Override per task type: `model_routing.overrides.dev-story: { model: "claude-opus-4-6" }` takes precedence
- AC4: Validation: config loader validates model names against known providers
- AC5: Default behavior when `model_routing` is absent: use the existing single-model config (zero regression)

**Files:** `src/modules/config/schema.ts`, config documentation

### Story 28-5: Model-Routed Agent Dispatch (P0, L)

**Problem:** The agent dispatcher currently passes a fixed model to all Claude Code invocations. It needs to select the model based on the task's routing phase.

**Acceptance Criteria:**
- AC1: `ClaudeCodeAdapter.buildCommand()` accepts a `model` parameter and passes it via `--model` flag
- AC2: The dispatcher resolves the model from routing config based on task type before dispatching
- AC3: For dev-story tasks, the primary execution uses the `generation` model; if subagent spawning is supported, exploration subagents use the `exploration` model
- AC4: Model selection is logged as a structured event: `dispatch:model-selected { storyKey, taskType, phase, model, provider }`
- AC5: Token costs in metrics (Epic 27) are attributed to the correct model for accurate cost tracking
- AC6: Fallback: if the configured model is unavailable (API error), fall back to `default` model with a warning event

**Files:** `src/modules/agent-dispatch/dispatcher-impl.ts`, `src/adapters/claude-adapter.ts`

### Story 28-6: Routing Telemetry + Savings Measurement (P1, M)

**Problem:** Model routing is only valuable if it actually saves tokens/cost. We need to measure the before/after difference using Epic 27's telemetry.

**Acceptance Criteria:**
- AC1: Token costs are tagged with the routing phase (`exploration`, `generation`, `review`) in the telemetry data
- AC2: `substrate metrics --routing` shows: tokens by phase, cost by phase, cost by model, savings vs. single-model baseline
- AC3: Baseline calculation: estimate what the run would have cost if all tokens used the `generation` model
- AC4: Savings percentage displayed: "Model routing saved $X.XX (Y%) on this pipeline run"
- AC5: Historical routing data stored in Dolt for trend analysis across sprints

**Depends on:** Epic 27 (telemetry), Story 28-5

**Files:** `src/modules/telemetry/routing-analyzer.ts`, `src/cli/commands/metrics.ts`

### Story 28-7: Repo-Map Prompt Injection (P1, M)

**Problem:** The repo-map exists but agents don't automatically receive it. Story agent prompts should include relevant repo-map context so agents start with structural knowledge.

**Acceptance Criteria:**
- AC1: The prompt assembler queries the repo-map for symbols relevant to the current story's scope (files mentioned in story spec, imports/exports referenced)
- AC2: Repo-map context injected into the `{{repo_context}}` placeholder in prompt templates
- AC3: Injection respects a configurable token budget (default 2000 tokens) — truncates by relevance
- AC4: Prompt templates updated: `dev-story.md` and `code-review.md` include `{{repo_context}}` section
- AC5: When repo-map is not available (not generated yet), the placeholder is empty (no error)
- AC6: Telemetry tracks repo-map injection: how many tokens of repo-map context were included per story

**Depends on:** Stories 28-2, 28-3

**Files:** `src/modules/context-compiler/`, prompt templates in `packs/bmad/prompts/`

### Story 28-8: Feedback Loop — Telemetry-Driven Routing Tuning (P1, L)

**Problem:** Static model routing config is a guess. Telemetry data from Epic 27 can inform better routing — if exploration tasks consistently produce low cache hit rates on cheap models, maybe they need the expensive model. If generation tasks have high cache rates, maybe they can use cheaper models.

**Acceptance Criteria:**
- AC1: After each pipeline run, the recommendation engine (Story 27-7) includes model routing recommendations
- AC2: Recommendations like: "Exploration tasks had 85% cache hit rate on sonnet — consider downgrading to haiku" or "Review tasks had 15% cache hit rate on haiku — consider upgrading to sonnet"
- AC3: `substrate metrics --routing-recommendations` shows these suggestions
- AC4: Optional auto-tuning: `model_routing.auto_tune: true` in config → substrate adjusts routing config based on last N runs (stored in Dolt)
- AC5: Auto-tune is conservative: only suggests changes when >5 data points confirm the pattern, and only adjusts one step at a time (opus→sonnet or sonnet→haiku, never opus→haiku)
- AC6: All auto-tune decisions are logged and reversible via Dolt history

**Depends on:** Epic 27 (recommendations engine), Story 28-6

**Files:** new `src/modules/telemetry/routing-tuner.ts`, `src/modules/telemetry/recommender.ts`

### Story 28-9: Repo-Map + Routing CLI Commands (P2, S)

**Problem:** The repo-map and routing features need CLI access for both humans and parent agents.

**Acceptance Criteria:**
- AC1: `substrate repo-map --show` displays the full repo-map in compact text format
- AC2: `substrate repo-map --query <symbol>` shows the symbol and its dependency chain
- AC3: `substrate repo-map --update` triggers an incremental update based on git diff
- AC4: `substrate repo-map --stats` shows: total symbols, files parsed, last updated, staleness percentage
- AC5: `substrate routing --show` displays current model routing configuration
- AC6: `substrate routing --history` shows routing changes over time (from Dolt auto-tune history)
- AC7: All commands support `--output-format json`

**Files:** new `src/cli/commands/repo-map.ts`, new `src/cli/commands/routing.ts`, `src/cli/index.ts`

### Story 28-10: Dolt Schema Migration — dependencies Column (P1, S)

**Problem:** The `dependencies JSON` column was added to `repo_map_symbols` in schema.sql (v6) during Sprint 1, but Dolt databases created with schema v5 won't gain this column via `CREATE TABLE IF NOT EXISTS`. Existing databases need an `ALTER TABLE ADD COLUMN` migration.

**Acceptance Criteria:**
- AC1: Detect missing `dependencies` column on `repo_map_symbols` during `ensureSchema()`
- AC2: Apply `ALTER TABLE ADD COLUMN dependencies JSON` idempotently
- AC3: Existing rows receive NULL, correctly treated as `[]` by `_rowToRepoMapSymbol()`
- AC4: Schema version 6 recorded in `_schema_version`
- AC5: Migration logged at info level

**Depends on:** Stories 28-2, 28-3 (Sprint 1 fix that introduced the column)

**Files:** `src/modules/state/dolt-state-store.ts`, tests

## Known Limitations

1. **`findAll()` client-side glob filtering** — `RepoMapQueryEngine.query()` at `query.ts:73` calls `repo.findAll()` then filters with `minimatch` client-side. For large codebases (10K+ symbols), this is a full table scan per query. Optimization: add SQL-side `LIKE` prefix filtering. Not blocking — no target project has hit this scale yet. Will be observable via Epic 27 telemetry if it becomes a bottleneck.

## Dependency Analysis

- Sprint 1 (28-1, 28-2, 28-3): 28-1 first (parser), then 28-2 (storage) and 28-3 (query) can overlap
- Sprint 2 (28-4, 28-5, 28-6): 28-4 first (schema), 28-5 depends on 28-4 (dispatch uses config), 28-6 depends on 28-5 + Epic 27
- Sprint 3 (28-7, 28-8, 28-9): 28-7 depends on 28-2/28-3 (needs repo-map data), 28-8 depends on 28-6 + Epic 27, 28-9 is independent

## Sprint Plan

**Sprint 1:** Stories 28-1, 28-2, 28-3 — Tree-sitter repo-map generation, storage, querying
**Sprint 2:** Stories 28-4, 28-5, 28-6 — Model routing config, dispatch, telemetry
**Sprint 3:** Stories 28-7, 28-8, 28-9 — Prompt injection, feedback loop, CLI
**Sprint 4:** Story 28-10 — Dolt schema migration for dependencies column

## Success Metrics

- Repo-map generation covers >95% of exported symbols in the target codebase
- Agents receiving repo-map context spend fewer exploration tokens (measurable via Epic 27 telemetry — target 30% reduction)
- Model routing reduces pipeline cost by >40% compared to single-model baseline (measured via routing telemetry)
- Incremental repo-map updates complete in <3 seconds after a typical story commit
- Feedback loop produces actionable routing recommendations after 5+ pipeline runs
- `substrate repo-map --query` returns relevant results in <1 second from Dolt
- Auto-tune makes conservative, correct adjustments validated by subsequent run efficiency scores
