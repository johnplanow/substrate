# Story 53-10: Adapter Hardening (Cross-Cutting)

## Story

As a substrate developer,
I want existing adapters hardened against format variance without requiring code changes,
so that a 5-story Codex run completes without manual substrate fixes.

## Acceptance Criteria

### AC1: Format Normalization on Initial Parse Failure
**Given** a Codex dispatch that produces YAML output wrapped in unexpected prose, extra markdown artifacts, or non-standard formatting
**When** the initial YAML extraction attempt (fenced block scan, then unfenced anchor-key scan) fails
**Then** an `AdapterOutputNormalizer` applies additional normalization strategies in sequence: (1) strip leading prose prefix lines, (2) remove markdown artifacts (`>`, `#`, `**`, `*` line-starters) line-by-line, (3) re-run anchor-key scan on the normalized text, (4) attempt JSON-to-YAML conversion on embedded JSON objects containing anchor keys
**And** each strategy is attempted in order and the first successful extraction is returned

### AC2: Structured Adapter Format Error with Diagnosis Context
**Given** a dispatcher that exhausts all normalization strategies without extracting valid output
**When** the `AdapterOutputNormalizer` returns a failure
**Then** an `AdapterFormatError` is returned with fields: `adapter_id` (string), `raw_output_snippet` (first 500 chars of raw output), `tried_strategies` (string array listing each attempted strategy by label), and `extraction_error` (the last parse error message)
**And** the error is logged at `warn` level with those fields as structured data so diagnosis does not require reading raw log files

### AC3: adapterError Flag Propagated on TaskResult
**Given** an `AdapterFormatError` returned by the normalizer inside `DispatcherImpl`
**When** the dispatcher constructs the `TaskResult` to return to the orchestrator
**Then** `TaskResult.adapterError` is set to `true`
**And** `TaskResult.verdict` is `'error'` with `errorMessage` containing the adapter ID, list of tried strategies, and the 500-char output snippet
**And** the `adapterError?: boolean` field is present in the `TaskResult` interface in `packages/core/src/adapters/types.ts` (optional, so existing callers without the field continue compiling)

### AC4: Root Cause Taxonomy Integration Surface
**Given** a `TaskResult` with `adapterError: true` returned from a failed dispatch
**When** the failure classification logic evaluates the result
**Then** the `adapterError` field on `TaskResult` is the authoritative signal for the `adapter-format` root cause category
**And** `AdapterFormatError` exposes `readonly rootCause = 'adapter-format' as const` so downstream classifiers can reference the literal without duplicating the string

### AC5: Claude Code Adapter Backward Compatibility
**Given** the existing `ClaudeCodeAdapter` producing standard fenced YAML output
**When** 5 sequential story dispatches pass through the `AdapterOutputNormalizer` layer in the dispatcher
**Then** all 5 dispatches produce valid `TaskResult` objects with correct verdict fields and no `adapterError` flag set
**And** no existing tests in `packages/core/src/adapters/__tests__/` or `packages/core/src/dispatch/__tests__/` fail after the dispatcher is modified

### AC6: Codex Format Variation Resilience
**Given** the `CodexCLIAdapter` where Codex CLI may produce output in these known variation types: (1) extra prose paragraphs before YAML, (2) JSON object wrapper instead of raw YAML, (3) duplicate key in YAML block, (4) trailing backtick fence artifact, (5) YAML indented inside an unlabelled code block
**When** each variation fixture is passed through the `AdapterOutputNormalizer`
**Then** at least 4 of these 5 known variation types are successfully normalized to valid, parseable YAML
**And** `adapterError` is only set when all normalization strategies are genuinely exhausted on an unrecognizable format

### AC7: Exports from Core Package
**Given** the new `AdapterOutputNormalizer` class, `AdapterFormatError` class, and updated `TaskResult` type
**When** consumers import from `@substrate-ai/core`
**Then** all three are available as named exports from the `@substrate-ai/core` package entry point
**And** the backward-compatible shim re-exports in `src/adapters/index.ts` are updated to surface the new exports

## Tasks / Subtasks

- [ ] Task 1: Extend TaskResult type and define AdapterFormatError (AC: #3, #4, #7)
  - [ ] Add `adapterError?: boolean` as an optional field to the `TaskResult` interface in `packages/core/src/adapters/types.ts` (must not break existing callers — no runtime change, type-only addition)
  - [ ] Create `packages/core/src/adapters/adapter-format-error.ts` defining `AdapterFormatError` class extending `Error` with: `readonly adapter_id: string`, `readonly raw_output_snippet: string`, `readonly tried_strategies: readonly string[]`, `readonly extraction_error: string`, `readonly rootCause = 'adapter-format' as const`
  - [ ] Constructor signature: `constructor(opts: { adapter_id: string; rawOutput: string; tried_strategies: string[]; extraction_error: string })` — auto-truncates `rawOutput` to 500 chars for the `raw_output_snippet` field

- [ ] Task 2: Implement AdapterOutputNormalizer with multi-strategy extraction (AC: #1, #2, #6)
  - [ ] Create `packages/core/src/adapters/adapter-output-normalizer.ts` exporting `AdapterOutputNormalizer` class
  - [ ] Implement `normalize(rawOutput: string, adapterId: string): { yaml: string; strategy: string } | AdapterFormatError` — returns the normalized YAML and which strategy succeeded, or an `AdapterFormatError` on exhaustion
  - [ ] Strategy `'standard'`: call existing `extractYamlBlock()` from `packages/core/src/dispatch/yaml-parser.ts`
  - [ ] Strategy `'strip-prose'`: remove leading non-YAML lines (lines not starting with a YAML key pattern or fence marker) until the first line that looks like YAML content, then retry `extractYamlBlock()`
  - [ ] Strategy `'strip-markdown'`: replace line-leading markdown artifacts (`^>\s?`, `^#{1,6}\s`, `^\*{1,2}`, `^_`) with empty prefix on each line, retry `extractYamlBlock()` on the cleaned text
  - [ ] Strategy `'json-fallback'`: scan for a JSON object `{...}` containing at least one YAML anchor key (`result:`, `verdict:`, `story_file:`, `expansion_priority:`), parse as JSON, serialize to YAML via `js-yaml.dump()`
  - [ ] Populate `tried_strategies[]` on each attempt; log each failure at `debug` level; log final exhaustion at `warn` level with structured `{ adapter_id, tried_strategies, snippet }` fields (never log full raw output)

- [ ] Task 3: Wire AdapterOutputNormalizer into DispatcherImpl (AC: #3, #5)
  - [ ] In `packages/core/src/dispatch/dispatcher-impl.ts`, inject `AdapterOutputNormalizer` via the constructor (or a factory parameter) so it can be mocked in unit tests — default to `new AdapterOutputNormalizer()` if not provided
  - [ ] Replace the direct `extractYamlBlock()` call in the dispatch result-parsing path with `this.normalizer.normalize(rawOutput, this.config.adapterId ?? 'unknown')`
  - [ ] On `AdapterFormatError` return: set `result.adapterError = true`, `result.verdict = 'error'`, `result.errorMessage = [error.adapter_id, error.tried_strategies.join(','), error.raw_output_snippet].join(' | ')`
  - [ ] On success: pass the returned `yaml` string into the existing `parseYamlResult()` call — no other behavior change; the happy path is transparent

- [ ] Task 4: Update package exports and shim re-exports (AC: #7)
  - [ ] Add `AdapterOutputNormalizer` and `AdapterFormatError` to named exports in `packages/core/src/adapters/index.ts`
  - [ ] Update `src/adapters/index.ts` shim (or equivalent monolith re-export file) to surface `AdapterOutputNormalizer` and `AdapterFormatError` from `@substrate-ai/core`
  - [ ] Run `npm run build` and confirm zero TypeScript errors before proceeding to test tasks
  - [ ] Verify with a quick grep that no file outside `packages/core/src/adapters/` imports from `adapter-output-normalizer.ts` directly (all consumers should go through the index)

- [ ] Task 5: Unit tests — AdapterOutputNormalizer strategy coverage (AC: #1, #2, #6)
  - [ ] Create `packages/core/src/adapters/__tests__/adapter-output-normalizer.test.ts`
  - [ ] Test `'standard'` strategy: a properly fenced YAML block is returned unchanged with `strategy: 'standard'`
  - [ ] Test `'strip-prose'` strategy: 3 prose paragraphs followed by a fenced YAML block — strategy `'standard'` fails on the unsanitized input, `'strip-prose'` succeeds
  - [ ] Test `'strip-markdown'` strategy: YAML lines prefixed with `>` blockquote markers are cleaned and successfully extracted
  - [ ] Test `'json-fallback'` strategy: `'{"verdict": "SUCCESS", "notes": "done"}'` embedded in prose is converted to YAML with `verdict: SUCCESS`
  - [ ] Test exhaustion: a string of pure binary/random noise returns `AdapterFormatError` with all 4 strategy labels in `tried_strategies` and `rootCause === 'adapter-format'`
  - [ ] Test snippet cap: when raw output is 2000 chars, `raw_output_snippet` on the returned error is exactly 500 chars
  - [ ] Do NOT mock `extractYamlBlock` — use real fixture strings so the extraction logic is exercised end-to-end

- [ ] Task 6: Unit tests — DispatcherImpl normalizer integration (AC: #3, #5)
  - [ ] Create `packages/core/src/dispatch/__tests__/dispatcher-impl-normalizer.test.ts` (or add cases to existing dispatcher test file if one exists)
  - [ ] Test: standard Claude Code fenced YAML output → `TaskResult.adapterError` is `undefined`, verdict reflects parsed YAML
  - [ ] Test: Codex output with prose prefix (normalizer strips it) → `TaskResult.adapterError` is `undefined`, verdict is correct
  - [ ] Test: completely unparseable output → `TaskResult.adapterError === true`, `TaskResult.verdict === 'error'`
  - [ ] Test: `TaskResult.errorMessage` on failure contains the adapter ID and output snippet but is not a raw stack trace
  - [ ] Use `AdapterOutputNormalizer` injected as a constructor argument so the dispatcher can be tested without a real adapter process

- [ ] Task 7: Integration test — 5-story adapter format fixture suite (AC: #5, #6)
  - [ ] Create `packages/core/src/adapters/__tests__/adapter-hardening.integration.test.ts`
  - [ ] Define 5 Codex output fixtures in the test file (no external fixture files): (1) prose prefix + YAML, (2) JSON wrapper `{"verdict":"SUCCESS",...}`, (3) duplicate YAML key `verdict: x\nverdict: y`, (4) trailing `\`\`\`` artifact after valid YAML, (5) YAML indented inside unlabelled code block
  - [ ] Define 5 Claude Code output fixtures representing standard fenced YAML blocks with varying story verdicts
  - [ ] For Claude Code set: assert all 5 normalize successfully (0 `adapterError` results)
  - [ ] For Codex set: assert ≥4/5 normalize successfully, and any failure returns a structured `AdapterFormatError` (not a thrown exception)
  - [ ] Mark with `// adapter-hardening-integration` comment; no real CLI invocation — fixture strings only

## Dev Notes

### Architecture Constraints
- **Package placement**: all new files go in `packages/core/src/adapters/`. No new files in `packages/sdlc/` — this is a core infrastructure concern, not an SDLC-level concern.
- **No adapter code changes**: `ClaudeCodeAdapter`, `CodexCLIAdapter`, and `GeminiCLIAdapter` must not be modified. The normalization layer is transparent to adapters — it operates on the raw string output after the adapter process exits.
- **Import rules**: `adapter-output-normalizer.ts` may import from `packages/core/src/dispatch/yaml-parser.ts` (same package). It must NOT import from `@substrate-ai/sdlc`, any `src/modules/` path, or any file outside `packages/core/`.
- **Backward compatibility**: `adapterError?: boolean` is optional. All existing callers of `TaskResult` continue to compile without changes. TypeScript will not require downstream code to handle the new field.
- **Dispatcher injection**: inject `AdapterOutputNormalizer` via the `DispatcherImpl` constructor (parameter with a default), not via module-level singleton. This enables unit testing without mocking module imports.
- **Output snippet**: always cap at 500 chars. Never log full raw output — it can be 100K+ chars and will flood structured logs.
- **Root cause bridge**: Story 53-5 defines the full `RootCauseCategory` union type and `classifyFailure()`. Story 53-10 exposes `adapterError: boolean` on `TaskResult` and `rootCause: 'adapter-format'` on `AdapterFormatError` as the integration surface. If `escalation-diagnosis.ts` does not yet have the `if (story.adapterError) return 'adapter-format'` branch (because 53-5 hasn't shipped), add it as a bridge in this story — see architecture doc §3.4.
- **js-yaml already a dependency**: the JSON-fallback strategy uses `js-yaml.dump()` to convert parsed JSON to YAML. Confirm `js-yaml` is already in `packages/core/package.json` before importing (it is used by `yaml-parser.ts`).

### Testing Requirements
- Test runner: `vitest` via `npm run test:fast` — all new test files must be auto-discovered (no manual config changes)
- Use `describe` / `it` naming convention throughout
- Do NOT mock `extractYamlBlock` in normalizer unit tests — use real fixture strings
- Do NOT make real CLI invocations in any test in this story
- The integration test (Task 7) is classified as a unit test (fixture-driven, no I/O) and must run under `npm run test:fast`

### File Paths to Create
- `packages/core/src/adapters/adapter-format-error.ts`
- `packages/core/src/adapters/adapter-output-normalizer.ts`
- `packages/core/src/adapters/__tests__/adapter-output-normalizer.test.ts`
- `packages/core/src/adapters/__tests__/adapter-hardening.integration.test.ts`
- `packages/core/src/dispatch/__tests__/dispatcher-impl-normalizer.test.ts`

### File Paths to Modify
- `packages/core/src/adapters/types.ts` — add `adapterError?: boolean` to `TaskResult`
- `packages/core/src/adapters/index.ts` — export `AdapterOutputNormalizer` and `AdapterFormatError`
- `packages/core/src/dispatch/dispatcher-impl.ts` — inject and wire `AdapterOutputNormalizer`
- `src/adapters/index.ts` — re-export new types from `@substrate-ai/core`
- `src/modules/implementation-orchestrator/escalation-diagnosis.ts` — add `adapter-format` bridge if story 53-5 has not shipped (see architecture doc §3.4)

## Interface Contracts

- **Export**: `AdapterFormatError` @ `packages/core/src/adapters/adapter-format-error.ts` (consumed by story 53-5 `classifyFailure()` for `RootCauseCategory` classification)
- **Export**: `AdapterOutputNormalizer` @ `packages/core/src/adapters/adapter-output-normalizer.ts` (consumed by `packages/core/src/dispatch/dispatcher-impl.ts`)
- **Export**: `TaskResult.adapterError` field @ `packages/core/src/adapters/types.ts` (consumed by story 53-5 `classifyFailure()` to detect `adapter-format` failures)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
