# Story 27-8: CLI Integration — Metrics Commands

Status: ready-for-dev

## Story

As a pipeline operator or parent agent,
I want telemetry analysis data accessible through `substrate metrics` subcommand flags,
so that I can inspect per-turn token usage, efficiency scores, semantic categories, context consumers, and actionable recommendations from the CLI without reading raw Dolt tables.

## Acceptance Criteria

### AC1: Efficiency Scores Flag
**Given** the telemetry persistence layer contains efficiency score records (from story 27-6)
**When** `substrate metrics --efficiency` is run
**Then** it prints a table of efficiency scores for recent stories — one row per story — showing: `story_key`, `score` (0-100), `cacheHitRate` (%), `ioRatio`, `contextManagementScore`, and `model`; if no records exist, prints a friendly "No efficiency data yet" message and exits 0

### AC2: Recommendations Flag
**Given** the telemetry persistence layer contains recommendation records (from story 27-7)
**When** `substrate metrics --recommendations [--story <storyKey>]` is run (optional story filter)
**Then** it prints recommendations ordered critical → warning → info, each showing `severity`, `title`, `description`, and (if set) `potentialSavingsTokens` and `actionTarget`; if no story filter is given, shows recommendations across all recent stories (limit 50); if `--story` filter is given, shows only that story's recommendations; exits 0 with "No recommendations yet" when the table is empty

### AC3: Per-Turn Analysis Flag
**Given** the telemetry persistence layer contains turn analysis records for a story (from story 27-4)
**When** `substrate metrics --turns <storyKey>` is run
**Then** it prints a chronological table of turns for that story: `turnNumber`, `name`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `freshTokens`, `cacheHitRate` (%), `durationMs`, `isContextSpike` (flagged with `⚠` when true), and `contextSize` (running cumulative); if the story key is not found, prints "No turn analysis found for story <storyKey>" and exits 1

### AC4: Context Consumers Flag
**Given** the telemetry persistence layer contains consumer group records for a story (from story 27-5)
**When** `substrate metrics --consumers <storyKey>` is run
**Then** it prints top token consumers for that story ranked by total token percentage: `rank`, `eventType`, `toolName`, `totalTokens`, `percentage` (%), and `count` (number of invocations); if no consumer data is found for the story, prints "No consumer data found for story <storyKey>" and exits 1

### AC5: Semantic Categories Flag
**Given** the telemetry persistence layer contains category analysis records (from story 27-5)
**When** `substrate metrics --categories [--story <storyKey>]` is run (optional story filter)
**Then** it prints per-category rows: `category`, `totalTokens`, `percentage` (%), `count`, `avgTokensPerEvent`, and `trend` (`growing` / `stable` / `shrinking`); rows are ordered by `totalTokens` descending; an optional `--story` flag scopes the query to a single story; without the flag, it shows the aggregate across all stories in the Dolt store

### AC6: JSON Output Mode
**Given** any of the new flags (`--efficiency`, `--recommendations`, `--turns`, `--consumers`, `--categories`) is used
**When** `--output-format json` is also passed
**Then** the command writes a single JSON object to stdout with a `success: true|false` field plus a typed data array (e.g. `{ success: true, efficiency: [...] }`, `{ success: true, recommendations: [...] }`, etc.); errors are written to stdout as `{ success: false, error: "<message>" }`; the exit code is 0 on success, 1 on data-not-found or internal error

### AC7: Story-vs-Story Efficiency Comparison
**Given** the telemetry persistence layer has efficiency score records for at least two distinct story keys
**When** `substrate metrics --compare-stories <storyA> <storyB>` is run (using the new flag name to avoid collision with existing `--compare` run-level flag)
**Then** it prints a side-by-side diff: for each metric (`score`, `cacheHitRate`, `ioRatio`, `contextManagementScore`), shows the value for storyA, storyB, and the delta (with `+` / `-` prefix); if either story has no efficiency record, exits 1 with an informative error; `--output-format json` produces `{ success: true, storyA: {...}, storyB: {...}, delta: {...} }`

## Tasks / Subtasks

- [ ] Task 1: Extend `MetricsOptions` interface and add new CLI flags in `src/cli/commands/metrics.ts` (AC: #1, #2, #3, #4, #5, #6, #7)
  - [ ] Add fields to `MetricsOptions`: `efficiency?: boolean`, `recommendations?: boolean`, `turns?: string`, `consumers?: string`, `categories?: boolean`, `compareStories?: [string, string]`
  - [ ] In `registerMetricsCommand`, add Commander options: `--efficiency`, `--recommendations`, `--turns <storyKey>`, `--consumers <storyKey>`, `--categories`, `--compare-stories <storyA,storyB>`
  - [ ] Parse `--compare-stories` the same way as existing `--compare`: split on comma, validate 2 parts, store as `[string, string]`
  - [ ] Guard: all new options are mutually exclusive with each other and with existing `--compare`, `--tag-baseline`, `--analysis` modes; if two conflicting flags are passed, print usage error to stderr and exit 1

- [ ] Task 2: Implement `--efficiency` mode in `runMetricsAction` (AC: #1, #6)
  - [ ] Import `ITelemetryPersistence`, `TelemetryPersistence`, `EfficiencyScore` from `../../modules/telemetry/index.js`
  - [ ] Construct `TelemetryPersistence` using the project's Dolt state store path (reuse the `doltStatePath` pattern already in the file); fall back to "No efficiency data" message when Dolt path does not exist
  - [ ] Call `telemetryPersistence.getEfficiencyScores()` (a new query method — see Task 4); limit to 20 most recent records ordered by `timestamp DESC`
  - [ ] Text mode: print a formatted table using `padEnd`/`padStart` matching the existing metrics table style; score shown as integer, cacheHitRate as `XX.X%`, ioRatio as float to 2 decimals
  - [ ] JSON mode: write `{ success: true, efficiency: EfficiencyScore[] }` to stdout

- [ ] Task 3: Implement `--recommendations`, `--turns`, `--consumers`, `--categories`, `--compare-stories` modes in `runMetricsAction` (AC: #2, #3, #4, #5, #7, #6)
  - [ ] `--recommendations`: call `telemetryPersistence.getRecommendations(storyKey)` (uses existing method from 27-7) or a new `getAllRecommendations(limit)` when no story filter; display formatted table; JSON: `{ success: true, recommendations: Recommendation[] }`
  - [ ] `--turns <storyKey>`: call `telemetryPersistence.getTurnAnalysis(storyKey)` (from 27-4); display formatted table with `⚠` on spike turns; JSON: `{ success: true, storyKey, turns: TurnAnalysis[] }`; exit 1 if empty
  - [ ] `--consumers <storyKey>`: call `telemetryPersistence.getConsumerGroups(storyKey)` (from 27-5); display ranked table; JSON: `{ success: true, storyKey, consumers: ConsumerGroup[] }`; exit 1 if empty
  - [ ] `--categories [--story]`: call `telemetryPersistence.getCategoryAnalysis(storyKey?)` (from 27-5); display table sorted by `totalTokens` desc; JSON: `{ success: true, categories: CategoryAnalysis[] }`
  - [ ] `--compare-stories <storyA,storyB>`: fetch `getEfficiencyScore(storyA)` and `getEfficiencyScore(storyB)`; compute delta object `{ score, cacheHitRate, ioRatio, contextManagementScore }` as storyB minus storyA; display side-by-side table; JSON: `{ success: true, storyA: {...}, storyB: {...}, delta: {...} }`; exit 1 if either story missing

- [ ] Task 4: Add missing persistence query methods to `ITelemetryPersistence` and `TelemetryPersistence` in `src/modules/telemetry/persistence.ts` (AC: #1, #2, #5)
  - [ ] Add `getEfficiencyScores(limit?: number): Promise<EfficiencyScore[]>` — queries `efficiency_scores` table ordered by `timestamp DESC`, applies limit (default 20), validates each row with `EfficiencyScoreSchema.parse()`
  - [ ] Add `getEfficiencyScore(storyKey: string): Promise<EfficiencyScore | null>` — queries `efficiency_scores` WHERE `story_key = ?`, returns null if not found
  - [ ] Add `getAllRecommendations(limit?: number): Promise<Recommendation[]>` — queries `recommendations` table ordered by `severity` (CASE WHEN critical/warning/info → 0/1/2), then `potential_savings_tokens DESC`, applies limit (default 50), validates with `RecommendationSchema.parse()`
  - [ ] All queries use parameterized prepared statements; no string interpolation of user input

- [ ] Task 5: Write unit tests for new metrics modes in `src/cli/commands/__tests__/metrics-telemetry.test.ts` (AC: #1, #2, #3, #4, #5, #6, #7)
  - [ ] Mock `TelemetryPersistence` via `vi.mock` and inject stub that returns fixture data from `tests/fixtures/telemetry/`
  - [ ] Test `--efficiency`: text output contains expected story key and score; JSON output has `success: true` and `efficiency` array
  - [ ] Test `--efficiency` with no data: exits 0, prints "No efficiency data yet"
  - [ ] Test `--recommendations --story 27-4`: returns only that story's recommendations; sorted critical first
  - [ ] Test `--turns 27-4`: table contains `⚠` for spike turns; JSON has `turns` array
  - [ ] Test `--turns <missing>`: exits 1 with informative error message
  - [ ] Test `--consumers 27-4`: ranked table printed; JSON has `consumers` array
  - [ ] Test `--categories`: all semantic categories printed sorted by token count
  - [ ] Test `--compare-stories 27-4,27-5`: delta row shows `+` or `-` prefix; JSON has `delta` object
  - [ ] Test `--compare-stories 27-4,missing`: exits 1 with error
  - [ ] Test flag conflict: `--efficiency --recommendations` → exits 1 with usage error

- [ ] Task 6: Write integration tests for new persistence query methods in `src/modules/telemetry/__tests__/persistence-telemetry-query.test.ts` (AC: #1, #2)
  - [ ] Use real in-memory SQLite (`:memory:`) seeded with efficiency and recommendation fixture rows
  - [ ] Test `getEfficiencyScores()` returns rows sorted by `timestamp DESC`; limit parameter is respected
  - [ ] Test `getEfficiencyScore(storyKey)` returns correct record and null for unknown key
  - [ ] Test `getAllRecommendations()` returns rows sorted critical → warning → info, then by savings descending
  - [ ] All test data inserted via parameterized statements matching what the real implementation would write

- [ ] Task 7: Verify `src/cli/index.ts` wiring is unchanged and build passes (AC: #1 through #7)
  - [ ] Confirm `registerMetricsCommand` is already registered in `src/cli/index.ts` (it is — no registration change needed since we extend the existing command, not add a new one)
  - [ ] Run `npm run build` — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all new and existing tests pass; no coverage regression below 80%

## Dev Notes

### Architecture Constraints
- **Extend existing file**: `src/cli/commands/metrics.ts` already exists and registers `registerMetricsCommand`. Add new flags to the existing Commander command definition — do NOT create a second command registration or a new file for the command. The pattern is: extend `MetricsOptions`, add `.option(...)` calls, and add `if (options.efficiency)` / `if (options.turns)` branches in `runMetricsAction`.
- **No new CLI registration in `index.ts`**: since this story extends an existing command, `src/cli/index.ts` does NOT need changes.
- **Dual-mode output**: follow the existing pattern exactly — `process.stdout.write(formatOutput(payload, 'json', true) + '\n')` for JSON, plain `process.stdout.write(...)` for text.
- **Import order**: Node built-ins first, third-party second, internal relative paths third; blank lines between groups.
- **No new npm dependencies**: all functionality uses existing imports and the telemetry module added by stories 27-3 through 27-7.
- **Constructor injection**: `TelemetryPersistence` is instantiated at call time inside the action handler (same pattern as `DatabaseWrapper` and `createStateStore` in the existing file).
- **Parameterized queries only**: all new SQL in persistence.ts uses better-sqlite3 prepared statements.

### File Paths
```
src/cli/commands/
  metrics.ts                                   ← EXTEND (new options + action branches)
  __tests__/
    metrics-telemetry.test.ts                  ← NEW (unit tests for new modes)

src/modules/telemetry/
  persistence.ts                               ← EXTEND (add getEfficiencyScores, getEfficiencyScore, getAllRecommendations)
  __tests__/
    persistence-telemetry-query.test.ts        ← NEW (integration tests for new query methods)

tests/fixtures/telemetry/
  sample-efficiency-scores.json                ← NEW (fixture for --efficiency tests)
  sample-all-recommendations.json              ← NEW (fixture for --recommendations tests without story filter)
```

### Dolt State Path Resolution
Reuse the existing pattern already in `metrics.ts`:
```typescript
const dbRoot = await resolveMainRepoRoot(projectRoot)
const doltStatePath = join(dbRoot, '.substrate', 'state', '.dolt')
if (!existsSync(doltStatePath)) {
  // print "No telemetry data yet" and return 0
}
const stateStore = createStateStore({ backend: 'dolt', basePath: join(dbRoot, '.substrate', 'state') })
await stateStore.initialize()
const telemetryPersistence = new TelemetryPersistence(stateStore, logger)
```
Remember to call `await stateStore.close()` in a `finally` block.

### Flag Conflict Detection
Collect active exclusive-mode flags at the top of `runMetricsAction`:
```typescript
const telemetryModes = [options.efficiency, options.recommendations, options.turns, options.consumers, options.categories, options.compareStories].filter(Boolean)
if (telemetryModes.length > 1) {
  process.stderr.write('Error: --efficiency, --recommendations, --turns, --consumers, --categories, and --compare-stories are mutually exclusive\n')
  return 1
}
```
Also treat these as mutually exclusive with `compare`, `tagBaseline`, and `analysis` existing modes.

### Text Formatting Conventions
Match the exact style already in `metrics.ts`:
- Section header: `process.stdout.write(`\n<Section Title> (<count> records)\n`)`
- Separator: `process.stdout.write('─'.repeat(80) + '\n')`
- Column header row using `.padEnd()` / `.padStart()` with consistent column widths
- Data rows indented with two leading spaces

### Efficiency Score Table Columns
```
Story Key     Score   Cache Hit%   I/O Ratio   Ctx Mgmt   Model
─────────────────────────────────────────────────────────────────────────────────
26-4          87      74.2%        0.23        91         claude-3-5-sonnet
```

### Edge Cases
- **Dolt not present**: print friendly "No telemetry data yet — run a pipeline with `telemetry.enabled: true`" and exit 0 for `--efficiency`, `--recommendations`, `--categories`; exit 1 for `--turns <key>` and `--consumers <key>` (they require a specific story)
- **Empty table for story-scoped queries**: `--turns <storyKey>` and `--consumers <storyKey>` exit 1 when no data found (not 0) — caller needs to know the query failed
- **Zero total tokens**: percentage fields should show `0.0%` not `NaN%`; guard with `totalTokens > 0 ? ... : 0`
- **`--compare-stories` with same key twice**: treat as valid — show delta of all zeros

### Testing Requirements
- **Unit tests** (`metrics-telemetry.test.ts`): mock `TelemetryPersistence` via `vi.mock('../../modules/telemetry/index.js', ...)` — no Dolt or file I/O; spy on `process.stdout.write` to assert output content
- **Integration tests** (`persistence-telemetry-query.test.ts`): real in-memory SQLite seeded with schema from `src/modules/state/schema.sql`; test ordering, limit, and null-return behavior
- **Coverage**: ≥80% branch coverage on the new sections added to `metrics.ts` and new methods in `persistence.ts`
- **Test naming**: `describe('metrics command — telemetry modes')` → `describe('--efficiency')` → `it('should ...')`

## Interface Contracts

- **Import**: `EfficiencyScore`, `EfficiencyScoreSchema` @ `src/modules/telemetry/efficiency-scorer.ts` (from story 27-6)
- **Import**: `Recommendation`, `RecommendationSchema` @ `src/modules/telemetry/types.ts` (from story 27-7)
- **Import**: `TurnAnalysis` @ `src/modules/telemetry/types.ts` (from story 27-4)
- **Import**: `CategoryAnalysis` @ `src/modules/telemetry/categorizer.ts` (from story 27-5)
- **Import**: `ConsumerGroup` @ `src/modules/telemetry/consumer-analyzer.ts` (from story 27-5)
- **Import**: `ITelemetryPersistence`, `TelemetryPersistence` @ `src/modules/telemetry/persistence.ts` (from story 27-3, extended by 27-4, 27-5, 27-7)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
