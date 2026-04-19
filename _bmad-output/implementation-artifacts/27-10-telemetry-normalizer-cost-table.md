# Story 27-10: Telemetry Normalizer + Cost Table

Status: ready-for-dev

## Story

As a substrate pipeline operator,
I want ingested OTLP payloads transformed into a source-agnostic normalized telemetry model,
so that downstream analysis can work with consistent token counts, costs, and timestamps regardless of which LLM provider emitted the telemetry.

## Context — What Already Exists

This story implements the normalizer data pipeline that was originally scoped as 27-2 but never built. The following already exist and MUST NOT be recreated or modified (unless extending):

- `src/modules/telemetry/types.ts` (358 lines) — already has `NormalizedSpan`, `NormalizedLog`, `TurnAnalysis`, `ChildSpanSummary`, all Zod schemas. Check if `TokenCounts` and `ModelPricing` types need adding.
- `src/modules/telemetry/ingestion-server.ts` (162 lines) — HTTP server that accepts OTLP payloads but currently stubs processing (line ~149: "Accept all OTLP payloads — future stories will parse and persist them")
- `src/modules/telemetry/index.ts` (59 lines) — re-exports from submodules
- `src/modules/telemetry/persistence.ts` (757 lines) — SQLite persistence for turn_analysis, efficiency_scores, recommendations, category_stats, consumer_stats

**DO NOT** modify or recreate these files beyond adding new exports to `index.ts` and potentially extending `types.ts` with missing types.

## Acceptance Criteria

### AC1: Cost Table Configuration
**Given** the telemetry module is imported
**When** `estimateCost(model, tokens)` is called with a known model string and token counts
**Then** it looks up per-million-token rates from `COST_TABLE`, applies a 90% discount on cacheReadTokens (cache reads cost 10% of input rate), and returns 0 for unknown models without throwing

### AC2: Fuzzy Token Extraction from Attributes
**Given** an OTLP span or log with attribute keys using any naming convention (e.g. `anthropic.input_tokens`, `openai.prompt_token_count`, `gen_ai.usage.cache_read_input_tokens`)
**When** the normalizer processes the attributes map
**Then** it matches keys via case-insensitive substring patterns and maps the first matching value to the correct field

### AC3: JSON Body Fallback for Token Fields
**Given** an OTLP span or log where token counts are absent from the top-level attribute map
**When** the normalizer processes it
**Then** it parses the body as JSON and recursively searches up to depth 4 for keys matching token patterns

### AC4: Timestamp Normalization
**Given** a timestamp value in any of five formats: nanosecond integer, microsecond integer, millisecond integer, second integer, or ISO 8601 string
**When** `normalizeTimestamp()` processes the value
**Then** it returns the timestamp as a Unix millisecond number; null/undefined/unparseable inputs fall back to `Date.now()`

### AC5: TelemetryNormalizer Class
**Given** a raw OTLP trace or log payload
**When** `normalizer.normalizeSpan(raw)` or `normalizer.normalizeLog(raw)` is called
**Then** it returns arrays of `NormalizedSpan` or `NormalizedLog` objects with all fields populated; missing numeric fields default to 0; never throws on malformed input (returns empty array)

### AC6: Unit Test Coverage
**Given** the normalizer implementation
**When** unit tests execute
**Then** tests cover: Claude Code OTLP trace payloads, Codex OTLP payloads, body fallback, malformed payloads, cost computation, and all timestamp formats

## Tasks / Subtasks

- [ ] Task 1: Check if `TokenCounts` and `ModelPricing` types exist in `types.ts`; add only if missing
- [ ] Task 2: Implement `src/modules/telemetry/cost-table.ts` — `COST_TABLE`, `resolveModel()`, `estimateCost()`
  - Models: claude-3-opus-20240229, claude-3-sonnet-20240229, claude-3-haiku-20240307, claude-3-5-sonnet-20241022, claude-3-5-haiku-20241022, gpt-4, gpt-4-turbo, gpt-3.5-turbo
  - Cache read discount: use explicit `cacheReadPerMToken` from table when present
- [ ] Task 3: Implement `src/modules/telemetry/timestamp-normalizer.ts` — `normalizeTimestamp(value: unknown): number`
  - Detection order: ISO string, nanoseconds (>=1e18), microseconds (>=1e15), milliseconds (>=1e12), seconds (<1e12), fallback Date.now()
  - Handle bigint string values from OTLP `startTimeUnixNano`
- [ ] Task 4: Implement `src/modules/telemetry/token-extractor.ts` — `extractTokensFromAttributes()`, `extractTokensFromBody()`, `mergeTokenCounts()`
  - Patterns: input_token|prompt_token, output_token|completion_token, cache_read, cache_creation
  - Attributes take priority over body for each field
- [ ] Task 5: Implement `src/modules/telemetry/normalizer.ts` — `TelemetryNormalizer` class
  - `normalizeSpan(raw)`: iterate resourceSpans[].scopeSpans[].spans[], extract model, tokens, cost, timestamps
  - `normalizeLog(raw)`: iterate resourceLogs[].scopeLogs[].logRecords[], extract eventName, sessionId, toolName
  - Never throw — return empty array on errors, log warnings
- [ ] Task 6: Unit tests for all 4 new files in `src/modules/telemetry/__tests__/`
- [ ] Task 7: Add exports to `src/modules/telemetry/index.ts`: `TelemetryNormalizer`, `estimateCost`, `COST_TABLE`, `normalizeTimestamp`

## Dev Notes

### Architecture Constraints
- No external dependencies — use only built-in Node.js, zod, and internal modules
- Constructor injection: `TelemetryNormalizer` accepts `ILogger` in constructor
- Never throw from public methods — return empty arrays on error
- OTLP integer values arrive as strings (`"intValue": "2048"`) — always `Number()` before use
- OTLP attributes are arrays of `{ key: string; value: { stringValue?, intValue?, doubleValue? } }`

### OTLP Span Structure Reference
```json
{
  "resourceSpans": [{
    "resource": {
      "attributes": [{ "key": "service.name", "value": { "stringValue": "claude-code" } }]
    },
    "scopeSpans": [{
      "spans": [{
        "spanId": "abc123",
        "traceId": "trace456",
        "name": "LLM.call",
        "startTimeUnixNano": "1709900000000000000",
        "endTimeUnixNano": "1709900005000000000",
        "attributes": [
          { "key": "gen_ai.request.model", "value": { "stringValue": "claude-3-5-sonnet-20241022" } },
          { "key": "anthropic.input_tokens", "value": { "intValue": "2048" } }
        ]
      }]
    }]
  }]
}
```

### Cost Table Pricing
```typescript
'claude-3-opus-20240229':    { inputPerMToken: 15.00, outputPerMToken: 75.00, cacheReadPerMToken: 1.50, cacheCreationPerMToken: 18.75 }
'claude-3-5-sonnet-20241022':{ inputPerMToken: 3.00,  outputPerMToken: 15.00, cacheReadPerMToken: 0.30, cacheCreationPerMToken: 3.75  }
'claude-3-5-haiku-20241022': { inputPerMToken: 0.80,  outputPerMToken: 4.00,  cacheReadPerMToken: 0.08, cacheCreationPerMToken: 1.00  }
'claude-3-haiku-20240307':   { inputPerMToken: 0.25,  outputPerMToken: 1.25,  cacheReadPerMToken: 0.03, cacheCreationPerMToken: 0.30  }
'claude-3-sonnet-20240229':  { inputPerMToken: 3.00,  outputPerMToken: 15.00, cacheReadPerMToken: 0.30, cacheCreationPerMToken: 3.75  }
'gpt-4':                     { inputPerMToken: 30.00, outputPerMToken: 60.00, cacheReadPerMToken: 3.00, cacheCreationPerMToken: 30.00 }
'gpt-4-turbo':               { inputPerMToken: 10.00, outputPerMToken: 30.00, cacheReadPerMToken: 1.00, cacheCreationPerMToken: 10.00 }
'gpt-3.5-turbo':             { inputPerMToken: 0.50,  outputPerMToken: 1.50,  cacheReadPerMToken: 0.05, cacheCreationPerMToken: 0.50  }
```

### File Paths (NEW files only)
```
src/modules/telemetry/
  cost-table.ts              <- NEW
  timestamp-normalizer.ts    <- NEW
  token-extractor.ts         <- NEW
  normalizer.ts              <- NEW
  __tests__/
    cost-table.test.ts       <- NEW
    timestamp-normalizer.test.ts <- NEW
    token-extractor.test.ts  <- NEW
    normalizer.test.ts       <- NEW
```

## Interface Contracts

- **Import**: `NormalizedSpan`, `NormalizedLog` from `./types.ts` (already exist)
- **Export**: `TelemetryNormalizer`, `estimateCost`, `COST_TABLE`, `normalizeTimestamp` via `index.ts`
- **Consumed by**: Story 27-12 (ingestion wiring)
