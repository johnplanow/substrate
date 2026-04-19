# Epic 32: Substrate Core Extraction — General-Purpose Agent Harness

**Status: PLANNED**
**Sequencing: After Epic 31 (Dolt Work Graph). Prerequisites: Epic 29 complete, Epic 31 complete.**

## Vision

Extract Substrate's general-purpose agent infrastructure into a shared library (`substrate-core`). Substrate becomes a consumer of that library for SDLC work. A second, lighter consumer handles general-purpose agent tasks (research, writing, analysis, personal assistant workflows).

The hard parts — multi-provider routing, adapter abstraction, telemetry, cost tracking — get built once and shared. Substrate stays focused on SDLC orchestration. The general-purpose harness stays thin.

The end state: **one infrastructure library, two (or more) consumers, zero duplication of agent plumbing.**

## Rationale

### Why extract?

- Substrate already solves multi-provider agent orchestration, routing, telemetry, and cost tracking — but these capabilities are locked inside an SDLC tool
- The Claude ecosystem lacks orchestration, scheduling, messaging, and multi-provider fallback for general-purpose agent work (per research council run `20260312-141824`)
- Duplicating adapter/routing/telemetry code for a second consumer is waste — extract a library from one working product instead
- The `DatabaseAdapter` interface (Epic 29) already provides the clean persistence boundary needed for extraction

### Why after Epic 31?

- Epic 29 finishes the Dolt migration — stabilizes the persistence layer
- Epic 31 builds the work graph — establishes which tables are SDLC-specific vs general-purpose
- Both epics battle-test the boundaries that become the extraction cut line
- Extracting before these settle risks drawing the line in the wrong place

## What Gets Extracted: `substrate-core`

Modules that are already general-purpose and have no SDLC opinion:

| Module | What it does | SDLC-specific? |
|--------|-------------|----------------|
| **Adapter registry + worker adapter** | Spawn/health/capabilities abstraction over Claude, Codex, Gemini CLIs | No |
| **Routing engine + routing policy** | Subscription-first algorithm, fallback chains, rate limits, provider health, hot-reload | No |
| **Event bus** | Typed pub/sub | No |
| **Telemetry pipeline** | Token extraction, cost attribution, OTEL spans | No |
| **Cost tracker** | Token rates, budget tracking | No |
| **Monitor + recommendation engine** | Agent performance metrics and routing recommendations | No (task-type classifier needs small generalization) |
| **DatabaseAdapter interface** | Async persistence abstraction | No |
| **Config system** | Schema-validated config with hot-reload | Partially — needs generalization |

### Proposed package structure

```
substrate-core/
├── adapters/          # CLI agent abstraction
│   ├── types.ts
│   ├── worker-adapter.ts
│   ├── claude-adapter.ts
│   ├── codex-adapter.ts
│   ├── gemini-adapter.ts
│   └── adapter-registry.ts
├── routing/           # Policy-driven dispatch
│   ├── routing-engine.ts
│   ├── routing-policy.ts
│   ├── provider-status.ts
│   └── routing-decision.ts
├── persistence/       # DatabaseAdapter interface + implementations
│   ├── adapter.ts
│   ├── memory-adapter.ts
│   └── dolt-adapter.ts
├── telemetry/         # Token tracking, cost, OTEL
├── cost/              # Budget tracking
├── monitor/           # Agent performance metrics
├── events/            # Typed event bus
└── config/            # Schema-validated config (generalized)
```

## What Stays in Substrate

SDLC-specific orchestration and methodology:

- Phase orchestrator (analysis → planning → solutioning → implementation)
- Compiled workflows (create-story, dev-story, code-review, fix)
- Methodology packs (BMAD)
- Story discovery, context compiler, prompt assembler
- Quality gates, interface contract verification
- Dolt work graph (Epic 31: `stories`, `story_dependencies`, `ready_stories`)
- SDLC persistence schema (decisions, pipeline_runs, amendments)
- Supervisor experiments (SDLC-specific A/B tests)
- Git worktree management
- CLI commands (SDLC-specific)

## What a General-Purpose Harness Looks Like

A second consumer of `substrate-core`, much thinner than Substrate:

- **Task definition** — "run this prompt against an agent with these constraints" (no story/phase/review-cycle structure)
- **Conversational loop** — back-and-forth with a human over some transport (Telegram, CLI, etc.)
- **Simple scheduling** — cron-like "run this task every N hours"
- **Session/memory management** — conversation history, context injection (different from methodology-pack-driven context compilation, but shares token counting primitives)

## Design Constraints

### Persistence boundary

`substrate-core` owns the `DatabaseAdapter` interface and general-purpose tables (telemetry turns, cost records, monitor metrics). Substrate owns SDLC tables (stories, story_dependencies, decisions, pipeline_runs). Both use the same Dolt instance in production, but the schema is logically partitioned.

A general-purpose harness consumer can use `InMemoryDatabaseAdapter` or a future `PostgresAdapter` — it doesn't need Dolt.

### Extraction constraint

**Substrate's tests keep passing throughout extraction.** If moving a module to `substrate-core` breaks Substrate, the boundary is drawn wrong.

### Design-for-extraction (applies NOW, before extraction)

Even before this epic executes, prior epics should follow these rules:

1. **29-6**: Code telemetry + monitor to `DatabaseAdapter` interface, not `DoltDatabaseAdapter` directly
2. **Epic 31**: Keep work graph tables logically separate from telemetry/cost/monitor tables
3. **All new modules**: Accept `DatabaseAdapter` as a parameter, don't import a specific implementation

## Story Map (Draft)

```
Sprint 1 — Monorepo + Core Package:
  32-1: Set up monorepo structure (packages/core, packages/substrate) (P0, M)
  32-2: Extract adapter registry + worker adapter to core (P0, M)
  32-3: Extract routing engine + routing policy to core (P0, M)

Sprint 2 — Persistence + Telemetry:
  32-4: Extract DatabaseAdapter interface + InMemory/Dolt implementations to core (P0, M)
  32-5: Extract telemetry pipeline to core (P0, M)
  32-6: Extract cost tracker + monitor to core (P0, M)

Sprint 3 — Event Bus + Config + Integration:
  32-7: Extract event bus to core (P0, S)
  32-8: Generalize config system for core (P1, M)
  32-9: Integration validation — Substrate's full test suite passes against core imports (P0, M)

Sprint 4 — General-Purpose Harness (MVP):
  32-10: Minimal general-purpose harness — dispatch a task, get a result, track cost (P1, M)
  32-11: Conversational loop transport (CLI first) (P1, M)
  32-12: Simple scheduling — cron-like recurring tasks (P2, M)
```

### Dependency chain

```
32-1 → 32-2 → 32-3 (sequential — monorepo first, then extractions)
       32-4 → 32-5 → 32-6 (persistence before telemetry before monitor)
       32-7 (independent)
       32-8 (independent)
       All above → 32-9 (integration validation)
       32-9 → 32-10 → 32-11 → 32-12 (harness after core stabilizes)
```

## Success Metrics

- `substrate-core` is a standalone npm package with zero SDLC concepts
- Substrate imports from `@substrate/core` and all 5400+ tests pass
- General-purpose harness can dispatch a task to Claude/Codex/Gemini, get structured output, and track cost — without importing anything from Substrate
- `npm install substrate-core` has zero native C++ dependencies
- Routing, telemetry, and cost tracking work identically in both consumers

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Extraction boundary drawn wrong — too much or too little in core | Epic 31 battle-tests boundaries first; extraction constraint enforces "Substrate tests keep passing" |
| Monorepo tooling complexity (workspaces, builds, publishing) | Use standard npm workspaces + tsconfig project references; well-trodden path |
| General-purpose harness scope creep | Sprint 4 is MVP only — dispatch, result, cost. No bells and whistles |
| Config system too SDLC-coupled to generalize | 32-8 addresses this explicitly; worst case, core gets a minimal config layer |
| Two consumers diverge on adapter interface | Core owns the interface; both consumers are downstream. Semantic versioning enforces contract |

## Related

- **Epic 29**: Dolt migration — establishes `DatabaseAdapter` as the persistence boundary
- **Epic 31**: Dolt work graph — establishes which tables are SDLC-specific
- **Research council run `20260312-141824`**: Evaluated Claude ecosystem gaps; core extraction addresses orchestration/routing/telemetry gaps
- **`~/substrate-core-extraction.md`**: Original conversation notes (2026-03-12)
