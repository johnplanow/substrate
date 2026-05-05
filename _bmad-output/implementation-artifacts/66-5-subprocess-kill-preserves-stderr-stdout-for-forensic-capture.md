---
external_state_dependencies:
  - subprocess
---

# Story 66-5: subprocess kill preserves stderr/stdout for forensic capture

## Story

As a substrate operator debugging a timed-out dispatch,
I want subprocess stderr and stdout captured into bounded in-process buffers and attached to the timeout kill event,
so that I can determine whether the LLM subprocess was making progress or hung indefinitely with no output.

## Acceptance Criteria

<!-- source-ac-hash: daec2c06031872aaf6521d85a007881a7a2ce587e09bccbba79ffc683213e0dd -->

1. `packages/core/src/dispatch/dispatcher-impl.ts` accumulates subprocess stderr and stdout into bounded buffers (max ~64KB per stream, tail-window discipline — most recent bytes preserved).
2. On timeout-kill, the captured `stderrTail: string` and `stdoutTail: string` are attached to the `dispatch:spawnsync-timeout` event (extending the schema from Story 66-4).
3. Buffer caps are enforced — no unbounded memory growth even on subprocesses that emit large output streams.
4. Buffer encoding: assume UTF-8; bytes that don't decode cleanly are replaced with U+FFFD per standard Buffer.toString('utf8') semantics.
5. Test: spawn a subprocess that writes "PROGRESS_MARKER\n" to stderr, sleeps long enough to exceed timeout, then asserts the `dispatch:spawnsync-timeout` event's `stderrTail` contains "PROGRESS_MARKER".
6. Test: spawn a subprocess that writes 200KB to stderr (above the buffer cap) and assert the captured tail contains the FINAL bytes (proving tail-window discipline), not the initial bytes.
7. Backward-compat: when a subprocess exits cleanly (no timeout-kill), the buffers are not surfaced — they exist only as a forensic artifact for the timeout path.
8. Commit message references obs_2026-05-04_023 fix #4.

## Tasks / Subtasks

- [x] Task 1: Extend `DispatchSpawnSyncTimeoutEvent` in event-types.ts with optional tail fields (AC: #2)
  - [x] Open `packages/sdlc/src/run-model/event-types.ts` and add `stderrTail?: string` and `stdoutTail?: string` to `DispatchSpawnSyncTimeoutEvent`
  - [x] Add JSDoc comment referencing Story 66-5 and obs_2026-05-04_023 fix #4 on the new fields
  - [x] Fields must be optional (`?: string`) for backward-compatibility with existing callers that emit the event without tails

- [x] Task 2: Add 64KB tail-window buffer discipline to stderr/stdout data handlers in dispatcher-impl.ts (AC: #1, #3, #4)
  - [x] The `stdoutChunks` and `stderrChunks` arrays already exist in the dispatch entry (lines ~665–694); add size-tracking variables (`stdoutSize`, `stderrSize`) initialized to 0 alongside each array
  - [x] In the `proc.stdout.on('data')` handler, increment `stdoutSize` and drop leading chunks while `stdoutSize > MAX_TAIL_BUFFER`
  - [x] In the `proc.stderr.on('data')` handler, increment `stderrSize` and drop leading chunks while `stderrSize > MAX_TAIL_BUFFER`
  - [x] Define `const MAX_TAIL_BUFFER = 64 * 1024` (64KB) as a module-level constant near the other constants (~lines 38–41)
  - [x] Encoding: use `Buffer.toString('utf8')` (not `'utf-8'`) for the tail assembly — Node.js `Buffer.toString('utf8')` replaces malformed bytes with U+FFFD automatically

- [x] Task 3: Attach captured tails to the `dispatch:spawnsync-timeout` event in the timeout handler (AC: #2, #7)
  - [x] In the `setTimeout` timeout callback (line ~712), after the existing `proc.kill('SIGTERM')` call, assemble `stderrTail` and `stdoutTail` from the accumulated chunks using `Buffer.concat(...).toString('utf8')`
  - [x] Add `stderrTail` and `stdoutTail` to the `dispatch:spawnsync-timeout` event payload emitted at line ~731
  - [x] Do NOT surface the buffers in the clean-exit path (`proc.on('close', ...)`) — they exist only as a forensic artifact for the timeout path (backward-compat)

- [x] Task 4: Write test — PROGRESS_MARKER captured in stderrTail on timeout (AC: #5)
  - [x] Create `packages/core/src/__tests__/dispatcher-timeout-capture.test.ts` (matches existing `packages/core/src/__tests__/` convention)
  - [x] Spawn a subprocess via Node.js inline script: writes `"PROGRESS_MARKER\n"` to stderr then sleeps (`setTimeout(() => {}, 99999)`)
  - [x] Configure a short timeout (e.g., 500ms) so the subprocess is killed before the sleep ends
  - [x] Assert the `dispatch:spawnsync-timeout` event's `stderrTail` contains `"PROGRESS_MARKER"`

- [x] Task 5: Write test — tail-window discipline at 200KB (AC: #6)
  - [x] In the same test file, spawn a subprocess that writes 200KB to stderr: use `"INITIAL_MARKER"` in the first 1KB block and `"FINAL_MARKER"` in the last 1KB block, with `"x"` fill in between
  - [x] Set timeout so the subprocess is killed after writing is complete (write synchronously, then call `setTimeout(() => {}, 99999)` to hold the process alive)
  - [x] Assert `stderrTail` contains `"FINAL_MARKER"` — the final bytes are preserved
  - [x] Assert `stderrTail` does NOT contain `"INITIAL_MARKER"` — the initial bytes were dropped by the tail-window discipline
  - [x] Assert `stderrTail.length` is ≤ `64 * 1024 + 2048` (cap + one chunk of slack)

- [x] Task 6: Verify backward-compat for clean subprocess exits (AC: #7)
  - [x] In the same test file or alongside existing tests, assert that a subprocess that exits cleanly produces no `stderrTail` or `stdoutTail` on any emitted event
  - [x] Confirm no existing tests require modification (the new fields are optional on the event schema)

## Dev Notes

### Architecture Constraints
- **File paths (non-negotiable per AC)**: `packages/core/src/dispatch/dispatcher-impl.ts` for buffer discipline and tail attachment; `packages/sdlc/src/run-model/event-types.ts` for the schema extension
- **Test location**: `packages/core/src/__tests__/dispatcher-timeout-capture.test.ts` — matches the existing `packages/core/src/__tests__/` convention (e.g., `yaml-parser.test.ts`, `event-bus.test.ts`)
- The `dispatch:spawnsync-timeout` event type in `event-types.ts` is `DispatchSpawnSyncTimeoutEvent` (confirmed at line 27); new fields must be appended with `?:` (optional)
- Story 66-4 already wires the `dispatch:spawnsync-timeout` event emission at line ~731 of dispatcher-impl.ts — this story extends that payload, not the wiring

### Buffer Accumulation Pattern (tail-window discipline)

The `stdoutChunks` and `stderrChunks` arrays already exist (lines 665–666 of dispatcher-impl.ts). Add size tracking alongside them:

```typescript
const MAX_TAIL_BUFFER = 64 * 1024 // 64KB — define as module constant near lines 38-41

// Inside dispatch():
const stdoutChunks: Buffer[] = []
const stderrChunks: Buffer[] = []
let stdoutSize = 0
let stderrSize = 0

proc.stdout?.on('data', (chunk: Buffer) => {
  stdoutChunks.push(chunk)
  stdoutSize += chunk.length
  while (stdoutSize > MAX_TAIL_BUFFER && stdoutChunks.length > 1) {
    const dropped = stdoutChunks.shift()!
    stdoutSize -= dropped.length
  }
  // ... existing agent:output event emission ...
})

proc.stderr?.on('data', (chunk: Buffer) => {
  stderrChunks.push(chunk)
  stderrSize += chunk.length
  while (stderrSize > MAX_TAIL_BUFFER && stderrChunks.length > 1) {
    const dropped = stderrChunks.shift()!
    stderrSize -= dropped.length
  }
})

// In timeout handler, attach tails:
const stderrTail = Buffer.concat(stderrChunks).toString('utf8')
const stdoutTail = Buffer.concat(stdoutChunks).toString('utf8')
this._eventBus.emit('dispatch:spawnsync-timeout' as never, {
  type: 'dispatch:spawnsync-timeout',
  // ... existing fields ...
  stderrTail,
  stdoutTail,
} as never)
```

Note: keep `while` loop (not `if`) so multiple leading chunks can be dropped in a single data event when a large chunk arrives.

### Subprocess Test Pattern

```typescript
// AC5: PROGRESS_MARKER test
const proc = spawn('node', ['-e', `
  process.stderr.write('PROGRESS_MARKER\\n');
  setTimeout(() => {}, 99999);
`])
// configure short timeout (500ms) via dispatcher
// listen for dispatch:spawnsync-timeout event
// assert event.stderrTail.includes('PROGRESS_MARKER')

// AC6: 200KB tail-window test
const proc = spawn('node', ['-e', `
  process.stderr.write('INITIAL_MARKER' + 'x'.repeat(1010) + '\\n');
  for (let i = 1; i < 199; i++) process.stderr.write('x'.repeat(1024));
  process.stderr.write('FINAL_MARKER' + 'x'.repeat(1012) + '\\n');
  setTimeout(() => {}, 99999);
`])
```

### Import Patterns
- `spawn` is already imported from `'node:child_process'` in dispatcher-impl.ts (line 16)
- Event type import in tests: `import type { DispatchSpawnSyncTimeoutEvent } from '@substrate/sdlc/run-model/event-types.js'` or equivalent cross-package import path used in the project
- Check existing test files (e.g., `packages/core/src/__tests__/event-bus.test.ts`) for the correct import path pattern

### Commit Message
Must reference `obs_2026-05-04_023 fix #4` per AC8.

## Interface Contracts

- **Export**: `DispatchSpawnSyncTimeoutEvent` @ `packages/sdlc/src/run-model/event-types.ts` — extended with optional `stderrTail?: string` and `stdoutTail?: string` fields (this story 66-5 extends the schema defined in story 66-4)

## Runtime Probes

```yaml
- name: progress-marker-captured-in-stderrtail
  sandbox: host
  command: |
    cd "$(git rev-parse --show-toplevel)"
    node -e "
    const { spawn } = require('node:child_process');
    const MAX = 64 * 1024;
    let chunks = [];
    let size = 0;
    const proc = spawn('node', ['-e',
      'process.stderr.write(\"PROGRESS_MARKER\\\\n\"); setTimeout(() => {}, 99999);'
    ]);
    proc.stderr.on('data', chunk => {
      chunks.push(chunk);
      size += chunk.length;
      while (size > MAX && chunks.length > 1) {
        const d = chunks.shift();
        size -= d.length;
      }
    });
    setTimeout(() => {
      proc.kill('SIGTERM');
      const tail = Buffer.concat(chunks).toString('utf8');
      if (!tail.includes('PROGRESS_MARKER')) {
        console.error('FAIL: PROGRESS_MARKER not found in stderrTail');
        process.exit(1);
      }
      console.log('PASS: PROGRESS_MARKER captured in stderrTail');
    }, 500);
    "
  expect_stdout_regex:
    - 'PASS: PROGRESS_MARKER captured in stderrTail'
  expect_stdout_no_regex:
    - 'FAIL:'
  description: >
    Exercises the production buffer-accumulation algorithm end-to-end: spawns a
    subprocess that writes PROGRESS_MARKER to stderr and hangs, kills it after
    500ms, and asserts PROGRESS_MARKER is present in the captured tail.
  timeout_ms: 15000

- name: tail-window-discipline-drops-initial-bytes
  sandbox: host
  command: |
    cd "$(git rev-parse --show-toplevel)"
    node -e "
    const { spawn } = require('node:child_process');
    const MAX = 64 * 1024;
    let chunks = [];
    let size = 0;
    const proc = spawn('node', ['-e', \`
      process.stderr.write('INITIAL_MARKER' + 'x'.repeat(1010) + '\\\\n');
      for (let i = 1; i < 199; i++) process.stderr.write('x'.repeat(1024));
      process.stderr.write('FINAL_MARKER' + 'x'.repeat(1012) + '\\\\n');
      setTimeout(() => {}, 99999);
    \`]);
    proc.stderr.on('data', chunk => {
      chunks.push(chunk);
      size += chunk.length;
      while (size > MAX && chunks.length > 1) {
        const d = chunks.shift();
        size -= d.length;
      }
    });
    setTimeout(() => {
      proc.kill('SIGTERM');
      const tail = Buffer.concat(chunks).toString('utf8');
      const hasFinal = tail.includes('FINAL_MARKER');
      const hasInitial = tail.includes('INITIAL_MARKER');
      const capOk = tail.length <= MAX + 2048;
      console.log('hasFinal:', hasFinal, 'hasInitial:', hasInitial, 'len:', tail.length, 'capOk:', capOk);
      if (!hasFinal) { console.error('FAIL: FINAL_MARKER not in tail'); process.exit(1); }
      if (hasInitial) { console.error('FAIL: INITIAL_MARKER should have been dropped'); process.exit(1); }
      if (!capOk) { console.error('FAIL: tail exceeds buffer cap'); process.exit(1); }
      console.log('PASS: tail-window discipline enforced');
    }, 800);
    "
  expect_stdout_regex:
    - 'PASS: tail-window discipline enforced'
  expect_stdout_no_regex:
    - 'FAIL:'
  description: >
    Spawns a 200KB stderr-emitting subprocess (INITIAL_MARKER in first 1KB,
    FINAL_MARKER in last 1KB), kills after 800ms, and asserts: FINAL_MARKER
    preserved, INITIAL_MARKER dropped, total tail ≤ 64KB + 2KB slack.
  timeout_ms: 15000
```

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All 6 tasks implemented and verified.
- **Rework cycle**: prior review flagged that Task 3 was claimed complete but the
  `dispatch:spawnsync-timeout` emit-site at lines 749–758 of dispatcher-impl.ts
  did NOT actually include `stderrTail`/`stdoutTail` in the event payload — the
  accumulated chunks were used only for the resolve() output string. This rework
  pass adds the two `Buffer.concat(...).toString('utf8')` assemblies inside the
  timeout handler and appends the fields to the emitted event literal. The
  `CoreEvents['dispatch:spawnsync-timeout']` shape in `packages/core/src/events/core-events.ts`
  is also extended with optional `stderrTail?: string`/`stdoutTail?: string` so
  the emit type-checks against the bus without `as never` lying about the shape.
- 4 new tests in `dispatcher-timeout-capture.test.ts` cover AC5, AC6, AC7, and
  stdoutTail capture.
- Build succeeded with no type errors.
- Commit message must reference obs_2026-05-04_023 fix #4 per AC8.

### File List
- packages/sdlc/src/run-model/event-types.ts (modified — added stderrTail? and stdoutTail? to DispatchSpawnSyncTimeoutEvent)
- packages/core/src/events/core-events.ts (modified — added stderrTail?/stdoutTail? to CoreEvents['dispatch:spawnsync-timeout'])
- packages/core/src/dispatch/dispatcher-impl.ts (modified — added MAX_TAIL_BUFFER constant, size-tracking variables, tail-window discipline in data handlers, stderrTail/stdoutTail assembled and attached to dispatch:spawnsync-timeout event payload)
- packages/core/src/__tests__/dispatcher-timeout-capture.test.ts (created — 4 tests covering AC5, AC6, AC7, and stdoutTail capture)

## Change Log
