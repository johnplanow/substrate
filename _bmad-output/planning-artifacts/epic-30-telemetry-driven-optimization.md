# Epic 30: Telemetry-Driven Optimization

**Status: PLANNED — Ready for development (Epics 27, 28 complete)**

## Vision

Close the gap between telemetry observation and pipeline optimization. Epics 27 and 28 built the telescope — ingestion, normalization, turn analysis, efficiency scoring, categorization, recommendations, and model routing. But the data sits in tables waiting for humans to query it. This epic makes the telemetry system **self-acting**: enriching data with dispatch context, computing recommendations during pipeline runs (not after), and injecting optimization directives into subsequent dispatches automatically.

The key architectural shift: telemetry becomes a **read-write feedback loop** instead of a **write-only data lake**. The orchestrator reads telemetry from story N to improve dispatches for story N+1 within the same pipeline run.

Source: Cross-project validation on ynab (2026-03-12) revealed that while telemetry data is now correct (v0.4.11), it lacks dispatch-level granularity and has no automated action path. Research council synthesis identified "caching strategies" as the major unsolved gap — this epic operationalizes the caching and efficiency data we're already collecting.

## Rationale

### What we have (Epics 27-28)

- OTLP ingestion server capturing Claude Code logs/metrics during every pipeline run
- LogTurnAnalyzer producing per-turn token breakdowns with cache hit rates
- EfficiencyScorer computing composite 0-100 scores from cache, I/O ratio, and context management
- Categorizer classifying operations into 6 semantic categories
- Recommender with 8 heuristic rules generating actionable insights
- RoutingTuner auto-downgrading models based on output ratio (only closed loop today)
- CLI commands exposing all data: `metrics --efficiency`, `--turns`, `--categories`, `--recommendations`

### What's missing

1. **Dispatch context**: Turns are all `name: "api_request"` with no task_type/phase. We can't tell dev-story turns from code-review turns. Category stats are 100% homogeneous.
2. **Pipeline-time recommendations**: Recommendations only generate on CLI query (`metrics --recommendations`), not during the pipeline run. They can't influence subsequent dispatches.
3. **Feedback injection**: No mechanism to read telemetry insights and inject optimization directives into the next dispatch's system prompt.
4. **Per-dispatch granularity**: Efficiency scores are per-story aggregates. A story with 3 dispatches gets one score — cache regressions between dispatches are invisible.
5. **Log-only path gaps**: `_processStoryFromTurns` was missing category stats (fixed in v0.4.11) and still lacks consumer stats and recommendation generation.

### Why now

- Telemetry data quality was just validated (v0.4.10-v0.4.11 fixes)
- The ynab cross-project target has accumulated real production data
- Every feature builds on existing infrastructure — no new ingestion, no new OTLP endpoints, no new tables (just new columns)
- The RoutingTuner proves the pattern: read telemetry → modify config → improve next run. This epic generalizes that pattern.

## Scope

### In Scope

- Dispatch context injection: tag OTLP turns with task_type, phase, and dispatch_id from the orchestrator
- Task-type-aware categorization: use dispatch context as primary classification signal
- Per-dispatch efficiency scoring: one efficiency score per dispatch, not just per story
- Log-only path full parity: consumer stats + recommendations in `_processStoryFromTurns`
- Pipeline-time recommendation generation: compute and persist during the run
- Recommendation-to-prompt injection: read story N recommendations, inject directives into story N+1 dispatch
- Cache delta regression detection: flag when consecutive dispatches show >30pp cache rate drop
- Efficiency-gated retry decisions: check efficiency profile before retrying escalated stories

### Out of Scope

- Web UI / dashboard (future)
- Cross-run statistical learning (not enough data yet — need 100+ runs)
- Automatic prompt rewriting / template reordering (future — requires prompt structure refactoring)
- Codex/Gemini telemetry enrichment (start with Claude Code only)
- Real-time mid-dispatch intervention (future — current architecture is post-dispatch)

## Architecture

### Dispatch Context Flow (Story 30-1)

```
Orchestrator prepares dispatch for storyKey + taskType + phase
  → ingestionServer.setActiveDispatch(storyKey, { taskType, phase, dispatchId })
  → ClaudeCodeAdapter spawns sub-agent with OTLP env vars
  → Claude Code sends OTLP logs to IngestionServer
  → IngestionServer stamps buffered payloads with activeDispatch context
  → TelemetryNormalizer propagates context to NormalizedLog
  → LogTurnAnalyzer copies to TurnAnalysis
  → Persistence writes to turn_analysis with task_type, phase, dispatch_id columns
  → Orchestrator calls ingestionServer.clearActiveDispatch(storyKey)
```

Concurrency: keyed on storyKey (each story dispatches sequentially through phases).

### Feedback Loop Flow (Stories 30-5, 30-6)

```
Story N completes → TelemetryPipeline processes turns
  → Recommender generates recommendations → persists to DB
  → Story N+1 dispatch preparation begins
  → Orchestrator reads recommendations for story N via TelemetryAdvisor
  → TelemetryAdvisor formats optimization directives
  → ContextCompiler injects directives into system prompt
  → Story N+1 sub-agent receives optimized prompt
```

### New Interface: TelemetryAdvisor

Thin service wrapping TelemetryPersistence reads:

```typescript
interface TelemetryAdvisor {
  getRecommendationsForStory(storyKey: string): Recommendation[]
  getEfficiencyProfile(storyKey: string): EfficiencyScore | null
  getDispatchEfficiency(dispatchId: string): EfficiencyScore | null
  formatOptimizationDirectives(recommendations: Recommendation[]): string
}
```

Keeps orchestrator decoupled from SQLite/Dolt schema details. Testable with mock implementations.

## Story Map

```
Sprint 1 — Data Enrichment & Parity (P0/P1):
  Story 30-1: Dispatch Context Injection into OTLP Turns (P0, L)
  Story 30-2: Task-Type-Aware Categorization (P1, M)
  Story 30-3: Per-Dispatch Efficiency Scoring (P1, M)
  Story 30-4: Log-Only Path Parity Audit (P0, M)

Sprint 2 — Closed-Loop Optimization (P1):
  Story 30-5: Pipeline-Time Recommendation Generation (P1, M)
  Story 30-6: Recommendation-to-Prompt Injection (P1, L)
  Story 30-7: Cache Delta Regression Detection (P2, S)
  Story 30-8: Efficiency-Gated Retry Decisions (P2, M)
```

## Story Details

### Story 30-1: Dispatch Context Injection into OTLP Turns (P0, L)

**Problem:** Every turn in turn_analysis has `name: "api_request"` with no indication of which pipeline phase or task type produced it. A story with 3 dispatches (create-story, dev-story, code-review) shows as a flat list of identical turns. This makes per-phase analysis impossible.

**Acceptance Criteria:**
- AC1: IngestionServer exposes `setActiveDispatch(storyKey, context)` and `clearActiveDispatch(storyKey)` methods. Context includes `taskType`, `phase`, and `dispatchId`.
- AC2: Orchestrator calls `setActiveDispatch` before each dispatch and `clearActiveDispatch` after dispatch completes (including error paths).
- AC3: IngestionServer stamps each buffered payload with the active dispatch context for its storyKey (matched via `substrate.story_key` resource attribute).
- AC4: TelemetryNormalizer propagates `taskType`, `phase`, `dispatchId` fields to `NormalizedLog`.
- AC5: LogTurnAnalyzer copies dispatch context fields to TurnAnalysis output.
- AC6: turn_analysis table schema extended with `task_type TEXT`, `phase TEXT`, `dispatch_id TEXT` columns (nullable for backward compatibility).
- AC7: `substrate metrics --turns <storyKey>` displays task_type and phase per turn.
- AC8: Concurrent dispatches (different storyKeys) are correctly isolated — dispatch context is keyed by storyKey, not global.
- AC9: Payloads arriving with no matching active dispatch context retain null dispatch fields (graceful degradation).

**Dev Notes:**
- IngestionServer maintains `Map<string, DispatchContext>` — set/clear keyed on storyKey
- BatchBuffer stamps payloads in the HTTP handler, before buffering
- Schema migration adds 3 nullable columns to turn_analysis
- Test with concurrent dispatches to verify isolation

**Tasks:**
- [ ] Add `setActiveDispatch` / `clearActiveDispatch` to IngestionServer
- [ ] Wire orchestrator to call set/clear around every dispatch call site
- [ ] Extend NormalizedLog type with optional taskType, phase, dispatchId
- [ ] Extend TurnAnalysis type with optional taskType, phase, dispatchId
- [ ] Update TelemetryNormalizer to propagate dispatch context
- [ ] Update LogTurnAnalyzer to copy dispatch context to output
- [ ] Schema migration: add columns to turn_analysis
- [ ] Update persistence to write new columns
- [ ] Update CLI metrics --turns to display new columns
- [ ] Tests: unit tests for set/clear, integration test for context flow, concurrent dispatch isolation

---

### Story 30-2: Task-Type-Aware Categorization (P1, M)

**Problem:** Category stats are 100% `conversation_history` because all Claude Code OTLP events are `api_request`. With dispatch context from 30-1, the categorizer can use `taskType` as a primary classification signal, producing meaningful per-category breakdowns.

**Acceptance Criteria:**
- AC1: `classify()` accepts optional `taskType` parameter alongside existing `operationName` and `toolName`.
- AC2: When `taskType` is present, it takes priority as Tier 0 classification (before exact match):
  - `create-story` → `system_prompts` (mostly reading workflow templates and writing story specs)
  - `dev-story` → `tool_outputs` (mostly code generation and tool use)
  - `code-review` → `conversation_history` (mostly reading code and producing verdicts)
  - `test-plan` → `system_prompts` (reading story + generating test plan)
  - `minor-fixes` → `tool_outputs` (targeted code changes)
- AC3: `computeCategoryStatsFromTurns()` passes `turn.taskType` to `classify()`.
- AC4: Category stats for a multi-dispatch story show non-zero entries for 3+ categories.
- AC5: Existing categorization (exact match, prefix, fuzzy) still works when taskType is absent.

**Dev Notes:**
- Add taskType to classify signature with optional parameter
- Tier 0 = taskType map, Tier 1 = exact match (existing), etc.
- Update computeCategoryStatsFromTurns to pass taskType
- Test with and without taskType to verify backward compat

**Tasks:**
- [ ] Add taskType parameter to classify()
- [ ] Add Tier 0 taskType → category lookup map
- [ ] Update computeCategoryStatsFromTurns to pass turn.taskType
- [ ] Tests: taskType classification, fallback when absent, multi-dispatch story produces diverse categories

---

### Story 30-3: Per-Dispatch Efficiency Scoring (P1, M)

**Problem:** Efficiency scores are per-story aggregates. A story with 3 dispatches gets one composite score. Cache regressions between dispatches — e.g., a prompt restructure breaking cache prefixes — are invisible.

**Acceptance Criteria:**
- AC1: When turns have `dispatchId`, group by dispatchId and produce one EfficiencyScore per dispatch.
- AC2: Per-dispatch scores include the dispatch's `taskType` and `phase` for identification.
- AC3: Per-story aggregate score is still produced (backward compatible).
- AC4: efficiency_scores table extended with nullable `dispatch_id TEXT`, `task_type TEXT`, `phase TEXT` columns.
- AC5: `substrate metrics --efficiency` shows per-dispatch breakdown when available, with a summary aggregate row.
- AC6: Per-dispatch scoring reuses existing EfficiencyScorer — no formula changes, just different turn groupings.

**Dev Notes:**
- TelemetryPipeline groups turns by dispatchId when present, scores each group
- Persistence stores dispatch-level and story-level scores
- CLI formats dispatch rows indented under the story aggregate
- Schema migration adds 3 nullable columns to efficiency_scores

**Tasks:**
- [ ] Group turns by dispatchId in pipeline processing
- [ ] Score each dispatch group with existing EfficiencyScorer
- [ ] Schema migration: add columns to efficiency_scores
- [ ] Update persistence to write dispatch-level scores
- [ ] Update CLI metrics --efficiency for per-dispatch display
- [ ] Tests: multi-dispatch scoring, single-dispatch fallback, null dispatchId backward compat

---

### Story 30-4: Log-Only Path Parity Audit (P0, M)

**Problem:** `_processStoryFromTurns` (log-only path) has been a second-class citizen. Category stats were missing until v0.4.11. Consumer stats and recommendation generation are still missing. Every feature gap becomes a production bug because Claude Code only exports logs, not traces.

**Acceptance Criteria:**
- AC1: Audit all branches in TelemetryPipeline that check for spans vs logs. Document each gap.
- AC2: `_processStoryFromTurns` generates consumer stats from turns (new method on ConsumerAnalyzer or adapter).
- AC3: `_processStoryFromTurns` generates recommendations via Recommender.
- AC4: All persistence calls in `_processStory` are mirrored in `_processStoryFromTurns` (turns, efficiency, categories, consumers, recommendations).
- AC5: Test coverage: log-only path test verifies all 5 persistence calls are made.
- AC6: Document remaining span-only features (if any) with explicit rationale for why they can't work from turns.

**Dev Notes:**
- ConsumerAnalyzer currently takes NormalizedSpan[]. Add computeConsumerStatsFromTurns(turns) that groups by taskType or toolName.
- Recommender.analyze() takes a context object — ensure the log-only code path provides all required context fields.
- Consider extracting a shared helper for the persistence Promise.all pattern to avoid divergence.

**Tasks:**
- [ ] Audit TelemetryPipeline for span-vs-log branches — document all gaps
- [ ] Add computeConsumerStatsFromTurns to ConsumerAnalyzer
- [ ] Wire consumer stats into _processStoryFromTurns
- [ ] Wire Recommender into _processStoryFromTurns
- [ ] Extract shared persistence helper to prevent future divergence
- [ ] Tests: log-only path verifies all 5 persistence calls
- [ ] Document any remaining span-only gaps with rationale

---

### Story 30-5: Pipeline-Time Recommendation Generation (P1, M)

**Problem:** Recommendations only generate when a user runs `substrate metrics --recommendations`. During a pipeline run processing 5 stories, no recommendations are computed — they can't influence subsequent stories.

**Acceptance Criteria:**
- AC1: Recommender runs as part of `_processStoryFromTurns` (wired in 30-4) during the pipeline.
- AC2: Recommendations persist to SQLite/Dolt immediately after each story's telemetry is processed.
- AC3: Recommendations for story N are queryable before story N+1's dispatch begins.
- AC4: `substrate metrics --recommendations` still works (reads from same table).
- AC5: Pipeline log emits recommendation count per story at info level.
- AC6: Recommendation generation never blocks or fails the pipeline (wrapped in try/catch).

**Dev Notes:**
- This is largely a wiring story — the Recommender already exists, persistence already exists.
- If 30-4 wires Recommender into _processStoryFromTurns, this story focuses on verifying timing guarantees (AC3) and adding any missing context fields.
- The key guarantee: recommendations must be persisted BEFORE the next story dispatch begins. Since TelemetryPipeline processes batches async via the BatchBuffer, we need to ensure the final flush completes before the next dispatch.

**Tasks:**
- [ ] Verify recommendations persist before next story dispatch (timing guarantee)
- [ ] Add recommendation count to pipeline log output
- [ ] Verify metrics --recommendations reads pipeline-generated recommendations
- [ ] Tests: multi-story pipeline produces recommendations for each story
- [ ] Tests: recommendation persistence timing relative to next dispatch

---

### Story 30-6: Recommendation-to-Prompt Injection (P1, L)

**Problem:** Even when recommendations are generated, nothing reads them to influence subsequent dispatches. The orchestrator prepares each dispatch in isolation. This story closes the loop: read story N's recommendations, inject optimization directives into story N+1's system prompt.

**Acceptance Criteria:**
- AC1: New `TelemetryAdvisor` service with constructor-injected TelemetryPersistence.
- AC2: `TelemetryAdvisor.getRecommendationsForRun(runId)` returns the most recent recommendations from the current pipeline run.
- AC3: `TelemetryAdvisor.formatOptimizationDirectives(recommendations)` produces a concise natural-language block suitable for system prompt injection. Max 500 tokens. Prioritizes by severity (critical > warning > info), truncates at limit.
- AC4: Orchestrator creates TelemetryAdvisor during pipeline initialization (alongside existing telemetry wiring).
- AC5: Before each story dispatch, orchestrator calls TelemetryAdvisor to get directives from previous stories in the same run.
- AC6: Directives are injected into the dispatch's system prompt via ContextCompiler (or equivalent injection point).
- AC7: Directive injection is logged at debug level with directive text.
- AC8: When no recommendations exist (first story, or all info-level), no directives are injected (no empty blocks).
- AC9: TelemetryAdvisor is optional — pipeline works identically when telemetry is disabled.

**Dev Notes:**
- TelemetryAdvisor is a thin read interface over TelemetryPersistence — keeps orchestrator decoupled from DB schema.
- formatOptimizationDirectives examples:
  - "OPTIMIZATION: Previous stories showed high file read token usage (>60% of budget). Prefer targeted line ranges (offset/limit) over reading entire files."
  - "OPTIMIZATION: Cache hit rate dropped between create-story and dev-story phases. Maintain consistent prompt prefix structure."
- Injection point: the contextCompiler already assembles system prompt + workflow + story content. Add an optional `optimizationDirectives` section.
- Must be non-blocking and failure-tolerant.

**Tasks:**
- [ ] Create TelemetryAdvisor class with constructor injection
- [ ] Implement getRecommendationsForRun
- [ ] Implement formatOptimizationDirectives with severity prioritization and token budget
- [ ] Wire TelemetryAdvisor creation in orchestrator initialization
- [ ] Add directive query before each story dispatch
- [ ] Inject directives via ContextCompiler
- [ ] Debug logging for injected directives
- [ ] Tests: advisor with recommendations, advisor with no recommendations, token truncation, multi-story pipeline integration

---

### Story 30-7: Cache Delta Regression Detection (P2, S)

**Problem:** Prompt restructuring between dispatches can break cache prefixes, causing cache hit rate to plummet. This is invisible in per-story aggregates. With per-dispatch scores (30-3), we can detect regressions.

**Acceptance Criteria:**
- AC1: New recommendation rule `cache_delta_regression` in Recommender.
- AC2: Fires when consecutive dispatches within a story show >30 percentage point drop in cache hit rate.
- AC3: Recommendation includes both dispatch identifiers, the delta, and a suggestion to investigate prompt prefix alignment.
- AC4: Severity is `warning` for >30pp drop, `critical` for >50pp drop.
- AC5: Rule requires per-dispatch efficiency data (30-3) — gracefully skipped when not available.

**Dev Notes:**
- Recommender needs access to per-dispatch efficiency scores, not just per-story.
- Add optional `dispatchScores` to the Recommender context.
- Sort dispatches chronologically, compare consecutive pairs.

**Tasks:**
- [ ] Add dispatchScores to Recommender context type
- [ ] Implement cache_delta_regression rule
- [ ] Wire dispatch scores into Recommender context in pipeline
- [ ] Tests: regression detected, no regression, insufficient data graceful skip

---

### Story 30-8: Efficiency-Gated Retry Decisions (P2, M)

**Problem:** `retry-escalated` retries failed stories blindly. A story that escalated with compositeScore 30 (terrible efficiency — context spikes, no caching) will likely fail the same way on retry, wasting tokens.

**Acceptance Criteria:**
- AC1: `retry-escalated` command reads efficiency score for the prior run's story via TelemetryAdvisor.
- AC2: If compositeScore < 50, emit a warning: "Previous run had low efficiency (score: N). Retry may encounter the same issues."
- AC3: If contextManagementSubScore < 50 (frequent context spikes), inject a `maxContextTokens` ceiling into the retry dispatch, set to 80% of the spike threshold.
- AC4: Warning and adjustment are logged at info level.
- AC5: `--force` flag bypasses the efficiency check (user override).
- AC6: When no efficiency data exists for the prior run, proceed normally (no gate).

**Dev Notes:**
- Wire TelemetryAdvisor into retry-escalated command.
- The context budget ceiling is passed through dispatch options — ClaudeCodeAdapter already supports maxTurns, extend with maxContextTokens if needed.
- Keep the gate advisory, not blocking — warn and adjust, don't refuse.

**Tasks:**
- [ ] Read efficiency score in retry-escalated via TelemetryAdvisor
- [ ] Emit warning when compositeScore < 50
- [ ] Inject context budget ceiling when context management score is low
- [ ] Add --force flag to bypass
- [ ] Tests: low score warning, context ceiling injection, no data graceful pass-through, --force bypass

## Dependencies

- **Epic 27** (COMPLETE): Provides ingestion server, normalizer, turn analyzer, categorizer, efficiency scorer, recommender, persistence, CLI metrics commands.
- **Epic 28** (COMPLETE): Provides model routing infrastructure, repo-map context injection, routing telemetry, RoutingTuner auto-tune pattern.
- **v0.4.10-v0.4.11 fixes**: Corrected cacheHitRate formula, categorizer OTLP event mapping, I/O ratio computation, freshTokens formula, log-only path category stats wiring.

## Estimated Effort

- **Sprint 1**: 4 stories, ~1 week. Two parallel tracks (dispatch enrichment: 30-1→30-2,30-3 and parity audit: 30-4).
- **Sprint 2**: 4 stories, ~1 week. Sequential dependency chain (30-5→30-6, 30-7 and 30-8 parallel).
- **Total**: 8 stories, 2 sprints.

## Success Criteria

1. `substrate metrics --turns 5-4` shows task_type and phase per turn (not just "api_request")
2. `substrate metrics --categories --story 5-4` shows 3+ non-zero categories for a multi-dispatch story
3. `substrate metrics --efficiency` shows per-dispatch scores within a story
4. recommendations table populated during pipeline run (not just on CLI query)
5. Story N+1 system prompt includes optimization directives derived from story N's telemetry
6. Cache delta regression flagged when consecutive dispatches show >30pp cache rate drop
7. retry-escalated warns when prior run had compositeScore < 50

## Risks

- **OTLP timing**: Ensuring telemetry data is fully flushed and persisted before the next dispatch begins. The BatchBuffer's 5-second timer may introduce latency. Mitigation: force-flush between dispatches.
- **Directive quality**: Auto-generated optimization directives may be too generic or misleading. Mitigation: start conservative (only inject for critical/warning severity), iterate based on observed impact.
- **Concurrent dispatch isolation**: Dispatch context keyed by storyKey assumes sequential phases per story. If future architecture allows parallel phases within a story, the context tracking breaks. Mitigation: document the constraint, add assertion.
