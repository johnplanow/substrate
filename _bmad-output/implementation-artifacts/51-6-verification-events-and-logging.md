# Story 51-6: Verification Events and Logging

## Story

As a substrate operator,
I want verification results emitted as NDJSON events and displayed clearly in the progress renderer,
so that I can monitor verification progress in real-time when running with `--events`.

## Acceptance Criteria

### AC1: NDJSON Event Types Defined
**Given** the `src/modules/implementation-orchestrator/event-types.ts` file that defines the `PipelineEvent` discriminated union
**When** the new verification event types are added
**Then** two new interfaces are exported: `VerificationCheckCompleteEvent` (type `'verification:check-complete'`) and `VerificationStoryCompleteEvent` (type `'verification:story-complete'`), each carrying a `ts: string` ISO-8601 timestamp
**And** both are added to the `PipelineEvent` union
**And** both type strings are added to `EVENT_TYPE_NAMES`
**And** the compile-time exhaustiveness check (`_AssertExhaustive`) continues to pass (confirmed by `npm run build` with zero TypeScript errors)

### AC2: Check-Complete Events Forwarded to NDJSON Stream
**Given** the `wireNdjsonEmitter()` function in `src/cli/commands/run.ts` that bridges internal eventBus events to the NDJSON output stream
**When** the eventBus emits `verification:check-complete` with payload `{ storyKey, checkName, status, details, duration_ms }`
**Then** a `VerificationCheckCompleteEvent` NDJSON line is emitted to stdout containing all five payload fields plus `type: 'verification:check-complete'` and `ts` timestamp

### AC3: Story-Complete Events Forwarded to NDJSON Stream
**Given** the `wireNdjsonEmitter()` function in `src/cli/commands/run.ts`
**When** the eventBus emits `verification:story-complete` with a `VerificationSummary` payload (`{ storyKey, checks, status, duration_ms }`)
**Then** a `VerificationStoryCompleteEvent` NDJSON line is emitted containing the full summary plus `type: 'verification:story-complete'` and `ts` timestamp

### AC4: Progress Renderer Shows In-Progress Verification State
**Given** a `ProgressRenderer` instance tracking a story in a terminal-ready state (e.g., after SHIP_IT verdict, while verification is running)
**When** a `verification:check-complete` event is received for that story
**Then** the story's status label in the progress display updates to `verifying...` (non-TTY: a new line is appended; TTY: the in-place display is redrawn)

### AC5: Progress Renderer Shows Final Verification Result
**Given** a `ProgressRenderer` instance tracking a story currently showing `verifying...`
**When** a `verification:story-complete` event is received for that story
**Then**:
- If `status === 'pass'`: status label updates to `verified ✓` (non-terminal — a subsequent `story:done` event will complete the state)
- If `status === 'warn'`: status label updates to `verified (warn)` (non-terminal — story still proceeds to COMPLETE)
- If `status === 'fail'`: story is marked terminal with status label `VERIFICATION FAILED` (colored red when TTY supports color)

### AC6: PIPELINE_EVENT_METADATA Updated
**Given** the `PIPELINE_EVENT_METADATA` array in `src/cli/commands/help-agent.ts` which must stay in sync with `PipelineEvent` (enforced by tests)
**When** the two new event types are added to the union
**Then** matching `EventMetadata` entries are added to `PIPELINE_EVENT_METADATA` for `'verification:check-complete'` and `'verification:story-complete'`, each with a `description`, `when`, and `fields` array
**And** `npm run test:fast` passes with zero failures (the `help-agent.test.ts` alignment tests confirm no gap)

### AC7: Unit Tests Pass
**Given** the unit test file for verification event logging
**When** `npm run test:fast` executes
**Then** at least 8 `it(...)` cases pass covering: NDJSON event emitted for `verification:check-complete` bus event, NDJSON event emitted for `verification:story-complete` bus event, progress renderer updates status label on check-complete, progress renderer shows `verified ✓` on story-complete pass, progress renderer shows `verified (warn)` on story-complete warn, progress renderer marks terminal on story-complete fail, renderer handles story not yet in storyState (adds to storyOrder), EVENT_TYPE_NAMES includes both new event type strings — confirmed by "Test Files" summary line showing the new test file green with zero failures

## Tasks / Subtasks

- [ ] Task 1: Add event types to NDJSON protocol (`event-types.ts`) (AC: #1)
  - [ ] Read the end of `src/modules/implementation-orchestrator/event-types.ts` before editing: `grep -n "VerificationCheck\|verification:\|PipelineEvent\|EVENT_TYPE_NAMES\|_AssertExhaustive" src/modules/implementation-orchestrator/event-types.ts | tail -30`
  - [ ] Add `VerificationCheckCompleteEvent` interface (before the `PipelineEvent` union):
    ```typescript
    /**
     * Emitted after each individual Tier A verification check completes (Story 51-6).
     * Payload mirrors the SdlcEvents 'verification:check-complete' payload plus ts timestamp.
     */
    export interface VerificationCheckCompleteEvent {
      type: 'verification:check-complete'
      /** ISO-8601 timestamp generated at emit time */
      ts: string
      /** Story key (e.g., "51-5") */
      storyKey: string
      /** Check name (e.g., "phantom-review", "trivial-output", "build") */
      checkName: string
      /** Check result status */
      status: 'pass' | 'warn' | 'fail'
      /** Human-readable details from the check */
      details: string
      /** Check execution time in milliseconds */
      duration_ms: number
    }
    ```
  - [ ] Add `VerificationStoryCompleteEvent` interface:
    ```typescript
    /**
     * Emitted once per story after all Tier A verification checks complete (Story 51-6).
     * Payload is the full VerificationSummary shape plus ts timestamp.
     */
    export interface VerificationStoryCompleteEvent {
      type: 'verification:story-complete'
      /** ISO-8601 timestamp generated at emit time */
      ts: string
      /** Story key (e.g., "51-5") */
      storyKey: string
      /** Per-check results */
      checks: Array<{
        checkName: string
        status: 'pass' | 'warn' | 'fail'
        details: string
        duration_ms: number
      }>
      /** Aggregated worst-case status across all checks */
      status: 'pass' | 'warn' | 'fail'
      /** Total duration of all checks in milliseconds */
      duration_ms: number
    }
    ```
  - [ ] Add both to the `PipelineEvent` union (insert before the `StoryAutoApprovedEvent` line at the end)
  - [ ] Add both type strings to `EVENT_TYPE_NAMES` with a comment `// Story 51-6: verification pipeline events`:
    - `'verification:check-complete'`
    - `'verification:story-complete'`
  - [ ] Run `npm run build` — confirm zero TypeScript errors (exhaustiveness check must pass)

- [ ] Task 2: Wire verification events in `wireNdjsonEmitter()` (`run.ts`) (AC: #2, #3)
  - [ ] Read the end of `wireNdjsonEmitter()` in `src/cli/commands/run.ts` before editing: `grep -n "wireNdjsonEmitter\|eventBus.on\|Story 24\|Story 25\|Story 51" src/cli/commands/run.ts | tail -20`
  - [ ] Import the new event types (if `VerificationCheckCompleteEvent` / `VerificationStoryCompleteEvent` are needed for the payload shape; otherwise the object literal is sufficient since TypeScript infers the shape from `ndjsonEmitter.emit`)
  - [ ] After the `story:metrics` handler block, add a comment and two new handlers:
    ```typescript
    // Verification pipeline events (Story 51-6)
    eventBus.on('verification:check-complete', (payload) => {
      ndjsonEmitter.emit({
        type: 'verification:check-complete',
        ts: new Date().toISOString(),
        storyKey: payload.storyKey,
        checkName: payload.checkName,
        status: payload.status,
        details: payload.details,
        duration_ms: payload.duration_ms,
      })
    })

    eventBus.on('verification:story-complete', (payload) => {
      ndjsonEmitter.emit({
        type: 'verification:story-complete',
        ts: new Date().toISOString(),
        storyKey: payload.storyKey,
        checks: payload.checks,
        status: payload.status,
        duration_ms: payload.duration_ms,
      })
    })
    ```
  - [ ] Run `npm run build` — confirm zero TypeScript errors

- [ ] Task 3: Update progress renderer to handle verification events (AC: #4, #5)
  - [ ] Read `src/modules/implementation-orchestrator/progress-renderer.ts` before editing to understand the `StoryState` interface and `render()` switch
  - [ ] Add `verificationStatus?: 'verifying' | 'pass' | 'warn' | 'fail'` field to the `StoryState` interface
  - [ ] In `buildStoryLines()`, after the terminal checks, add logic to show verification status when the story is non-terminal and `verificationStatus` is set:
    ```typescript
    // Show verification status for non-terminal stories in verification phase
    if (!state.terminal && state.verificationStatus === 'verifying') {
      statusText = 'verifying...'
    } else if (!state.terminal && state.verificationStatus === 'pass') {
      statusText = colorize('verified ✓', ANSI_GREEN)
    } else if (!state.terminal && state.verificationStatus === 'warn') {
      statusText = colorize('verified (warn)', ANSI_YELLOW)
    }
    // 'fail' terminal case handled in the terminal block below
    ```
  - [ ] In the terminal block inside `buildStoryLines()`, add a case for verification failure:
    ```typescript
    } else if (state.phase === 'verification-failed') {
      statusText = colorize('VERIFICATION FAILED', ANSI_RED)
    }
    ```
  - [ ] Add `VerificationCheckCompleteEvent` and `VerificationStoryCompleteEvent` to the import from `'./event-types.js'`
  - [ ] Add `handleVerificationCheckComplete(event: VerificationCheckCompleteEvent): void` function that:
    - Gets or creates a `StoryState` entry for `event.storyKey` (following the pattern in `handleStoryPhase`)
    - Sets `state.verificationStatus = 'verifying'`
    - Calls `redraw('  [verify] ' + event.storyKey + ' checking... (' + event.checkName + ')')`
  - [ ] Add `handleVerificationStoryComplete(event: VerificationStoryCompleteEvent): void` function that:
    - Gets or creates a `StoryState` entry for `event.storyKey`
    - Sets `state.verificationStatus = event.status`
    - If `event.status === 'fail'`: sets `state.phase = 'verification-failed'`, `state.terminal = true`
    - Calls `redraw` with appropriate non-TTY line:
      - pass: `'  [verify] ' + event.storyKey + ' verified ✓ (' + event.checks.length + ' checks)'`
      - warn: `'  [verify] ' + event.storyKey + ' verified (warn)'`
      - fail: `'  [verify] ' + event.storyKey + ' VERIFICATION FAILED'`
  - [ ] In the `render()` switch statement, add two new cases:
    ```typescript
    case 'verification:check-complete':
      handleVerificationCheckComplete(event)
      break
    case 'verification:story-complete':
      handleVerificationStoryComplete(event)
      break
    ```
  - [ ] Run `npm run build` — confirm zero TypeScript errors

- [ ] Task 4: Update `PIPELINE_EVENT_METADATA` in `help-agent.ts` (AC: #6)
  - [ ] Read the `PIPELINE_EVENT_METADATA` array in `src/cli/commands/help-agent.ts` before editing: `grep -n "verification\|story:build-verification\|PIPELINE_EVENT_METADATA" src/cli/commands/help-agent.ts | tail -20`
  - [ ] Add two entries to `PIPELINE_EVENT_METADATA` (after the existing `story:build-verification-*` entries or at the end before the closing bracket):
    ```typescript
    {
      type: 'verification:check-complete',
      description: 'Emitted after each Tier A verification check completes. Payload includes check name, status (pass/warn/fail), human-readable details, and execution duration.',
      when: 'After a story reaches SHIP_IT verdict, once per individual verification check (phantom-review, trivial-output, build).',
      fields: [
        { name: 'ts', type: 'string', description: 'Timestamp.' },
        { name: 'storyKey', type: 'string', description: 'Story key (e.g., "51-5").' },
        { name: 'checkName', type: 'string', description: 'Check name (e.g., "phantom-review", "trivial-output", "build").' },
        { name: 'status', type: 'pass|warn|fail', description: 'Check result.' },
        { name: 'details', type: 'string', description: 'Human-readable check details.' },
        { name: 'duration_ms', type: 'number', description: 'Check execution time in milliseconds.' },
      ],
    },
    {
      type: 'verification:story-complete',
      description: 'Emitted once per story after all Tier A verification checks complete. Payload is the full VerificationSummary with aggregated worst-case status.',
      when: 'After all Tier A checks complete for a story (after SHIP_IT verdict). Precedes story:done on pass/warn, or replaces it on fail.',
      fields: [
        { name: 'ts', type: 'string', description: 'Timestamp.' },
        { name: 'storyKey', type: 'string', description: 'Story key (e.g., "51-5").' },
        { name: 'checks', type: 'array', description: 'Per-check results (checkName, status, details, duration_ms).' },
        { name: 'status', type: 'pass|warn|fail', description: 'Aggregated worst-case status across all checks.' },
        { name: 'duration_ms', type: 'number', description: 'Total duration of all checks in milliseconds.' },
      ],
    },
    ```
  - [ ] Run `npm run build` — confirm zero TypeScript errors

- [ ] Task 5: Write unit tests (AC: #7)
  - [ ] Create `src/modules/implementation-orchestrator/__tests__/verification-event-logging.test.ts`
  - [ ] Import from `vitest`: `import { describe, it, expect, vi, beforeEach } from 'vitest'`
  - [ ] Import `EVENT_TYPE_NAMES` from `'../event-types.js'`
  - [ ] Import `createProgressRenderer` from `'../progress-renderer.js'`
  - [ ] For `wireNdjsonEmitter` tests: mock the event bus and ndjson emitter to verify forwarding; alternatively test the event type shapes directly
  - [ ] Test cases (minimum 8):
    1. `EVENT_TYPE_NAMES` includes `'verification:check-complete'`
    2. `EVENT_TYPE_NAMES` includes `'verification:story-complete'`
    3. Progress renderer: `verification:check-complete` event updates story status label to `verifying...` (non-TTY line contains "verifying")
    4. Progress renderer: `verification:story-complete` with `status: 'pass'` shows `verified ✓`
    5. Progress renderer: `verification:story-complete` with `status: 'warn'` shows `verified (warn)`
    6. Progress renderer: `verification:story-complete` with `status: 'fail'` marks story terminal and shows `VERIFICATION FAILED`
    7. Progress renderer: `verification:check-complete` for unknown story key adds it to storyOrder without crashing
    8. Progress renderer: `verification:story-complete` after `story:done` does not un-terminal the story (done state is preserved)
  - [ ] For each renderer test, pass a mock `Writable` stream and collect written output: `import { Writable } from 'node:stream'` then `const chunks: string[] = []; const stream = new Writable({ write(chunk, _, cb) { chunks.push(chunk.toString()); cb() } })`
  - [ ] Verify: `grep -c "it(" src/modules/implementation-orchestrator/__tests__/verification-event-logging.test.ts`
  - [ ] Tests for `wireNdjsonEmitter` NDJSON forwarding: create a minimal mock eventBus (`{ on: vi.fn(), emit: vi.fn() }`), call `wireNdjsonEmitter(mockBus, mockNdjsonEmitter)`, capture the handler registered for `'verification:check-complete'`, call it with a sample payload, assert `mockNdjsonEmitter.emit` was called with the correct object shape

- [ ] Task 6: Build and run tests (AC: #1, #6, #7)
  - [ ] Run `npm run build`; confirm zero TypeScript errors in all modified files
  - [ ] Run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line shows the new test file green with zero failures
  - [ ] Confirm `help-agent.test.ts` still passes (it validates PIPELINE_EVENT_METADATA alignment with EVENT_TYPE_NAMES)
  - [ ] NEVER pipe test output through `tail`, `head`, `grep`, or any filtering command

## Dev Notes

### Architecture Constraints
- **No LLM calls** (FR-V9): this story is pure event forwarding and display — no agent dispatches
- **`event-types.ts` has no external imports**: define `VerificationCheckCompleteEvent` and `VerificationStoryCompleteEvent` with inline payload shapes; do NOT import from `@substrate-ai/sdlc`. Mirror the `VerificationSummary` shape manually
- **Exhaustiveness must hold**: the compile-time `_AssertExhaustive` type in `event-types.ts` will produce a compile error if `PipelineEvent` and `EVENT_TYPE_NAMES` drift. Always run `npm run build` after editing `event-types.ts`
- **PIPELINE_EVENT_METADATA sync**: `help-agent.test.ts` imports `PIPELINE_EVENT_METADATA` and cross-checks it against `EVENT_TYPE_NAMES`. Adding to `EVENT_TYPE_NAMES` without a matching metadata entry will fail the test suite
- **ESM imports**: all relative imports within `src/` MUST use `.js` extensions
- **Progress renderer `PipelineEvent` import**: the `render()` method accepts `event: PipelineEvent`. After adding the two new event interfaces to the `PipelineEvent` union, TypeScript will correctly narrow them in the switch statement without additional casting

### Event Flow Architecture
The verification event flow is:
1. `VerificationPipeline.run()` (in `packages/sdlc`) emits on `TypedEventBus<SdlcEvents>` → `verification:check-complete` / `verification:story-complete`
2. `wireNdjsonEmitter()` (in `src/cli/commands/run.ts`) listens on `eventBus` (which is typed as `TypedEventBus<SdlcEvents>`) and calls `ndjsonEmitter.emit(...)` for each event
3. `ndjsonEmitter` writes the NDJSON line to stdout (when `--events` is active)
4. The same NDJSON stream is consumed by `createProgressRenderer()` via the `render()` method

Both the NDJSON emitter path and the progress renderer path receive the same events — the renderer is typically attached to the NDJSON stream in `auto.ts`.

### Locating `wireNdjsonEmitter` Integration Point
```bash
grep -n "wireNdjsonEmitter\|function wireNdjsonEmitter\|// Story 24\|// Story 25" src/cli/commands/run.ts | tail -15
```
Add the new handlers at the end of `wireNdjsonEmitter()`, after the `story:metrics` handler block (the last handler before the closing brace).

### Progress Renderer Ordering Note
Verification events arrive BEFORE `story:done` (because story 51-5 runs verification before marking the story COMPLETE). The renderer will show `verifying...` → `verified ✓` → then `story:done` replaces the state with `SHIP_IT (N cycles)`. This is the correct UX: the verification state is ephemeral and `story:done` is the final authoritative state for passing stories.

For failing verification, `verification:story-complete` with `status: 'fail'` marks the story terminal. No subsequent `story:done` arrives, so the `VERIFICATION FAILED` display persists.

### New File Paths
```
src/modules/implementation-orchestrator/__tests__/verification-event-logging.test.ts  — unit tests (≥8 cases)
```

### Modified File Paths
```
src/modules/implementation-orchestrator/event-types.ts   — 2 new event interfaces, PipelineEvent union, EVENT_TYPE_NAMES
src/cli/commands/run.ts                                   — 2 new handlers in wireNdjsonEmitter()
src/modules/implementation-orchestrator/progress-renderer.ts  — StoryState extension, 2 new handlers, render() cases
src/cli/commands/help-agent.ts                            — 2 new PIPELINE_EVENT_METADATA entries
```

### Testing Requirements
- **Framework**: Vitest (project standard). Import from `vitest` not `jest`
- **No real eventBus required**: for `wireNdjsonEmitter` tests, a minimal mock `{ on: vi.fn() }` is sufficient — capture the registered handler and invoke it directly
- **Stream mocking**: use `new Writable({ write(chunk, _, cb) { chunks.push(chunk.toString()); cb() } })` to capture renderer output without a real TTY
- **Duration assertion**: `duration_ms` in `VerificationCheckCompleteEvent` payloads can be any non-negative number; use fixed values in tests

## Interface Contracts

- **Import**: `verification:check-complete`, `verification:story-complete` event types @ `packages/sdlc/src/events.ts` (from story 51-1 — these are the SdlcEvents keys consumed by `wireNdjsonEmitter` via `eventBus.on(...)`)
- **Import**: `VerificationSummary` shape @ `packages/sdlc/src/verification/types.ts` (from story 51-1 — mirrored inline in `VerificationStoryCompleteEvent` without an import)
- **Export**: `VerificationCheckCompleteEvent` @ `src/modules/implementation-orchestrator/event-types.ts` (new NDJSON protocol type for `--events` consumers)
- **Export**: `VerificationStoryCompleteEvent` @ `src/modules/implementation-orchestrator/event-types.ts` (new NDJSON protocol type for `--events` consumers)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change |
|---|---|
| 2026-04-05 | Initial story created for Epic 51 Phase D |
