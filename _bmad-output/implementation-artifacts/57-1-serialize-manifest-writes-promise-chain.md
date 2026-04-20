# Story 57-1: Serialize Manifest Writes via Per-Instance Promise Chain

## Story

As a pipeline operator,
I want all `RunManifest` write operations to execute strictly sequentially on a single instance,
so that concurrent fire-and-forget patches no longer race and silently drop fields like `verification_result`.

## Acceptance Criteria

### AC1: Private Write-Chain Field
**Given** the `RunManifest` class in `packages/sdlc/src/run-model/run-manifest.ts`
**When** a new `RunManifest` instance is constructed
**Then** it has a private `_writeChain: Promise<void>` field initialized to `Promise.resolve()`

### AC2: All Public Mutations Are Chained
**Given** the four public mutation methods — `write()`, `patchStoryState()`, `patchCLIFlags()`, `appendRecoveryEntry()`
**When** any of these methods is called
**Then** each method's body executes only after all previously enqueued work on `_writeChain` completes, by replacing `_writeChain` with `this._writeChain.then(() => doActualWork())` before returning the enqueued promise to the caller

### AC3: Returned Promise Resolves When Work Completes
**Given** a caller that awaits the return value of any mutation method
**When** the enqueued write finishes
**Then** the returned promise resolves (or rejects on error) exactly when that call's own work completes — so existing `.catch()` fire-and-forget callers continue to receive and log failures

### AC4: Concurrent Writes Produce Zero Lost Fields
**Given** a `RunManifest` instance backed by a real temp-dir filesystem
**When** 100 concurrent `patchStoryState('s', { fieldA })` / `patchStoryState('s', { fieldB })` / `patchStoryState('s', { fieldC })` calls fire without awaiting between them
**Then** the final manifest read contains all three fields (`fieldA`, `fieldB`, `fieldC`) with their expected values, and this holds across 10 independent runs of the same test scenario

### AC5: Single-Threaded Callers Are Unaffected
**Given** any existing `RunManifest` unit test that does not exercise concurrency
**When** the test runs after the write-chain is introduced
**Then** all existing tests pass unchanged (no new failures, no observable behavior change for sequential call patterns)

### AC6: One Failed Write Does Not Block Subsequent Writes
**Given** a queued sequence of writes where one intermediate write throws an error
**When** the error is caught and `_writeChain` continues
**Then** subsequent writes enqueued after the failing write still execute and complete — the chain does not permanently stall after a single failure

## Tasks / Subtasks

- [ ] Task 1: Add `_writeChain` field and `_enqueue` helper to `RunManifest` (AC: #1, #2, #3, #6)
  - [ ] Add `private _writeChain: Promise<void> = Promise.resolve()` as a class field in the `RunManifest` constructor body (or as a class-field initializer)
  - [ ] Add a private helper `_enqueue<T>(fn: () => Promise<T>): Promise<T>` that appends `fn` to `_writeChain` via `.then()`, catches errors on the chain continuation so the chain itself never rejects, and returns the per-call promise that resolves/rejects from `fn` directly (so callers get failure signals)
  - [ ] Ensure the chain continuation swallows errors with a no-op catch so subsequent enqueues are not blocked

- [ ] Task 2: Wrap `write()` to go through `_enqueue` (AC: #2, #3, #5)
  - [ ] Extract the existing `write()` body into a private `_writeImpl()` method (or an inline arrow)
  - [ ] Replace the public `write()` body with `return this._enqueue(() => this._writeImpl(data))`
  - [ ] Verify the method signature and return type (`Promise<void>`) are unchanged

- [ ] Task 3: Wrap `patchStoryState()`, `patchCLIFlags()`, `appendRecoveryEntry()` to go through `_enqueue` (AC: #2, #3, #5)
  - [ ] For `patchStoryState()`: extract existing body into a private `_patchStoryStateImpl()`, replace public method body with `return this._enqueue(() => this._patchStoryStateImpl(storyKey, updates))`
  - [ ] For `patchCLIFlags()`: same pattern — extract to `_patchCLIFlagsImpl()`, wrap via `_enqueue`
  - [ ] For `appendRecoveryEntry()`: same pattern — extract to `_appendRecoveryEntryImpl()`, wrap via `_enqueue`

- [ ] Task 4: Write regression test for concurrent writes (AC: #4, #6)
  - [ ] Create `packages/sdlc/src/run-model/__tests__/run-manifest-concurrent-writes.test.ts`
  - [ ] Use real filesystem I/O with `os.tmpdir()` temp dirs (same pattern as `run-manifest-write.test.ts`)
  - [ ] Test: fire 100 concurrent patches setting three distinct fields on the same story key; after `Promise.allSettled()` resolves, read the manifest and assert all three fields are present with correct values; run this assertion loop 10 times to confirm zero flakiness
  - [ ] Test: assert that a write that throws (mock `fs.rename` to reject once) does not prevent the next enqueued write from completing

- [ ] Task 5: Build and run targeted tests (AC: #5)
  - [ ] Run `npm run build` to verify no TypeScript errors
  - [ ] Run `npm run test:changed` (or `npm run test:fast`) to confirm all existing `run-model` tests still pass alongside the new concurrent-writes tests

## Dev Notes

### Architecture Constraints
- **File to modify**: `packages/sdlc/src/run-model/run-manifest.ts` — all changes stay in this file; no new exports, no interface changes visible to consumers outside the class
- **New test file**: `packages/sdlc/src/run-model/__tests__/run-manifest-concurrent-writes.test.ts`
- **Import style**: ESM `.js` extension on all local imports (e.g. `from '../run-manifest.js'`)
- **Test framework**: Vitest — use `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` from `'vitest'`
- **No new dependencies**: the write chain is pure in-memory JS; no `async-mutex` or similar library

### Key Implementation Pattern for `_enqueue`

The chain must:
1. Capture the *previous* tail of the chain before replacing it
2. Append the new work as a `.then()` on the previous tail
3. Catch errors on the *chain* side (the `.catch()` that keeps `_writeChain` from rejecting), while returning the raw inner promise to the caller (so the caller gets real errors)

```typescript
// Sketch — not normative, implement as you see fit
private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
  // The promise returned to the caller — resolved/rejected by fn()
  let resolve!: (v: T | PromiseLike<T>) => void
  let reject!: (e: unknown) => void
  const callerPromise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Chain: only advances the chain after fn settles; chain itself never rejects
  this._writeChain = this._writeChain.then(() =>
    fn().then(resolve, reject)
  ).catch(() => { /* swallow so chain continues after caller rejection */ })
  return callerPromise
}
```

Alternatively, a simpler pattern that also works:
```typescript
private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = this._writeChain.then(() => fn())
  // Keep chain alive even if fn rejects
  this._writeChain = next.then(() => undefined, () => undefined)
  return next
}
```
The simpler pattern is preferred if it satisfies all ACs. Confirm AC6 with a test.

### Existing Mutation Method Structure

All four public mutation methods follow the same shape:
1. Read current manifest (or bootstrap a minimal default on `catch`)
2. Compute updated data
3. Call `this.write(updated)`

When wrapping via `_enqueue`, the **entire** read → compute → write sequence must run inside the enqueued function — not just `write()`. Otherwise two concurrent callers could both read the same stale state before either has written, reproducing the lost-update bug at a higher level.

For `write()` itself, the method already only writes (no read), so wrapping just the write body is fine.

### Testing Requirements
- Use `os.tmpdir()` + `randomUUID()` for temp dirs, same as `run-manifest-write.test.ts`
- `afterEach`: clean up temp dir with `fs.rm(tempDir, { recursive: true, force: true })`
- The concurrent test must use `Promise.allSettled` (not `Promise.all`) so a single failure doesn't mask the verification step
- Loop the concurrent scenario 10 times in a `for` loop inside a single `it` block to assert zero flakiness without spawning 10 separate test cases
- Target ≤ 200ms per iteration (real fs, small payloads) — no `vi.useFakeTimers()` needed

### File Paths Summary
| Path | Action |
|---|---|
| `packages/sdlc/src/run-model/run-manifest.ts` | Modify — add `_writeChain`, `_enqueue`, wrap 4 methods |
| `packages/sdlc/src/run-model/__tests__/run-manifest-concurrent-writes.test.ts` | New — concurrent-write regression tests |

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
