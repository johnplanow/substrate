# Story 27-13: CLI Metrics Telemetry Handlers

Status: review

## Story

As a pipeline operator or parent agent,
I want telemetry analysis data accessible through `substrate metrics` subcommand flags,
so that I can inspect efficiency scores, recommendations, per-turn analysis, consumers, and categories from the CLI.

## Context — What Already Exists

This story wires the CLI flags that already exist in `metrics.ts` to actual persistence queries. The following already exist:

**CLI scaffolding (exists but handlers are dead code):**
- `src/cli/commands/metrics.ts` — has option flags for `--efficiency`, `--recommendations`, `--turns`, `--consumers`, `--categories`, `--compare-stories` (lines ~67-77), but the action handler doesn't process them

**Persistence queries (exist and work):**
- `src/modules/telemetry/persistence.ts` — has all the query methods:
  - `getTurnAnalysis(storyKey)` → `TurnAnalysis[]`
  - `getEfficiencyScore(storyKey)` → `EfficiencyScore | null`
  - `getEfficiencyScores(limit?)` → `EfficiencyScore[]`
  - `getRecommendations(storyKey)` → `Recommendation[]`
  - `getAllRecommendations(limit?)` → `Recommendation[]`
  - `getCategoryStats(storyKey)` → `CategoryStats[]`
  - `getConsumerStats(storyKey)` → `ConsumerStats[]`

**This story's job:** Connect the existing CLI flags to the existing persistence methods, format output (text tables + JSON).

## Acceptance Criteria

### AC1: Efficiency Scores Flag
**Given** efficiency score records exist in persistence
**When** `substrate metrics --efficiency` is run
**Then** it prints a table showing: story_key, score (0-100), cacheHitRate (%), ioRatio, contextManagementScore, model; "No efficiency data yet" when empty

### AC2: Recommendations Flag
**Given** recommendation records exist
**When** `substrate metrics --recommendations [--story <key>]` is run
**Then** it prints recommendations ordered critical → warning → info, showing severity, title, description, potentialSavings, actionTarget

### AC3: Per-Turn Analysis Flag
**Given** turn analysis records exist for a story
**When** `substrate metrics --turns <storyKey>` is run
**Then** it prints chronological turns with turnNumber, name, model, inputTokens, outputTokens, cacheHitRate%, durationMs, isContextSpike flag; exits 1 if story not found

### AC4: Context Consumers Flag
**Given** consumer stats exist for a story
**When** `substrate metrics --consumers <storyKey>` is run
**Then** it prints top consumers ranked by token percentage; exits 1 if not found

### AC5: Semantic Categories Flag
**Given** category stats exist
**When** `substrate metrics --categories [--story <key>]` is run
**Then** it prints per-category breakdown: category, totalTokens, percentage, count, trend

### AC6: JSON Output Mode
**Given** any telemetry flag is used with `--output-format json`
**When** the command executes
**Then** it writes a JSON object with `success: true|false` and typed data array

### AC7: Story Comparison
**Given** efficiency scores exist for two stories
**When** `substrate metrics --compare-stories <storyA,storyB>` is run
**Then** it shows side-by-side metrics with delta values; exits 1 if either story missing

## Tasks / Subtasks

- [ ] Task 1: Read existing `src/cli/commands/metrics.ts` to understand current structure, option parsing, and output patterns
- [ ] Task 2: Implement `--efficiency` handler in `runMetricsAction`
  - Construct TelemetryPersistence from project state store
  - Call `getEfficiencyScores(20)`
  - Text: formatted table with padEnd/padStart matching existing style
  - JSON: `{ success: true, efficiency: [...] }`
  - Empty: "No efficiency data yet", exit 0
- [ ] Task 3: Implement `--recommendations` handler
  - With `--story`: call `getRecommendations(storyKey)`
  - Without: call `getAllRecommendations(50)`
  - Sort: critical → warning → info
  - JSON: `{ success: true, recommendations: [...] }`
- [ ] Task 4: Implement `--turns <storyKey>` handler
  - Call `getTurnAnalysis(storyKey)`
  - Empty → exit 1 with "No turn analysis found for story <key>"
  - Text: chronological table, flag spikes
  - JSON: `{ success: true, storyKey, turns: [...] }`
- [ ] Task 5: Implement `--consumers <storyKey>` handler
  - Call `getConsumerStats(storyKey)`
  - Empty → exit 1
  - Text: ranked table
  - JSON: `{ success: true, storyKey, consumers: [...] }`
- [ ] Task 6: Implement `--categories` handler
  - Call `getCategoryStats(storyKey?)` or aggregate
  - Text: table sorted by totalTokens desc
  - JSON: `{ success: true, categories: [...] }`
- [ ] Task 7: Implement `--compare-stories <a,b>` handler
  - Fetch two efficiency scores, compute delta
  - Text: side-by-side with +/- prefix
  - JSON: `{ success: true, storyA: {...}, storyB: {...}, delta: {...} }`
  - Either missing → exit 1
- [ ] Task 8: Add mutual exclusivity guard for all telemetry flags
- [ ] Task 9: Unit tests in `src/cli/commands/__tests__/metrics-telemetry.test.ts`
  - Mock TelemetryPersistence
  - Test each flag in text and JSON modes
  - Test empty data scenarios
  - Test flag conflicts
  - Test missing story exits 1

## Dev Notes

### Architecture Constraints
- EXTEND existing `src/cli/commands/metrics.ts` — do NOT create a new file or command registration
- No changes needed to `src/cli/index.ts` — metrics command is already registered
- Follow existing dual-mode output pattern in the file
- TelemetryPersistence construction: use the SQLite DB path from project config
- All flags mutually exclusive with each other AND with existing --compare, --tag-baseline, --analysis modes
- Import order: Node built-ins, third-party, internal — blank lines between groups

### Text Formatting — Match Existing Style
```
Efficiency Scores (5 records)
────────────────────────────────────────────────────────────────────────────────
Story Key     Score   Cache Hit%   I/O Ratio   Ctx Mgmt   Model
  26-4          87      74.2%        0.23        91       claude-3-5-sonnet
```

### TelemetryPersistence Construction Pattern
Look at how the existing metrics.ts constructs its DB connection. Follow the same pattern for TelemetryPersistence — it takes a `better-sqlite3` Database instance. The telemetry DB is the same SQLite file used by the state store.

### File Paths
```
src/cli/commands/
  metrics.ts                              <- MODIFY (add handler implementations)
  __tests__/
    metrics-telemetry.test.ts             <- NEW
```

## Interface Contracts

- **Import**: `TelemetryPersistence`, all telemetry types from `../../modules/telemetry/index.js`
- **No exports** — this extends an existing CLI command

## Dependencies

- **Can run in parallel with**: 27-10, 27-11 (no shared files)
- **Does NOT depend on**: 27-12 (wiring) — this reads from persistence, not from the live pipeline
