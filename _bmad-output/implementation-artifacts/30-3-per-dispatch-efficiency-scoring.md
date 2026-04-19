# Story 30-3: Per-Dispatch Efficiency Scoring

## Story

As a pipeline operator analyzing telemetry data,
I want efficiency scores computed per dispatch (not just per story),
so that cache regressions and performance drops between individual dispatches are visible instead of hidden inside a single per-story aggregate.

## Acceptance Criteria

### AC1: EfficiencyScore type extended with optional dispatch context fields
**Given** the `EfficiencyScoreSchema` in `src/modules/telemetry/types.ts`
**When** the schema is updated
**Then** it includes three new optional fields: `dispatchId?: string`, `taskType?: string`, and `phase?: string` — all existing fields remain unchanged and required (backward compatible)

### AC2: Per-dispatch scores produced when turns carry dispatchId
**Given** a `TurnAnalysis[]` where turns have non-null `dispatchId` values (from story 30-1)
**When** `TelemetryPipeline._processStoryFromTurns()` or `_processStory()` processes them
**Then** turns are grouped by `dispatchId`, each group is scored independently via `EfficiencyScorer.score()`, and the resulting `EfficiencyScore` objects have `dispatchId`, `taskType` (from `turns[0].taskType`), and `phase` (from `turns[0].phase`) set

### AC3: Per-story aggregate score still produced (backward compatible)
**Given** any turn batch regardless of whether dispatch context is present
**When** the pipeline processes the story
**Then** a story-level aggregate `EfficiencyScore` (with `dispatchId` undefined) is always produced and persisted — this is identical to the pre-30-3 behavior

### AC4: efficiency_scores table extended with nullable dispatch context columns
**Given** the existing `efficiency_scores` table schema in `src/modules/state/schema.sql`
**When** the schema migration runs
**Then** the table has three new nullable columns: `dispatch_id TEXT`, `task_type TEXT`, and `phase TEXT` — existing rows are unaffected (columns default to NULL)

### AC5: Persistence stores dispatch-level scores alongside story aggregate
**Given** dispatch-level `EfficiencyScore` objects with `dispatchId` set
**When** `storeEfficiencyScore()` is called for each
**Then** all scores are persisted to `efficiency_scores` without PK conflicts — dispatch scores use timestamp offsets (`baseTimestamp + index + 1`) to guarantee uniqueness within a story batch

### AC6: New persistence method retrieves dispatch-level scores for a story
**Given** a story with both aggregate and dispatch-level scores in the DB
**When** `getDispatchEfficiencyScores(storyKey)` is called on `ITelemetryPersistence`
**Then** it returns only the dispatch-level scores (where `dispatch_id IS NOT NULL`) in chronological order (ascending timestamp) for that story

### AC7: `substrate metrics --efficiency` shows per-dispatch breakdown
**Given** a story with dispatch-level scores stored in the DB
**When** `substrate metrics --efficiency` is run
**Then** the output shows dispatch-level rows indented under the story aggregate row, each including `taskType/phase`, composite score, and cache hit rate; stories without dispatch scores display only the aggregate row (unchanged behavior)

## Tasks / Subtasks

- [ ] Task 1: Extend EfficiencyScore type with optional dispatch context fields (AC: #1)
  - [ ] Open `src/modules/telemetry/types.ts`, find `EfficiencyScoreSchema`
  - [ ] Add three optional fields after `perSourceBreakdown`: `dispatchId: z.string().optional()`, `taskType: z.string().optional()`, `phase: z.string().optional()`
  - [ ] Verify `EfficiencyScore` TypeScript type auto-updates (it is `z.infer<typeof EfficiencyScoreSchema>`)
  - [ ] Confirm no existing tests break (fields are optional — backward compatible)

- [ ] Task 2: Schema migration — add nullable columns to efficiency_scores (AC: #4)
  - [ ] In `src/modules/state/schema.sql`, add `dispatch_id TEXT`, `task_type TEXT`, `phase TEXT` nullable columns to the `efficiency_scores` CREATE TABLE block
  - [ ] Add `ALTER TABLE efficiency_scores ADD COLUMN dispatch_id TEXT` (and the other two columns) as conditional migration statements after the `INSERT IGNORE INTO _schema_version` block for efficiency_scores — follow the same pattern used in earlier schema migrations in the file
  - [ ] Insert a new schema version row: `INSERT IGNORE INTO _schema_version (version, description) VALUES (N, 'Add dispatch context columns to efficiency_scores (Epic 30-3)')`

- [ ] Task 3: Update persistence INSERT/SELECT and add getDispatchEfficiencyScores (AC: #5, #6)
  - [ ] In `src/modules/telemetry/adapter-persistence.ts`, update the `storeEfficiencyScore` INSERT to include the three new columns: `dispatch_id`, `task_type`, `phase` — insert `score.dispatchId ?? null`, `score.taskType ?? null`, `score.phase ?? null`
  - [ ] Update the `getEfficiencyScore(storyKey)` SELECT query to include the new columns and map them back: `dispatchId: row.dispatch_id ?? undefined`, etc.
  - [ ] Update `getEfficiencyScores(limit)` SELECT to filter `WHERE dispatch_id IS NULL` so it returns only story-level aggregates (backward compatible)
  - [ ] Add `getDispatchEfficiencyScores(storyKey: string)` method that queries `SELECT * FROM efficiency_scores WHERE story_key = ? AND dispatch_id IS NOT NULL ORDER BY timestamp ASC`, mapping rows to `EfficiencyScore` (same row-to-object mapping pattern as `getEfficiencyScore`)
  - [ ] Update the `EfficiencyScoreRow` interface (private type in adapter-persistence.ts) with three new optional fields: `dispatch_id: string | null`, `task_type: string | null`, `phase: string | null`
  - [ ] Add `getDispatchEfficiencyScores(storyKey: string): Promise<EfficiencyScore[]>` to the `ITelemetryPersistence` interface in `src/modules/telemetry/persistence.ts`
  - [ ] Add the method delegation in the `TelemetryPersistence` wrapper class

- [ ] Task 4: Update TelemetryPipeline to group turns by dispatchId and produce dispatch scores (AC: #2, #3, #5)
  - [ ] In `src/modules/telemetry/telemetry-pipeline.ts`, add a private helper `_groupTurnsByDispatchId(turns: TurnAnalysis[]): Map<string, TurnAnalysis[]>` that groups turns with non-null/non-undefined `dispatchId` by that value; turns without `dispatchId` are excluded from dispatch grouping
  - [ ] In `_processStoryFromTurns()`: after computing the story-level `efficiencyScore`, call `_groupTurnsByDispatchId(turns)`; if the map has any entries, score each group and build an array of dispatch `EfficiencyScore` objects using: `{ ...this._efficiencyScorer.score(storyKey, groupTurns), dispatchId, taskType: groupTurns[0]?.taskType, phase: groupTurns[0]?.phase, timestamp: baseTimestamp + index + 1 }` where `baseTimestamp = efficiencyScore.timestamp`
  - [ ] In `_processStory()`: apply the same dispatch-scoring logic after computing the story-level `efficiencyScore`
  - [ ] Update the `Promise.all([ ... ])` persistence block in both methods to include `storeEfficiencyScore` calls for each dispatch score (alongside the existing story-level call)
  - [ ] Update the log output at the end of `_processStoryFromTurns` to include `dispatchScores: dispatchScores.length`

- [ ] Task 5: Update CLI metrics --efficiency to display per-dispatch rows (AC: #7)
  - [ ] In `src/cli/commands/metrics.ts`, update `printEfficiencyTable()` to accept an additional parameter `dispatchScoresByStory: Map<string, EfficiencyScore[]>`
  - [ ] For each story row printed, look up dispatch scores by `s.storyKey`; if any exist, print each dispatch row immediately below the story row, indented with two extra spaces, with format: `    ↳ <taskType>/<phase> score=<N> cache=<X>% turns=<N>`
  - [ ] In the `efficiency === true` branch of `runMetricsAction()`: after fetching story-level scores, also call `getDispatchEfficiencyScores(s.storyKey)` for each story (or batch-fetch if a bulk method exists) and build the `Map<string, EfficiencyScore[]>` to pass to `printEfficiencyTable()`
  - [ ] JSON output format: include dispatch scores under each story record as `dispatchScores: EfficiencyScore[]` (or keep existing flat structure — JSON consumers can filter by `dispatchId` presence)

- [ ] Task 6: Tests (AC: #2, #3, #5, #6)
  - [ ] Add tests in `src/modules/telemetry/__tests__/telemetry-pipeline.test.ts`: mock turns with mixed `dispatchId` values (3 turns with `dispatchId: 'dispatch-1'`, 2 with `dispatchId: 'dispatch-2'`, 1 with no `dispatchId`); verify `storeEfficiencyScore` is called 3 times (1 story aggregate + 2 dispatch scores); verify dispatch score objects carry the correct `dispatchId`, `taskType`, `phase`
  - [ ] Add test: turns with no `dispatchId` at all → only 1 call to `storeEfficiencyScore` (backward compat)
  - [ ] Add test: timestamp offsets are unique — dispatch scores have `timestamp = storyScore.timestamp + index + 1`
  - [ ] In `src/modules/telemetry/__tests__/efficiency-scores.integration.test.ts`: add tests for `getDispatchEfficiencyScores(storyKey)` — store a story aggregate + two dispatch scores, verify `getDispatchEfficiencyScores` returns only the 2 dispatch scores; verify `getEfficiencyScores(20)` returns only the story aggregate; verify dispatch scores round-trip with `dispatchId`, `taskType`, `phase` intact

## Dev Notes

### Architecture Constraints

- **File locations** (must match exactly):
  - Types: `src/modules/telemetry/types.ts` — extend `EfficiencyScoreSchema` (3 optional fields)
  - Schema: `src/modules/state/schema.sql` — add nullable columns to `efficiency_scores`
  - Adapter persistence: `src/modules/telemetry/adapter-persistence.ts` — update INSERT/SELECT, add `getDispatchEfficiencyScores`
  - Persistence interface: `src/modules/telemetry/persistence.ts` — add `getDispatchEfficiencyScores` to `ITelemetryPersistence` and `TelemetryPersistence` wrapper
  - Pipeline: `src/modules/telemetry/telemetry-pipeline.ts` — dispatch grouping and scoring in `_processStory` and `_processStoryFromTurns`
  - CLI: `src/cli/commands/metrics.ts` — update `printEfficiencyTable` and the `efficiency === true` branch

- **Import style**: All imports use `.js` extensions (ESM). No new external dependencies — this story only touches existing modules.
- **Test framework**: Vitest — use `vi.mock`, `vi.fn()`, `describe`/`it`/`expect`. Do NOT use jest APIs.
- **EfficiencyScorer is unchanged**: Do NOT modify `src/modules/telemetry/efficiency-scorer.ts`. The formula, `score()` signature, and return type are unchanged. Dispatch context fields are attached by TelemetryPipeline after calling `score()`.

### Timestamp Collision Avoidance

The `efficiency_scores` PRIMARY KEY is `(story_key, timestamp)`. When TelemetryPipeline calls `EfficiencyScorer.score()` multiple times rapidly (once per dispatch group), all calls resolve within the same millisecond, producing identical `timestamp: Date.now()` values, causing PK conflicts on INSERT.

**Solution**: Assign timestamps explicitly in TelemetryPipeline, not inside `EfficiencyScorer.score()`. Capture `baseTimestamp = Date.now()` once, then:
- Story aggregate: `{ ...storyScore, timestamp: baseTimestamp }`
- Dispatch score 0: `{ ...dispatchScore, timestamp: baseTimestamp + 1 }`
- Dispatch score 1: `{ ...dispatchScore, timestamp: baseTimestamp + 2 }`
- etc.

This ensures unique `(story_key, timestamp)` pairs within each processing batch.

### Grouping Logic

```typescript
private _groupTurnsByDispatchId(turns: TurnAnalysis[]): Map<string, TurnAnalysis[]> {
  const groups = new Map<string, TurnAnalysis[]>()
  for (const turn of turns) {
    if (!turn.dispatchId) continue  // skip turns without dispatch context
    const existing = groups.get(turn.dispatchId)
    if (existing) {
      existing.push(turn)
    } else {
      groups.set(turn.dispatchId, [turn])
    }
  }
  return groups
}
```

Only groups dispatch IDs with at least one turn. Turns without `dispatchId` still contribute to the story-level aggregate score but are not scored separately.

### Schema Migration Pattern

Check the `_schema_version` inserts in `schema.sql` for the next version number. Add `ALTER TABLE` statements in the migration block after the existing efficiency_scores-related schema version insert. Use this pattern (already used for turn_analysis columns in 30-1):

```sql
ALTER TABLE efficiency_scores ADD COLUMN dispatch_id TEXT;
ALTER TABLE efficiency_scores ADD COLUMN task_type TEXT;
ALTER TABLE efficiency_scores ADD COLUMN phase TEXT;

INSERT IGNORE INTO _schema_version (version, description) VALUES (N, 'Add dispatch context columns to efficiency_scores (Epic 30-3)');
```

The `CREATE TABLE IF NOT EXISTS efficiency_scores (...)` block must also include the new columns for fresh database initialization.

### CLI Display Format

Current output (no per-dispatch breakdown):
```
  Story Key       Score   Cache Hit%  I/O Ratio  Ctx Mgmt Model
  5-1                85        80.0%       1.50         95 claude-sonnet-4-5
```

New output with dispatch breakdown:
```
  Story Key       Score   Cache Hit%  I/O Ratio  Ctx Mgmt Model
  5-1                85        80.0%       1.50         95 claude-sonnet-4-5
    ↳ dev-story/dispatch    92   85.0%
    ↳ code-review/dispatch  78   75.2%
```

The `↳` rows use a narrower format (label + score + cache%) since they're secondary detail. Show at most 5 dispatch rows per story to avoid table bloat. Only show dispatch breakdown in text format — JSON output can return the full structure.

### Testing Requirements

- **Test framework**: Vitest — test files must use `.test.ts` extension
- **Integration tests**: Use `createWasmSqliteAdapter()` for in-memory SQLite — see `efficiency-scores.integration.test.ts` for the pattern
- **Coverage**: 80% threshold enforced — all new branches (dispatch present, dispatch absent, empty group, timestamp offset) must be covered
- **Run tests**: `npm run test:fast` — never pipe output; confirm results by looking for "Test Files" in output
- **Targeted run during dev**: `npm run test:changed`

### Scope Boundaries

- **In scope**: Type extension, schema migration, persistence methods, pipeline grouping/scoring, CLI display
- **Out of scope**: Modifying `EfficiencyScorer` internals; changing the per-model or per-source breakdown logic; adding dispatch efficiency to any CLI mode other than `--efficiency`; TelemetryAdvisor dispatch query (`getDispatchEfficiency()`) — that's story 30-6

## Interface Contracts

- **Export**: Extended `EfficiencyScore` (with optional `dispatchId`, `taskType`, `phase`) @ `src/modules/telemetry/types.ts` — consumed by story 30-6 (`TelemetryAdvisor.getDispatchEfficiency()`) and story 30-7 (cache delta regression rule which reads consecutive dispatch scores)
- **Export**: `getDispatchEfficiencyScores(storyKey: string): Promise<EfficiencyScore[]>` @ `src/modules/telemetry/persistence.ts` (ITelemetryPersistence interface) — consumed by story 30-7 (to compute cache delta between consecutive dispatches) and story 30-8 (retry-escalated command)
- **Import**: `TurnAnalysis` @ `src/modules/telemetry/types.ts` — requires `dispatchId`, `taskType`, `phase` optional fields added in story 30-1

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
