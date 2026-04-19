# Story 48-8: Loop Detection and Steering Injection

## Story

As a host application developer,
I want the coding agent to automatically detect repeating tool call patterns and support mid-task steering injection,
so that the agent recovers from infinite loops autonomously and host applications can redirect the agent between tool rounds without restarting the session.

## Acceptance Criteria

### AC1: Steering Queue — Injection Before Next LLM Call
**Given** a `CodingAgentSession` that is mid-loop (tool calls have been executed, loop is about to call LLM again)
**When** `session.steer("redirect message")` is called (from the host application or from loop detection)
**Then** the message is pushed onto `_steeringQueue`; on the next call to `_drainSteering()`, it is dequeued, appended to history as a `SteeringTurn`, and a `STEERING_INJECTED` event is emitted with `{ content: message }`; the SteeringTurn appears in the LLM request as a user-role message on the subsequent `llmClient.complete()` call

### AC2: Follow-Up Queue — Triggers New Processing Cycle
**Given** a `CodingAgentSession` that has reached natural completion (LLM returns text-only response with no tool calls)
**When** one or more messages were queued via `session.follow_up("follow-up message")` before or during processing
**Then** after the natural-completion break, the first message is dequeued from `_followupQueue` and `processInput` is called recursively with it, triggering a new processing cycle; `PROCESSING_END` is NOT emitted until all follow-ups are exhausted; subsequent follow-ups in the queue are processed one at a time in FIFO order

### AC3: `_drainSteering` Appends Turns and Emits Events
**Given** `_steeringQueue` contains N messages
**When** `_drainSteering()` is called
**Then** every message is dequeued in FIFO order; each message produces a `SteeringTurn { content, timestamp }` appended to `session.history`; a `STEERING_INJECTED` event is emitted per message with `{ content: message }`; after draining, `_steeringQueue` is empty

### AC4: `LoopDetector` Tracks Tool Call Signatures via Rolling Window
**Given** a `LoopDetector` constructed with `windowSize = 10` and `enabled = true`
**When** `detector.record(toolName, toolArgs)` is called for each executed tool call
**Then** the detector computes a SHA-256 hex digest of `"${toolName}:${JSON.stringify(toolArgs)}"` and pushes it to an internal array; the array retains only the last `windowSize` entries (oldest entries are evicted when the window is full)

### AC5: Loop Detection — Repeating Single-Call Pattern (Pattern Length 1)
**Given** a `LoopDetector` with `windowSize = 10` whose rolling window now has 10 entries all with the same signature (same tool called with same args 10 times)
**When** `detector.record(...)` is called and the window fills to `windowSize`
**Then** `detector.record(...)` returns `true` (loop detected)

### AC6: Loop Detection — Alternating Two-Call Pattern (Pattern Length 2)
**Given** a `LoopDetector` with `windowSize = 10` whose rolling window contains 10 entries following an A-B-A-B-A-B-A-B-A-B pattern (two distinct signatures alternating)
**When** `detector.record(...)` causes the window to contain this full A-B pattern repeated 5 times
**Then** `detector.record(...)` returns `true`; a single-call pattern (all same) that does not divide evenly OR a non-repeating pattern returns `false`

### AC7: Loop Detection Integration — Auto-Steer and LOOP_DETECTION Event
**Given** a `CodingAgentSession` with `enable_loop_detection: true` in its `SessionConfig`
**When** the internal `LoopDetector` returns `true` after a tool round completes (after `_drainSteering()` has already run)
**Then** the warning message `"Loop detected: the last ${windowSize} tool calls follow a repeating pattern. Try a different approach."` is appended directly to `session.history` as a `SteeringTurn` (bypassing the steering queue); a `LOOP_DETECTION` event is emitted with `{ message: warningMessage }`; when `enable_loop_detection: false`, no detection runs and no `LOOP_DETECTION` event is emitted

## Tasks / Subtasks

- [ ] Task 1: Create `LoopDetector` class in `packages/factory/src/agent/loop-detection.ts` (AC: #4, #5, #6)
  - [ ] Define and export `LoopDetectionConfig` interface: `{ windowSize: number; enabled: boolean }`
  - [ ] Define and export `LoopDetector` class with constructor `(config: LoopDetectionConfig)`
  - [ ] Implement `record(toolName: string, toolArgs: Record<string, unknown>): boolean` method
    - Compute SHA-256 hex digest: `createHash('sha256').update(\`${toolName}:${JSON.stringify(toolArgs)}\`).digest('hex')`
    - If `!config.enabled`, return `false` immediately without recording
    - Push signature to internal `_window: string[]`; evict oldest if `_window.length > windowSize`
    - After push: if `_window.length < windowSize`, return `false`; otherwise call `_detectPattern()` and return result
  - [ ] Implement private `_detectPattern(): boolean` that implements the spec algorithm (Section 2.10):
    - For `patternLen` in `[1, 2, 3]`: skip if `windowSize % patternLen !== 0`
    - Extract `pattern = _window.slice(0, patternLen)`
    - Check every subsequent block of `patternLen` entries matches `pattern`
    - Return `true` if any pattern length matches; return `false` if none match
  - [ ] Export `LoopDetector` and `LoopDetectionConfig` as named exports; no default exports

- [ ] Task 2: Implement `steer()` and `follow_up()` public methods on `CodingAgentSession` in `packages/factory/src/agent/loop.ts` (AC: #1, #2)
  - [ ] `steer(message: string): void` — pushes message to `this._steeringQueue`
  - [ ] `follow_up(message: string): void` — pushes message to `this._followupQueue`
  - [ ] These methods are safe to call from any state (IDLE, PROCESSING, CLOSED); if called while CLOSED, the message is queued but never drained

- [ ] Task 3: Implement `_drainSteering()` method fully on `CodingAgentSession` (AC: #3)
  - [ ] Replace the stub from story 48-7 with the full implementation
  - [ ] While `_steeringQueue.length > 0`: dequeue first message, create `SteeringTurn { content: msg, timestamp: new Date() }`, push to `this.history`, emit `STEERING_INJECTED` with `{ content: msg }`
  - [ ] Verify that `_drainSteering()` is called in both places in the loop: (a) at the start of the first LLM call (before the loop iteration), and (b) after each tool round's `ToolResultsTurn` is appended — confirm both call sites from story 48-7 are present and wired correctly

- [ ] Task 4: Integrate `LoopDetector` into the `processInput` core loop in `packages/factory/src/agent/loop.ts` (AC: #7)
  - [ ] Import `LoopDetector` from `'./loop-detection.js'`
  - [ ] Instantiate `LoopDetector` inside `processInput` (fresh detector per input): `new LoopDetector({ windowSize: config.loop_detection_window, enabled: config.enable_loop_detection })`
  - [ ] After each tool call execution (inside `_executeSingleTool` or inside the tool round dispatch), call `loopDetector.record(toolCall.name, toolCall.arguments)`; collect per-call results
  - [ ] After `_drainSteering()` runs post-tool-round: check if any `record()` call in that round returned `true`
    - If yes: construct `warningMessage = \`Loop detected: the last ${config.loop_detection_window} tool calls follow a repeating pattern. Try a different approach.\``
    - Append `SteeringTurn { content: warningMessage, timestamp: new Date() }` directly to `this.history` (do NOT use `_steeringQueue`)
    - Emit `LOOP_DETECTION` event with `{ message: warningMessage }`

- [ ] Task 5: Implement follow-up queue drain after natural completion in `processInput` (AC: #2)
  - [ ] After the natural-completion `break` (LLM response has no tool calls), before `PROCESSING_END`:
    - Check `if (this._followupQueue.length > 0)`
    - Dequeue first message: `const nextInput = this._followupQueue.shift()!`
    - Await `this.processInput(nextInput)` recursively
    - `return` immediately after (do not fall through to `PROCESSING_END` emission)
  - [ ] `PROCESSING_END` is only emitted when `_followupQueue` is empty at the end of the outer call

- [ ] Task 6: Update barrel exports in `packages/factory/src/agent/index.ts` (AC: all)
  - [ ] Add `export * from './loop-detection.js'` to re-export `LoopDetector` and `LoopDetectionConfig`
  - [ ] Verify factory-level `packages/factory/src/index.ts` still re-exports from `'./agent/index.js'`

- [ ] Task 7: Write unit tests for `LoopDetector` in `packages/factory/src/agent/__tests__/loop-detection.test.ts` (AC: #4, #5, #6)
  - [ ] `new LoopDetector` starts with an empty window; first `record()` call returns `false`
  - [ ] With `windowSize=10`, returns `false` for any call count below 10
  - [ ] 10 identical signatures returns `true` (pattern length 1 match)
  - [ ] 10 entries in A-B-A-B-...-A-B returns `true` (pattern length 2 match)
  - [ ] 9 A-entries + 1 B-entry returns `false` (not a clean pattern-1 or pattern-2 match)
  - [ ] Non-repeating 10 entries returns `false`
  - [ ] `enabled: false` always returns `false` regardless of pattern
  - [ ] Different `toolArgs` produce different signatures (no false positives across tools with same name)
  - [ ] Window eviction: with `windowSize=4`, after 6 calls (A-A-A-B-B-B), only last 4 (B-B-B-B wait... A-B-B-B) remain; verify `record()` reflects only the evicted window
  - [ ] Pattern length 3 detection: `windowSize=6`, 2 repetitions of A-B-C returns `true`

- [ ] Task 8: Write integration tests for steering/follow-up/loop-detection in `packages/factory/src/agent/__tests__/loop.test.ts` (AC: #1, #2, #3, #7)
  - [ ] `steer()` message appears as SteeringTurn before next LLM call and in correct history position
  - [ ] `STEERING_INJECTED` event is emitted with correct content when `_drainSteering()` runs
  - [ ] `follow_up()` queued message triggers new processing cycle; `PROCESSING_END` only emitted after follow-up completes
  - [ ] Loop detection fires when mock LLM returns the same tool call 10+ times: `LOOP_DETECTION` event emitted, SteeringTurn with warning in history
  - [ ] `enable_loop_detection: false` suppresses `LOOP_DETECTION` event even with repeating pattern
  - [ ] `steer()` called while session is IDLE (not processing): message is buffered and injected on next `processInput` call

## Dev Notes

### Architecture Constraints
- **ESM imports**: all imports within `packages/factory/` use `.js` extensions (e.g., `import { LoopDetector } from './loop-detection.js'`)
- **Named exports only** — no default exports anywhere
- **Node.js crypto**: use `import { createHash } from 'node:crypto'` for SHA-256 hashing; no external hash libraries
- **ADR-003**: `packages/factory` MUST NOT import from `packages/sdlc` or the sdlc entry point; `@substrate-ai/core` imports are allowed (cost utilities, etc.)
- **No provider SDK imports** in the agent layer

### Key File Locations
- **New file**: `packages/factory/src/agent/loop-detection.ts` — `LoopDetector` class + `LoopDetectionConfig` type
- **Modify**: `packages/factory/src/agent/loop.ts` — implement `steer()`, `follow_up()`, fill in `_drainSteering()`, integrate `LoopDetector`, handle follow-up drain
- **Modify**: `packages/factory/src/agent/index.ts` — add `export * from './loop-detection.js'`
- **New test**: `packages/factory/src/agent/__tests__/loop-detection.test.ts`
- **Modify test**: `packages/factory/src/agent/__tests__/loop.test.ts` — add integration tests for steering and loop detection

### Pattern Detection Algorithm (from spec Section 2.10)
Story 48-7 left `_drainSteering`, `steer`, and `follow_up` as stubs. The 48-7 loop body already calls `_drainSteering()` in the correct positions. This story fills in those stubs and adds `LoopDetector`. The spec algorithm is:

```
FUNCTION detect_loop(history, window_size) -> Boolean:
    recent_calls = extract_tool_call_signatures(history, last = window_size)
    IF LENGTH(recent_calls) < window_size: RETURN false

    -- Check for repeating patterns of length 1, 2, or 3
    FOR pattern_len IN [1, 2, 3]:
        IF window_size % pattern_len != 0: CONTINUE
        pattern = recent_calls[0..pattern_len]
        all_match = true
        FOR i FROM pattern_len TO window_size STEP pattern_len:
            IF recent_calls[i..i+pattern_len] != pattern:
                all_match = false; BREAK
        IF all_match: RETURN true

    RETURN false
```

For `windowSize = 10`: pattern lengths 1 (10÷1=10✓) and 2 (10÷2=5✓) are checked; length 3 is skipped (10÷3≠integer).

The `LoopDetector` implements this with a rolling in-memory window rather than re-scanning history, which is more efficient.

### Signature Hash Input
```typescript
import { createHash } from 'node:crypto'

function makeSignature(toolName: string, toolArgs: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${toolName}:${JSON.stringify(toolArgs)}`)
    .digest('hex')
}
```

**Important**: `JSON.stringify` is non-deterministic for objects with different key insertion order. Use `JSON.stringify` directly — this is acceptable because tool call arguments from a given LLM call are stable and consistent; the same call repeated will have the same serialized form.

### Loop Detection Call Site in `processInput`
The loop detection should be scoped per `processInput` call (not across sessions). Create a fresh `LoopDetector` at the start of `processInput`. Record each individual tool call as it executes. Check for detection after each round (after `_drainSteering()`). Note: for parallel tool calls in a single round, all tool calls in the round are recorded; the window check fires after the last one in the round.

Pattern for integration in `processInput`:
```typescript
// Fresh detector for this input
const loopDetector = new LoopDetector({
  windowSize: this._config.loop_detection_window,
  enabled: this._config.enable_loop_detection
})

// Inside the tool round, after executing ALL tool calls:
let loopTriggered = false
for (const toolCall of toolCalls) {
  const detected = loopDetector.record(toolCall.name, toolCall.arguments)
  if (detected) loopTriggered = true
}

// After _drainSteering():
if (loopTriggered) {
  const warningMessage = `Loop detected: the last ${this._config.loop_detection_window} tool calls follow a repeating pattern. Try a different approach.`
  this.history.push({ content: warningMessage, timestamp: new Date() } satisfies SteeringTurn)
  this._emit(EventKind.LOOP_DETECTION, { message: warningMessage })
}
```

### Follow-Up Queue Behavior
Follow-up recursion is depth-first: if A queues follow-up B, and B queues follow-up C, processing is A → B → C before `PROCESSING_END`. The recursion is bounded by the follow-up queue draining naturally. There is no cycle guard — if follow_up is called inside processing, it is fine; the new message is queued and processed after the current turn's natural completion.

### SteeringTurn vs Steering Queue for Loop Detection
Loop detection injects its warning **directly into history** as a `SteeringTurn` — it does NOT go through `_steeringQueue`. This matches the spec pseudocode:
```
session.history.APPEND(SteeringTurn(content = warning))
session.emit(LOOP_DETECTION, message = warning)
```
The direct-inject approach ensures the warning is always the last entry before the next LLM call, regardless of any other queued steering messages.

### Testing Requirements
- Use `vitest` (`describe`, `it`, `expect`, `vi`, `beforeEach`)
- For `loop-detection.test.ts`: no mocking needed — `LoopDetector` is pure computation
- For `loop.test.ts` integration tests: mock `LLMClient.complete()` with `vi.fn()` returning sequences of tool-call responses then text-only responses
- Do NOT make real HTTP calls or spawn real processes
- Collect events via `session.on(kind, e => events.push(e))`
- Run via `npm run test:fast` (timeout 300000ms) — never pipe output

### Key Imports Pattern for `loop-detection.ts`
```typescript
import { createHash } from 'node:crypto'

export interface LoopDetectionConfig {
  windowSize: number
  enabled: boolean
}

export class LoopDetector {
  private readonly _config: LoopDetectionConfig
  private readonly _window: string[] = []

  constructor(config: LoopDetectionConfig) {
    this._config = config
  }

  record(toolName: string, toolArgs: Record<string, unknown>): boolean {
    if (!this._config.enabled) return false
    const sig = createHash('sha256')
      .update(`${toolName}:${JSON.stringify(toolArgs)}`)
      .digest('hex')
    this._window.push(sig)
    if (this._window.length > this._config.windowSize) {
      this._window.shift()
    }
    if (this._window.length < this._config.windowSize) return false
    return this._detectPattern()
  }

  private _detectPattern(): boolean {
    const w = this._window
    const n = this._config.windowSize
    for (const patternLen of [1, 2, 3]) {
      if (n % patternLen !== 0) continue
      const pattern = w.slice(0, patternLen)
      let allMatch = true
      for (let i = patternLen; i < n; i += patternLen) {
        for (let j = 0; j < patternLen; j++) {
          if (w[i + j] !== pattern[j]) { allMatch = false; break }
        }
        if (!allMatch) break
      }
      if (allMatch) return true
    }
    return false
  }
}
```

## Interface Contracts

- **Import**: `SessionConfig`, `SteeringTurn`, `EventKind`, `SessionEvent` @ `packages/factory/src/agent/types.ts` (from story 48-7)
- **Import**: `CodingAgentSession` class, `_steeringQueue`, `_followupQueue`, `_drainSteering` stub @ `packages/factory/src/agent/loop.ts` (from story 48-7)
- **Export**: `LoopDetector`, `LoopDetectionConfig` @ `packages/factory/src/agent/loop-detection.ts` (consumed by story 48-10 `DirectCodergenBackend` indirectly via session)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
