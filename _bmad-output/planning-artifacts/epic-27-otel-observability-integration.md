# Epic 27: OTEL Observability Integration

## Vision

Build a first-party observability engine into substrate that captures, analyzes, and persists OpenTelemetry data from agent executions. Move beyond single-number cost tracking to per-turn token analysis, semantic categorization of token consumption, context growth visualization, cache efficiency scoring, and an automated recommendation engine that identifies waste. Store everything in Dolt (Epic 26) for historical querying across sprints, stories, and models.

Inspired by the "dude-wheres-my-tokens" OTEL Observer project — fork the approach, own the implementation, persist in Dolt instead of in-memory circular buffers.

Source: Integrated Synthesis report "caching strategies" gap (no system documents this), OTEL Observer architecture patterns, substrate operational data showing no visibility into where agent tokens actually go, Epic 24-4 pipeline metrics limitations.

## Scope

### In Scope

- OTLP ingestion endpoint: accept traces, logs, and metrics from child agents via OTLP/HTTP JSON
- Normalized telemetry model: source-agnostic representation of spans, logs, and metrics with fuzzy token extraction
- Telemetry persistence in Dolt: all normalized events written to Dolt state layer (Epic 26), not in-memory buffers
- Per-turn token analysis: input/output/cache breakdown, context growth tracking, fresh token calculation per LLM turn
- Semantic categorization: classify every operation (tool_outputs, file_reads, system_prompts, conversation_history, user_prompts) with trend detection
- Context consumer identification: group operations by type+tool, rank by token percentage, drill-down to invocations
- Efficiency scoring: 0-100 composite score based on cache hit rate, I/O ratio, context management
- Recommendation engine: 8 heuristic rules generating actionable insights (biggest consumers, large file reads, expensive bash, context spikes, cache efficiency, growing categories, repeated calls, model comparison)
- CLI integration: `substrate metrics --recommendations`, `substrate metrics --efficiency`, `substrate metrics --turns <storyKey>`
- Agent telemetry export: configure substrate's child Claude Code agents to emit OTLP to substrate's ingestion endpoint
- Dolt schema extension: telemetry tables (spans, logs, metrics, turns, consumers, recommendations)

### Out of Scope

- Web UI / dashboard (future — OTEL Observer's React UI could be adapted later)
- Real-time SSE streaming (future — start with batch analysis post-execution)
- Codex/local LLM ingestion (future — start with Claude Code)
- Automatic optimization actions based on recommendations (future — Epic 28+ territory)
- Remote telemetry collection (agent and observer run on same machine)

## Story Map

```
Sprint 1 — Ingestion + Normalization (P0):                    [COMPLETE]
  Story 27-1: OTLP Ingestion Endpoint (P0, M)                 [COMPLETE]
  Story 27-2: Telemetry Normalization Engine (P0, L)           [COMPLETE]
  Story 27-3: Dolt Telemetry Schema + Persistence (P0, M)     [COMPLETE]

Sprint 2 — Analysis Engine (P0/P1):                           [COMPLETE]
  Story 27-4: Per-Turn Token Analysis (P0, L)                  [COMPLETE]
  Story 27-5: Semantic Categorization + Context Consumers (P1, M) [COMPLETE]
  Story 27-6: Efficiency Scoring (P1, M)                       [COMPLETE]

Sprint 3 — Recommendations + CLI (P1/P2):                     [COMPLETE]
  Story 27-7: Recommendation Engine (P1, L)                    [COMPLETE]
  Story 27-8: CLI Integration — Metrics Commands (P1, M)       [COMPLETE]
  Story 27-9: Agent Telemetry Export Configuration (P2, S)     [COMPLETE]

Sprint 4 — Normalizer + Turn Analyzer + Pipeline Wiring:      [COMPLETE]
  Story 27-10: Telemetry Normalizer + Cost Table (P0, M)       [COMPLETE]
  Story 27-11: Turn Analyzer Module (P0, M)                    [COMPLETE]
  Story 27-12: Ingestion Pipeline Wiring (P0, L)               [COMPLETE]
  Story 27-13: CLI Metrics Handlers (P1, M)                    [COMPLETE]

Sprint 5 — Log-Based Telemetry + E2E Validation (P0):
  Story 27-14: Log-Based Turn Analyzer (P0, M)
  Story 27-15: TelemetryPipeline Dual-Track — Spans + Logs (P0, M)
  Story 27-16: Category/Consumer Stats from Turn Analysis (P1, S)
  Story 27-17: E2E Telemetry Validation (P0, S)
```

## Story Details

### Story 27-1: OTLP Ingestion Endpoint (P0, M)

**Problem:** Substrate has no way to receive telemetry from its child agents. Claude Code already supports OTLP export, but there's nothing listening.

**Acceptance Criteria:**
- AC1: Substrate exposes OTLP/HTTP JSON endpoints: `POST /v1/traces`, `POST /v1/logs`, `POST /v1/metrics` on a configurable local port (default 4318)
- AC2: Endpoints accept standard OTLP protobuf-as-JSON payloads (matching the OpenTelemetry spec)
- AC3: Ingestion server starts automatically when pipeline runs, stops when pipeline completes
- AC4: Source detection identifies the sending agent: `claude-code`, `codex`, `local-llm`, or `unknown` based on `service.name` and `telemetry.sdk.name` attributes
- AC5: Raw payloads are buffered in memory and flushed to the normalization pipeline in batches (100 events or 5 seconds, whichever first)
- AC6: Health endpoint: `GET /health` returns server status

**Files:** new `src/modules/telemetry/ingestion-server.ts`, new `src/modules/telemetry/types.ts`

### Story 27-2: Telemetry Normalization Engine (P0, L)

**Problem:** Different LLM providers send token data under different attribute names and formats. A normalization layer must extract tokens, costs, and metadata regardless of source format.

**Acceptance Criteria:**
- AC1: `NormalizedSpan` type: `spanId, traceId, parentSpanId, name, source, model, provider, operationName, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd, durationMs, startTime, endTime, attributes, events`
- AC2: `NormalizedLog` type: `logId, traceId, spanId, timestamp, severity, body, eventName, sessionId, toolName, inputTokens, outputTokens, cacheReadTokens, costUsd, model`
- AC3: Fuzzy token extraction: pattern-match attribute keys containing `input_token`, `prompt_token`, `output_token`, `completion_token`, `cache_read`, `cache_creation` — handles any naming convention
- AC4: JSON body fallback: if token attributes are missing, parse the body as JSON and search recursively (depth 4) for token fields
- AC5: Cost estimation: hardcoded pricing table for Claude (Opus/Sonnet/Haiku) and GPT models, with 90% cache discount. Pricing table is a config file, not hardcoded constants.
- AC6: Timestamp normalization: handle nanoseconds, microseconds, milliseconds, seconds, and ISO strings
- AC7: Unit tests cover: Claude Code OTLP payloads, Codex payloads, missing-field payloads, malformed payloads

**Files:** new `src/modules/telemetry/normalizer.ts`, new `src/modules/telemetry/cost-table.ts`, new `src/modules/telemetry/types.ts`

### Story 27-3: Dolt Telemetry Schema + Persistence (P0, M)

**Problem:** Telemetry data needs to persist in Dolt for historical querying. The OTEL Observer used in-memory circular buffers — we replace that with Dolt tables.

**Acceptance Criteria:**
- AC1: Dolt schema extended with tables: `telemetry_spans` (all NormalizedSpan fields), `telemetry_logs` (all NormalizedLog fields), `telemetry_metrics` (name, value, type, unit, timestamp, attributes_json)
- AC2: Normalized events are batch-inserted into Dolt (one commit per flush batch, not per event)
- AC3: Indexes on: `(story_key, timestamp)`, `(trace_id)`, `(model)`, `(source)`
- AC4: Retention policy: configurable max age (default 30 days), with `substrate telemetry prune` command
- AC5: Query helpers: `getSpansForStory(storyKey)`, `getLogsBySession(sessionId)`, `getTokensByModel(dateRange)`

**Depends on:** Epic 26 (StateStore/Dolt backend)

**Files:** schema extension in `src/modules/state/schema.sql`, new `src/modules/telemetry/persistence.ts`

### Story 27-4: Per-Turn Token Analysis (P0, L)

**Problem:** Substrate tracks total tokens per story but has zero visibility into how tokens are consumed across individual LLM turns within a story. A dev agent doing 20 turns might spend 80% of tokens in the last 5 turns as context grows.

**Acceptance Criteria:**
- AC1: `TurnAnalysis` type: `spanId, turnNumber, name, timestamp, source, model, inputTokens, outputTokens, cacheReadTokens, freshTokens, cacheHitRate, costUsd, durationMs, contextSize (running cumulative), contextDelta, toolName`
- AC2: Analysis engine processes all spans for a story and orders them chronologically as turns
- AC3: Child span drill-down: for each turn, list the tool calls/operations that occurred within it, with their individual token costs
- AC4: Context growth calculation: track running cumulative input tokens, flag turns with >2x average input as "context spikes"
- AC5: Results stored in Dolt `turn_analysis` table linked to story_key
- AC6: `stateStore.getTurnAnalysis(storyKey)` returns the full turn sequence

**Files:** new `src/modules/telemetry/turn-analyzer.ts`

### Story 27-5: Semantic Categorization + Context Consumers (P1, M)

**Problem:** Raw token counts don't tell you what the tokens were used *for*. Categorizing operations by semantic type (file reads, tool outputs, system prompts) reveals where optimization effort should go.

**Acceptance Criteria:**
- AC1: Semantic categories: `tool_outputs`, `file_reads`, `system_prompts`, `conversation_history`, `user_prompts`, `other`
- AC2: Classification logic: exact match lookup table → prefix patterns (`tool.*` → tool_outputs) → fuzzy substring matching
- AC3: Per-category statistics: total tokens, percentage, count, avg tokens per event, trend (growing/stable/shrinking)
- AC4: Context consumer grouping: events grouped by `eventType + toolName`, ranked by token percentage, top 20 specific invocations per consumer
- AC5: Trend detection: compare first half vs. second half of turns — `growing` if recent > 1.2x older, `shrinking` if < 0.8x
- AC6: Results stored in Dolt and queryable: "what category consumed the most tokens in story 26-4?"

**Files:** new `src/modules/telemetry/categorizer.ts`, new `src/modules/telemetry/consumer-analyzer.ts`

### Story 27-6: Efficiency Scoring (P1, M)

**Problem:** There's no single metric that summarizes how efficiently an agent used its token budget. A composite score enables comparison across stories, models, and prompt templates.

**Acceptance Criteria:**
- AC1: Efficiency score 0-100 computed from: cache hit rate (40% weight), I/O ratio (30% weight — lower is better, meaning more output per input), context management (30% weight — penalizes context growth spikes)
- AC2: Per-model efficiency: cache hit rate, avg I/O ratio, cost per 1K output tokens
- AC3: Per-source efficiency: compare Claude Code vs. other sources if multiple agents report
- AC4: Score stored in Dolt `efficiency_scores` table with timestamp, story_key, model, score breakdown
- AC5: Historical trend: `substrate metrics --efficiency --sprint 3` shows scores over time

**Files:** new `src/modules/telemetry/efficiency-scorer.ts`

### Story 27-7: Recommendation Engine (P1, L)

**Problem:** Efficiency data is useless without actionable next steps. An automated recommendation engine translates telemetry patterns into specific advice for improving pipeline efficiency.

**Acceptance Criteria:**
- AC1: 8 heuristic rules implemented: (1) biggest token consumers (names tool + top 3 files), (2) large file reads (>3K tokens, suggest line ranges), (3) expensive bash outputs (>3K tokens, suggest filtering), (4) context growth spikes (>2x avg, explain cause), (5) cache efficiency (if <30%, identify worst operations + calculate savings), (6) growing categories (warn on upward trend), (7) repeated tool calls (same file read twice, suggest caching), (8) per-model comparison (flag models with lower cache efficiency)
- AC2: Each recommendation has: `severity` (critical/warning/info), `title`, `description`, optional `potentialSavings`, optional `actionTarget`
- AC3: Critical = impacts >25% of tokens. Warning = >10%. Info = advisory.
- AC4: Recommendations stored in Dolt per story/sprint
- AC5: Recommendations are deterministic given the same telemetry data (testable with golden files)

**Files:** new `src/modules/telemetry/recommender.ts`

### Story 27-8: CLI Integration — Metrics Commands (P1, M)

**Problem:** All the analysis data needs to be accessible from the CLI for both humans and parent agents.

**Acceptance Criteria:**
- AC1: `substrate metrics --efficiency` shows efficiency scores for recent stories
- AC2: `substrate metrics --recommendations` shows actionable recommendations
- AC3: `substrate metrics --turns <storyKey>` shows per-turn token analysis with context growth
- AC4: `substrate metrics --consumers <storyKey>` shows top token consumers
- AC5: `substrate metrics --categories` shows semantic category breakdown
- AC6: All commands support `--output-format json` for agent consumption
- AC7: `substrate metrics --compare <storyA> <storyB>` compares efficiency between two stories

**Files:** `src/cli/commands/metrics.ts`, `src/cli/index.ts`

### Story 27-9: Agent Telemetry Export Configuration (P2, S)

**Problem:** Substrate's child Claude Code agents don't emit OTLP by default. The pipeline must configure them to export telemetry to substrate's ingestion endpoint.

**Acceptance Criteria:**
- AC1: When the ingestion server starts (Story 27-1), it generates the OTLP environment variables needed by Claude Code
- AC2: `ClaudeCodeAdapter.buildCommand()` includes OTLP env vars when telemetry is enabled: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:<port>`
- AC3: Telemetry export is opt-in: `telemetry.enabled: true` in project config (default false)
- AC4: When disabled, no ingestion server starts and no env vars are passed (zero overhead)

**Files:** `src/adapters/claude-adapter.ts`, `src/modules/telemetry/ingestion-server.ts`, config schema

### Story 27-14: Log-Based Turn Analyzer (P0, M)

**Problem:** The TelemetryPipeline's analysis chain requires OTLP trace spans (resourceSpans), but Claude Code exports OTLP logs and metrics — not traces. The `TurnAnalyzer` produces `TurnAnalysis[]` from spans. A parallel `LogTurnAnalyzer` is needed to produce the same `TurnAnalysis[]` from log records.

**Acceptance Criteria:**
- AC1: `LogTurnAnalyzer.analyze(logs)` returns `TurnAnalysis[]` — same type as `TurnAnalyzer.analyze(spans)`
- AC2: Token fields mapped from NormalizedLog: inputTokens, outputTokens, cacheReadTokens, freshTokens, cacheHitRate, costUsd
- AC3: Context growth tracking: running cumulative inputTokens, contextDelta, spike detection (>2x average)
- AC4: Story key extraction from log attributes
- AC5: Deduplication: logs with same traceId+spanId merged into single turn
- AC6: Never throws — returns empty array on error

**Files:** new `src/modules/telemetry/log-turn-analyzer.ts`

### Story 27-15: TelemetryPipeline Dual-Track — Spans + Logs (P0, M)

**Problem:** `TelemetryPipeline.processBatch()` early-returns at line 133 when `allSpans.length === 0`, discarding all normalized logs. This must be replaced with a dual-track approach: process spans via TurnAnalyzer AND logs via LogTurnAnalyzer, merge results, feed downstream.

**Acceptance Criteria:**
- AC1: No early return on zero spans — pipeline continues to process logs
- AC2: Both TurnAnalyzer (spans) and LogTurnAnalyzer (logs) run, results merged and deduplicated
- AC3: Log-only batches produce complete analysis: turn_analysis + efficiency_scores populated
- AC4: Span-only batches behave identically to current implementation (backwards compatible)
- AC5: Logs grouped by storyKey for per-story analysis
- AC6: Persistence called for log-derived turns

**Depends on:** 27-14

**Files:** modify `src/modules/telemetry/telemetry-pipeline.ts`, modify `orchestrator-impl.ts`

### Story 27-16: Category/Consumer Stats from Turn Analysis (P1, S)

**Problem:** `orchestrator-impl.ts:1629` has `const spans: NormalizedSpan[] = []` with TODO(27-3), making category_stats and consumer_stats always empty. Fix: compute from TurnAnalysis[] (which is now populated via 27-14/27-15) instead of raw spans.

**Acceptance Criteria:**
- AC1: `Categorizer.computeCategoryStatsFromTurns(turns)` produces CategoryStats[] from TurnAnalysis[]
- AC2: `ConsumerAnalyzer.analyzeFromTurns(turns)` produces ConsumerStats[] from TurnAnalysis[]
- AC3: TODO(27-3) eliminated — orchestrator uses turn-based computation
- AC4: Graceful degradation when no turns exist (debug log, no crash)
- AC5: Backwards compatible with span-based pipeline path (INSERT OR REPLACE)

**Depends on:** 27-15

**Files:** modify `categorizer.ts`, modify `consumer-analyzer.ts`, modify `orchestrator-impl.ts`

### Story 27-17: E2E Telemetry Validation (P0, S)

**Problem:** Epic 27 has never been validated end-to-end with real data. All telemetry tables are empty in production runs. This story validates the complete chain by running a real pipeline and verifying non-zero data.

**Acceptance Criteria:**
- AC1: Pipeline completes with telemetry active (clean exit, no telemetry errors)
- AC2: `turn_analysis` has > 0 rows with non-zero token counts
- AC3: `efficiency_scores` has 1 row with compositeScore 0-100
- AC4: `category_stats` has > 0 rows with non-zero totalTokens
- AC5: `consumer_stats` has > 0 rows
- AC6: `substrate metrics --output-format json` shows non-empty telemetry data

**Depends on:** 27-14, 27-15, 27-16 (manual validation story — no new code)

## Dependency Analysis

- Sprint 1 (27-1, 27-2, 27-3): 27-1 and 27-2 are parallel (ingestion and normalization). 27-3 depends on both (persists normalized data).
- Sprint 2 (27-4, 27-5, 27-6): All depend on 27-3 (read from Dolt). Can run in parallel — different analysis dimensions.
- Sprint 3 (27-7, 27-8, 27-9): 27-7 depends on 27-4/27-5/27-6 (uses their outputs). 27-8 depends on all analysis stories. 27-9 is independent.
- Sprint 4 (27-10, 27-11, 27-12, 27-13): 27-10 and 27-11 are parallel. 27-12 depends on both. 27-13 independent.
- Sprint 5 (27-14, 27-15, 27-16, 27-17): Sequential chain. 27-14 first (LogTurnAnalyzer), then 27-15 (dual-track), then 27-16 (category/consumer from turns), finally 27-17 (E2E validation).

## Sprint Plan

**Sprint 1:** Stories 27-1, 27-2, 27-3 — OTLP ingestion, normalization, Dolt persistence [COMPLETE]
**Sprint 2:** Stories 27-4, 27-5, 27-6 — Turn analysis, categorization, efficiency scoring [COMPLETE]
**Sprint 3:** Stories 27-7, 27-8, 27-9 — Recommendations, CLI commands, agent configuration [COMPLETE]
**Sprint 4:** Stories 27-10, 27-11, 27-12, 27-13 — Normalizer, turn analyzer, pipeline wiring, CLI handlers [COMPLETE]
**Sprint 5:** Stories 27-14, 27-15, 27-16, 27-17 — Log-based telemetry, dual-track pipeline, E2E validation

## Success Metrics

- Per-turn token breakdown available for every pipeline story execution
- Efficiency scores computed and stored for historical comparison
- Recommendation engine identifies at least 3 actionable insights per pipeline run
- Token consumption categorized by semantic type with trend detection
- `substrate metrics --efficiency` returns results in <2 seconds from Dolt
- Cache hit rate visible per story, per model — enabling data-driven prompt optimization
- Zero performance overhead when telemetry is disabled (opt-in architecture)
