# Story 53-2: Multi-Signal Stall Detection

## Story

As a substrate developer,
I want stall detection to require two independent signals before declaring a stall,
so that false positives are eliminated and healthy long-running dispatches are never killed.

## Acceptance Criteria

### AC1: Timer-Exceeded, Output Still Growing → Stall NOT Declared
**Given** a dispatch whose staleness has exceeded the phase-aware threshold (from `StallDetector.evaluate()`, `isStalled: true`)
**When** `OutputGrowthTracker` shows positive byte growth between the most recent two consecutive polls for that story
**Then** `MultiSignalStallDetector.evaluate()` returns `{ isStall: false, suppressedBySingleSignal: true }`
**And** `handleStallRecovery` does NOT trigger the kill sequence

### AC2: Timer-Exceeded + 2-Poll Output Stagnation → Stall Declared
**Given** a dispatch whose staleness has exceeded the phase-aware threshold
**When** `OutputGrowthTracker.isStagnant(storyKey, 2)` returns `true` (no byte growth over 2 consecutive polls)
**Then** `MultiSignalStallDetector.evaluate()` returns `{ isStall: true }`
**And** `handleStallRecovery` proceeds with the kill-and-restart sequence

### AC3: CPU Sampling Unavailable → Output Growth Is the Sole Second Signal
**Given** CPU sampling returns `{ cpuPercent: null, available: false }` (e.g., permission denied in container)
**When** `MultiSignalStallDetector.evaluate()` is called with that result
**Then** the stall verdict depends only on `outputStagnant2` (output stagnation over 2 polls) as the second signal
**And** a warning is logged: `"CPU sampling unavailable — using output growth as second stall signal"`
**And** `CpuSampler.sample(pid)` returns `{ cpuPercent: null, available: false }` when `/proc/{pid}/stat` is inaccessible and `ps` fails

### AC4: Zombie Detection — CPU = 0 + 3-Poll Output Stagnation
**Given** a process that is alive (`processAlive: true`) and CPU sampling is available
**When** `cpuPercent === 0` AND `OutputGrowthTracker.isStagnant(storyKey, 3)` returns `true`
**Then** `MultiSignalStallDetector.evaluate()` returns `{ isZombie: true }`
**And** `handleStallRecovery` treats `isZombie: true` identically to `isStall: true` (triggers kill-and-restart)
**And** the kill event includes `reason: 'zombie'` instead of `reason: 'stall'`

### AC5: CpuSampler Platform-Aware Sampling
**Given** a running process PID on Linux
**When** `CpuSampler.sample(pid)` is called on two successive polls
**Then** on Linux it reads `/proc/{pid}/stat`, extracts `utime + stime` ticks (fields 14 and 15, 1-indexed), and returns `{ cpuPercent: 0, available: true }` if the tick delta between polls is zero, or `{ cpuPercent: 1, available: true }` if ticks increased
**And** on macOS (`process.platform === 'darwin'`), it runs `ps -p {pid} -o %cpu=` and parses the floating-point result
**And** when the process PID does not exist or `/proc` access is denied, it returns `{ cpuPercent: null, available: false }` without throwing

### AC6: Integration — handleStallRecovery Uses Multi-Signal Verdict
**Given** `handleStallRecovery` receives an optional `multiSignal` state (containing `OutputGrowthTracker` and `CpuSampler` instances) via the `config` parameter
**When** a `multiSignal` state is provided and the timer threshold is exceeded
**Then** `handleStallRecovery` computes the current output size via `deps.computeOutputSize(projectRoot)`, records it in the tracker, samples CPU for the orchestrator PID, and delegates to `MultiSignalStallDetector.evaluate()`
**And** when `multiSignal` is not provided (legacy callers, tests without multi-signal), the existing single-signal timer-only path remains active unchanged

## Tasks / Subtasks

- [ ] Task 1: Define `OutputGrowthTracker` class and related types (AC: #1, #2, #4)
  - [ ] Create `src/modules/supervisor/multi-signal-stall.ts` with the following exports:
    - `OutputSnapshot`: `{ sizeBytes: number; recordedAt: number }`
    - `OutputGrowthTracker` class:
      - Constructor takes optional `maxHistoryPerStory: number` (default: 5)
      - `recordSnapshot(storyKey: string, sizeBytes: number): void` — appends to per-story history, trims to `maxHistoryPerStory`
      - `isStagnant(storyKey: string, minConsecutivePolls: number): boolean` — returns `true` if the last `minConsecutivePolls` snapshots all have equal `sizeBytes`; `false` if fewer than `minConsecutivePolls` snapshots exist (not enough data to declare stagnation)
      - `clear(storyKey: string): void` — removes history for one story (call on story completion or restart)
      - `clearAll(): void` — wipes all history (call on supervisor restart)
  - [ ] Stagnation logic: compare `snapshots.slice(-minConsecutivePolls).every(s => s.sizeBytes === snapshots[snapshots.length - 1].sizeBytes)` — returns `false` rather than `true` when there is insufficient history

- [ ] Task 2: Define `CpuSampler` class (AC: #3, #5)
  - [ ] In `src/modules/supervisor/multi-signal-stall.ts`, add:
    - `CpuSamplerResult`: `{ cpuPercent: number | null; available: boolean }`
    - `CpuSamplerDeps`: `{ readFile?: (path: string) => Promise<string>; execLine?: (cmd: string) => Promise<string> }` (injectable for tests; defaults use `fs.promises.readFile` and a minimal `child_process.execFile` wrapper)
    - `CpuSampler` class:
      - Constructor takes `deps: CpuSamplerDeps = {}` and optional `platform?: string` (defaults to `process.platform`)
      - Internal: `prevTicks: Map<number, number>` for delta-based Linux measurement
      - `sample(pid: number): Promise<CpuSamplerResult>`:
        - Linux path: read `/proc/${pid}/stat`, split on whitespace, parse fields[13] + fields[14] as `utime + stime` (0-indexed). Compare to `prevTicks.get(pid) ?? -1`. If `prevTicks` has no entry for this PID yet, store current ticks and return `{ cpuPercent: null, available: true }` (first sample — not enough data). On second+ call, return `{ cpuPercent: delta > 0 ? 1 : 0, available: true }`. Update `prevTicks`.
        - macOS path: run `ps -p {pid} -o %cpu=`, trim whitespace, parse float. Return `{ cpuPercent: parsed, available: true }`.
        - On any error (ENOENT, EACCES, non-zero exit, NaN parse): return `{ cpuPercent: null, available: false }`. Clear `prevTicks` entry for this PID.
  - [ ] Do NOT import `child_process` directly — accept `execLine` dep so tests remain synchronous

- [ ] Task 3: Define `MultiSignalStallDetector` class (AC: #1, #2, #3, #4)
  - [ ] In `src/modules/supervisor/multi-signal-stall.ts`, add:
    - `MultiSignalInput`:
      ```typescript
      {
        stallTimerExceeded: boolean      // from StallDetector.evaluate().isStalled
        outputStagnant2: boolean         // OutputGrowthTracker.isStagnant(key, 2)
        outputStagnant3: boolean         // OutputGrowthTracker.isStagnant(key, 3)
        cpuResult: CpuSamplerResult
        processAlive: boolean            // true when orchestrator PID responds to kill(pid, 0)
      }
      ```
    - `MultiSignalResult`:
      ```typescript
      {
        isStall: boolean
        isZombie: boolean
        suppressedBySingleSignal: boolean  // true when timer exceeded but second signal absent
        reason: string                     // human-readable explanation
      }
      ```
    - `MultiSignalStallDetector` class with method `evaluate(input: MultiSignalInput, logWarning: (msg: string) => void): MultiSignalResult`:
      - **Zombie check** (independent of timer): `processAlive && cpuResult.available && cpuResult.cpuPercent === 0 && outputStagnant3`
      - **Stall check**:
        - If `cpuResult.available`: `stallTimerExceeded && (outputStagnant2 || cpuResult.cpuPercent === 0 || !processAlive)`
        - If `!cpuResult.available`: call `logWarning('CPU sampling unavailable — using output growth as second stall signal')` once; then `stallTimerExceeded && outputStagnant2`
      - `suppressedBySingleSignal`: `stallTimerExceeded && !isStall && !isZombie`
  - [ ] Keep this class pure (no I/O, no side effects — logging via injected callback)

- [ ] Task 4: Integrate multi-signal into `handleStallRecovery` (AC: #6)
  - [ ] In `src/cli/commands/supervisor.ts`:
    - Add `MultiSignalState` type: `{ tracker: OutputGrowthTracker; sampler: CpuSampler; detector: MultiSignalStallDetector }`
    - Extend the `config` parameter of `handleStallRecovery` with optional `multiSignal?: MultiSignalState`
    - Add `computeOutputSize?: (projectRoot: string) => Promise<number>` to the `deps` parameter
    - After the existing `StallDetector.evaluate()` call that yields `{ isStalled, effectiveThreshold }`:
      ```typescript
      // When multi-signal state is provided, gate the kill on a second signal
      if (config.multiSignal && deps.computeOutputSize) {
        const sizeBytes = await deps.computeOutputSize(state.projectRoot).catch(() => 0)
        const storyKey = /* first active story key from health.stories.details */ 'active'
        config.multiSignal.tracker.recordSnapshot(storyKey, sizeBytes)
        const orchPid = health.process.orchestrator_pid
        const cpuResult = orchPid !== null
          ? await config.multiSignal.sampler.sample(orchPid)
          : { cpuPercent: null, available: false }
        const processAlive = orchPid !== null && (() => {
          try { process.kill(orchPid, 0); return true } catch { return false }
        })()
        const msResult = config.multiSignal.detector.evaluate({
          stallTimerExceeded: isStalled,
          outputStagnant2: config.multiSignal.tracker.isStagnant(storyKey, 2),
          outputStagnant3: config.multiSignal.tracker.isStagnant(storyKey, 3),
          cpuResult,
          processAlive,
        }, log)
        if (msResult.suppressedBySingleSignal) {
          log(`Supervisor: stall timer exceeded but output growing — suppressing kill (multi-signal)`)
          return null
        }
        if (!msResult.isStall && !msResult.isZombie) return null
        // Override kill reason for zombie
        if (msResult.isZombie && !msResult.isStall) {
          // emit reason: 'zombie' instead of 'stall' in the kill event below
        }
      } else if (!isStalled) {
        return null
      }
      ```
    - Replace the existing `if (!isStalled) return null` with the block above
    - In `runSupervisorAction`, construct the `MultiSignalState` once (before the poll loop) and pass it into `handleStallRecovery`. Use `defaultComputeOutputSize` as the default dep.

- [ ] Task 5: Add `computeOutputSize` default implementation (AC: #6)
  - [ ] In `src/cli/commands/supervisor.ts`, add helper `defaultComputeOutputSize(projectRoot: string): Promise<number>`:
    - Runs `git diff --stat HEAD` with `cwd: projectRoot` via `child_process.execFile`
    - Parses total insertions from the summary line (e.g. "3 files changed, 47 insertions(+)") — returns `parseInt(match[1], 10)`
    - On any error (not a git repo, timeout, etc.): returns `0`
    - Timeout: 5 seconds
  - [ ] Add `computeOutputSize` to `SupervisorDeps` interface as optional `computeOutputSize?: (projectRoot: string) => Promise<number>`, defaulting to `defaultComputeOutputSize`

- [ ] Task 6: Write unit tests (AC: #1, #2, #3, #4, #5)
  - [ ] Create `src/modules/supervisor/__tests__/multi-signal-stall.test.ts` using Vitest
  - [ ] `OutputGrowthTracker` tests:
    - `isStagnant` returns `false` with fewer than `minConsecutivePolls` entries
    - Returns `false` when bytes increase between polls
    - Returns `true` when bytes are unchanged for exactly `minConsecutivePolls`
    - `clear(storyKey)` resets history; subsequent `isStagnant` returns `false`
  - [ ] `CpuSampler` tests (inject mock `readFile` and `execLine` deps):
    - Linux first sample: stores ticks, returns `available: true, cpuPercent: null`
    - Linux second sample same ticks: returns `{ cpuPercent: 0, available: true }`
    - Linux second sample increased ticks: returns `{ cpuPercent: 1, available: true }`
    - macOS path: mock `execLine` returns `"12.5"`, assert `{ cpuPercent: 12.5, available: true }`
    - Unavailable path: mock `readFile` throws EACCES, `execLine` throws, assert `{ cpuPercent: null, available: false }`
  - [ ] `MultiSignalStallDetector` tests:
    - Timer exceeded + output growing → `{ isStall: false, suppressedBySingleSignal: true }`
    - Timer exceeded + output stagnant 2 polls + CPU available → `{ isStall: true }`
    - Timer exceeded + CPU unavailable + output stagnant 2 polls → `{ isStall: true }` and warning logged
    - Timer exceeded + CPU unavailable + output growing → `{ isStall: false, suppressedBySingleSignal: true }`
    - Zombie: processAlive + CPU=0 + output stagnant 3 polls + timer NOT exceeded → `{ isZombie: true, isStall: false }`
    - No zombie when CPU sampling unavailable (cannot confirm CPU=0)

## Dev Notes

### Architecture Constraints
- `OutputGrowthTracker`, `CpuSampler`, and `MultiSignalStallDetector` all live in `src/modules/supervisor/multi-signal-stall.ts` — NOT in `packages/sdlc` or `packages/core`; this is a supervisor-level concern (same rationale as `stall-detector.ts` from 53-1)
- All three new classes must be pure with respect to the `supervisor.ts` integration: no I/O in the classes themselves; all I/O is injected or delegated to `handleStallRecovery`
- The `handleStallRecovery` function signature change must be backward-compatible — new params are optional so existing callers and tests compile without changes
- Import style: `import { ... } from '../../modules/supervisor/multi-signal-stall.js'` (`.js` extension for ESM)
- Do NOT add new Dolt tables; all state is in-memory within the supervisor process (TTL = process lifetime)
- The `MultiSignalState` instances (`tracker`, `sampler`, `detector`) must be constructed once in `runSupervisorAction` and reused across poll cycles — do NOT construct per-call inside `handleStallRecovery`

### Key File Paths
- **New file:** `src/modules/supervisor/multi-signal-stall.ts`
- **New test:** `src/modules/supervisor/__tests__/multi-signal-stall.test.ts`
- **Modify:** `src/cli/commands/supervisor.ts` — `handleStallRecovery` (add multi-signal gating after `StallDetector.evaluate()`), `runSupervisorAction` (construct `MultiSignalState`, add `computeOutputSize` dep), `SupervisorDeps` interface
- **Reference (do not modify):** `src/modules/supervisor/stall-detector.ts` — exports `StallDetector`, `StallEvaluateResult`, `DEFAULT_STALL_THRESHOLDS` consumed by this story

### Linux /proc/{pid}/stat Field Parsing
```typescript
// Fields are space-separated; field indices are 0-based in the array
// Standard /proc/{pid}/stat layout (man 5 proc):
//   [0]  pid
//   [13] utime  — user-mode CPU time in clock ticks
//   [14] stime  — kernel-mode CPU time in clock ticks
const fields = content.trim().split(' ')
const utime = parseInt(fields[13]!, 10)
const stime = parseInt(fields[14]!, 10)
const ticks = utime + stime  // total CPU ticks consumed since process start
```
On the first call for a PID, store `ticks` in `prevTicks` and return `{ cpuPercent: null, available: true }` — the caller must call `sample()` at least twice to get a definitive CPU = 0 verdict.

### OutputGrowthTracker Stagnation Logic
```typescript
isStagnant(storyKey: string, minConsecutivePolls: number): boolean {
  const history = this.history.get(storyKey) ?? []
  if (history.length < minConsecutivePolls) return false   // not enough data
  const recent = history.slice(-minConsecutivePolls)
  const baseline = recent[0]!.sizeBytes
  return recent.every(s => s.sizeBytes === baseline)
}
```
Key invariant: `isStagnant` NEVER returns `true` when there are fewer than `minConsecutivePolls` samples. This prevents false-positive zombie declarations on the first few polls.

### MultiSignalStallDetector Evaluate Logic
```typescript
evaluate(input: MultiSignalInput, logWarning: (msg: string) => void): MultiSignalResult {
  const { stallTimerExceeded, outputStagnant2, outputStagnant3, cpuResult, processAlive } = input

  // Zombie: independent of timer — a process that is alive but consumes no CPU and
  // produces no output for 3 consecutive polls is hung beyond recovery.
  const isZombie = processAlive
    && cpuResult.available
    && cpuResult.cpuPercent === 0
    && outputStagnant3

  let isStall = false
  if (stallTimerExceeded) {
    if (cpuResult.available) {
      // Second signal: output stagnation OR CPU idle OR process dead
      isStall = outputStagnant2 || cpuResult.cpuPercent === 0 || !processAlive
    } else {
      // CPU signal unavailable — output growth is the required second signal
      logWarning('CPU sampling unavailable — using output growth as second stall signal')
      isStall = outputStagnant2
    }
  }

  const suppressedBySingleSignal = stallTimerExceeded && !isStall && !isZombie

  return {
    isStall,
    isZombie,
    suppressedBySingleSignal,
    reason: isZombie
      ? 'zombie: process alive, CPU=0, output stagnant 3 polls'
      : isStall
        ? `stall: timer exceeded, second signal confirmed (cpu=${cpuResult.cpuPercent}, outputStagnant=${outputStagnant2})`
        : suppressedBySingleSignal
          ? 'timer exceeded but output still growing — kill suppressed'
          : 'no stall',
  }
}
```

### Active Story Key for OutputGrowthTracker
When recording snapshots in `handleStallRecovery`, use a synthetic key `'active'` (or the first active story key from `health.stories.details`) — the tracker only needs to track one stream per supervisor poll cycle. The exact story key used for recording must be consistent across calls; `'active'` is sufficient since the tracker is reset on supervisor restart.

### Testing Requirements
- Framework: Vitest — `import { describe, it, expect, vi, beforeEach } from 'vitest'`
- `CpuSampler` tests must inject mock `readFile` / `execLine` deps — do NOT read real `/proc` in tests
- `OutputGrowthTracker` tests are purely synchronous (no async needed)
- `MultiSignalStallDetector` tests inject a `logWarning` spy (`vi.fn()`) to assert the CPU-unavailable warning
- All tests in `multi-signal-stall.test.ts` must pass with `npm run test:fast`

## Interface Contracts

- **Import**: `StallDetector`, `StallEvaluateResult`, `DEFAULT_STALL_THRESHOLDS` @ `src/modules/supervisor/stall-detector.ts` (from story 53-1)
- **Export**: `OutputGrowthTracker`, `CpuSampler`, `CpuSamplerResult`, `MultiSignalStallDetector`, `MultiSignalInput`, `MultiSignalResult` @ `src/modules/supervisor/multi-signal-stall.ts` (may be consumed by story 53-9 dispatch gating for zombie-aware pre-conditions)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-04-06: Story created (Epic 53, Phase D Autonomous Operations)
