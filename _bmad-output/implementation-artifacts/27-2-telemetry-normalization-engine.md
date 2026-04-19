# Story 27-2: Telemetry Normalization Engine

Status: ready-for-dev

## Story

As a substrate pipeline operator,
I want ingested OTLP payloads transformed into a source-agnostic normalized telemetry model,
so that downstream analysis can work with consistent token counts, costs, and timestamps regardless of which LLM provider emitted the telemetry.

## Acceptance Criteria

### AC1: NormalizedSpan Type
**Given** a raw OTLP trace payload from any supported source (`claude-code`, `codex`, `local-llm`, or `unknown`)
**When** the normalizer processes the payload
**Then** it returns an array of `NormalizedSpan` objects — one per OTLP span — with all fields populated: `spanId`, `traceId`, `parentSpanId`, `name`, `source`, `model`, `provider`, `operationName`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`, `durationMs`, `startTime`, `endTime`, `attributes`, `events`; missing numeric fields default to `0`, missing optional string fields to `undefined`

### AC2: NormalizedLog Type
**Given** a raw OTLP log payload from any supported source
**When** the normalizer processes the payload
**Then** it returns an array of `NormalizedLog` objects — one per OTLP log record — with all fields populated: `logId`, `traceId`, `spanId`, `timestamp`, `severity`, `body`, `eventName`, `sessionId`, `toolName`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `costUsd`, `model`; missing numeric fields default to `0`

### AC3: Fuzzy Token Extraction from Attributes
**Given** an OTLP span or log with attribute keys using any naming convention (e.g. `anthropic.input_tokens`, `openai.prompt_token_count`, `gen_ai.usage.cache_read_input_tokens`)
**When** the normalizer processes the attributes map
**Then** it matches keys via case-insensitive substring patterns — `input_token` / `prompt_token` → `inputTokens`, `output_token` / `completion_token` → `outputTokens`, `cache_read` → `cacheReadTokens`, `cache_creation` → `cacheCreationTokens` — and maps the first matching value to the correct field

### AC4: JSON Body Fallback for Token Fields
**Given** an OTLP span or log where token counts are absent from the top-level attribute map
**When** the normalizer processes it
**Then** it parses the `body` field as JSON (if it is a string) or uses it directly (if it is already an object), then recursively searches up to depth 4 for keys matching the same token patterns, using the first matched numeric value found per field

### AC5: Cost Estimation from Pricing Config
**Given** a normalized span with a known `model` string and token counts
**When** the normalizer computes `costUsd`
**Then** it looks up per-million-token rates from the `COST_TABLE` exported by `cost-table.ts`, applies a 90% discount on `cacheReadTokens` (i.e. cache reads cost 10% of input rate), and returns `0` for unknown or missing models without throwing

### AC6: Timestamp Normalization
**Given** a timestamp value in any of five formats: nanosecond integer (≥ 1e18), microsecond integer (≥ 1e15), millisecond integer (≥ 1e12), second integer (< 1e12), or ISO 8601 string
**When** `normalizeTimestamp()` processes the value
**Then** it returns the timestamp as a Unix millisecond number; `null`, `undefined`, and unparseable inputs fall back to `Date.now()`

### AC7: Unit Test Coverage for All Payload Variants
**Given** the normalizer implementation
**When** unit tests execute via `npm run test:fast`
**Then** tests cover: Claude Code OTLP trace payload with Anthropic attribute names, Codex OTLP payload with OpenAI attribute names, span with no attributes but token-bearing JSON body (depth-4 fallback), completely malformed payload with missing `resourceSpans` key (returns empty array, no throw), `NormalizedLog` extraction from a log record, cost computation for a known model, and all five timestamp input formats

## Tasks / Subtasks

- [ ] Task 1: Extend `src/modules/telemetry/types.ts` with normalized type definitions (AC: #1, #2)
  - [ ] Add `NormalizedSpan` interface with all required fields (use `number` for tokens/cost/durations, `string` for IDs/names, `unknown[]` for `attributes` and `events`)
  - [ ] Add `NormalizedLog` interface with all required fields
  - [ ] Add `TokenCounts` type: `{ input: number; output: number; cacheRead: number; cacheCreation: number }`
  - [ ] Add `ModelPricing` type: `{ inputPerMToken: number; outputPerMToken: number; cacheReadPerMToken: number; cacheCreationPerMToken: number }`
  - [ ] Do NOT re-export `RawOtlpPayload` / `OtlpSource` / `BatchFlushEvent` — those are already exported from story 27-1; import them from the same file

- [ ] Task 2: Implement pricing config in `src/modules/telemetry/cost-table.ts` (AC: #5)
  - [ ] Export `COST_TABLE: Record<string, ModelPricing>` with entries for: `claude-3-opus-20240229`, `claude-3-sonnet-20240229`, `claude-3-haiku-20240307`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo` — use current published pricing in USD per million tokens
  - [ ] Export `resolveModel(rawModel: string | undefined): string | undefined` — normalizes partial model strings (e.g. `"claude-3-5-sonnet"` → matches `claude-3-5-sonnet-20241022`) via prefix/substring lookup, returns `undefined` for no match
  - [ ] Export `estimateCost(model: string | undefined, tokens: TokenCounts): number` — looks up resolved model, computes `(input * inputRate + output * outputRate + cacheRead * inputRate * 0.10 + cacheCreation * cacheCreationRate) / 1e6`, returns `0` for unknown model
  - [ ] Unit tests in `src/modules/telemetry/__tests__/cost-table.test.ts`: known model with all four token fields, unknown model returns exactly `0`, cache read discount (90%) applied correctly, `resolveModel` handles partial strings and unknown input

- [ ] Task 3: Implement timestamp normalization in `src/modules/telemetry/timestamp-normalizer.ts` (AC: #6)
  - [ ] Export `normalizeTimestamp(value: unknown): number` with detection order: ISO string → `new Date(value).getTime()`, nanoseconds (≥ 1e18) → divide by 1e6, microseconds (≥ 1e15) → divide by 1e3, milliseconds (≥ 1e12) → use as-is, seconds (numeric, < 1e12) → multiply by 1e3, fallback → `Date.now()`
  - [ ] Handle `bigint` nanosecond values (OTLP sometimes emits `startTimeUnixNano` as a bigint string like `"1234567890000000000"`) — parse string first, then apply range check
  - [ ] Unit tests in `src/modules/telemetry/__tests__/timestamp-normalizer.test.ts`: all five numeric formats, ISO 8601 string, bigint string, `null`, `undefined`, non-numeric string (fallback)

- [ ] Task 4: Implement fuzzy token extraction in `src/modules/telemetry/token-extractor.ts` (AC: #3, #4)
  - [ ] Export `TOKEN_PATTERNS` constant: `{ input: /input_token|prompt_token/i, output: /output_token|completion_token/i, cacheRead: /cache_read/i, cacheCreation: /cache_creation/i }`
  - [ ] Export `extractTokensFromAttributes(attributes: Record<string, unknown>): TokenCounts` — iterates all keys, applies patterns in order, takes the first match per category, converts value to `Number()` (treats NaN as 0)
  - [ ] Export `extractTokensFromBody(body: unknown, maxDepth?: number): Partial<TokenCounts>` — recursive object walk up to `maxDepth` (default 4); treats arrays as objects indexed by position; stops recursion at depth 4 without throwing; returns only fields that were found
  - [ ] Export `mergeTokenCounts(fromAttributes: TokenCounts, fromBody: Partial<TokenCounts>): TokenCounts` — attributes take priority over body for each field
  - [ ] Unit tests in `src/modules/telemetry/__tests__/token-extractor.test.ts`: attribute-level match (Anthropic and OpenAI naming), body fallback triggered when attributes empty, depth-4 cutoff respected (depth-5 value ignored), mixed sources (attribute value takes priority), all-empty inputs return all-zeros

- [ ] Task 5: Implement `TelemetryNormalizer` in `src/modules/telemetry/normalizer.ts` (AC: #1, #2, #3, #4, #5, #6)
  - [ ] Export `ITelemetryNormalizer` interface: `{ normalizeSpan(raw: RawOtlpPayload): NormalizedSpan[]; normalizeLog(raw: RawOtlpPayload): NormalizedLog[] }`
  - [ ] Implement `TelemetryNormalizer` class: constructor `new TelemetryNormalizer(logger: ILogger)`; implements `ITelemetryNormalizer`
  - [ ] `normalizeSpan(raw)`: iterate `body.resourceSpans[].scopeSpans[].spans[]`; extract `model` from `gen_ai.request.model`, `model`, or `llm.request.model` attribute (first non-empty match); call `extractTokensFromAttributes` then body fallback; call `estimateCost`; call `normalizeTimestamp` for `startTimeUnixNano` / `endTimeUnixNano`; compute `durationMs = endTime - startTime`; on any parse error, skip the span with a `logger.warn` and continue
  - [ ] `normalizeLog(raw)`: iterate `body.resourceLogs[].scopeLogs[].logRecords[]`; extract `eventName` from `body.stringValue` or `attributes['event.name']`; extract `sessionId` from `attributes['session.id']` or `attributes['gen_ai.conversation.id']`; extract `toolName` from `attributes['tool.name']` or `attributes['gen_ai.tool.name']`; normalize `timeUnixNano` timestamp; extract tokens same as spans; on parse error, skip with `logger.warn`
  - [ ] Return empty array (not `null`) and never throw on malformed/missing/null payloads

- [ ] Task 6: Unit tests for `TelemetryNormalizer` in `src/modules/telemetry/__tests__/normalizer.test.ts` (AC: #7)
  - [ ] Fixture: Claude Code OTLP trace payload using Anthropic attribute names (`anthropic.input_tokens`, `anthropic.output_tokens`, `anthropic.cache_read_input_tokens`) → verify all `NormalizedSpan` fields
  - [ ] Fixture: Codex OTLP payload using OpenAI naming (`openai.prompt_tokens`, `openai.completion_tokens`) → verify fuzzy extraction populates correct fields
  - [ ] Fixture: span with attributes map empty but token counts embedded in JSON body at depth 3 → verify body fallback populates `inputTokens`/`outputTokens`
  - [ ] Fixture: payload with `resourceSpans: null` (no key at all) → verify returns `[]`, no throw
  - [ ] Fixture: OTLP log payload → verify `NormalizedLog` `eventName`, `toolName`, `timestamp` populated correctly
  - [ ] Fixture: known model with all four token fields → verify `costUsd > 0`
  - [ ] Fixture: timestamp as nanosecond bigint string → verify millisecond result is reasonable (within current era)

- [ ] Task 7: Export public API from `src/modules/telemetry/index.ts` and build verification (AC: #1, #2)
  - [ ] Add exports: `TelemetryNormalizer`, `ITelemetryNormalizer`, `NormalizedSpan`, `NormalizedLog`, `TokenCounts`, `estimateCost`, `COST_TABLE`
  - [ ] Do NOT export internal helpers (`extractTokensFromAttributes`, `extractTokensFromBody`, `resolveModel`, `TOKEN_PATTERNS`) — keep them package-private
  - [ ] Run `npm run build` and confirm zero TypeScript errors before marking story complete

## Dev Notes

### Architecture Constraints
- **No external dependencies added**: use only built-in Node.js, `zod` (already a project dependency), and internal modules. Do not add `opentelemetry-js`, `protobufjs`, or any OTLP SDK — the normalizer operates on already-parsed JSON objects.
- **Never throw from public methods**: `normalizeSpan` and `normalizeLog` must return empty arrays on any error. Log warnings via `ILogger`, do not propagate exceptions to callers.
- **Constructor injection**: `TelemetryNormalizer` accepts `ILogger` in its constructor. Use the existing `createLogger('telemetry:normalizer')` factory (find the import path by checking other modules like `src/modules/state/` or `src/modules/agent-dispatch/`).
- **Immutable types**: `NormalizedSpan` and `NormalizedLog` should use `readonly` fields to prevent accidental mutation downstream.
- **Import order**: Node built-ins → third-party packages → internal modules; blank line between groups.

### File Paths
```
src/modules/telemetry/
  types.ts                         ← extend with NormalizedSpan, NormalizedLog, TokenCounts, ModelPricing
  cost-table.ts                    ← COST_TABLE, ModelPricing, estimateCost, resolveModel
  timestamp-normalizer.ts          ← normalizeTimestamp
  token-extractor.ts               ← TOKEN_PATTERNS, extractTokensFromAttributes, extractTokensFromBody, mergeTokenCounts
  normalizer.ts                    ← ITelemetryNormalizer interface + TelemetryNormalizer class
  index.ts                         ← extend public exports
  __tests__/
    cost-table.test.ts
    timestamp-normalizer.test.ts
    token-extractor.test.ts
    normalizer.test.ts
```

### OTLP Span Structure for Reference
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
        "parentSpanId": "",
        "name": "LLM.call",
        "startTimeUnixNano": "1709900000000000000",
        "endTimeUnixNano": "1709900005000000000",
        "attributes": [
          { "key": "gen_ai.request.model", "value": { "stringValue": "claude-3-5-sonnet-20241022" } },
          { "key": "anthropic.input_tokens", "value": { "intValue": "2048" } },
          { "key": "anthropic.output_tokens", "value": { "intValue": "512" } },
          { "key": "anthropic.cache_read_input_tokens", "value": { "intValue": "1024" } }
        ],
        "events": []
      }]
    }]
  }]
}
```

Note that OTLP integer values arrive as strings (`"intValue": "2048"`) — always `Number(value.intValue ?? value.doubleValue ?? value.stringValue)` before use.

### Attribute Extraction Helper Pattern
OTLP attributes are an array of `{ key: string; value: { stringValue?: string; intValue?: string; doubleValue?: string; boolValue?: boolean } }`. Write a helper `getAttrValue(attributes: unknown[], key: string): string | number | undefined` to avoid repeating this traversal.

### Token Extraction Priority
1. Span-level `attributes[]` array (OTLP typed values)
2. If all token fields are 0 after step 1, walk `body` as plain JSON (body fallback)

Do not mix results — if any field is found in attributes, treat step 2 as skipped for that field only.

### Cost Table Pricing (approximate, verify against current Anthropic/OpenAI docs)
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
The `cacheReadPerMToken` in `estimateCost` should use `inputPerMToken * 0.10` for Claude models (Anthropic's standard cache discount) unless a specific `cacheReadPerMToken` is set in the table — prefer the explicit table value when present.

### Testing Requirements
- **Unit tests only** (`test:fast` tier) — no real HTTP, no real Dolt, no file system
- Use `vi.mock` for `ILogger` — pass a mock logger to `TelemetryNormalizer`
- OTLP fixture payloads: hardcode as `const` objects in test files (no external fixture files needed)
- Coverage target: ≥ 80% for all four new source files (`normalizer.ts`, `cost-table.ts`, `timestamp-normalizer.ts`, `token-extractor.ts`)
- Test file naming: `<module>.test.ts` co-located in `src/modules/telemetry/__tests__/`

## Interface Contracts

- **Import**: `RawOtlpPayload` @ `src/modules/telemetry/types.ts` (from story 27-1)
- **Import**: `OtlpSource` @ `src/modules/telemetry/types.ts` (from story 27-1)
- **Export**: `NormalizedSpan` @ `src/modules/telemetry/types.ts` (consumed by story 27-3 Dolt persistence)
- **Export**: `NormalizedLog` @ `src/modules/telemetry/types.ts` (consumed by story 27-3 Dolt persistence)
- **Export**: `ITelemetryNormalizer` @ `src/modules/telemetry/normalizer.ts` (consumed by story 27-3 for wiring normalizer into the flush pipeline)
- **Export**: `TelemetryNormalizer` @ `src/modules/telemetry/normalizer.ts` (consumed by story 27-3 for instantiation at composition root)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
