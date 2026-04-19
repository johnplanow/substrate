# Story 27-5: Semantic Categorization + Context Consumers

Status: ready-for-dev

## Story

As a substrate pipeline operator,
I want token consumption classified by semantic category and grouped by context consumer,
so that I can see *what* agent tokens were spent on (file reads, tool outputs, system prompts, etc.) and identify the top consumers driving context growth.

## Acceptance Criteria

### AC1: Semantic Category Types and CategoryStats / ConsumerStats Definitions
**Given** the telemetry module is imported
**When** a consumer references `SemanticCategory`, `CategoryStats`, `ConsumerStats`, `TopInvocation`, and `Trend`
**Then** all types are exported from `src/modules/telemetry/types.ts`:
- `SemanticCategory` is a union/enum of `'tool_outputs' | 'file_reads' | 'system_prompts' | 'conversation_history' | 'user_prompts' | 'other'`
- `Trend` is `'growing' | 'stable' | 'shrinking'`
- `CategoryStatsSchema` is a Zod schema with fields: `category: SemanticCategory`, `totalTokens: number`, `percentage: number`, `eventCount: number`, `avgTokensPerEvent: number`, `trend: Trend`; TypeScript type `CategoryStats` is derived via `z.infer<>`
- `TopInvocationSchema` has fields: `spanId: string`, `name: string`, `toolName: string (optional)`, `totalTokens: number`, `inputTokens: number`, `outputTokens: number`; type `TopInvocation` derived via `z.infer<>`
- `ConsumerStatsSchema` has fields: `consumerKey: string`, `category: SemanticCategory`, `totalTokens: number`, `percentage: number`, `eventCount: number`, `topInvocations: TopInvocation[]` (max 20); type `ConsumerStats` derived via `z.infer<>`

### AC2: Three-Tier Classification Logic
**Given** an operation name string and optional tool name
**When** `Categorizer.classify(operationName: string, toolName?: string): SemanticCategory` is called
**Then** classification proceeds through three tiers in order, returning on the first match:
1. **Exact match**: lookup table of operation names → category (e.g. `'read_file' → file_reads`, `'system_prompt' → system_prompts`, `'human_turn' → user_prompts`, `'assistant_turn' → conversation_history`)
2. **Prefix pattern**: regex patterns applied to `operationName` (e.g. `^tool\b` or `/^(bash|exec|run)/i` → `tool_outputs`, `/^(read|cat|open).*file/i` → `file_reads`)
3. **Fuzzy substring**: case-insensitive substring search (e.g. contains `'file'` and (`'read'` or `'open'`) → `file_reads`; contains `'system'` or `'prompt'` → `system_prompts`; contains `'bash'` or `'exec'` or `'tool'` → `tool_outputs`)
4. **Fallback**: returns `'other'`; `toolName` presence (non-empty) always overrides fallback to `'tool_outputs'` if tier 1-3 all miss

### AC3: Per-Category Token Statistics Calculation
**Given** a list of `NormalizedSpan[]` for a story and a `TurnAnalysis[]` sequence (may be empty)
**When** `Categorizer.computeCategoryStats(spans: NormalizedSpan[], turns: TurnAnalysis[]): CategoryStats[]` is called
**Then** all six `SemanticCategory` values are present in the result (zero-token categories included with `totalTokens: 0`), each entry has correctly computed `totalTokens = sum(inputTokens + outputTokens)` for all spans in that category, `percentage = (categoryTokens / grandTotal) * 100` (0 if grandTotal is 0), `eventCount = count of spans in category`, `avgTokensPerEvent = totalTokens / eventCount` (0 if eventCount is 0), and `trend` computed per AC5; results are sorted by `totalTokens` descending

### AC4: Context Consumer Grouping and Ranking
**Given** a list of `NormalizedSpan[]` for a story
**When** `ConsumerAnalyzer.analyze(spans: NormalizedSpan[]): ConsumerStats[]` is called
**Then** spans are grouped by a `consumerKey = operationName + '|' + (toolName ?? '')`, each group's category is determined by calling `Categorizer.classify(operationName, toolName)`, each `ConsumerStats` has `totalTokens = sum(inputTokens + outputTokens)` for the group, `percentage = (groupTokens / grandTotal) * 100`, `eventCount = span count in group`, and `topInvocations` is the top 20 spans from the group sorted by `(inputTokens + outputTokens)` descending (each mapped to `TopInvocation`); the final array is sorted by `totalTokens` descending; `ConsumerStats` with `totalTokens === 0` are excluded

### AC5: Trend Detection Using Turn-Ordered Span Attribution
**Given** a `TurnAnalysis[]` and a set of spans classified into a category
**When** trend is computed for a category via `Categorizer.computeTrend(categorySpans: NormalizedSpan[], turns: TurnAnalysis[]): Trend`
**Then**:
- If `turns` is empty or has fewer than 2 turns, return `'stable'`
- Attribute each span to a turn by matching `span.spanId` against `turn.spanId` or `turn.childSpans[].spanId`; unmatched spans are attributed by timestamp (assigned to the turn with the closest `startTime ≤ span.startTime`)
- Split turns into first half (indices `0..(N/2 - 1)`) and second half (indices `N/2..N-1`)
- Sum `totalTokens` for category spans attributed to each half
- If `secondHalfTokens > 1.2 × firstHalfTokens` → `'growing'`; if `secondHalfTokens < 0.8 × firstHalfTokens` → `'shrinking'`; otherwise `'stable'`; if `firstHalfTokens === 0 && secondHalfTokens === 0` → `'stable'`

### AC6: Dolt Schema Extension and Persistence for Category / Consumer Data
**Given** category and consumer analysis results for a story
**When** `telemetryRepository.storeCategoryStats(storyKey: string, stats: CategoryStats[]): Promise<void>` and `telemetryRepository.storeConsumerStats(storyKey: string, consumers: ConsumerStats[]): Promise<void>` are called
**Then**:
- Rows are batch-inserted into `category_stats` (columns: `story_key`, `category`, `total_tokens`, `percentage`, `event_count`, `avg_tokens_per_event`, `trend`) using `INSERT IGNORE` with a single Dolt commit per call
- Rows are batch-inserted into `consumer_stats` (columns: `story_key`, `consumer_key`, `category`, `total_tokens`, `percentage`, `event_count`, `top_invocations_json`) similarly
- `getCategoryStats(storyKey: string): Promise<CategoryStats[]>` returns rows ordered by `total_tokens DESC` with Zod validation on each row
- `getConsumerStats(storyKey: string): Promise<ConsumerStats[]>` returns rows ordered by `total_tokens DESC` with `top_invocations_json` deserialized
- Both getter methods return an empty array if no rows exist for the given `storyKey`

## Tasks / Subtasks

- [ ] Task 1: Add type definitions to `src/modules/telemetry/types.ts` (AC: #1)
  - [ ] Define `SemanticCategory` as a Zod enum: `z.enum(['tool_outputs', 'file_reads', 'system_prompts', 'conversation_history', 'user_prompts', 'other'])`; derive TypeScript type via `z.infer<>`
  - [ ] Define `Trend` as `z.enum(['growing', 'stable', 'shrinking'])`; derive TypeScript type
  - [ ] Define `TopInvocationSchema` Zod object with all required fields; derive `TopInvocation` type
  - [ ] Define `CategoryStatsSchema` Zod object with all fields from AC1; derive `CategoryStats` type
  - [ ] Define `ConsumerStatsSchema` Zod object with `topInvocations: z.array(TopInvocationSchema).max(20)` and all fields from AC1; derive `ConsumerStats` type
  - [ ] Export all new types and schemas from `src/modules/telemetry/index.ts`

- [ ] Task 2: Implement `Categorizer` class in `src/modules/telemetry/categorizer.ts` (AC: #2)
  - [ ] Constructor: `new Categorizer(logger: ILogger)` — follow constructor injection pattern
  - [ ] Define exact-match lookup table as a `Map<string, SemanticCategory>` constant at module scope (at least 12 entries covering common Claude Code operation names: `read_file`, `write_file`, `bash`, `tool_use`, `system_prompt`, `human_turn`, `assistant_turn`, `search_files`, `list_files`, `run_command`, `memory_read`, `web_fetch`)
  - [ ] Define prefix pattern array: `Array<{ pattern: RegExp; category: SemanticCategory }>` at module scope
  - [ ] Implement `classify(operationName: string, toolName?: string): SemanticCategory` per AC2 three-tier logic + toolName override fallback
  - [ ] `computeTrend` is a public method on `Categorizer` per AC5 specification
  - [ ] `computeCategoryStats(spans: NormalizedSpan[], turns: TurnAnalysis[]): CategoryStats[]` — classify each span, accumulate tokens per category, compute percentages, call `computeTrend` per category, return all 6 categories sorted by `totalTokens` desc

- [ ] Task 3: Implement `ConsumerAnalyzer` class in `src/modules/telemetry/consumer-analyzer.ts` (AC: #4)
  - [ ] Constructor: `new ConsumerAnalyzer(categorizer: Categorizer, logger: ILogger)` — inject `Categorizer` dependency
  - [ ] `analyze(spans: NormalizedSpan[]): ConsumerStats[]` — group by `consumerKey`, compute per-group totals, derive category from `categorizer.classify`, select top 20 invocations per group, exclude zero-token groups, sort by `totalTokens` desc
  - [ ] Helper: `private buildConsumerKey(span: NormalizedSpan): string` — returns `(span.operationName ?? span.name) + '|' + (toolNameFromAttributes(span) ?? '')`
  - [ ] Helper: `private extractToolName(span: NormalizedSpan): string | undefined` — checks `span.attributes['tool.name']`, `span.attributes['llm.tool.name']`, `span.attributes['claude.tool_name']` in priority order

- [ ] Task 4: Implement trend detection in `Categorizer` (AC: #5)
  - [ ] `computeTrend(categorySpans: NormalizedSpan[], turns: TurnAnalysis[]): Trend`
  - [ ] Build span-to-turn attribution map: for each turn, collect direct `turn.spanId` and all `child.spanId` from `turn.childSpans`; any span not matched by ID is attributed by closest preceding turn timestamp (binary search or linear scan by `startTime`)
  - [ ] Split turns into two halves: `firstHalf = turns.slice(0, Math.floor(turns.length / 2))`, `secondHalf = turns.slice(Math.floor(turns.length / 2))`
  - [ ] Sum `totalTokens = span.inputTokens + span.outputTokens` for spans attributed to each half
  - [ ] Apply threshold comparisons per AC5 to return `Trend`
  - [ ] Edge cases: single turn, all turns zero tokens → `'stable'`; handle `turns.length === 0` guard

- [ ] Task 5: Extend Dolt schema with `category_stats` and `consumer_stats` tables in `src/modules/state/schema.sql` (AC: #6)
  - [ ] Add `category_stats` table: `story_key VARCHAR(100) NOT NULL`, `category VARCHAR(30) NOT NULL`, `total_tokens BIGINT NOT NULL DEFAULT 0`, `percentage DECIMAL(6,3) NOT NULL DEFAULT 0`, `event_count INTEGER NOT NULL DEFAULT 0`, `avg_tokens_per_event DECIMAL(12,2) NOT NULL DEFAULT 0`, `trend VARCHAR(10) NOT NULL DEFAULT 'stable'`, `PRIMARY KEY (story_key, category)`
  - [ ] Add `consumer_stats` table: `story_key VARCHAR(100) NOT NULL`, `consumer_key VARCHAR(300) NOT NULL`, `category VARCHAR(30) NOT NULL`, `total_tokens BIGINT NOT NULL DEFAULT 0`, `percentage DECIMAL(6,3) NOT NULL DEFAULT 0`, `event_count INTEGER NOT NULL DEFAULT 0`, `top_invocations_json TEXT`, `PRIMARY KEY (story_key, consumer_key)`
  - [ ] Add index: `CREATE INDEX IF NOT EXISTS idx_category_stats_story ON category_stats (story_key, total_tokens)`
  - [ ] Add index: `CREATE INDEX IF NOT EXISTS idx_consumer_stats_story ON consumer_stats (story_key, total_tokens)`
  - [ ] Increment schema version seed to `version = 3` (or next appropriate value): `INSERT IGNORE INTO _schema_version (version, description) VALUES (3, 'Add category_stats and consumer_stats tables (Epic 27-5)')`

- [ ] Task 6: Add persistence methods to `TelemetryRepository` in `src/modules/telemetry/persistence.ts` (AC: #6)
  - [ ] Extend `ITelemetryPersistence` interface with: `storeCategoryStats`, `getCategoryStats`, `storeConsumerStats`, `getConsumerStats`
  - [ ] `storeCategoryStats(storyKey: string, stats: CategoryStats[]): Promise<void>` — skip if empty; bulk `INSERT IGNORE` all rows in one statement; issue single Dolt commit with message `"telemetry: store category stats for ${storyKey}"`
  - [ ] `getCategoryStats(storyKey: string): Promise<CategoryStats[]>` — SELECT WHERE `story_key = ?` ORDER BY `total_tokens DESC`; validate each row with `CategoryStatsSchema.parse()`; return `[]` if none
  - [ ] `storeConsumerStats(storyKey: string, consumers: ConsumerStats[]): Promise<void>` — serialize `topInvocations` to JSON string; bulk INSERT IGNORE; single Dolt commit
  - [ ] `getConsumerStats(storyKey: string): Promise<ConsumerStats[]>` — SELECT WHERE `story_key = ?` ORDER BY `total_tokens DESC`; deserialize `top_invocations_json` with `JSON.parse`; validate each row with `ConsumerStatsSchema.parse()`; return `[]` if none
  - [ ] Prepare all INSERT/SELECT statements at construction time following the existing pattern in `TelemetryRepository`

- [ ] Task 7: Wire categorizer into post-story telemetry pipeline (AC: #3, #4, #6)
  - [ ] Find the same wiring location used by story 27-4 (where `turnAnalyzer.analyze(spans)` is called after story completion)
  - [ ] After `storeTurnAnalysis`, instantiate (or reuse) `Categorizer` and `ConsumerAnalyzer`, call `computeCategoryStats(spans, turns)` and `consumerAnalyzer.analyze(spans)`, then call `storeCategoryStats` and `storeConsumerStats`
  - [ ] Guard: skip if `spans` is empty (no telemetry data)
  - [ ] Log info-level summary: top category name, top consumer key, total categories with trend `'growing'`

- [ ] Task 8: Unit tests for `Categorizer` and `ConsumerAnalyzer` (AC: #2, #3, #4, #5)
  - [ ] File: `src/modules/telemetry/__tests__/categorizer.test.ts`
  - [ ] Test: exact match — `'read_file'` → `'file_reads'`, `'bash'` → `'tool_outputs'`, `'system_prompt'` → `'system_prompts'`, `'human_turn'` → `'user_prompts'`, `'assistant_turn'` → `'conversation_history'`
  - [ ] Test: prefix pattern fallback — `'tool_result'` not in exact map but matches prefix pattern → `'tool_outputs'`
  - [ ] Test: fuzzy substring fallback — `'read_partial_file'` → `'file_reads'` (contains "file" and "read")
  - [ ] Test: toolName override — unknown operation name + non-empty toolName → `'tool_outputs'`
  - [ ] Test: fallback — empty operation name, no toolName → `'other'`
  - [ ] Test: `computeCategoryStats` returns all 6 categories even when some have zero spans
  - [ ] Test: `computeCategoryStats` correctly computes percentage (sums to 100 for all-positive categories)
  - [ ] Test: trend `growing` when second half tokens > 1.2× first half
  - [ ] Test: trend `shrinking` when second half tokens < 0.8× first half
  - [ ] Test: trend `stable` for zero-turn input
  - [ ] File: `src/modules/telemetry/__tests__/consumer-analyzer.test.ts`
  - [ ] Test: spans with same operation+tool grouped into single ConsumerStats
  - [ ] Test: top 20 cap — 25 spans in one group → only 20 topInvocations returned
  - [ ] Test: zero-token spans excluded from results
  - [ ] Test: results sorted by totalTokens descending

## Dev Notes

### Architecture Constraints
- **Constructor injection**: both `Categorizer` and `ConsumerAnalyzer` accept `ILogger` — never instantiate logger inside the class; `ConsumerAnalyzer` also accepts `Categorizer` via constructor injection
- **Zod-first types**: define `CategoryStatsSchema`, `ConsumerStatsSchema`, `TopInvocationSchema` as Zod schemas; derive TypeScript types via `z.infer<>`; validate on DB read boundary using `schema.parse()`
- **Repository extension**: all new persistence methods go on the **existing** `TelemetryRepository` concrete class and `ITelemetryPersistence` interface from story 27-3. Do NOT create separate repository classes
- **No external dependencies**: `Categorizer` and `ConsumerAnalyzer` depend only on types from `src/modules/telemetry/types.ts` and the logger — zero new npm packages
- **Import order**: Node built-ins first, third-party second, internal modules (relative paths) third — blank line between each group; use `.js` extension on all internal imports
- **Lookup table as module constant**: the exact-match lookup table and prefix-pattern array must be defined as module-scope constants (not inside the class constructor) to avoid recreation on every `classify()` call
- **Prepared statements at construction time**: follow the existing pattern in `TelemetryRepository` — all INSERT/SELECT statements are prepared once at class construction

### File Paths
```
src/modules/telemetry/
  types.ts                          ← MODIFY: add SemanticCategory, Trend, CategoryStats, ConsumerStats, TopInvocation schemas/types
  categorizer.ts                    ← NEW: Categorizer class
  consumer-analyzer.ts              ← NEW: ConsumerAnalyzer class
  persistence.ts                    ← MODIFY: add 4 new methods to ITelemetryPersistence + TelemetryRepository
  index.ts                          ← MODIFY: export new public types + classes
  __tests__/
    categorizer.test.ts             ← NEW: unit tests for Categorizer
    consumer-analyzer.test.ts       ← NEW: unit tests for ConsumerAnalyzer
src/modules/state/
  schema.sql                        ← MODIFY: add category_stats + consumer_stats tables + indexes + v3 seed
```

### Exact-Match Lookup Table (Starter Set)
```typescript
const EXACT_CATEGORY_MAP = new Map<string, SemanticCategory>([
  ['read_file', 'file_reads'],
  ['write_file', 'tool_outputs'],
  ['bash', 'tool_outputs'],
  ['tool_use', 'tool_outputs'],
  ['tool_result', 'tool_outputs'],
  ['system_prompt', 'system_prompts'],
  ['human_turn', 'user_prompts'],
  ['user_message', 'user_prompts'],
  ['assistant_turn', 'conversation_history'],
  ['assistant_message', 'conversation_history'],
  ['search_files', 'file_reads'],
  ['list_files', 'file_reads'],
  ['run_command', 'tool_outputs'],
  ['memory_read', 'system_prompts'],
  ['web_fetch', 'tool_outputs'],
]);
```

### Prefix Pattern Array (Starter Set)
```typescript
const PREFIX_PATTERNS: Array<{ pattern: RegExp; category: SemanticCategory }> = [
  { pattern: /^(bash|exec|run|spawn)/i, category: 'tool_outputs' },
  { pattern: /^(read|open|cat|head|tail).*file/i, category: 'file_reads' },
  { pattern: /^(list|glob|find).*file/i, category: 'file_reads' },
  { pattern: /^tool/i, category: 'tool_outputs' },
  { pattern: /^system/i, category: 'system_prompts' },
  { pattern: /^(human|user)/i, category: 'user_prompts' },
  { pattern: /^(assistant|ai|model)/i, category: 'conversation_history' },
];
```

### Trend Detection — Turn Attribution Algorithm
For spans that don't directly match a `turn.spanId` or `turn.childSpans[].spanId`:
- Build a sorted array of turn `startTime` values
- For each unmatched span, find the last turn whose `startTime ≤ span.startTime` (lower-bound binary search or `findLastIndex`)
- If no turn precedes the span, attribute it to turn index 0
- This O(N log M) attribution runs once per story; N = spans, M = turns

```typescript
function attributeSpanToTurnIndex(spanStartTime: number, turns: TurnAnalysis[]): number {
  let lo = 0, hi = turns.length - 1, result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (turns[mid].timestamp <= spanStartTime) { result = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}
```

### ConsumerKey Design
The `consumerKey` must be stable and collision-resistant:
```typescript
const operationPart = (span.operationName ?? span.name ?? 'unknown').slice(0, 200);
const toolPart = (toolName ?? '').slice(0, 100);
const consumerKey = `${operationPart}|${toolPart}`;
```
No URL-encoding or hashing needed — Dolt VARCHAR(300) handles the pipe-delimited key.

### Percentage Calculation
Guard against division-by-zero for both category stats and consumer stats:
```typescript
const percentage = grandTotal > 0 ? (totalTokens / grandTotal) * 100 : 0;
```
Round to 3 decimal places when storing (`Math.round(pct * 1000) / 1000`).

### Testing Requirements
- **Mocking**: unit tests must NOT touch SQLite or Dolt; inject mock `ILogger` via `vi.fn()` stubs; pass mock `Categorizer` to `ConsumerAnalyzer` unit tests using a `vi.fn()` stub for `classify()`
- **Coverage**: ≥80% branch and line coverage for `categorizer.ts` and `consumer-analyzer.ts`
- **Test naming**: `describe('Categorizer') → describe('classify()') → it('should ...')`; use `describe.each` for the lookup-table tier tests
- **Test framework**: vitest — `import { describe, it, expect, vi, beforeEach } from 'vitest'`; NO jest APIs

## Interface Contracts

- **Import**: `NormalizedSpan` @ `src/modules/telemetry/types.ts` (from story 27-2)
- **Import**: `TurnAnalysis`, `ChildSpanSummary` @ `src/modules/telemetry/types.ts` (from story 27-4)
- **Import**: `ITelemetryPersistence`, `TelemetryRepository` @ `src/modules/telemetry/persistence.ts` (from story 27-3)
- **Export**: `SemanticCategory` @ `src/modules/telemetry/types.ts` (consumed by stories 27-6, 27-7, 27-8)
- **Export**: `CategoryStats` @ `src/modules/telemetry/types.ts` (consumed by stories 27-6, 27-7, 27-8)
- **Export**: `ConsumerStats`, `TopInvocation` @ `src/modules/telemetry/types.ts` (consumed by stories 27-7, 27-8)
- **Export**: `Categorizer` @ `src/modules/telemetry/categorizer.ts` (consumed by stories 27-7, 27-8)
- **Export**: `ConsumerAnalyzer` @ `src/modules/telemetry/consumer-analyzer.ts` (consumed by story 27-8)
- **Export**: `getCategoryStats`, `getConsumerStats` on `ITelemetryPersistence` @ `src/modules/telemetry/persistence.ts` (consumed by stories 27-7, 27-8)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
