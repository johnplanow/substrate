# Story 30-6: Recommendation-to-Prompt Injection

## Story

As a pipeline operator running multi-story pipelines,
I want optimization directives derived from completed stories' telemetry automatically injected into each subsequent story's dispatch prompt,
so that accumulated efficiency insights from story N reduce wasted tokens and context issues in story N+1 without any manual intervention.

## Acceptance Criteria

### AC1: TelemetryAdvisor gains getRecommendationsForRun() that aggregates across completed stories
**Given** a `TelemetryAdvisor` instance and a list of `completedStoryKeys` representing stories that have finished in the current pipeline run
**When** `getRecommendationsForRun(completedStoryKeys)` is called
**Then** it queries `getRecommendations(storyKey)` for each key, merges the results, deduplicates by recommendation `id`, and returns the combined array sorted by severity (critical first, then warning, then info) — returns an empty array when `completedStoryKeys` is empty or no recommendations exist

### AC2: TelemetryAdvisor gains formatOptimizationDirectives() with severity filter and token budget
**Given** a list of `Recommendation` objects of mixed severities
**When** `formatOptimizationDirectives(recommendations)` is called
**Then** it filters to only `critical` and `warning` severity items, formats each as a natural-language `OPTIMIZATION: …` line with the recommendation title and description, and truncates output to a maximum of 2000 characters (~500 tokens) — returns an empty string when no critical or warning recommendations are present

### AC3: AdapterOptions extended with optional optimizationDirectives field
**Given** the `AdapterOptions` interface in `src/adapters/types.ts`
**When** the interface is read
**Then** it includes an optional `optimizationDirectives?: string` field with a JSDoc comment explaining its purpose (prompt injection from prior story telemetry)

### AC4: ClaudeAdapter.buildCommand() appends directives to the system prompt when present
**Given** a `ClaudeAdapter` instance called with `options.optimizationDirectives` set to a non-empty string
**When** `buildCommand(prompt, options)` is called
**Then** the `--system-prompt` argument passed to the Claude CLI is the base system prompt string followed by a blank line, an `## Optimization Directives` header, and the directives text — the total system prompt is passed as a single string to `--system-prompt`

### AC5: ClaudeAdapter.buildCommand() skips injection when directives are absent or empty
**Given** a `ClaudeAdapter` instance called with `options.optimizationDirectives` set to `undefined` or `""`
**When** `buildCommand(prompt, options)` is called
**Then** the `--system-prompt` argument is exactly the unmodified base system prompt string — no header, no blank lines appended

### AC6: Orchestrator queries TelemetryAdvisor before each story dispatch and threads directives through
**Given** an active pipeline run with TelemetryAdvisor wired (telemetry enabled) and at least one completed story in the current run
**When** the orchestrator prepares the next story's dispatch
**Then** it calls `telemetryAdvisor.getRecommendationsForRun(completedStoryKeys)` followed by `formatOptimizationDirectives(recommendations)`, and the resulting non-empty string is passed as `optimizationDirectives` in the `AdapterOptions` (or equivalent dispatch options) used for the ClaudeAdapter invocation

### AC7: Directive injection is failure-tolerant and skips cleanly when conditions are not met
**Given** any of: (a) no TelemetryAdvisor configured (telemetry disabled), (b) `completedStoryKeys` is empty (first story in run), (c) all recommendations are info-level, or (d) TelemetryAdvisor throws an error
**When** the orchestrator processes the next story dispatch
**Then** no `optimizationDirectives` field is included in dispatch options, the pipeline continues normally, and any advisor error is caught and logged at debug level — dispatch is never blocked

## Tasks / Subtasks

- [ ] Task 1: Add `getRecommendationsForRun()` to TelemetryAdvisor (AC: #1)
  - [ ] In `src/modules/telemetry/telemetry-advisor.ts`, add `async getRecommendationsForRun(completedStoryKeys: string[]): Promise<Recommendation[]>`
  - [ ] Guard: return `[]` immediately when `completedStoryKeys` is empty
  - [ ] For each storyKey, call `this._persistence.getRecommendations(storyKey)` — collect results in parallel via `Promise.all`
  - [ ] Deduplicate by `rec.id` (a story may have been processed twice; keep first occurrence)
  - [ ] Sort merged array: severity order `critical → warning → info` (match existing severity enum ordering in `RecommendationSeveritySchema`)
  - [ ] Wrap in try/catch; log warn and return `[]` on failure
  - [ ] Add import for `Recommendation` type from `./types.js` (already imported as `EfficiencyScore` — add `Recommendation` to same import)

- [ ] Task 2: Add `formatOptimizationDirectives()` to TelemetryAdvisor (AC: #2)
  - [ ] In `src/modules/telemetry/telemetry-advisor.ts`, add `formatOptimizationDirectives(recommendations: Recommendation[]): string` (synchronous)
  - [ ] Filter input to only `critical` and `warning` severity items; return `""` if none
  - [ ] Format each recommendation as: `OPTIMIZATION (${rec.severity}): ${rec.title}. ${rec.description}`
  - [ ] Join lines with `"\n"` and truncate the combined string to a maximum of 2000 characters at a word boundary (use `lastIndexOf(' ', 2000)` to avoid mid-word cuts, then append `"…"`)
  - [ ] Return the truncated string (or full string if ≤2000 chars)
  - [ ] Log at debug level: directive count and total character length

- [ ] Task 3: Add `optimizationDirectives` to AdapterOptions (AC: #3)
  - [ ] In `src/adapters/types.ts`, add to `AdapterOptions`:
    ```typescript
    /**
     * Optional optimization directives derived from prior stories' telemetry (Story 30-6).
     * When set, appended to the system prompt to guide the sub-agent toward efficient patterns.
     * Generated by TelemetryAdvisor.formatOptimizationDirectives().
     */
    optimizationDirectives?: string
    ```
  - [ ] Verify TypeScript compiles: `npm run build`

- [ ] Task 4: Update ClaudeAdapter.buildCommand() to inject directives into system prompt (AC: #4, #5)
  - [ ] In `src/adapters/claude-adapter.ts`, locate the `systemPrompt` constant (lines ~130–134)
  - [ ] After the constant declaration, add conditional append:
    ```typescript
    const effectiveSystemPrompt =
      options.optimizationDirectives !== undefined && options.optimizationDirectives.length > 0
        ? `${systemPrompt}\n\n## Optimization Directives\n${options.optimizationDirectives}`
        : systemPrompt
    ```
  - [ ] Replace the `'--system-prompt', systemPrompt` array entry with `'--system-prompt', effectiveSystemPrompt`
  - [ ] Log at debug level when directives are injected: `logger.debug({ storyKey: options.storyKey, directiveChars: options.optimizationDirectives.length }, 'Injecting optimization directives into system prompt')`
  - [ ] Verify TypeScript compiles: `npm run build`

- [ ] Task 5: Wire TelemetryAdvisor directive query in orchestrator (AC: #6, #7)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, locate where `ingestionServer` is initialized during orchestrator startup
  - [ ] Alongside `ingestionServer`, initialize a `TelemetryAdvisor | undefined` (when `telemetryPersistence` or the database adapter is available): `const telemetryAdvisor = db !== undefined ? createTelemetryAdvisor({ db }) : undefined`
  - [ ] In the sequential story processing loop (the `for (const storyKey of group)` loop), maintain a `completedStoryKeys: string[]` array — push `storyKey` immediately after `await processStory(storyKey)` completes
  - [ ] Before each `processStory(storyKey)` call, compute optimization directives:
    ```typescript
    let optimizationDirectives: string | undefined
    if (telemetryAdvisor !== undefined && completedStoryKeys.length > 0) {
      try {
        const recs = await telemetryAdvisor.getRecommendationsForRun(completedStoryKeys)
        const directives = telemetryAdvisor.formatOptimizationDirectives(recs)
        if (directives.length > 0) {
          optimizationDirectives = directives
          logger.debug({ storyKey, directiveCount: recs.filter(r => r.severity !== 'info').length }, 'Optimization directives ready for dispatch')
        }
      } catch (err) {
        logger.debug({ err, storyKey }, 'Failed to fetch optimization directives — proceeding without')
      }
    }
    ```
  - [ ] Thread `optimizationDirectives` into the options that eventually reach `AdapterOptions` — follow the same pattern used by `maxContextTokens` in story 30-8 (find the dispatch call that uses `maxContextTokens` and add `optimizationDirectives` alongside it)
  - [ ] Verify TypeScript compiles: `npm run build`

- [ ] Task 6: Unit tests for TelemetryAdvisor new methods (AC: #1, #2, #7)
  - [ ] In `src/modules/telemetry/__tests__/telemetry-advisor.test.ts` (existing file), add a new `describe('getRecommendationsForRun', ...)` block:
    - Test: empty `completedStoryKeys` → returns `[]`
    - Test: single story with 2 recommendations → returns both sorted by severity
    - Test: two stories with overlapping recommendation IDs → deduplicates (returns unique IDs only)
    - Test: `_persistence.getRecommendations` throws → caught, returns `[]`
    - Test: multiple stories, verifies `Promise.all` parallelism (both stories queried)
  - [ ] Add a `describe('formatOptimizationDirectives', ...)` block:
    - Test: empty array → returns `""`
    - Test: all `info` severity → returns `""`
    - Test: one `critical`, one `warning`, one `info` → returns string with only critical and warning, critical first
    - Test: combined description exceeds 2000 chars → truncates to ≤2000 chars, ends with `"…"`
    - Test: combined description ≤2000 chars → returns full string unmodified
  - [ ] Use mock `ITelemetryPersistence` with `vi.fn()` for `getRecommendations`

- [ ] Task 7: Unit tests for ClaudeAdapter system prompt injection + run tests (AC: #4, #5)
  - [ ] In `src/adapters/__tests__/claude-adapter.test.ts` (or equivalent), add tests:
    - Test: `buildCommand(prompt, { ...baseOptions, optimizationDirectives: 'OPTIMIZATION: foo' })` → `--system-prompt` arg contains `"## Optimization Directives\nOPTIMIZATION: foo"`
    - Test: `buildCommand(prompt, { ...baseOptions, optimizationDirectives: undefined })` → `--system-prompt` arg equals base system prompt string exactly (no appended header)
    - Test: `buildCommand(prompt, { ...baseOptions, optimizationDirectives: '' })` → `--system-prompt` arg equals base system prompt string exactly
  - [ ] Run `npm run test:fast` — confirm "Test Files" summary shows all passing and no regressions

## Dev Notes

### Architecture Constraints

- **File locations** (must match exactly):
  - TelemetryAdvisor extension: `src/modules/telemetry/telemetry-advisor.ts` — add two methods to existing class, no new file
  - AdapterOptions extension: `src/adapters/types.ts` — add one optional field
  - ClaudeAdapter injection: `src/adapters/claude-adapter.ts` — update `buildCommand()` only
  - Orchestrator wiring: `src/modules/implementation-orchestrator/orchestrator-impl.ts` — directive query + completedStoryKeys tracking + dispatch threading
  - Tests: `src/modules/telemetry/__tests__/telemetry-advisor.test.ts` and `src/adapters/__tests__/claude-adapter.test.ts`

- **Import style**: All imports use `.js` extensions (ESM). No new external dependencies.
- **Test framework**: Vitest — use `vi.fn()`, `vi.mock`, `describe`/`it`/`expect`. Never jest APIs.
- **TelemetryAdvisor is additive**: Do NOT remove or rename `getEfficiencyProfile()` — it is used by story 30-8 (`retry-escalated` command). Add the two new methods alongside the existing one.
- **No new DB schema migrations**: This story reads from `recommendations` table (written by 30-4/30-5). No new columns needed.

### TelemetryAdvisor: Importing Recommendation type

The existing `telemetry-advisor.ts` imports `EfficiencyScore` from `./types.js`. Add `Recommendation` to the same import line:

```typescript
import type { EfficiencyScore, Recommendation } from './types.js'
```

The `TelemetryPersistence` class's `getRecommendations(storyKey)` method already exists (confirmed in persistence.ts line 64). No changes needed to persistence layer.

### formatOptimizationDirectives: token budget approximation

Use a character-count proxy (2000 chars ≈ 500 tokens at average 4 chars/token). Truncate at a word boundary to avoid mid-word cuts:

```typescript
formatOptimizationDirectives(recommendations: Recommendation[]): string {
  const MAX_CHARS = 2000
  const actionable = recommendations.filter(r => r.severity === 'critical' || r.severity === 'warning')
  if (actionable.length === 0) return ''

  const lines = actionable.map(
    r => `OPTIMIZATION (${r.severity}): ${r.title}. ${r.description}`
  )
  const full = lines.join('\n')

  if (full.length <= MAX_CHARS) {
    logger.debug({ count: actionable.length, chars: full.length }, 'Formatting optimization directives')
    return full
  }

  // Truncate at word boundary
  const cutAt = full.lastIndexOf(' ', MAX_CHARS)
  const truncated = (cutAt > 0 ? full.slice(0, cutAt) : full.slice(0, MAX_CHARS)) + '…'
  logger.debug({ count: actionable.length, chars: truncated.length }, 'Optimization directives truncated to budget')
  return truncated
}
```

### ClaudeAdapter: system prompt injection pattern

The existing `buildCommand()` constructs `systemPrompt` as a string constant on line ~130. The injection adds a conditional `effectiveSystemPrompt`:

```typescript
const systemPrompt =
  'You are an autonomous coding agent executing a single pipeline task. ' +
  'Ignore all session startup context, memory notes, and "Next Up" indicators. ' +
  'Follow the instructions in the user message exactly. ' +
  'Emit ONLY the YAML output specified in the Output Contract — no other text.'

const effectiveSystemPrompt =
  options.optimizationDirectives !== undefined && options.optimizationDirectives.length > 0
    ? `${systemPrompt}\n\n## Optimization Directives\n${options.optimizationDirectives}`
    : systemPrompt

const args = [
  '-p',
  '--model', model,
  '--dangerously-skip-permissions',
  '--system-prompt', effectiveSystemPrompt,
  // ...rest unchanged
]
```

The `## Optimization Directives` header is intentionally minimal — it provides structure without mimicking the CLAUDE.md system-reminder format, which agents are explicitly told to ignore.

### Orchestrator: completedStoryKeys tracking

The sequential processing loop already exists around line ~2077 in `orchestrator-impl.ts`. Add `completedStoryKeys` tracking:

```typescript
const completedStoryKeys: string[] = []

for (const storyKey of group) {
  // Query optimization directives from prior stories (Story 30-6)
  let optimizationDirectives: string | undefined
  if (telemetryAdvisor !== undefined && completedStoryKeys.length > 0) {
    try {
      const recs = await telemetryAdvisor.getRecommendationsForRun(completedStoryKeys)
      const directives = telemetryAdvisor.formatOptimizationDirectives(recs)
      if (directives.length > 0) optimizationDirectives = directives
    } catch (err) {
      logger.debug({ err, storyKey }, 'Failed to fetch optimization directives — proceeding without')
    }
  }

  await processStory(storyKey, { optimizationDirectives })   // pass through to dispatch
  completedStoryKeys.push(storyKey)

  // Flush OTLP telemetry between stories (Story 30-5)
  await ingestionServer?.flushAndAwait()
  // GC hint, sleep... (existing code unchanged)
}
```

The `optimizationDirectives` must be threaded into whatever options object is assembled for the dispatcher. Look at how `maxContextTokens` (story 30-8) was propagated — `optimizationDirectives` should follow the exact same path.

### Orchestrator: TelemetryAdvisor initialization

The orchestrator already initializes `telemetryPersistence` and/or has access to the `DatabaseAdapter` for telemetry. Follow the existing pattern for telemetry initialization. Locate how `telemetryPersistence` is created in the orchestrator setup and instantiate `TelemetryAdvisor` immediately after, using the same DB adapter:

```typescript
import { createTelemetryAdvisor } from '../telemetry/telemetry-advisor.js'

// Alongside existing telemetry setup:
const telemetryAdvisor = db !== undefined ? createTelemetryAdvisor({ db }) : undefined
```

The exact variable name for the database adapter in orchestrator scope may differ — search for `new TelemetryPersistence(` or `createTelemetryAdvisor` to find the right anchor.

### Testing Requirements

- **Test framework**: Vitest — test files use `.test.ts` extension
- **Coverage**: 80% threshold enforced — cover all branches: empty keys, deduplication, truncation, undefined/empty directives (no injection), error path (try/catch)
- **Run tests**: `npm run test:fast` — never pipe output; confirm by checking for "Test Files" in output
- **Targeted run during dev**: `npm run test:changed`

### Scope Boundaries

- **In scope**: `TelemetryAdvisor` new methods, `AdapterOptions.optimizationDirectives`, `buildCommand()` injection, orchestrator wiring, unit tests
- **Out of scope**: CLI changes (no new commands or flags); new recommendation rules (30-7); retry gating (30-8 consumes `TelemetryAdvisor.getEfficiencyProfile` — do not change that method); changing the `formatOptimizationDirectives` format for display (this is prompt injection, not human output); modifying `TelemetryPipeline` or `Recommender`

## Interface Contracts

- **Export**: `TelemetryAdvisor.getRecommendationsForRun(completedStoryKeys: string[]): Promise<Recommendation[]>` @ `src/modules/telemetry/telemetry-advisor.ts`
- **Export**: `TelemetryAdvisor.formatOptimizationDirectives(recommendations: Recommendation[]): string` @ `src/modules/telemetry/telemetry-advisor.ts`
- **Export**: `AdapterOptions.optimizationDirectives?: string` @ `src/adapters/types.ts` — consumed by `ClaudeAdapter.buildCommand()` and threaded through the dispatcher from the orchestrator
- **Import**: `Recommendation` @ `src/modules/telemetry/types.ts` (existing type, no changes)
- **Import**: `EfficiencyScore` @ `src/modules/telemetry/types.ts` (from story 30-3 — dispatch-level scores; not directly used here but relevant to context)
- **Import**: `ITelemetryPersistence.getRecommendations(storyKey)` @ `src/modules/telemetry/persistence.ts` (from story 30-4/30-5 — already exists)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
